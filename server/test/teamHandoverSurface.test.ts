import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProgramRecord, SuiteRecord, PromptRecord } from "@agent-console/shared";
import { updateSettings, settings } from "../src/settings.ts";
import { TaskControlService, type HandoverTap } from "../src/taskControl.ts";
import { mintItemId } from "../src/teamItems.ts";
import type { TeamRoster } from "../src/teamRoster.ts";
import { compareCapabilities } from "../src/teamHandoverRun.ts";
import { applyControlTransition } from "../src/teamControlRecord.ts";
import { formatTelegramMessage } from "../src/integrations/telegram/liveFormat.ts";
import { renderHandoverOfferCard, renderHandoverReviewCard } from "../src/taskControlRenderer.ts";
import { renderTeamItemActionCard } from "../src/teamItemViews.ts";
import {
  HANDOVER_SANDBOX,
  applyItemHandover,
  beginItemHandover,
  controlRemote,
  handoverSurfaceInternals,
  reviewItemHandover,
  requestItemChanges,
  handleHandoverTap,
  knownHandoverRecord,
  listControlItems,
  pollControlRecords,
  previewItemHandover,
  publishItemHandover,
  receiverPolicy,
  requesterEnvironment,
  type SurfaceContext,
} from "../src/teamHandoverSurface.ts";
import { WorkspaceError, workspaces } from "../src/workspaces.ts";

/*
 * The handover surface (H06, gap register C1).
 *
 * The engine was complete and had no caller. These cases assert the three joins
 * this task adds, at the tier where they can be asserted without two app roots:
 * the requester's begin/preview/publish path against a real shared repository,
 * the control-record read that makes a receiver discover an open call without
 * being told an item id, and the tap handler `registerHandoverTapHandler` never
 * had. The two-database half is TM-T1-H1 to TM-T1-H3.
 *
 * Every case restores both settings, because both are false by default and the
 * default-off contract is what the last case here asserts.
 */

const REQUESTER = "jd";
const RECEIVER = "yousef";
const PROVIDER = "claude";

