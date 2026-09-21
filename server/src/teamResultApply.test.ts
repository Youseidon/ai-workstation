import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { config } from "./config.ts";
import { settings } from "./settings.ts";
import { TaskControlService } from "./taskControl.ts";
import {
  BareGitControlRecordRemote,
  applyControlTransition,
  handoverBranch,
  type ControlRecord,
} from "./teamControlRecord.ts";
import {
  BareGitHandoverPackageRemote,
  beginHandover,
  captureHandoverPackage,
  publishHandoverOffer,
  readPublishedOffer,
  type CapturePreview,
} from "./teamHandoverCapture.ts";
import { returnHandoverWork, type HandoverStopReason, type ReceiverEnvironment } from "./teamHandoverRun.ts";
import {
  applyReturnedResult,
  compareWorkspaceBaseline,
  deleteHandoverBranch,
  handoverPipelineHold,
  observeWorkspace,
  probeResultMerge,
  readApplyIntent,
  readReturnedResult,
  recoverApplyIntent,
  requestHandoverChanges,
  reviewReturnedResult,
  type HandoverBaseline,
  type RequesterEnvironment,
} from "./teamResultApply.ts";
import { parseTeamItemGrantedCommand } from "./teamItemViews.ts";
import { mintItemId } from "./teamItems.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

/*
 * Scenario TM-T1-H3, docs/e2e-scenarios/tm4.md: the receiver returns the work,
 * the requester reviews it and applies it by ordinary merge, and the task
 * completes.
 *
 * TM-T1-H3 is a T1 row, so its phone half belongs to the two-environment
 * harness. This file runs everything that is reachable at the server tier, and
 * that is most of the row, because the subject of this task is the requester's
 * own checkout and the shared record rather than two bots:
 *
 *   - the shared bare repository is real, and both halves of what crosses are
 *     real: `aw/handover/<item>` carrying the snapshot and then the result
 *     commits, and `refs/aw/items/<item>/control` carrying the states;
 *   - the requester's own checkout is a real Git working tree with real staged,
 *     unstaged, untracked and ignored content, because the baseline comparison
 *     is the whole point of the row and a fake tree would not have one;
 *   - the receiver's side is driven through H04's own `return_work`, so the
 *     return this file reviews is the one the product actually publishes.
 *
 * What is left for the harness is named in the task report and written into
 * `e2e/tests/t1/tm4-handover.spec.ts`: delivery of the review card to a phone,
 * env A stopped while the work is returned, and the anchor edits.
 */

const REQUESTER = "jd";
const RECEIVER = "yousef";
const PROVIDER = "claude";
const MODEL = "sonnet";
const CAPABILITY = { teamEnabled: true, handoverEnabled: true } as const;

const database = () => new Database(join(config.repoRoot, ".agent-console/console.sqlite"));