function git(directory: string, args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

interface Fixture {
  itemId: string;
  promptId: number;
  bare: string;
  /** The requester's own checkout: the workspace the item's task lives in. */
  source: string;
  /** The receiver's own clone of the shared remote. */
  clone: string;
  roster: TeamRoster;
  requester: SurfaceContext;
  receiver: SurfaceContext;
  dispose(): void;
}

function fixture(prefix: string): Fixture {
  const itemId = mintItemId();
  const groupChat = `-100${itemId.slice(-10)}`;
  const bare = mkdtempSync(join(tmpdir(), `${prefix}-bare-`));
  const source = mkdtempSync(join(tmpdir(), `${prefix}-src-`));
  const clone = mkdtempSync(join(tmpdir(), `${prefix}-clone-`));
  execFileSync("git", ["init", "--bare", "-q", bare]);

  git(source, ["init", "-q", "-b", "work"]);
  git(source, ["config", "user.email", "jd@invalid"]);
  git(source, ["config", "user.name", "jd"]);
  writeFileSync(join(source, "task.md"), "half finished\n");
  git(source, ["add", "-A"]);
  git(source, ["commit", "-q", "-m", "base"]);
  // The uncommitted work the package carries, so the preview has something to list.
  writeFileSync(join(source, "task.md"), "half finished, then some\n");
  writeFileSync(join(source, "notes.md"), "what is left\n");
  execFileSync("git", ["clone", "-q", bare, clone]);

  const workspace = workspaces.create({ name: `${prefix}-source`, workDirectory: source });
  const receiverWorkspace = workspaces.create({ name: `${prefix}-clone`, workDirectory: clone });
  const program = workspaces.createChild("program", workspace.id, { name: "Team", overview: "" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: "Items", overview: "" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: `Item ${prefix}`, content: "Finish the colour work." }) as PromptRecord;
  workspaces.createItemLink({ itemId, promptId: prompt.id, role: "requester", epoch: 1 });

  const roster: TeamRoster = {
    version: 1,
    teamId: `awt1_${prefix}`,
    groupChatId: groupChat,
    remoteUrl: bare,
    members: [
      { personId: REQUESTER, telegramUserId: "9000", botId: "jd-bot", botUsername: "jd_bot", workstationId: "jd-laptop", workstationLabel: "jd-laptop", personLabel: "jd" },
      { personId: RECEIVER, telegramUserId: "9001", botId: "yousef-bot", botUsername: "yousef_bot", workstationId: "yousef-desktop", workstationLabel: "yousef-desktop", personLabel: "Yousef" },
    ],
    usedInviteIds: [],
    commandIds: [],
    updatedAt: new Date().toISOString(),
  };
  for (const member of roster.members) {
    workspaces.upsertTeamGroupActor({
      id: `fake-tg-${member.personId}-group-${itemId}`,
      transport: "telegram",
      transportUserId: member.telegramUserId,
      chatId: groupChat,
      label: member.personLabel,
    });
  }

  return {
    itemId,
    promptId: prompt.id,
    bare,
    source,
    clone,
    roster,
    requester: { roster, botId: "jd-bot", providers: [PROVIDER] },
    receiver: { roster, botId: "yousef-bot", providers: [PROVIDER] },
    dispose() {
      for (const entry of workspaces.list()) {
        if (entry.id === workspace.id || entry.id === receiverWorkspace.id) workspaces.remove(entry.id);
      }
      for (const directory of [bare, source, clone]) rmSync(directory, { recursive: true, force: true });
    },
  };
}

function enable(): void {
  updateSettings({ "team.enabled": true, "team.handoverEnabled": true });
}

function disable(): void {
  updateSettings({ "team.enabled": false, "team.handoverEnabled": false });
}

/** Env A's whole requester path through the surface, as the routes drive it. */
async function offered(f: Fixture) {
  await beginItemHandover(f.requester, f.itemId);
  const preview = await previewItemHandover(f.requester, f.itemId, { provider: PROVIDER });
  const published = await publishItemHandover(f.requester, f.itemId, {
    confirmations: ["publish"],
    acknowledgedBytes: preview.totalBytes,
  });
  return { preview, ...published };
}

test("C1: the requester's route path captures, publishes and leaves an open call on the shared remote", async () => {
  enable();
  const f = fixture("surface-publish");
  try {
    const { preview, offer, record } = await offered(f);

    // The preview is what TM-T0-7 requires a requester to see before anything
    // is pushed: every uncommitted file by path, and the package's own size.
    assert.deepEqual(preview.files.map(one => one.path).sort(), ["notes.md", "task.md"]);
    assert.ok(preview.totalBytes > 0);
    assert.deepEqual(preview.requiredConfirmations, ["publish"]);

    // The offer is an open call: it names no receiver, whatever accepted it.
    assert.equal(offer.receiver, null);
    assert.equal(record.state, "OFFERED");
    assert.equal(record.executor, null);
    assert.equal(offer.sandbox, HANDOVER_SANDBOX, "an offer states the sandbox it is to be run under");

    // The branch and the record are both on the shared remote, and the record
    // is in its own namespace outside refs/heads.
    assert.equal(git(f.bare, ["rev-parse", `refs/heads/${offer.branch}`]), offer.snapshotCommit);
    assert.deepEqual(listControlItems(f.bare), [f.itemId]);

    // HEAD, the index and the worktree are untouched by the capture.
    assert.equal(git(f.source, ["rev-parse", "--abbrev-ref", "HEAD"]), "work");
    assert.equal(git(f.source, ["status", "--porcelain=v1"]).split("\n").length, 2);
  } finally {
    f.dispose();
    disable();
  }
});

/*
 * H07: the reader the `/close` guard asks. `TelegramLiveRuntime` registers it
 * beside the tap handler, so this is the production probe rather than a stub.
 */
test("H07: this workstation's own mirror answers what state the item's handover is in, with no remote", async () => {
  enable();
  const f = fixture("surface-close-guard");
  try {
    assert.equal(await knownHandoverRecord(f.itemId), null, "an item with no control record reads as no handover");
    const { record } = await offered(f);
    assert.equal(record.state, "OFFERED");

    // The shared repository goes away entirely. Closing a thread is the owner's
    // own decision on their own workstation, so the guard must still be able to
    // ask, and the mirror is what answers.
    rmSync(f.bare, { recursive: true, force: true });
    const known = await knownHandoverRecord(f.itemId);
    assert.equal(known?.state, "OFFERED", "the state comes from the local mirror, not a fetch");
    assert.equal(known?.itemId, f.itemId);
    assert.equal(await knownHandoverRecord(mintItemId()), null, "and an item this workstation never saw reads as no handover");
  } finally {
    f.dispose();
    disable();
  }
});

test("C1: nothing is published from a package nobody previewed", async () => {
  enable();
  const f = fixture("surface-unpreviewed");
  try {
    await beginItemHandover(f.requester, f.itemId);
    await assert.rejects(
      () => publishItemHandover(f.requester, f.itemId, { confirmations: ["publish"], acknowledgedBytes: 0 }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "preview_required",
    );
    assert.deepEqual(git(f.bare, ["for-each-ref", "--format=%(refname)", "refs/heads/aw"]), "");
  } finally {
    f.dispose();
    disable();
  }
});

test("C1: the control-record read is what makes a receiver discover an open call", async () => {
  enable();
  const f = fixture("surface-discover");
  try {
    const { offer } = await offered(f);

    // Nothing told env B this item exists. The read is the discovery.
    const discovered = await pollControlRecords(f.receiver);
    assert.deepEqual(discovered.discovered, [f.itemId]);
    assert.equal(discovered.items, 1);

    // The card is posted by the receiver's own bot, not the requester's.
    const outbox = workspaces.handoverOfferCardOutbox("yousef-bot", f.itemId);
    assert.notEqual(outbox, null, "the receiver's own bot posts its own Accept card");
    assert.equal(workspaces.handoverOfferCardOutbox("jd-bot", f.itemId), null);
    const actions = workspaces.handoverActionsForItem("yousef-bot", f.itemId);
    assert.deepEqual(actions.map(one => one.action).sort(), ["accept_offer", "decline_offer"]);

    // A second read does not repost it.
    await pollControlRecords(f.receiver);
    assert.equal(workspaces.handoverOfferCardOutbox("yousef-bot", f.itemId), outbox);

    // The requester does not accept their own open call.
    const own = await pollControlRecords(f.requester);
    assert.deepEqual(own.discovered, []);
    assert.equal(workspaces.handoverOfferCardOutbox("jd-bot", f.itemId), null);

    // The requested capabilities are inside the receiver's own policy, so the
    // Accept card is offered rather than withheld (RTC-12, within_limit).
    const comparison = compareCapabilities(
      { provider: offer.provider, model: offer.model, hostAccess: false, sandbox: HANDOVER_SANDBOX, tools: [] },
      receiverPolicy([PROVIDER]),
    );
    assert.equal(comparison.outcome, "within_limit");
    assert.equal(comparison.runnable, true);
  } finally {
    f.dispose();
    disable();
  }
});

test("RTC-12: a provider this workstation is not logged in to is unknown, not permission", () => {
  const comparison = compareCapabilities(
    { provider: "codex", model: null, hostAccess: false, sandbox: HANDOVER_SANDBOX, tools: [] },
    receiverPolicy(["claude"]),
  );
  assert.equal(comparison.outcome, "unknown");
  assert.equal(comparison.runnable, false, "an omitted requirement is not permission");
  assert.deepEqual(comparison.unknown, ["provider:codex"]);
});

test("C1: a tap routes into the engine, and the claim is the record's compare-and-swap", async () => {
  enable();
  const f = fixture("surface-tap");
  try {
    await offered(f);
    await pollControlRecords(f.receiver);
    const accept = workspaces.handoverActionsForItem("yousef-bot", f.itemId).find(one => one.action === "accept_offer")!;

    const tap: HandoverTap = {
      action: "accept_offer",
      actionRef: accept.ref,
      itemId: f.itemId,
      epoch: 1,
      commandId: "b-accept-1",
      botId: "yousef-bot",
      chatId: f.roster.groupChatId,
      topicId: null,
      transportUserId: "9001",
      promptId: workspaces.handoverCandidatePrompt("yousef-bot", f.itemId)!,
    };
    const receipt = await handleHandoverTap(f.receiver, tap);
    assert.equal(receipt.state, "APPLIED");

    // The shared record, not the tap, is what records the claim.
    const state = JSON.parse(execFileSync("git", ["--git-dir", f.bare, "show", `refs/aw/items/${f.itemId}/control:state.json`], { encoding: "utf8" })) as { state: string; executor: string };
    assert.equal(state.state, "CLAIMED");
    assert.equal(state.executor, RECEIVER);

    // Duplicate delivery returns the first receipt and claims nothing twice.
    const replay = await handleHandoverTap(f.receiver, { ...tap, commandId: "b-accept-2" });
    assert.equal(replay.commandId, receipt.commandId, "a duplicate tap is answered from the first receipt");
  } finally {
    f.dispose();
    disable();
  }
});

test("C1: a tap this surface offers no button for is refused rather than read as something else", async () => {
  enable();
  const f = fixture("surface-unknown-tap");
  try {
    await offered(f);
    await pollControlRecords(f.receiver);
    const decline = workspaces.handoverActionsForItem("yousef-bot", f.itemId).find(one => one.action === "decline_offer")!;
    const receipt = await handleHandoverTap(f.receiver, {
      action: "withdraw_offer",
      actionRef: decline.ref,
      itemId: f.itemId,
      epoch: 1,
      commandId: "b-withdraw-1",
      botId: "yousef-bot",
      chatId: f.roster.groupChatId,
      topicId: null,
      transportUserId: "9001",
      promptId: workspaces.handoverCandidatePrompt("yousef-bot", f.itemId)!,
    });
    assert.equal(receipt.state, "REJECTED");
    assert.equal(receipt.errorCode, "action_not_available");
  } finally {
    f.dispose();
    disable();
  }
});

test("C1: both settings stay false by default, and each route says which one refused it", async () => {
  disable();
  assert.equal(settings.team.enabled, false, "team.enabled is false by default");
  assert.equal(settings.team.handoverEnabled, false, "team.handoverEnabled is false by default");

  const f = fixture("surface-default-off");
  try {
    // Team off.
    await assert.rejects(
      () => beginItemHandover(f.requester, f.itemId),
      (error: unknown) => error instanceof WorkspaceError && error.status === 403 && error.code === "team_disabled",
    );

    // Team on, handover off: a different capability, and it says so.
    updateSettings({ "team.enabled": true });
    for (const call of [
      () => beginItemHandover(f.requester, f.itemId),
      () => previewItemHandover(f.requester, f.itemId, { provider: PROVIDER }),
      () => publishItemHandover(f.requester, f.itemId, { confirmations: ["publish"], acknowledgedBytes: 0 }),
    ]) {
      await assert.rejects(call, (error: unknown) =>
        error instanceof WorkspaceError && error.status === 403 && error.code === "handover_disabled");
    }

    // The record is untouched by any of it, and the poll does nothing at all.
    assert.deepEqual(listControlItems(f.bare), []);
    assert.deepEqual(await pollControlRecords(f.receiver), { items: 0, discovered: [], reviewed: [], expired: [], returnable: [] });

    // The capability gate H04 built still refuses a tap, with both settings named.
    const control = new TaskControlService({
      enabled: true, teamEnabled: true, handoverEnabled: false,
      notificationsEnabled: true, remoteActionsEnabled: true, transport: "telegram", botId: "jd-bot",
    });
    let called = false;
    control.registerHandoverTapHandler(async () => { called = true; throw new Error("unreachable"); });
    assert.equal(called, false, "a registered handler is never reached while handover is off");
  } finally {
    f.dispose();
    disable();
  }
});

test("C1: the requester's environment is built from the roster, never from the offer", () => {
  enable();
  const f = fixture("surface-environment");
  try {
    const env = requesterEnvironment(f.requester, f.itemId);
    assert.equal(env.personId, REQUESTER);
    assert.equal(env.workstationId, "jd-laptop");
    assert.equal(env.botId, "jd-bot");
    assert.equal(env.remoteUrl, f.bare);
    assert.equal(env.workDirectory, f.source);
    assert.deepEqual(env.roster, [REQUESTER, RECEIVER]);
  } finally {
    f.dispose();
    disable();
  }
});

/**
 * The return and the apply, driven through the surface.
 *
 * The run itself is the one thing this tier cannot have - it needs a real
 * provider in the receiver's own worktree - so the record is advanced to
 * RUNNING exactly as `startReceiverRun` advances it, and the receiver's worktree
 * and its run row are real. Everything after that is the surface: the Return
 * work tap, the requester's poll finding the returned work, the review card and
 * the apply.
 */
async function claimedAndRunning(f: Fixture, offer: { epoch: number }) {
  await pollControlRecords(f.receiver);
  const accept = workspaces.handoverActionsForItem("yousef-bot", f.itemId).find(one => one.action === "accept_offer")!;
  await handleHandoverTap(f.receiver, {
    action: "accept_offer", actionRef: accept.ref, itemId: f.itemId, epoch: offer.epoch,
    commandId: `b-accept-${f.itemId}`, botId: "yousef-bot", chatId: f.roster.groupChatId, topicId: null,
    transportUserId: "9001", promptId: workspaces.handoverCandidatePrompt("yousef-bot", f.itemId)!,
  });
}

test("C1: Return work publishes the result, and the requester's poll turns it into a review card", async () => {
  enable();
  const f = fixture("surface-return");
  try {
    const { offer } = await offered(f);
    await claimedAndRunning(f, offer);

    // The record's own path from CLAIMED to RUNNING, which the receiver's run
    // walks. `runClaimedItem` cannot run here because there is no provider.
    const remote = controlRemote(f.itemId, f.bare);
    for (const [event, payload] of [
      ["preparation_complete", { policyChecked: true, workspaceReserved: true, startIntentDurable: true }],
      ["run_started", { runId: "run-b-1" }],
    ] as const) {
      const current = (await remote.read())!;
      await applyControlTransition(remote, {
        event, actor: { personId: RECEIVER, workstationId: "yousef-desktop" },
        commandId: `b-${event}`, epoch: current.record.epoch, fromHead: current.head,
        roster: [REQUESTER, RECEIVER], payload,
      });
    }

    // The receiver's real worktree of the handover branch, and the work it did.
    const worktreeRoot = mkdtempSync(join(tmpdir(), "surface-return-wt-"));
    const worktree = join(worktreeRoot, f.itemId);
    execFileSync("git", ["fetch", "-q", "origin", `+refs/heads/aw/handover/${f.itemId}:refs/remotes/origin/aw/handover/${f.itemId}`], { cwd: f.clone });
    execFileSync("git", ["worktree", "add", "-q", "--detach", worktree, `refs/remotes/origin/aw/handover/${f.itemId}`], { cwd: f.clone });
    writeFileSync(join(worktree, "notes.md"), "what is left: nothing, it is done\n");

    const receiverWorkspace = workspaces.create({ name: `handover-${f.itemId}`, workDirectory: worktree });
    const program = workspaces.createChild("program", receiverWorkspace.id, { name: "Team handover", overview: "" }) as ProgramRecord;
    const suite = workspaces.createChild("suite", program.id, { name: f.itemId, overview: "" }) as SuiteRecord;
    const task = workspaces.createChild("prompt", suite.id, { title: `Handover ${f.itemId}`, content: "Finish it." }) as PromptRecord;
    // No underscores: a request id is /^[-0-9a-zA-Z]{8,100}$/ and an item id has one.
    const runId = `run-b-${f.itemId.replace(/_/g, "-")}`;
    workspaces.beginAgentRun({ runId, workspaceId: receiverWorkspace.id, promptId: task.id, provider: "claude", model: null, tokenHash: runId, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    workspaces.updateAgentStatus(runId, { requestId: `${runId}-done`, expectedStatus: "IN_PROGRESS", status: "DONE", reason: "handover work finished", verificationSummary: "surface fixture" });
    workspaces.finishAgentRun(runId, "done");
    handoverSurfaceInternals.activeRuns.set(f.itemId, {
      itemId: f.itemId, runId, worktree, workspaceId: receiverWorkspace.id,
      promptId: task.id, cardPromptId: workspaces.handoverCandidatePrompt("yousef-bot", f.itemId)!,
      provider: "claude", model: null,
    });

    // The receiver's poll offers Return work once the run has ended.
    const polled = await pollControlRecords(f.receiver);
    assert.deepEqual(polled.returnable, [f.itemId]);
    const returnAction = workspaces.handoverActionsForItem("yousef-bot", f.itemId).find(one => one.action === "return_work");
    assert.ok(returnAction, "the receiver's own bot offers Return work");

    const returned = await handleHandoverTap(f.receiver, {
      action: "return_work", actionRef: returnAction.ref, itemId: f.itemId, epoch: 1,
      commandId: `b-return-${f.itemId}`, botId: "yousef-bot", chatId: f.roster.groupChatId, topicId: null,
      transportUserId: "9001", promptId: task.id,
    });
    assert.equal(returned.state, "APPLIED", returned.message);
    assert.match(returned.message, /Returned full work/, "a completed run returns a full result, not a partial one");

    // RETURNED releases the executor; there is no release action and no
    // RELEASED state anywhere in the record.
    const state = JSON.parse(execFileSync("git", ["--git-dir", f.bare, "show", `refs/aw/items/${f.itemId}/control:state.json`], { encoding: "utf8" })) as { state: string; executor: string | null; resultLabel: string };
    assert.equal(state.state, "RETURNED");
    assert.equal(state.executor, null);
    assert.equal(state.resultLabel, "full");

    // The requester's own poll is what surfaces it, so the report is readable
    // the moment it lands even if this workstation was stopped when it did (D01).
    const reviewed = await pollControlRecords(f.requester);
    assert.deepEqual(reviewed.reviewed, [f.itemId]);
    const review = await reviewItemHandover(f.requester, f.itemId);
    assert.equal(review.applyOffered, true, review.reason);
    assert.deepEqual(review.card.offered, ["review", "request_changes", "apply_result"]);
    assert.equal(review.result.label, "full");

    // Apply, then apply again: the second returns the first receipt and merges
    // nothing a second time (B27).
    const applied = await applyItemHandover(f.requester, f.itemId, { acceptanceMet: true });
    assert.equal(applied.kind, "applied", "kind" in applied ? applied.kind : "");
    assert.equal(execFileSync("git", ["show", "HEAD:notes.md"], { cwd: f.source, encoding: "utf8" }).trim(), "what is left: nothing, it is done");
    const again = await applyItemHandover(f.requester, f.itemId, { acceptanceMet: true });
    assert.equal(again.kind, "already_applied");

    workspaces.remove(receiverWorkspace.id);
    execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: f.clone });
    rmSync(worktreeRoot, { recursive: true, force: true });
    handoverSurfaceInternals.activeRuns.delete(f.itemId);
  } finally {
    f.dispose();
    disable();
  }
});

/*
 * The third leg of C1: the cards H03 to H05 render had no Telegram formatting
 * at all. `formatTelegramMessage` had no case for `handover_offer`,
 * `handover_review` or `handover_question`, so every one of them failed
 * delivery with "unsupported payload kind" and no tap was ever possible.
 */

test("C1: the offer card renders as an open call with an Accept and run button", () => {
  const formatted = formatTelegramMessage(renderHandoverOfferCard({
    itemId: "awi1_75c3aabf7831461bc7c4a395",
    branch: "aw/handover/awi1_75c3aabf7831461bc7c4a395",
    epoch: 1,
    startDeadline: "2026-09-22T09:00:00.000Z",
    requested: { provider: "grok", model: null, hostAccess: false, sandbox: HANDOVER_SANDBOX, tools: [] },
    capability: { outcome: "within_limit", additions: [], denied: [], unknown: [], reason: "This package is inside your own settings." },
    promptId: null,
    actions: [{ ref: "tc_accept", action: "accept_offer" }, { ref: "tc_decline", action: "decline_offer" }],
  }), () => null);
  assert.match(formatted.text, /Handover offered/);
  assert.match(formatted.text, /names no receiver/);
  assert.match(formatted.text, /#item_/, "the card carries the item's own tag");
  assert.deepEqual(formatted.replyMarkup?.inline_keyboard.flat(), [
    { text: "Accept and run", callback_data: "tc_accept" },
    { text: "Decline", callback_data: "tc_decline" },
  ]);
});

test("C1: an inert offer card keeps its reason and offers no tap", () => {
  const formatted = formatTelegramMessage(renderHandoverOfferCard({
    itemId: "awi1_75c3aabf7831461bc7c4a395",
    branch: "aw/handover/awi1_75c3aabf7831461bc7c4a395",
    epoch: 1,
    startDeadline: "2026-09-22T09:00:00.000Z",
    requested: { provider: "grok", model: null, hostAccess: false, sandbox: HANDOVER_SANDBOX, tools: [] },
    capability: { outcome: "within_limit", additions: [], denied: [], unknown: [], reason: "Inside your settings." },
    promptId: null,
    actions: [{ ref: "tc_accept", action: "accept_offer" }],
    inert: true,
    reason: "yousef holds this item now (CLAIMED).",
  }), () => null);
  assert.match(formatted.text, /yousef holds this item now/);
  assert.equal(formatted.replyMarkup, null);
});

test("Q9: the review card offers Apply only when the merge is clean", () => {
  const base = {
    itemId: "awi1_75c3aabf7831461bc7c4a395",
    branch: "aw/handover/awi1_75c3aabf7831461bc7c4a395",
    epoch: 1,
    resultId: "r-1",
    resultCommit: "b".repeat(40),
    label: "full" as const,
    verification: ["run r-1 on yousef-desktop"],
    uncertainEffects: [],
    evidenceMissing: false,
    divergedPaths: [],
    conflictPaths: [],
    promptId: null,
    reason: "The result merges cleanly into this checkout.",
  };
  const clean = formatTelegramMessage(renderHandoverReviewCard({
    ...base,
    applyOffered: true,
    actions: [{ ref: "tc_apply", action: "apply_result" }, { ref: "tc_changes", action: "request_changes" }],
  }), () => null);
  assert.deepEqual(clean.replyMarkup?.inline_keyboard.flat(), [
    { text: "Apply", callback_data: "tc_apply" },
    { text: "Request changes", callback_data: "tc_changes" },
  ]);

  const conflicted = formatTelegramMessage(renderHandoverReviewCard({
    ...base,
    applyOffered: false,
    conflictPaths: ["task.md"],
    reason: "Git stopped with a conflict in task.md.",
    actions: [{ ref: "tc_changes", action: "request_changes" }],
  }), () => null);
  assert.deepEqual(conflicted.replyMarkup?.inline_keyboard.flat(), [{ text: "Request changes", callback_data: "tc_changes" }]);
  assert.doesNotMatch(conflicted.text, /\bApply\b(?!\sis not offered)/);
  assert.match(conflicted.text, /Apply is not offered while the merge is not clean/);
  assert.match(conflicted.text, /conflict in: task\.md/);
});

test("B26: a full result with no evidence says so rather than letting the label speak", () => {
  const formatted = formatTelegramMessage(renderHandoverReviewCard({
    itemId: "awi1_75c3aabf7831461bc7c4a395",
    branch: "aw/handover/awi1_75c3aabf7831461bc7c4a395",
    epoch: 1,
    resultId: "r-1",
    resultCommit: "b".repeat(40),
    label: "full",
    verification: [],
    uncertainEffects: ["a deploy may have started"],
    evidenceMissing: true,
    applyOffered: true,
    divergedPaths: [],
    conflictPaths: [],
    promptId: null,
    actions: [{ ref: "tc_apply", action: "apply_result" }],
    reason: "This result is labelled full but carries no verification evidence.",
  }), () => null);
  assert.match(formatted.text, /Evidence: none was reported/);
  assert.match(formatted.text, /which is not acceptance/);
  assert.match(formatted.text, /Uncertain external effects: a deploy may have started/);
});

test("C1: a requirement question reads as the requester's to answer and is replied to", () => {
  const payload = {
    kind: "handover_question",
    itemId: "awi1_75c3aabf7831461bc7c4a395",
    questionKind: "requirement",
    audience: "requester",
    question: "Should the release colour be blue or green?",
    actions: [{ ref: "tc_save", action: "save_human_response" }, { ref: "tc_resume", action: "answer_and_resume" }],
  };
  const unanswered = formatTelegramMessage(payload, () => null);
  assert.match(unanswered.text, /requirements question, so it is yours to answer/);
  assert.match(unanswered.text, /Reply to this message with your answer/);
  assert.equal(unanswered.replyMarkup, null, "a tap with no bound answer has nothing to save");

  const answered = formatTelegramMessage(payload, ref => (ref === "tc_save" || ref === "tc_resume" ? "Use blue" : null));
  assert.match(answered.text, /Your answer:\nUse blue/);
  assert.deepEqual(answered.replyMarkup?.inline_keyboard.flat().map(one => one.text), ["Save answer", "Answer and resume"]);
});

test("C1: the Return work card renders its own button", () => {
  const formatted = formatTelegramMessage(renderTeamItemActionCard({
    itemId: "awi1_75c3aabf7831461bc7c4a395",
    title: "Return work",
    detail: "This run finished. Return the work to the requester for review.",
    actions: [{ ref: "tc_return", action: "return_work" }],
  }), () => null);
  assert.deepEqual(formatted.replyMarkup?.inline_keyboard.flat(), [{ text: "Return work", callback_data: "tc_return" }]);
});

test("TM-T1-H3: Request changes opens a new epoch whose fresh offer is discoverable again", async () => {
  enable();
  const f = fixture("surface-request-changes");
  try {
    const { offer } = await offered(f);
    await pollControlRecords(f.receiver);
    const firstCard = workspaces.handoverOfferCardOutbox("yousef-bot", f.itemId);
    assert.notEqual(firstCard, null);

    // The teammate declines this round, so the next one must still reach them.
    const decline = workspaces.handoverActionsForItem("yousef-bot", f.itemId).find(one => one.action === "decline_offer")!;
    await handleHandoverTap(f.receiver, {
      action: "decline_offer", actionRef: decline.ref, itemId: f.itemId, epoch: offer.epoch,
      commandId: `b-decline-${f.itemId}`, botId: "yousef-bot", chatId: f.roster.groupChatId, topicId: null,
      transportUserId: "9001", promptId: workspaces.handoverCandidatePrompt("yousef-bot", f.itemId)!,
    });

    // The requester re-offers the same package at a new epoch. `requestHandoverChanges`
    // only runs from RETURNED, so the record is walked there the way the
    // receiver's run walks it, and the re-offer is driven through the surface.
    const remote = controlRemote(f.itemId, f.bare);
    const walk = async (event: string, payload: Record<string, unknown>) => {
      const current = (await remote.read())!;
      await applyControlTransition(remote, {
        event: event as never, actor: { personId: event === "accept_offer" ? RECEIVER : RECEIVER, workstationId: "yousef-desktop" },
        commandId: `w-${event}-${f.itemId}`, epoch: current.record.epoch, fromHead: current.head,
        roster: [REQUESTER, RECEIVER], payload,
      });
    };
    await walk("accept_offer", {});
    await walk("preparation_complete", { policyChecked: true, workspaceReserved: true, startIntentDurable: true });
    await walk("run_started", { runId: "run-w-1" });
    await walk("run_ended", { outcome: "partial", reason: "quota" });
    await walk("return_work", {
      resultCommit: offer.snapshotCommit, resultLabel: "partial", resultId: "r-w-1",
      result: { resultId: "r-w-1", epoch: 1, resultCommit: offer.snapshotCommit, label: "partial", verification: [], uncertainEffects: [], releaseEvidence: "stopped", executor: RECEIVER, returnedAt: new Date().toISOString() },
    });

    const changes = await requestItemChanges(f.requester, f.itemId, { requirements: "Use blue, not green." });
    assert.equal(changes.receiver, null, "the new round is an open call and names nobody");
    assert.equal(changes.epoch, 2, "Request changes opens a new epoch");

    // The teammate who declined the previous round discovers the new one.
    const rediscovered = await pollControlRecords(f.receiver);
    assert.deepEqual(rediscovered.discovered, [f.itemId]);
    const secondCard = workspaces.handoverOfferCardOutbox("yousef-bot", f.itemId);
    assert.notEqual(secondCard, firstCard, "a new epoch posts a fresh card rather than leaving the spent one");
    // Tappable means unexpired **and** undecided: an action that already carries
    // a receipt is answered from it rather than re-applied, which is why
    // `expireHandoverActionsForItem` leaves a decided one alone. The previous
    // round's decline is decided, so it is not a live button; its accept was
    // never tapped, so ending it is what stops a stale card being usable.
    const tappable = workspaces.handoverActionsForItem("yousef-bot", f.itemId).filter(one => {
      const action = workspaces.taskControlAction(one.ref);
      return action !== null
        && Date.parse(action.expires_at) > Date.now()
        && workspaces.taskControlReceiptForAction(one.ref) === null;
    });
    assert.deepEqual(tappable.map(one => one.action).sort(), ["accept_offer", "decline_offer"],
      "the new round's buttons are the only ones left to tap");
  } finally {
    f.dispose();
    disable();
  }
});