function git(directory: string, args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

function tryGit(directory: string, args: string[]): { status: number; stdout: string } {
  try {
    return { status: 0, stdout: execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    return { status: 1, stdout: String((error as { stdout?: string }).stdout ?? "") };
  }
}

interface Fixture {
  itemId: string;
  groupChat: string;
  bare: string;
  /** Env A: jd's own checkout, which is the original workspace apply merges into. */
  source: string;
  /** Env B's clone, where the result commits are made. */
  receiverClone: string;
  integrationRoot: string;
  control: BareGitControlRecordRemote;
  env: RequesterEnvironment;
  receiver: ReceiverEnvironment;
  promptId: number;
  workspaceId: number;
  dispose(): void;
}

/**
 * jd's own checkout with real staged, unstaged, untracked and ignored content,
 * linked to a local task as `requester`, plus the shared bare repository and
 * env B's clone of it.
 */
function fixture(prefix: string): Fixture {
  const itemId = mintItemId();
  const groupChat = `-100${itemId.slice(-10)}`;
  const bare = mkdtempSync(join(tmpdir(), `${prefix}-bare-`));
  const source = mkdtempSync(join(tmpdir(), `${prefix}-src-`));
  const receiverClone = mkdtempSync(join(tmpdir(), `${prefix}-recv-`));
  const integrationRoot = mkdtempSync(join(tmpdir(), `${prefix}-integration-`));
  execFileSync("git", ["init", "--bare", "-q", bare]);

  git(source, ["init", "-q", "-b", "work"]);
  git(source, ["config", "user.email", "jd@invalid"]);
  git(source, ["config", "user.name", "jd"]);
  writeFileSync(join(source, ".gitignore"), "secrets.log\n");
  writeFileSync(join(source, "task.md"), "step one\n");
  writeFileSync(join(source, "notes.md"), "notes\n");
  git(source, ["add", "-A"]);
  git(source, ["commit", "-q", "-m", "base"]);

  const workspace = workspaces.create({ name: source, workDirectory: source });
  const program = workspaces.createChild("program", workspace.id, { name: "Team", overview: "Handover" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: "Work", overview: "TM4" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: `Item ${itemId}`, content: "Finish the work" }) as PromptRecord;
  workspaces.createItemLink({ itemId, promptId: prompt.id, role: "requester", epoch: 1 });

  workspaces.upsertTeamGroupActor({
    id: `fake-tg-${REQUESTER}-group-${itemId}`, transport: "fake_telegram", transportUserId: "9000",
    chatId: groupChat, label: "jd",
  });
  // The roster the item's thread belongs to, which is what the item half of
  // `TaskControlService` resolves an owner and an acting member against.
  const teamId = `team-${itemId}`;
  workspaces.upsertTeamRoster({
    teamId, groupChatId: groupChat, remoteUrl: bare, revision: "r1",
    record: {
      version: 1, teamId, groupChatId: groupChat, remoteUrl: bare, usedInviteIds: [], commandIds: [],
      updatedAt: new Date().toISOString(),
      members: [
        { personId: REQUESTER, telegramUserId: "9000", botId: "jd-bot", botUsername: "jd_bot", workstationId: "jd-laptop", workstationLabel: "jd-laptop", personLabel: "jd" },
        { personId: RECEIVER, telegramUserId: "9001", botId: "yousef-bot", botUsername: "yousef_bot", workstationId: "yousef-desktop", workstationLabel: "yousef-desktop", personLabel: "yousef" },
      ],
    },
  });

  const control = new BareGitControlRecordRemote(bare, itemId);
  const env: RequesterEnvironment = {
    personId: REQUESTER,
    workstationId: "jd-laptop",
    botId: "jd-bot",
    chatId: groupChat,
    topicId: null,
    actorId: `fake-tg-${REQUESTER}-group-${itemId}`,
    roster: [REQUESTER, RECEIVER],
    workDirectory: source,
    remoteUrl: bare,
  };
  const receiver: ReceiverEnvironment = {
    personId: RECEIVER,
    workstationId: "yousef-desktop",
    botId: "yousef-bot",
    chatId: groupChat,
    topicId: null,
    actorId: `fake-tg-${RECEIVER}-group-${itemId}`,
    roster: [REQUESTER, RECEIVER],
    workspaceId: workspace.id,
    suiteId: suite.id,
    policy: () => ({ providers: [PROVIDER], models: [MODEL], hostAccess: false, sandbox: ["workspace-write"], tools: [], grantable: [], denied: [], unenforceable: [] }),
  };

  return {
    itemId, groupChat, bare, source, receiverClone, integrationRoot, control, env, receiver,
    promptId: prompt.id, workspaceId: workspace.id,
    dispose() {
      // Every row and every file this fixture created goes with it, so the file
      // passes twice against one unchanged repo root.
      for (const entry of workspaces.list()) if (entry.id === workspace.id) workspaces.remove(entry.id);
      // `team_roster` has no removal API, so the cache row goes back out the
      // way the other suites clear theirs.
      const db = database();
      try { db.prepare("DELETE FROM team_roster WHERE team_id=?").run(teamId); } finally { db.close(); }
      workspaces.removeTaskControlActor(`fake-tg-${REQUESTER}-group-${itemId}`);
      rmSync(join(config.repoRoot, ".agent-console", "handover-apply", `${itemId}.json`), { force: true });
      for (const directory of [bare, source, receiverClone, integrationRoot]) rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** jd's uncommitted work: one modified tracked file, one staged file, one untracked file, one ignored file. */
function dirtyWorkspace(f: Fixture): void {
  writeFileSync(join(f.source, "task.md"), "step one\nstep two in progress\n");
  writeFileSync(join(f.source, "staged.md"), "staged work\n");
  git(f.source, ["add", "staged.md"]);
  writeFileSync(join(f.source, "untracked.md"), "scratch\n");
  writeFileSync(join(f.source, "secrets.log"), "ignored and never published\n");
}

/** Env A's half: hold the item, capture the package and publish the open call. */
async function published(f: Fixture): Promise<CapturePreview> {
  await beginHandover(f.control, { itemId: f.itemId, requester: REQUESTER, commandId: "a-begin", workstationId: "jd-laptop" });
  dirtyWorkspace(f);
  const preview = await captureHandoverPackage({
    itemId: f.itemId, requester: REQUESTER, provider: PROVIDER, model: MODEL, control: f.control,
    idleWait: { attempts: 0, delayMs: 0 },
  });
  await publishHandoverOffer({
    preview, control: f.control, packages: new BareGitHandoverPackageRemote(f.source, f.bare),
    commandId: "a-publish", actor: { personId: REQUESTER, workstationId: "jd-laptop" },
    confirmations: preview.requiredConfirmations, acknowledgedBytes: preview.totalBytes,
  });
  return preview;
}

/**
 * Env B's half, driven through H04's own `return_work`: clone the branch, make
 * result commits, push them on the **same branch**, and move the record to
 * `RETURNED`.
 */
async function returned(
  f: Fixture,
  options: { stopReason?: HandoverStopReason; verification?: string[]; uncertainEffects?: string[]; work?: (clone: string) => void } = {},
): Promise<{ resultCommit: string; resultId: string; label: "full" | "partial" }> {
  const branch = handoverBranch(f.itemId);
  execFileSync("git", ["clone", "-q", "--branch", branch, f.bare, f.receiverClone]);
  git(f.receiverClone, ["config", "user.email", "yousef@invalid"]);
  git(f.receiverClone, ["config", "user.name", "yousef"]);
  const work = options.work ?? ((clone: string) => {
    writeFileSync(join(clone, "result.md"), "the receiver's work\n");
    writeFileSync(join(clone, "task.md"), "step one\nstep two in progress\nstep three done by the receiver\n");
  });
  work(f.receiverClone);
  git(f.receiverClone, ["add", "-A"]);
  git(f.receiverClone, ["commit", "-q", "-m", "receiver work"]);
  const resultCommit = git(f.receiverClone, ["rev-parse", "HEAD"]);

  const offer = (await readPublishedOffer((await f.control.read())!.record, f.control))!;
  await applyControlTransition(f.control, {
    event: "accept_offer", actor: { personId: RECEIVER, workstationId: "yousef-desktop" }, commandId: "b-accept",
    epoch: offer.epoch, roster: [REQUESTER, RECEIVER],
  });
  await applyControlTransition(f.control, {
    event: "preparation_complete", actor: { personId: RECEIVER }, commandId: "b-prepare", epoch: offer.epoch,
    payload: { policyChecked: true, workspaceReserved: true, startIntentDurable: true },
  });
  await applyControlTransition(f.control, {
    event: "run_started", actor: { personId: RECEIVER }, commandId: "b-started", epoch: offer.epoch, payload: { runId: "run-b-1" },
  });
  const result = await returnHandoverWork(f.control, {
    env: f.receiver,
    itemId: f.itemId,
    commandIdPrefix: "b",
    stopReason: options.stopReason ?? "completed",
    resultCommit,
    runId: "run-b-1",
    verification: options.verification ?? ["The receiver ran the suite and it passed."],
    uncertainEffects: options.uncertainEffects,
    push: async () => { git(f.receiverClone, ["push", "-q", f.bare, `HEAD:refs/heads/${branch}`]); },
  });
  return { resultCommit, resultId: result.resultId, label: result.label };
}

/** The whole path up to the record being `RETURNED`, which is where TM-T1-H3 starts. */
async function atReturn(
  f: Fixture,
  options: Parameters<typeof returned>[1] = {},
): Promise<{ baseline: HandoverBaseline; resultCommit: string; resultId: string; label: "full" | "partial" }> {
  const preview = await published(f);
  const result = await returned(f, options);
  return { baseline: preview.context.baseline, ...result };
}

/**
 * The owner's `/close` as the product applies it (H07).
 *
 * `handleTeamGrantedCommand` mints one `close_thread` action for the `/close`
 * text command and for the item card's Close thread button alike, so both entry
 * points arrive here, and the probe is the one `TelegramLiveRuntime` registers:
 * this workstation's own view of the item's control record.
 */
function closeThreadTap(f: Fixture, ref: string): { control: TaskControlService; tap: Parameters<TaskControlService["handleCallback"]>[0] } {
  workspaces.createTaskControlAction({
    ref, action: "close_thread", promptId: f.promptId, actorId: f.env.actorId, chatId: f.groupChat, botId: f.env.botId,
    messageId: `close-card-${ref}`, expectedRevision: workspaces.humanInputState(f.promptId).revision,
    expiresAt: "2099-01-01T00:00:00.000Z", subjectKind: "item", itemId: f.itemId,
  });
  const control = new TaskControlService({
    enabled: true, teamEnabled: true, handoverEnabled: true,
    notificationsEnabled: true, remoteActionsEnabled: true, transport: "fake_telegram", botId: f.env.botId,
  });
  control.registerHandoverStateProbe(async itemId => (await new BareGitControlRecordRemote(f.bare, itemId).read())?.record ?? null);
  return { control, tap: { ref, transportUserId: "9000", chatId: f.groupChat, botId: f.env.botId, messageId: `close-card-${ref}`, commandId: `${ref}-command` } };
}

const state = async (f: Fixture): Promise<ControlRecord> => (await f.control.read())!.record;

/* ========================================================================== */
/* TM-T1-H3, first: apply onto a diverged tree                                 */
/* ========================================================================== */

test("TM-T1-H3: return, review and apply", async (t) => {
  await t.test("Return: the result is on the same branch, the record is RETURNED, and Review, Request changes and Apply are offered", async () => {
    const f = fixture("tm-t1-h3-return");
    try {
      const { resultCommit, resultId } = await atReturn(f);
      const record = await state(f);
      assert.equal(record.state, "RETURNED", "PAUSED to RETURNED, by the executor, through the record");
      assert.equal(record.executor, null, "RETURNED releases the executor");
      assert.equal(record.resultLabel, "full");

      // The result commits are on the same aw/handover/<item> branch, not a new one.
      const branch = handoverBranch(f.itemId);
      assert.equal(git(f.bare, ["rev-parse", `refs/heads/${branch}`]), resultCommit, "result commits are pushed on the same branch");
      assert.deepEqual(
        git(f.bare, ["for-each-ref", "--format=%(refname)", "refs/heads/"]).split("\n").filter(one => one !== ""),
        [`refs/heads/${branch}`], "and no second branch is created");

      const result = (await readReturnedResult(f.control, f.itemId))!;
      assert.equal(result.resultId, resultId, "the Result record carries its own id");
      assert.equal(result.resultCommit, resultCommit);
      assert.equal(result.label, "full");
      assert.deepEqual(result.verification, ["The receiver ran the suite and it passed."], "evidence travels with the result");
      assert.match(result.releaseEvidence, /yousef/, "and so does the executor's release evidence");

      const review = await reviewReturnedResult(f.control, { env: f.env, itemId: f.itemId, baseline: (await atReturnBaseline(f)), capability: CAPABILITY, integrationRoot: f.integrationRoot });
      assert.deepEqual(review.card.offered, ["review", "request_changes", "apply_result"],
        "the requester is offered Review, Request changes and Apply");
      assert.deepEqual(review.card.actions.map(one => one.action).sort(), ["apply_result", "request_changes"],
        "and only the two that change state mint an action; Review is this card's own evidence, not an eighth action");

      const db = database();
      try {
        const row = db.prepare("SELECT bot_id botId,payload_json payload FROM telegram_outbox WHERE id=?").get(review.card.outboxId) as { botId: string; payload: string };
        assert.equal(row.botId, f.env.botId, "the review card is posted by the requester's own bot");
        const payload = JSON.parse(row.payload) as { kind: string; label: string; applyOffered: boolean; verification: string[] };
        assert.equal(payload.kind, "handover_review");
        assert.equal(payload.label, "full");
        assert.equal(payload.applyOffered, true);
        assert.deepEqual(payload.verification, ["The receiver ran the suite and it passed."]);
      } finally { db.close(); }
    } finally { f.dispose(); }
  });

  await t.test("First: an uncommitted divergence alone blocks the apply, which checking only HEAD would miss", async () => {
    const f = fixture("tm-t1-h3-uncommitted");
    try {
      const { baseline } = await atReturn(f);
      const headAtExport = git(f.source, ["rev-parse", "HEAD"]);

      // jd edits his own working tree while the item is claimed, and commits nothing.
      writeFileSync(join(f.source, "notes.md"), "notes\nand an unrelated note jd wrote while waiting\n");

      const comparison = compareWorkspaceBaseline(f.source, baseline);
      assert.equal(git(f.source, ["rev-parse", "HEAD"]), headAtExport, "HEAD has not moved at all");
      assert.equal(comparison.committedDivergence, false, "so a HEAD-only check would see nothing");
      assert.equal(comparison.uncommittedDivergence, true, "but the complete baseline sees the working tree moved");
      assert.equal(comparison.matches, false, "and the comparison as a whole refuses");
      assert.deepEqual(comparison.divergedPaths, ["notes.md"], "naming the file that diverged");

      const review = await reviewReturnedResult(f.control, { env: f.env, itemId: f.itemId, baseline, capability: CAPABILITY, integrationRoot: f.integrationRoot });
      assert.equal(review.merge.clean, true, "Git itself would have merged this cleanly");
      assert.equal(review.applyOffered, false, "yet Apply is not offered, because the workspace no longer matches its baseline");
      assert.deepEqual(review.refusedBecause, ["baseline_diverged"], "and the baseline is the only gate that refuses");
      assert.deepEqual(review.card.offered, ["review", "request_changes"], "so the phone shows no Apply to tap");
      assert.equal(review.card.actions.some(one => one.action === "apply_result"), false, "and mints no apply action");
      assert.match(review.reason, /uncommitted changes since export in notes\.md/);

      const before = observeWorkspace(f.source);
      const applied = await applyReturnedResult(f.control, {
        env: f.env, itemId: f.itemId, baseline, commandId: "a-apply", acceptance: { met: true },
        capability: CAPABILITY, integrationRoot: f.integrationRoot,
      });
      assert.equal(applied.kind, "blocked", "and applying anyway is refused");
      assert.equal(applied.merged, false, "no merge happened");
      assert.deepEqual(observeWorkspace(f.source), before, "jd's HEAD, index and working tree are exactly as they were");
      assert.equal(readFileSync(join(f.source, "notes.md"), "utf8"), "notes\nand an unrelated note jd wrote while waiting\n",
        "the unrelated change is not overwritten");
      assert.equal((await state(f)).state, "APPLYING", "the record does not advance past APPLYING on the failed attempt");
      assert.equal(workspaces.promptOutcome(f.promptId).status !== "DONE", true, "and the task is not completed");
    } finally { f.dispose(); }
  });

  await t.test("First: a committed and an uncommitted divergence together stop in Git's own conflict state", async () => {
    const f = fixture("tm-t1-h3-conflict");
    try {
      const { baseline } = await atReturn(f);

      // jd's checkout moved on, both ways: a commit that touches the same file
      // the receiver touched, and an uncommitted edit on top.
      writeFileSync(join(f.source, "task.md"), "step one\nstep two rewritten by jd\n");
      git(f.source, ["add", "task.md"]);
      git(f.source, ["commit", "-q", "-m", "jd carried on"]);
      const headAfterCommit = git(f.source, ["rev-parse", "HEAD"]);
      writeFileSync(join(f.source, "notes.md"), "notes\nand more\n");

      const comparison = compareWorkspaceBaseline(f.source, baseline);
      assert.equal(comparison.committedDivergence, true, "HEAD moved");
      assert.equal(comparison.uncommittedDivergence, true, "and so did the working tree");

      const review = await reviewReturnedResult(f.control, { env: f.env, itemId: f.itemId, baseline, capability: CAPABILITY, integrationRoot: f.integrationRoot });
      assert.equal(review.merge.clean, false, "Git cannot complete this merge");
      assert.deepEqual(review.merge.conflictPaths, ["task.md"], "and names the conflicted path itself");
      assert.equal(review.applyOffered, false, "so Apply is not offered; a moved checkout shows as a conflict, not a silent overwrite");
      assert.deepEqual(review.refusedBecause, ["baseline_diverged", "merge_conflict"],
        "and both gates refuse independently: Apply is offered only when the merge is clean, as well as when the baseline matches");
      assert.match(review.reason, /conflict/i);

      const checkout = review.merge.integrationCheckout;
      assert.equal(typeof checkout, "string", "the merge was attempted in an isolated integration checkout");
      assert.equal(checkout!.startsWith(f.integrationRoot), true, "which is not the original workspace");
      assert.match(readFileSync(join(checkout!, "task.md"), "utf8"), /^<{7} /m,
        "and it is left in Git's own conflict state, markers and all, rather than resolved automatically");
      assert.equal(git(checkout!, ["diff", "--name-only", "--diff-filter=U"]), "task.md", "with Git's own unmerged path list");

      const before = observeWorkspace(f.source);
      const applied = await applyReturnedResult(f.control, {
        env: f.env, itemId: f.itemId, baseline, commandId: "a-apply", acceptance: { met: true },
        capability: CAPABILITY, integrationRoot: f.integrationRoot,
      });
      assert.equal(applied.kind, "blocked");
      if (applied.kind !== "blocked") return;
      assert.deepEqual(applied.merge.conflictPaths, ["task.md"], "the apply says so with Git's own conflict list");
      assert.equal(git(f.source, ["rev-parse", "HEAD"]), headAfterCommit, "jd's HEAD is untouched");
      assert.deepEqual(observeWorkspace(f.source), before, "and so are his index and working tree");
      assert.equal(git(f.source, ["status", "--porcelain=v1", "-uall"]).includes("UU"), false, "the original is not left conflicted");
      assert.equal((await state(f)).state, "APPLYING", "the record does not advance past APPLYING");
      assert.equal(git(f.bare, ["rev-parse", `refs/heads/${handoverBranch(f.itemId)}`]) !== "", true);
      assert.equal(tryGit(f.bare, ["rev-parse", "--verify", "-q", "refs/heads/work"]).status, 1,
        "nothing is pushed to a product branch");
    } finally { f.dispose(); }
  });

  await t.test("First: a protected product branch is never merged into automatically", async () => {
    const f = fixture("tm-t1-h3-protected");
    try {
      const { baseline } = await atReturn(f);
      git(f.source, ["branch", "-m", "work", "main"]);

      const review = await reviewReturnedResult(f.control, { env: f.env, itemId: f.itemId, baseline, capability: CAPABILITY, integrationRoot: f.integrationRoot });
      assert.equal(review.applyOffered, false, "Apply is not offered on a protected product branch");
      assert.deepEqual(review.refusedBecause, ["protected_branch"],
        "the baseline matches and the merge is clean, and Apply is still withheld");
      assert.match(review.reason, /protected product branch/);

      await assert.rejects(
        () => applyReturnedResult(f.control, {
          env: f.env, itemId: f.itemId, baseline, commandId: "a-apply", acceptance: { met: true },
          capability: CAPABILITY, integrationRoot: f.integrationRoot,
        }),
        (error: unknown) => error instanceof WorkspaceError && error.code === "protected_branch",
      );
      assert.equal((await state(f)).state, "RETURNED", "and nothing is claimed for it");
    } finally { f.dispose(); }
  });

  /* ======================================================================== */
  /* TM-T1-H3, third: apply clean                                              */
  /* ======================================================================== */

  await t.test("Third: an undiverged checkout applies by ordinary merge, completes the task and releases the hold", async () => {
    const f = fixture("tm-t1-h3-clean");
    try {
      const { baseline, resultCommit, resultId } = await atReturn(f);
      assert.equal(handoverPipelineHold(f.itemId, await state(f)).held, true,
        "jd's own pipeline hold survives the return: RETURNED releases the executor, not the hold");

      const review = await reviewReturnedResult(f.control, { env: f.env, itemId: f.itemId, baseline, capability: CAPABILITY, integrationRoot: f.integrationRoot });
      assert.equal(review.applyOffered, true);
      assert.deepEqual(review.refusedBecause, [], "no gate refuses");
      assert.equal(review.merge.fastForward, true, "an undiverged checkout fast-forwards");

      const outboxBefore = database().prepare("SELECT COUNT(*) n FROM telegram_outbox").get() as { n: number };
      const applied = await applyReturnedResult(f.control, {
        env: f.env, itemId: f.itemId, baseline, commandId: "a-apply", acceptance: { met: true },
        capability: CAPABILITY, integrationRoot: f.integrationRoot,
      });
      assert.equal(applied.kind, "applied");
      if (applied.kind !== "applied") return;
      assert.equal(applied.merged, true);
      assert.equal(applied.receipt.resultId, resultId, "RESULT_APPLIED carries the same result id");
      assert.equal(applied.receipt.fastForward, true);
      assert.equal(applied.taskCompleted, true);
      assert.equal(applied.pipelineHoldReleased, true);

      // The files really are jd's now, and the ignored file was never touched.
      assert.equal(git(f.source, ["rev-parse", "HEAD"]), resultCommit, "the merge fast-forwarded jd's own branch");
      assert.equal(git(f.source, ["rev-parse", "--abbrev-ref", "HEAD"]), "work", "in jd's own checkout, on his own branch");
      assert.equal(readFileSync(join(f.source, "result.md"), "utf8"), "the receiver's work\n");
      assert.match(readFileSync(join(f.source, "task.md"), "utf8"), /step three done by the receiver/);
      assert.equal(readFileSync(join(f.source, "staged.md"), "utf8"), "staged work\n", "jd's staged work survived, inside the result");
      assert.equal(readFileSync(join(f.source, "untracked.md"), "utf8"), "scratch\n", "and so did his untracked work");
      assert.equal(readFileSync(join(f.source, "secrets.log"), "utf8"), "ignored and never published\n", "the ignored file is left alone");
      assert.equal(git(f.source, ["status", "--porcelain=v1"]), "", "and the checkout is clean afterwards");

      const record = await state(f);
      assert.equal(record.state, "COMPLETED", "APPLYING to COMPLETED, once acceptance is met");
      assert.equal(workspaces.promptOutcome(f.promptId).status, "DONE", "the task completes");
      assert.equal(handoverPipelineHold(f.itemId, record).held, false, "and the pipeline hold is released");

      const intent = readApplyIntent(f.itemId)!;
      assert.equal(intent.receipt !== null, true, "the application is recorded");
      assert.equal(intent.filesDone, true, "with APPLY_FILES_DONE recorded before the bookkeeping");
      assert.equal(intent.receipt!.observedTarget.worktreeTree, intent.target.tree, "and the observed target hashes recorded");
      assert.equal(git(f.source, ["rev-parse", "--verify", intent.preRef]), intent.preSnapshot,
        "a recoverable pre-apply snapshot is retained");
      assert.equal(git(f.source, ["rev-parse", `${intent.preSnapshot}^{tree}`]), intent.pre.worktreeTree,
        "and it holds the pre-apply working tree");

      const outboxAfter = database().prepare("SELECT COUNT(*) n FROM telegram_outbox").get() as { n: number };
      assert.equal(outboxAfter.n, outboxBefore.n,
        "the application writes no Telegram row at all, so a close or edit failure afterwards cannot roll it back");
    } finally { f.dispose(); }
  });

  await t.test("Third: acceptance is the requester's own decision and is never read off the result's label", async () => {
    const f = fixture("tm-t1-h3-acceptance");
    try {
      const { baseline } = await atReturn(f, { verification: [] });
      const review = await reviewReturnedResult(f.control, { env: f.env, itemId: f.itemId, baseline, capability: CAPABILITY, integrationRoot: f.integrationRoot });
      assert.equal(review.result.label, "full", "the receiver stopped with a completed run");
      assert.equal(review.evidenceMissing, true, "but it carries no evidence, and a DONE statement without evidence is not acceptance");
      assert.equal(review.applyOffered, true, "review and apply may still accept it; the requester decides");

      const applied = await applyReturnedResult(f.control, {
        env: f.env, itemId: f.itemId, baseline, commandId: "a-apply", acceptance: { met: false },
        capability: CAPABILITY, integrationRoot: f.integrationRoot,
      });
      assert.equal(applied.kind, "applied");
      if (applied.kind !== "applied") return;
      assert.equal(applied.taskCompleted, false, "acceptance was not met, so the task is not completed");
      assert.equal((await state(f)).state, "PAUSED", "and the application stays resumable");
      assert.equal(workspaces.promptOutcome(f.promptId).status, "TODO");
    } finally { f.dispose(); }
  });

  await t.test("Third: the baseline is rechecked immediately before the original moves, not once at the start", async () => {
    const f = fixture("tm-t1-h3-recheck");
    try {
      const { baseline } = await atReturn(f);
      const review = await reviewReturnedResult(f.control, { env: f.env, itemId: f.itemId, baseline, capability: CAPABILITY, integrationRoot: f.integrationRoot });
      assert.equal(review.applyOffered, true, "Apply was genuinely offered: the workspace matched when it was reviewed");

      // jd saves a file while the apply is in flight, after APPLYING has been
      // claimed and the merge has been probed against a workspace that matched.
      let before: ReturnType<typeof observeWorkspace> | null = null;
      const applied = await applyReturnedResult(f.control, {
        env: f.env, itemId: f.itemId, baseline, commandId: "a-apply", acceptance: { met: true },
        capability: CAPABILITY, integrationRoot: f.integrationRoot,
        hooks: { beforeMerge: () => {
          writeFileSync(join(f.source, "untracked.md"), "scratch, edited mid-apply\n");
          before = observeWorkspace(f.source);
        } },
      });
      assert.equal(applied.kind, "blocked", "the recheck catches it and the original is kept unchanged");
      if (applied.kind !== "blocked") return;
      assert.equal(applied.merged, false);
      assert.deepEqual(applied.baseline.divergedPaths, ["untracked.md"], "naming what moved under it");
      assert.deepEqual(observeWorkspace(f.source), before, "jd's own save is not overwritten");
      assert.equal(readFileSync(join(f.source, "untracked.md"), "utf8"), "scratch, edited mid-apply\n");
      assert.equal(existsSync(join(f.source, "result.md")), false, "and nothing of the result reached the workspace");
      assert.equal((await state(f)).state, "APPLYING", "the record does not advance past APPLYING");
      assert.equal(workspaces.promptOutcome(f.promptId).status !== "DONE", true);
    } finally { f.dispose(); }
  });

  /* ======================================================================== */
  /* TM-T1-H3, second: idempotency and restart                                 */
  /* ======================================================================== */

  await t.test("Second: a second Apply returns the first receipt and performs no second merge (B27)", async () => {
    const f = fixture("tm-t1-h3-idempotent");
    try {
      const { baseline } = await atReturn(f);
      const first = await applyReturnedResult(f.control, {
        env: f.env, itemId: f.itemId, baseline, commandId: "a-apply", acceptance: { met: true },
        capability: CAPABILITY, integrationRoot: f.integrationRoot,
      });
      assert.equal(first.kind, "applied");
      if (first.kind !== "applied") return;
      const head = git(f.source, ["rev-parse", "HEAD"]);
      const reflog = git(f.source, ["reflog", "--format=%gs"]).split("\n").length;

      // A second tap, with its own command id, as a duplicate callback delivery
      // or a second card would produce.
      const second = await applyReturnedResult(f.control, {
        env: f.env, itemId: f.itemId, baseline, commandId: "a-apply-again", acceptance: { met: true },
        capability: CAPABILITY, integrationRoot: f.integrationRoot,
      });
      assert.equal(second.kind, "already_applied", "the second Apply is idempotent");
      if (second.kind !== "already_applied") return;
      assert.equal(second.merged, false, "no second merge happens");
      assert.deepEqual(second.receipt, first.receipt, "and the first receipt is what comes back");
      assert.equal(git(f.source, ["rev-parse", "HEAD"]), head, "jd's HEAD did not move again");
      assert.equal(git(f.source, ["reflog", "--format=%gs"]).split("\n").length, reflog, "and Git recorded no second update");
      assert.equal((await state(f)).state, "COMPLETED", "the record is where the first application left it");
    } finally { f.dispose(); }
  });

  await t.test("Second: a restart with the target present finishes the bookkeeping without applying again", async () => {
    const f = fixture("tm-t1-h3-restart");
    try {
      const { baseline, resultId } = await atReturn(f);
      // The crash: the files move, APPLY_FILES_DONE is written, and the process
      // dies before acceptance, the pipeline and RESULT_APPLIED are recorded.
      await assert.rejects(() => applyReturnedResult(f.control, {
        env: f.env, itemId: f.itemId, baseline, commandId: "a-apply", acceptance: { met: true },
        capability: CAPABILITY, integrationRoot: f.integrationRoot,
        hooks: { afterFilesDone: () => { throw new Error("the workstation restarted"); } },
      }));
      const torn = readApplyIntent(f.itemId)!;
      assert.equal(torn.filesDone, true, "APPLY_FILES_DONE is on disk");
      assert.equal(torn.receipt, null, "RESULT_APPLIED is not");
      assert.equal((await state(f)).state, "APPLYING", "and the record is mid-application");
      assert.equal(workspaces.promptOutcome(f.promptId).status !== "DONE", true, "with the task not yet accepted");
      const head = git(f.source, ["rev-parse", "HEAD"]);

      const recovered = await recoverApplyIntent(f.control, { env: f.env, itemId: f.itemId });
      assert.equal(recovered.kind, "finished_bookkeeping", "the target is present, so the bookkeeping is finished");
      if (recovered.kind !== "finished_bookkeeping") return;
      assert.equal(recovered.merged, false, "and nothing is applied again");
      assert.equal(recovered.receipt.resultId, resultId);
      assert.equal(git(f.source, ["rev-parse", "HEAD"]), head, "jd's HEAD did not move during recovery");
      assert.equal(recovered.record.state, "COMPLETED");
      assert.equal(workspaces.promptOutcome(f.promptId).status, "DONE");

      const again = await recoverApplyIntent(f.control, { env: f.env, itemId: f.itemId });
      assert.equal(again.kind, "already_applied", "and a second recovery returns the receipt rather than repeating it");
    } finally { f.dispose(); }
  });

  await t.test("Second: a restart onto a partial or unknown tree requires recovery rather than a destructive retry", async () => {
    const f = fixture("tm-t1-h3-torn");
    try {
      const { baseline } = await atReturn(f);
      await assert.rejects(() => applyReturnedResult(f.control, {
        env: f.env, itemId: f.itemId, baseline, commandId: "a-apply", acceptance: { met: true },
        capability: CAPABILITY, integrationRoot: f.integrationRoot,
        hooks: { afterFilesDone: () => { throw new Error("the workstation restarted"); } },
      }));
      // The tree is then neither the pre-apply state nor the target: half a
      // restore, a stray editor save, an interrupted checkout.
      rmSync(join(f.source, "result.md"));
      const head = git(f.source, ["rev-parse", "HEAD"]);

      const recovered = await recoverApplyIntent(f.control, { env: f.env, itemId: f.itemId });
      assert.equal(recovered.kind, "recovery_required", "a partial or unknown tree requires recovery");
      if (recovered.kind !== "recovery_required") return;
      assert.match(recovered.reason, /partial or unknown/);
      assert.match(recovered.reason, new RegExp(recovered.intent.preRef.replace(/\//g, "\\/")), "and points at the retained pre-apply snapshot");
      assert.equal(git(f.source, ["rev-parse", "HEAD"]), head, "nothing destructive was retried");
      assert.equal(existsSync(join(f.source, "result.md")), false, "the tree is left exactly as it was found");
      assert.equal((await state(f)).state, "APPLYING", "and the pipeline is not advanced");
      assert.equal(workspaces.promptOutcome(f.promptId).status !== "DONE", true);
      assert.equal(readApplyIntent(f.itemId)!.receipt, null, "no receipt is invented");
    } finally { f.dispose(); }
  });

  await t.test("Second: an untouched tree after a restart is known, not unknown, and is safe to apply again", async () => {
    const f = fixture("tm-t1-h3-pre-intact");
    try {
      const { baseline } = await atReturn(f);
      const pre = observeWorkspace(f.source);
      await applyReturnedResult(f.control, {
        env: f.env, itemId: f.itemId, baseline, commandId: "a-apply", acceptance: { met: true },
        capability: CAPABILITY, integrationRoot: f.integrationRoot,
      });
      // Rewind the workspace to exactly its pre-apply state, as a restore from
      // the retained snapshot would.
      const intent = readApplyIntent(f.itemId)!;
      git(f.source, ["reset", "--hard", "-q", intent.pre.head]);
      git(f.source, ["checkout", "-q", intent.preSnapshot, "--", "."]);
      git(f.source, ["reset", "-q", intent.pre.head]);
      writeFileSync(join(f.source, "secrets.log"), "ignored and never published\n");
      git(f.source, ["add", "staged.md"]);
      assert.deepEqual(observeWorkspace(f.source), pre, "the workspace is the pre-apply state again");

      rmSync(join(config.repoRoot, ".agent-console", "handover-apply", `${f.itemId}.json`));
      const restored = { ...intent, receipt: null, filesDone: false };
      mkdirSync(join(config.repoRoot, ".agent-console", "handover-apply"), { recursive: true });
      writeFileSync(join(config.repoRoot, ".agent-console", "handover-apply", `${f.itemId}.json`), JSON.stringify(restored), "utf8");

      const recovered = await recoverApplyIntent(f.control, { env: f.env, itemId: f.itemId });
      assert.equal(recovered.kind, "pre_intact", "an untouched tree is a known state, not an unknown one");
    } finally { f.dispose(); }
  });

  /* ======================================================================== */
  /* TM-T1-H3, fourth: applying a partial result                               */
  /* ======================================================================== */

  await t.test("Fourth: a partial result can be applied but can never be labelled complete", async () => {
    const f = fixture("tm-t1-h3-partial");
    try {
      const { baseline, label } = await atReturn(f, { stopReason: "quota", uncertainEffects: ["A deployment may have started."] });
      assert.equal(label, "partial", "quota is its own stop reason and the result is labelled partial");
      assert.equal((await state(f)).resultLabel, "partial");

      const review = await reviewReturnedResult(f.control, { env: f.env, itemId: f.itemId, baseline, capability: CAPABILITY, integrationRoot: f.integrationRoot });
      assert.equal(review.applyOffered, true, "a partial result is still applicable");
      assert.deepEqual(review.result.uncertainEffects, ["A deployment may have started."],
        "and its uncertain external effects stay separate from any claimed completion");

      // Even with the requester saying acceptance is met, a partial result
      // cannot complete the task.
      const applied = await applyReturnedResult(f.control, {
        env: f.env, itemId: f.itemId, baseline, commandId: "a-apply", acceptance: { met: true },
        capability: CAPABILITY, integrationRoot: f.integrationRoot,
      });
      assert.equal(applied.kind, "applied");
      if (applied.kind !== "applied") return;
      assert.equal(applied.label, "partial");
      assert.equal(applied.taskCompleted, false, "applying a partial result is never labelled complete");
      assert.equal(applied.receipt.taskCompleted, false);

      const record = await state(f);
      assert.equal(record.state, "PAUSED", "applying a partial result leaves the source owning a PAUSED task");
      assert.equal(workspaces.promptOutcome(f.promptId).status, "TODO", "which is resumable locally");
      assert.equal(readFileSync(join(f.source, "result.md"), "utf8"), "the receiver's work\n", "while the usable work is applied");
      assert.match(workspaces.promptOutcome(f.promptId).result, /Uncertain external effect: A deployment may have started\./);
      assert.equal(handoverPipelineHold(f.itemId, record).held, false, "and the hold is released by the application");
    } finally { f.dispose(); }
  });

  /* ======================================================================== */
  /* TM-T1-H3, fifth: request changes                                          */
  /* ======================================================================== */

  await t.test("Fifth: Request changes opens a new epoch and a fresh open call", async () => {
    const f = fixture("tm-t1-h3-changes");
    try {
      const preview = await published(f);
      const before = await state(f);
      await returned(f);
      const returnedEpoch = (await state(f)).epoch;

      const changed = await requestHandoverChanges(f.control, {
        env: f.env, itemId: f.itemId, commandId: "a-changes", requirementsRevision: "rev-2",
        packageHash: preview.packageHash, snapshotCommit: preview.snapshotCommit,
        provider: PROVIDER, model: MODEL, capability: CAPABILITY,
        verifyBranch: async () => true,
      });
      assert.equal(changed.record.state, "OFFERED", "RETURNED back to OFFERED");
      assert.equal(changed.epoch, returnedEpoch + 1, "at a new epoch");
      assert.equal(changed.receiver, null, "and the fresh offer names no receiver");
      assert.equal(changed.record.executor, null);
      assert.equal(before.epoch, 1);

      const offer = await readPublishedOffer(changed.record, f.control);
      assert.equal(offer !== null, true, "the new offer is discoverable by any available teammate");
      assert.equal(offer!.receiver, null);
      assert.equal(offer!.epoch, changed.epoch);

      // A command bound to the previous epoch can never become valid again.
      await assert.rejects(
        () => applyControlTransition(f.control, {
          event: "accept_offer", actor: { personId: RECEIVER }, commandId: "b-accept-stale",
          epoch: returnedEpoch, roster: [REQUESTER, RECEIVER],
        }),
        (error: unknown) => error instanceof WorkspaceError && error.code === "control_stale_epoch",
      );
      // Including the one who declined the previous round: the open call is open.
      const accepted = await applyControlTransition(f.control, {
        event: "accept_offer", actor: { personId: RECEIVER }, commandId: "b-accept-2",
        epoch: changed.epoch, roster: [REQUESTER, RECEIVER],
      });
      assert.equal(accepted.record.state, "CLAIMED");
    } finally { f.dispose(); }
  });

  /* ======================================================================== */
  /* TM-T1-H3, sixth: refusals, offline and the thread                         */
  /* ======================================================================== */

  await t.test("Sixth: Apply on an item closed by /close is refused, because a closed item accepts no action (F02)", async () => {
    const f = fixture("tm-t1-h3-closed");
    try {
      const { baseline } = await atReturn(f);
      const before = observeWorkspace(f.source);
      assert.equal(workspaces.closeItemLink({ itemId: f.itemId, commandId: "a-close" }), true);

      for (const attempt of [
        () => reviewReturnedResult(f.control, { env: f.env, itemId: f.itemId, baseline, capability: CAPABILITY, integrationRoot: f.integrationRoot }),
        () => applyReturnedResult(f.control, {
          env: f.env, itemId: f.itemId, baseline, commandId: "a-apply", acceptance: { met: true },
          capability: CAPABILITY, integrationRoot: f.integrationRoot,
        }),
        () => requestHandoverChanges(f.control, {
          env: f.env, itemId: f.itemId, commandId: "a-changes", requirementsRevision: "rev-2",
          packageHash: "pkg", snapshotCommit: "0".repeat(40), provider: PROVIDER, capability: CAPABILITY,
          verifyBranch: async () => true,
        }),
      ]) {
        await assert.rejects(attempt, (error: unknown) => error instanceof WorkspaceError && error.code === "item_closed" && error.status === 409);
      }
      assert.deepEqual(observeWorkspace(f.source), before, "nothing is merged into a closed item's workspace");
      assert.equal((await state(f)).state, "RETURNED", "and the record is untouched; reopening is a new item");
    } finally { f.dispose(); }
  });

  /*
   * H07, ruling 7 of 2026-09-22 (handover-rules.md section 4.5 and section 8).
   *
   * Refusing to *apply* to a closed item, which the test above covers, is not
   * enough on its own: the damage happens one step earlier. Closing while the
   * receiver's work is back and unapplied revokes the grants and ends the item,
   * and the apply refusal above then guarantees that work can never land. That
   * is the data loss, and this row is the whole path a person walks to it:
   * `/close` on the item's thread, the card it mints, and the tap.
   */
  await t.test("Sixth: /close while returned work is unapplied is refused, and the receiver's work survives (H07)", async () => {
    const f = fixture("tm-t1-h7-close-returned");
    try {
      const { baseline } = await atReturn(f);
      const before = observeWorkspace(f.source);
      workspaces.grantItemCapability({ itemId: f.itemId, personId: RECEIVER, capability: "context", commandId: "a-grant" });
      assert.equal((await state(f)).state, "RETURNED", "the receiver's work is back and nobody has applied it");

      // The owner's `/close`, from the text a person types to the tap that
      // applies it. `/close` parses to the owner-only close command, which
      // `handleTeamGrantedCommand` mints as exactly this `close_thread` action
      // (runtime.ts), so the button and the text command converge here.
      assert.deepEqual(parseTeamItemGrantedCommand("/close", "jd_bot"), { command: "close" },
        "the text command a person types is the owner's close");
      const closing = closeThreadTap(f, "h07-close-returned");
      const receipt = await closing.control.handleCallback(closing.tap);

      assert.equal(receipt.state, "REJECTED", "the close is refused while the handover is live");
      assert.equal(receipt.errorCode, "handover_live");
      assert.match(receipt.message ?? "", /live handover/, "and the reason names the live handover");
      assert.match(receipt.message ?? "", new RegExp(f.itemId), "by item");
      assert.match(receipt.message ?? "", /work returned on .* has not been applied/, "says what is at stake");
      assert.match(receipt.message ?? "", /Apply the returned work or cancel the handover first/,
        "and says what the owner must do instead");

      // Nothing the close would have destroyed was touched.
      assert.equal(workspaces.itemLink(f.itemId)!.closedAt, null, "the item is not closed");
      assert.equal(workspaces.hasItemCapability(f.itemId, RECEIVER, "context"), true, "and no grant was revoked");
      assert.equal((await state(f)).state, "RETURNED", "the record is exactly where it was");
      assert.deepEqual(observeWorkspace(f.source), before, "and the owner's own checkout is untouched");

      // The path back the close would have destroyed is still open.
      const applied = await applyReturnedResult(f.control, {
        env: f.env, itemId: f.itemId, baseline, commandId: "a-apply-after-refusal", acceptance: { met: true },
        capability: CAPABILITY, integrationRoot: f.integrationRoot,
      });
      assert.equal(applied.kind, "applied", "the owner can still apply the work the close would have discarded");
      assert.equal(readFileSync(join(f.source, "result.md"), "utf8"), "the receiver's work\n",
        "and the receiver's work is in the requester's checkout");
    } finally { f.dispose(); }
  });

  await t.test("Sixth: /close is allowed again once the handover is over, and still refused while it is only offered (H07)", async () => {
    const f = fixture("tm-t1-h7-close-states");
    try {
      const { baseline } = await atReturn(f);
      workspaces.grantItemCapability({ itemId: f.itemId, personId: RECEIVER, capability: "context", commandId: "a-grant" });

      // OFFERED: nobody holds it, but the offer is live and any teammate can
      // still accept, so the owner withdraws it rather than closing over it.
      await requestHandoverChanges(f.control, {
        env: f.env, itemId: f.itemId, commandId: "a-changes", requirementsRevision: "rev-2",
        packageHash: "pkg", snapshotCommit: (await readReturnedResult(f.control, f.itemId))!.resultCommit,
        provider: PROVIDER, model: MODEL, capability: CAPABILITY, verifyBranch: async () => true,
      });
      assert.equal((await state(f)).state, "OFFERED");
      const offered = closeThreadTap(f, "h07-close-offered");
      const refusedWhileOffered = await offered.control.handleCallback(offered.tap);
      assert.equal(refusedWhileOffered.errorCode, "handover_live", "an open offer is a live handover");
      assert.match(refusedWhileOffered.message ?? "", /Withdraw the offer first/);
      assert.equal(workspaces.itemLink(f.itemId)!.closedAt, null);

      // WITHDRAWN: the offer is gone and nobody's work is outstanding, so the
      // close the owner was told to make instead is the one that works.
      await applyControlTransition(f.control, {
        event: "withdraw_offer", actor: { personId: REQUESTER, workstationId: "jd-laptop" },
        commandId: "a-withdraw", epoch: (await state(f)).epoch, roster: [REQUESTER, RECEIVER],
      });
      assert.equal((await state(f)).state, "WITHDRAWN");
      const closing = closeThreadTap(f, "h07-close-withdrawn");
      const closed = await closing.control.handleCallback(closing.tap);
      assert.equal(closed.state, "APPLIED", "with no live handover the close applies as it always did");
      assert.equal(closed.message, "Thread closed; grants ended.");
      assert.equal(workspaces.itemLink(f.itemId)!.closedAt !== null, true, "the thread is closed");
      assert.equal(workspaces.hasItemCapability(f.itemId, RECEIVER, "context"), false, "and the grants ended with it");
      assert.equal(baseline.head.length > 0, true);
    } finally { f.dispose(); }
  });

  await t.test("Sixth: with env A stopped the completion report is readable at once and Apply waits (D01, B28)", async () => {
    const f = fixture("tm-t1-h3-offline");
    try {
      // env A does nothing at all between the publish and here: no poll, no card.
      const { resultCommit } = await atReturn(f);
      const record = await state(f);
      const result = (await readReturnedResult(f.control, f.itemId))!;
      assert.equal(result.resultCommit, resultCommit, "the completion report is visible the moment env A reads the record");
      assert.equal(record.state, "RETURNED");
      assert.equal(readApplyIntent(f.itemId), null, "and nothing was applied while env A was stopped: Apply waits for it");
      assert.equal(handoverPipelineHold(f.itemId, record).held, true, "jd's pipeline hold survives the return");

      // B28: closing or leaving the Telegram thread completes, cancels and
      // reassigns nothing.
      const db = database();
      try {
        db.prepare("DELETE FROM telegram_thread WHERE chat_id=?").run(f.groupChat);
      } finally { db.close(); }
      const after = await state(f);
      assert.equal(after.state, "RETURNED", "the record is exactly where it was");
      assert.equal(after.epoch, record.epoch);
      assert.equal(after.executor, null);
      assert.equal(workspaces.promptOutcome(f.promptId).status !== "DONE", true, "nothing completed");
    } finally { f.dispose(); }
  });

  await t.test("Sixth: a handover tap routes only behind Team and handover, both off by default", async () => {
    const f = fixture("tm-t1-h3-gate");
    try {
      const { baseline } = await atReturn(f);
      const review = await reviewReturnedResult(f.control, { env: f.env, itemId: f.itemId, baseline, capability: CAPABILITY, integrationRoot: f.integrationRoot });
      const applyRef = review.card.actions.find(one => one.action === "apply_result")!.ref;
      const actor = workspaces.taskControlActorById(f.env.actorId)!;
      const service = (teamEnabled: boolean, handoverEnabled: boolean) => new TaskControlService({
        enabled: true, teamEnabled, handoverEnabled,
        notificationsEnabled: true, remoteActionsEnabled: true,
        transport: "fake_telegram", botId: f.env.botId,
      });
      const tap = (commandId: string) => ({
        ref: applyRef, transportUserId: actor.transport_user_id, chatId: actor.chat_id,
        topicId: null, botId: f.env.botId, messageId: `handover-review-${f.itemId}`, commandId,
      });

      const teamOff = await service(false, true).handleCallback(tap("gate-team-off"));
      assert.equal(teamOff.errorCode, "team_disabled", "Team disabled answers 403 and stops the card applying");
      const handoverOff = await service(true, false).handleCallback(tap("gate-handover-off"));
      assert.equal(handoverOff.errorCode, "handover_disabled");

      // With both on, the tap is decoded as a handover tap and reaches the runtime.
      let seen: { action: string; itemId: string } | null = null;
      const routed = service(true, true);
      routed.registerHandoverTapHandler(async tapped => {
        seen = { action: tapped.action, itemId: tapped.itemId };
        return workspaces.recordTaskControlReceipt({
          commandId: tapped.commandId, actionRef: tapped.actionRef, state: "APPLIED", message: "Applied.",
        });
      });
      const on = await routed.handleCallback(tap("gate-on"));
      assert.equal(on.state, "APPLIED");
      assert.deepEqual(seen, { action: "apply_result", itemId: f.itemId }, "the review card's tap routes as a handover tap");
      assert.equal((await state(f)).state, "RETURNED", "and a refused tap leaves the record untouched");

      for (const attempt of [
        () => reviewReturnedResult(f.control, { env: f.env, itemId: f.itemId, baseline, capability: { teamEnabled: true, handoverEnabled: false }, integrationRoot: f.integrationRoot }),
        () => applyReturnedResult(f.control, {
          env: f.env, itemId: f.itemId, baseline, commandId: "a-apply-off", acceptance: { met: true },
          capability: { teamEnabled: false, handoverEnabled: true }, integrationRoot: f.integrationRoot,
        }),
      ]) {
        await assert.rejects(attempt, (error: unknown) => error instanceof WorkspaceError && error.status === 403);
      }
    } finally { f.dispose(); }
  });

  /* ======================================================================== */
  /* TM-T1-H3, seventh: retention (G04)                                        */
  /* ======================================================================== */

  await t.test("Seventh: the branch is deleted once the item is applied, and the record is kept and still readable", async () => {
    const f = fixture("tm-t1-h3-retention");
    try {
      const { baseline } = await atReturn(f);
      const branch = handoverBranch(f.itemId);

      const early = await deleteHandoverBranch(f.control, { env: f.env, itemId: f.itemId });
      assert.equal(early.deleted, false, "the branch is kept until the item is applied or cancelled");
      assert.equal(tryGit(f.bare, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).status, 0);

      await applyReturnedResult(f.control, {
        env: f.env, itemId: f.itemId, baseline, commandId: "a-apply", acceptance: { met: true },
        capability: CAPABILITY, integrationRoot: f.integrationRoot,
      });
      const deleted = await deleteHandoverBranch(f.control, { env: f.env, itemId: f.itemId });
      assert.equal(deleted.deleted, true, "the requester deletes the branch once the item is applied");
      assert.equal(deleted.recordKept, true);
      assert.equal(tryGit(f.bare, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).status, 1, "the branch is gone");

      const current = await f.control.read();
      assert.equal(current !== null, true, "and the control record is still readable afterwards");
      assert.equal(current!.record.state, "COMPLETED");
      const returnEvent = await f.control.readEvent("b-return");
      assert.equal(returnEvent !== null, true, "with its events kept as the audit trail");
      assert.equal(returnEvent!.event, "return_work");
    } finally { f.dispose(); }
  });

  await t.test("Standing: Team and handover are both off by default", () => {
    assert.equal(settings.team.enabled, false);
    assert.equal(settings.team.handoverEnabled, false);
  });
});

/* ========================================================================== */
/* The baseline comparison and the merge probe, as their own units             */
/* ========================================================================== */

test("TM-T1-H3: the complete baseline and the isolated integration checkout", async (t) => {
  await t.test("The baseline covers HEAD, the index and the working tree, and observing it disturbs none of them", async () => {
    const f = fixture("tm-t1-h3-baseline");
    try {
      const preview = await published(f);
      const baseline = preview.context.baseline;
      assert.equal(baseline.head, git(f.source, ["rev-parse", "HEAD"]));
      assert.deepEqual(baseline.staged, ["staged.md"], "the staged paths are recorded");
      assert.equal(baseline.worktree.includes("task.md"), true, "and so are the working-tree paths");
      assert.equal(/^[0-9a-f]{40}$/.test(baseline.indexTree), true, "the index is recorded as a tree");
      assert.equal(/^[0-9a-f]{40}$/.test(baseline.worktreeTree), true, "and so is the working tree");
      assert.notEqual(baseline.indexTree, baseline.worktreeTree, "they are genuinely different states");

      const indexBefore = readFileSync(join(f.source, ".git/index"));
      const status = git(f.source, ["status", "--porcelain=v1", "-uall"]);
      assert.deepEqual(compareWorkspaceBaseline(f.source, baseline).matches, true);
      assert.equal(readFileSync(join(f.source, ".git/index")).equals(indexBefore), true,
        "comparing the baseline leaves the developer's index byte-identical");
      assert.equal(git(f.source, ["status", "--porcelain=v1", "-uall"]), status, "and their working tree untouched");

      // Each of the three moves on its own, and each is caught.
      writeFileSync(join(f.source, "untracked.md"), "changed scratch\n");
      const worktreeMoved = compareWorkspaceBaseline(f.source, baseline);
      assert.equal(worktreeMoved.committedDivergence, false);
      assert.equal(worktreeMoved.uncommittedDivergence, true, "an untracked file changing is uncommitted divergence");
      assert.deepEqual(worktreeMoved.divergedPaths, ["untracked.md"]);

      writeFileSync(join(f.source, "untracked.md"), "scratch\n");
      git(f.source, ["add", "untracked.md"]);
      const indexMoved = compareWorkspaceBaseline(f.source, baseline);
      assert.equal(indexMoved.matches, false, "staging a file that was already there is still divergence");
      assert.notEqual(indexMoved.observed.indexTree, baseline.indexTree);
      assert.equal(indexMoved.observed.worktreeTree, baseline.worktreeTree, "even though the working tree is identical");
    } finally { f.dispose(); }
  });

  await t.test("An ignored file is never part of the baseline and never blocks an apply", async () => {
    const f = fixture("tm-t1-h3-ignored");
    try {
      const { baseline } = await atReturn(f);
      writeFileSync(join(f.source, "secrets.log"), "a fresh ignored write\n");
      const comparison = compareWorkspaceBaseline(f.source, baseline);
      assert.equal(comparison.matches, true, "an ignored file is outside the baseline, exactly as it was outside the package");

      const applied = await applyReturnedResult(f.control, {
        env: f.env, itemId: f.itemId, baseline, commandId: "a-apply", acceptance: { met: true },
        capability: CAPABILITY, integrationRoot: f.integrationRoot,
      });
      assert.equal(applied.kind, "applied");
      assert.equal(readFileSync(join(f.source, "secrets.log"), "utf8"), "a fresh ignored write\n", "and it survives the merge untouched");
    } finally { f.dispose(); }
  });

  await t.test("The merge probe runs in an isolated worktree, resolves nothing, and leaves no orphan when clean", async () => {
    const f = fixture("tm-t1-h3-probe");
    try {
      const { resultCommit } = await atReturn(f);
      execFileSync("git", ["fetch", "--no-tags", "-q", f.bare, `+refs/heads/${handoverBranch(f.itemId)}:refs/aw/handover/${f.itemId}`], { cwd: f.source });

      const clean = probeResultMerge({ root: f.source, resultCommit, integrationRoot: f.integrationRoot });
      assert.equal(clean.clean, true);
      assert.equal(clean.fastForward, true, "an undiverged checkout fast-forwards, so no checkout is needed at all");
      assert.equal(clean.integrationCheckout, null);
      assert.deepEqual(git(f.source, ["worktree", "list", "--porcelain"]).split("\n").filter(one => one.startsWith("worktree ")).length, 1,
        "and the probe leaves no orphan worktree");

      writeFileSync(join(f.source, "task.md"), "step one\nsomething else entirely\n");
      git(f.source, ["add", "task.md"]);
      git(f.source, ["commit", "-q", "-m", "jd carried on"]);
      const before = observeWorkspace(f.source);
      const status = git(f.source, ["status", "--porcelain=v1", "-uall"]);
      const conflicted = probeResultMerge({ root: f.source, resultCommit, integrationRoot: f.integrationRoot });
      assert.equal(conflicted.clean, false);
      assert.deepEqual(conflicted.conflictPaths, ["task.md"]);
      assert.equal(conflicted.tree, null, "a conflicted merge produces no target");
      assert.deepEqual(observeWorkspace(f.source), before, "and the original checkout is untouched throughout");
      assert.equal(git(f.source, ["status", "--porcelain=v1", "-uall"]), status, "with not one conflicted path in it");
    } finally { f.dispose(); }
  });
});

/** The baseline as capture recorded it, read back from the published package. */
async function atReturnBaseline(f: Fixture): Promise<HandoverBaseline> {
  const branch = handoverBranch(f.itemId);
  const snapshot = git(f.bare, ["rev-parse", `refs/heads/${branch}`]);
  const context = execFileSync("git", ["--git-dir", f.bare, "show", `${snapshot}:.agent-console/handover.json`], { encoding: "utf8" });
  return (JSON.parse(context) as { baseline: HandoverBaseline }).baseline;
}
