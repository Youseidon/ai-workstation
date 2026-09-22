import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { config } from "../src/config.ts";
import { settings } from "../src/settings.ts";
import { TaskControlService } from "../src/taskControl.ts";
import {
  BareGitControlRecordRemote,
  OFFER_DEADLINE_MS,
  applyControlTransition,
  createControlRecord,
  handoverBranch,
  type ControlRecordRemote,
} from "../src/teamControlRecord.ts";
import { readPublishedOffer, type PublishedOffer } from "../src/teamHandoverCapture.ts";
import {
  HANDOVER_STOP_REASONS,
  acceptHandoverOffer,
  acknowledgeExecutorStop,
  assertHandoverEnabled,
  assertRuntimeCapability,
  capabilityTokens,
  classifyHandoverStop,
  closeAfterHandover,
  compareCapabilities,
  declineHandoverOffer,
  discoverHandoverOffer,
  handoverQuestionAudience,
  postHandoverQuestion,
  reacquireOwnership,
  recordLocalCompletionCancelRequest,
  requestExecutorStop,
  retireHandoverCardsFor,
  returnHandoverWork,
  startReceiverRun,
  type ReceiverEnvironment,
  type ReceiverPolicy,
} from "../src/teamHandoverRun.ts";
import { mintItemId } from "../src/teamItems.ts";
import { WorkspaceError, workspaces } from "../src/workspaces.ts";

/*
 * Scenarios TM-T1-H1 and TM-T1-H2, docs/e2e-scenarios/tm4.md: a receiver
 * discovers an open-call offer, accepts and claims it, runs the work in a
 * worktree under their own provider and policy, and requirement questions cross
 * workstations while the requester is stopped.
 *
 * Both rows are T1: they are written for the two-environment harness, where env
 * A and env B have their own app roots, bots and databases and share one fake
 * Telegram group and one bare repository. This file runs the half that is
 * reachable at the server tier, which is everything that does not need two
 * databases or a delivered Telegram update:
 *
 *   - the shared bare repository is real, and env A's side of it is real: the
 *     branch and the control record are exactly what crosses between the two
 *     workstations, so they are driven here as env A would write them;
 *   - the local database is env B's, which is why the requester's `item_link`
 *     is not present: `item_link.item_id` is a primary key, so one database
 *     cannot hold both roles for one item, and that is the two-environment
 *     boundary itself;
 *   - the receiver's own bot, actor, cards, worktree, reservation, start intent
 *     and run are all real here.
 *
 * What is left for the harness is named in the task report: delivery of each
 * card to a phone, both bots receiving every group update, the anchor edits,
 * and env B restarting mid-offer.
 */

const REQUESTER = "jd";
const RECEIVER = "yousef";
const OTHER_RECEIVER = "sam";
const PROVIDER = "claude";
const MODEL = "sonnet";

const database = () => new Database(workspaces.databasePath);

function git(directory: string, args: string[]): string {
  return execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
}

/** The receiver's own approved policy: within limits for the offer below. */
function policyWithin(): ReceiverPolicy {
  return {
    providers: [PROVIDER],
    models: [MODEL],
    hostAccess: false,
    sandbox: ["workspace-write"],
    tools: ["read", "edit"],
    grantable: [],
    denied: [],
    unenforceable: [],
  };
}

interface Fixture {
  itemId: string;
  /** One fake group per fixture, so actor rows never collide across fixtures. */
  groupChat: string;
  bare: string;
  /** Env A's checkout, used only to build the branch the receiver fetches. */
  source: string;
  /** Env B's own clone of the shared remote. */
  clone: string;
  worktreeRoot: string;
  control: BareGitControlRecordRemote;
  env: ReceiverEnvironment;
  snapshotCommit: string;
  dispose(): void;
}

/**
 * One shared bare repository, env A's published branch and control record, and
 * env B's own clone, workspace, bot and enrolled actors. Env B's policy is a
 * mutable box so a test can change it between the claim and the start, which is
 * what B19's "re-validate immediately before starting" needs to be observable.
 */
function fixture(prefix: string, options: { policy?: () => ReceiverPolicy } = {}): Fixture {
  const itemId = mintItemId();
  const groupChat = `-100${itemId.slice(-10)}`;
  const source = mkdtempSync(join(tmpdir(), `${prefix}-src-`));
  const bare = mkdtempSync(join(tmpdir(), `${prefix}-bare-`));
  const clone = mkdtempSync(join(tmpdir(), `${prefix}-clone-`));
  const worktreeRoot = mkdtempSync(join(tmpdir(), `${prefix}-wt-`));
  execFileSync("git", ["init", "--bare", "-q", bare]);

  git(source, ["init", "-q", "-b", "work"]);
  git(source, ["config", "user.email", "jd@invalid"]);
  git(source, ["config", "user.name", "jd"]);
  writeFileSync(join(source, "task.md"), "half finished\n");
  git(source, ["add", "-A"]);
  git(source, ["commit", "-q", "-m", "snapshot"]);
  const snapshotCommit = git(source, ["rev-parse", "HEAD"]);
  git(source, ["push", "-q", bare, `HEAD:refs/heads/${handoverBranch(itemId)}`]);
  execFileSync("git", ["clone", "-q", bare, clone]);

  // Env B's own workspace, where its candidate task for an offer is created.
  const home = mkdtempSync(join(tmpdir(), `${prefix}-home-`));
  const workspace = workspaces.create({ name: home, workDirectory: home });
  const program = workspaces.createChild("program", workspace.id, { name: "Team", overview: "Handover" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: "Incoming", overview: "TM4" }) as SuiteRecord;

  // Env B's own actor, and the requester's group actor as env B's roster knows it.
  workspaces.upsertTaskControlActor({
    id: `fake-tg-${RECEIVER}-private`, transport: "fake_telegram", transportUserId: "9001",
    chatId: `${prefix}-yousef-private`, topicId: null, label: "Yousef",
  });
  workspaces.upsertTeamGroupActor({
    id: `fake-tg-${REQUESTER}-group-${itemId}`, transport: "fake_telegram", transportUserId: "9000",
    chatId: groupChat, label: "jd",
  });
  workspaces.upsertTeamGroupActor({
    id: `fake-tg-${RECEIVER}-group-${itemId}`, transport: "fake_telegram", transportUserId: "9001",
    chatId: groupChat, label: "Yousef",
  });

  const control = new BareGitControlRecordRemote(bare, itemId);
  const env: ReceiverEnvironment = {
    personId: RECEIVER,
    workstationId: "yousef-desktop",
    botId: "yousef-bot",
    chatId: groupChat,
    topicId: null,
    actorId: `fake-tg-${RECEIVER}-group-${itemId}`,
    roster: [REQUESTER, RECEIVER, OTHER_RECEIVER],
    workspaceId: workspace.id,
    suiteId: suite.id,
    policy: options.policy ?? policyWithin,
  };

  return {
    itemId, groupChat, bare, source, clone, worktreeRoot, control, env, snapshotCommit,
    dispose() {
      // Every row this fixture created goes with it, so the suite passes twice
      // against one unchanged repo root (F00B's second kind of non-determinism).
      for (const entry of workspaces.list()) {
        if (entry.id === workspace.id || entry.workDirectory.startsWith(worktreeRoot)) workspaces.remove(entry.id);
      }
      for (const directory of [source, bare, clone, worktreeRoot, home]) rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * A second receiver. On the harness this is a third app root; here it is its own
 * suite, bot and actor inside the one database, which is enough for the record
 * to be what arbitrates between them.
 */
function secondReceiver(f: Fixture): ReceiverEnvironment {
  const program = workspaces.createChild("program", f.env.workspaceId, { name: `Team ${OTHER_RECEIVER}`, overview: "Handover" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: "Incoming", overview: "TM4" }) as SuiteRecord;
  workspaces.upsertTeamGroupActor({
    id: `fake-tg-${OTHER_RECEIVER}-group-${f.itemId}`, transport: "fake_telegram", transportUserId: "9002",
    chatId: f.groupChat, label: "Sam",
  });
  return {
    ...f.env,
    personId: OTHER_RECEIVER,
    workstationId: "sam-desktop",
    botId: "sam-bot",
    actorId: `fake-tg-${OTHER_RECEIVER}-group-${f.itemId}`,
    suiteId: suite.id,
  };
}

/** Env A's half of what crosses: the record, published as `OFFERED` at epoch 1. */
async function publishedOffer(f: Fixture, now = new Date()): Promise<PublishedOffer> {
  await createControlRecord(f.control, { itemId: f.itemId, requester: REQUESTER, commandId: "a-create", now });
  await applyControlTransition(f.control, {
    event: "request_takeover", actor: { personId: REQUESTER }, commandId: "a-takeover", epoch: 0, now,
    payload: { sourceHoldPersisted: true },
  });
  await applyControlTransition(f.control, {
    event: "publish_offer", actor: { personId: REQUESTER }, commandId: "a-publish", epoch: 0, now,
    payload: {
      writersStopped: true, packageVerified: true, branchVerified: true,
      offerDeadline: new Date(now.getTime() + OFFER_DEADLINE_MS).toISOString(),
      requestedProvider: PROVIDER, requestedModel: MODEL,
      requestedHostAccess: false, requestedSandbox: "workspace-write", requestedTools: ["read", "edit"],
      packageHash: "pkg-1", snapshotCommit: f.snapshotCommit,
    },
  });
  const current = (await f.control.read())!;
  return (await readPublishedOffer(current.record, f.control))!;
}

const spawnStarted = async () => ({ kind: "started" as const });

async function claimed(f: Fixture, offer: PublishedOffer) {
  const discovery = await discoverHandoverOffer(f.control, f.env);
  assert.equal(discovery.kind, "offer");
  const accepted = await acceptHandoverOffer(f.control, { env: f.env, itemId: f.itemId, offer, commandId: "b-accept" });
  assert.equal(accepted.kind, "claimed");
  return discovery;
}

/* ========================================================================== */
/* TM-T1-H1: the happy path across two environments                            */
/* ========================================================================== */

test("TM-T1-H1: discover, accept, claim and run under the receiver's own provider and policy", async (t) => {
  await t.test("Discovery: env B reads the shared record on its poll and posts its own Accept and run card from its own bot", async () => {
    const f = fixture("tm-t1-h1-discover");
    try {
      const offer = await publishedOffer(f);
      const discovery = await discoverHandoverOffer(f.control, f.env);
      assert.equal(discovery.kind, "offer");
      if (discovery.kind !== "offer") return;

      assert.equal(discovery.offer.itemId, f.itemId, "the offer is reconstructed from the shared record, not from a message");
      assert.equal(discovery.offer.receiver, null, "the open call names no receiver");
      assert.equal(discovery.offer.branch, handoverBranch(f.itemId));
      assert.equal(discovery.offer.provider, offer.provider);
      assert.equal(discovery.offer.epoch, 1);

      const db = database();
      try {
        const row = db.prepare("SELECT bot_id botId,payload_json payload FROM telegram_outbox WHERE id=?").get(discovery.card.outboxId) as { botId: string; payload: string };
        assert.equal(row.botId, f.env.botId, "the Accept and run card is posted by env B's own bot, not the requester's");
        const payload = JSON.parse(row.payload) as { kind: string; itemId: string; receiver: string | null };
        assert.equal(payload.kind, "handover_offer");
        assert.equal(payload.itemId, f.itemId);
        assert.equal(payload.receiver, null, "the card names no receiver either");

        const actions = discovery.card.actions.map(one => one.action).sort();
        assert.deepEqual(actions, ["accept_offer", "decline_offer"], "within limits, the card offers Accept and run and Decline");
        for (const action of discovery.card.actions) {
          const stored = workspaces.taskControlAction(action.ref)!;
          assert.equal(stored.bot_id, f.env.botId, "every action on the card belongs to env B's bot");
          assert.equal(stored.actor_id, f.env.actorId, "and is bound to the receiver's own actor");
          assert.equal(JSON.parse(stored.payload_json!).itemId, f.itemId, "and carries the item it is about");
        }
        assert.equal(workspaces.itemLink(f.itemId), null, "discovery alone claims nothing and links nothing");
      } finally { db.close(); }
    } finally { f.dispose(); }
  });

  await t.test("Discovery: a requester does not discover their own offer, and an unoffered item offers nothing", async () => {
    const f = fixture("tm-t1-h1-own");
    try {
      assert.deepEqual(await discoverHandoverOffer(f.control, f.env).catch((e: WorkspaceError) => e.code), "control_not_found");
      await publishedOffer(f);
      const asRequester = await discoverHandoverOffer(f.control, { ...f.env, personId: REQUESTER });
      assert.equal(asRequester.kind, "own_offer", "the requester's own workstation does not offer to accept its own item");
    } finally { f.dispose(); }
  });

  await t.test("Accept: the claim goes through the control record and links the item locally as executor", async () => {
    const f = fixture("tm-t1-h1-accept");
    try {
      const offer = await publishedOffer(f);
      const discovery = await claimed(f, offer);
      if (discovery.kind !== "offer") return;

      const current = (await f.control.read())!;
      assert.equal(current.record.state, "CLAIMED");
      assert.equal(current.record.executor, RECEIVER, "the record names the receiver as executor");
      assert.equal(current.record.epoch, 1, "acceptance claims only the offered epoch");

      const link = workspaces.itemLink(f.itemId);
      assert.equal(link?.role, "executor", "env B links the item to its own candidate task as executor");
      assert.equal(link?.promptId, discovery.promptId);
      assert.equal(link?.controlHead, current.head, "and writes the accepted head into item_link.control_head");
    } finally { f.dispose(); }
  });

  await t.test("Run: a worktree of the handover branch, a local task, the normal start path, and the receiver's own provider", async () => {
    const f = fixture("tm-t1-h1-run");
    try {
      const offer = await publishedOffer(f);
      const discovery = await claimed(f, offer);
      if (discovery.kind !== "offer") return;

      const order: string[] = [];
      const started = await startReceiverRun(f.control, {
        env: f.env, itemId: f.itemId, offer, commandIdPrefix: "b-run",
        clone: { directory: f.clone, worktreeRoot: f.worktreeRoot },
        checkProvider: async () => { order.push("provider-check"); },
        spawn: async context => { order.push(`spawn:${context.provider}:${context.model}`); return { kind: "started" }; },
      });
      assert.equal(started.kind, "started");
      if (started.kind !== "started") return;

      assert.equal(existsSync(started.worktree), true, "the receiver runs in a worktree");
      assert.equal(git(started.worktree, ["rev-parse", "HEAD"]), f.snapshotCommit, "of aw/handover/<item>");
      assert.equal(readFileSync(join(started.worktree, "task.md"), "utf8"), "half finished\n");
      assert.notEqual(started.workspaceId, f.env.workspaceId, "the worktree is its own workspace, not the receiver's own checkout");

      assert.equal(workspaces.itemLink(f.itemId)!.promptId, started.promptId, "the worktree is linked to a local task");
      assert.deepEqual(order, ["provider-check", `spawn:${PROVIDER}:${MODEL}`], "the provider is checked, then one run is spawned");

      const db = database();
      try {
        const intent = db.prepare("SELECT id,state,provider,effective_directory dir FROM workspace_start_intent WHERE id=?").get(started.runId) as { id: string; state: string; provider: string; dir: string };
        assert.equal(intent.state, "RUNNING", "the start went through the normal start-intent path");
        assert.equal(intent.provider, PROVIDER, "under the receiver's own provider");
        assert.equal(intent.dir, started.worktree, "reserved on the worktree's own directory");
        assert.equal(
          (db.prepare("SELECT COUNT(*) n FROM workspace_start_intent WHERE released_at IS NULL").get() as { n: number }).n, 1,
          "exactly one run exists and it is env B's",
        );
      } finally { db.close(); }

      assert.equal((await f.control.read())!.record.state, "RUNNING");
    } finally { f.dispose(); }
  });

  await t.test("Run: the workspace is reserved atomically before the asynchronous provider check, and a START_INTENT is committed before spawning", async () => {
    const f = fixture("tm-t1-h1-order");
    try {
      const offer = await publishedOffer(f);
      await claimed(f, offer);
      const order: string[] = [];
      const started = await startReceiverRun(f.control, {
        env: f.env, itemId: f.itemId, offer, commandIdPrefix: "b-order",
        clone: { directory: f.clone, worktreeRoot: f.worktreeRoot },
        checkProvider: async () => {
          const db = database();
          try {
            order.push(`provider-check:intents=${(db.prepare("SELECT COUNT(*) n FROM workspace_start_intent WHERE released_at IS NULL").get() as { n: number }).n}`);
          } finally { db.close(); }
        },
        spawn: async context => {
          const db = database();
          try {
            order.push(`spawn:${(db.prepare("SELECT state FROM workspace_start_intent WHERE id=?").get(context.runId) as { state: string }).state}`);
          } finally { db.close(); }
          return { kind: "started" };
        },
      });
      assert.equal(started.kind, "started");
      assert.deepEqual(order, ["provider-check:intents=1", "spawn:START_INTENT"],
        "the reservation exists before the asynchronous provider check, and the start intent is durable before the spawn");
    } finally { f.dispose(); }
  });

  await t.test("Run: settings are re-validated immediately before starting, not at claim time (B19)", async () => {
    let policy = policyWithin();
    const f = fixture("tm-t1-h1-b19", { policy: () => policy });
    try {
      const offer = await publishedOffer(f);
      await claimed(f, offer);
      // The receiver's own settings change between the claim and the start.
      policy = { ...policyWithin(), providers: ["grok"], denied: [`provider:${PROVIDER}`] };
      let spawned = 0;
      const result = await startReceiverRun(f.control, {
        env: f.env, itemId: f.itemId, offer, commandIdPrefix: "b-b19",
        clone: { directory: f.clone, worktreeRoot: f.worktreeRoot },
        spawn: async () => { spawned += 1; return { kind: "started" }; },
      });
      assert.equal(result.kind, "refused", "a settings change after the claim refuses the start");
      if (result.kind !== "refused") return;
      assert.equal(result.comparison.outcome, "hard_deny");
      assert.equal(spawned, 0, "and spawns nothing");
      assert.equal((await f.control.read())!.record.state, "CLAIMED", "the acceptance is preserved rather than advanced");

      const db = database();
      try {
        assert.equal((db.prepare("SELECT COUNT(*) n FROM workspace_start_intent WHERE released_at IS NULL").get() as { n: number }).n, 0,
          "a refused start holds no reservation");
      } finally { db.close(); }
      assert.deepEqual(
        [...(existsSync(f.worktreeRoot) ? execFileSync("ls", [f.worktreeRoot], { encoding: "utf8" }).split("\n") : [])].filter(one => one !== ""),
        [], "and leaves no orphan worktree",
      );
    } finally { f.dispose(); }
  });

  await t.test("Run: an unknown spawn outcome is START_UNKNOWN, needs reconciliation and is never retried (B23)", async () => {
    const f = fixture("tm-t1-h1-unknown");
    try {
      const offer = await publishedOffer(f);
      await claimed(f, offer);
      let spawns = 0;
      const result = await startReceiverRun(f.control, {
        env: f.env, itemId: f.itemId, offer, commandIdPrefix: "b-unknown",
        clone: { directory: f.clone, worktreeRoot: f.worktreeRoot },
        spawn: async () => { spawns += 1; return { kind: "unknown", reason: "the supervisor lost the process handle" }; },
      });
      assert.equal(result.kind, "start_unknown");
      if (result.kind !== "start_unknown") return;
      assert.equal(result.requiresReconciliation, true);
      assert.equal(spawns, 1, "an unknown start is not retried automatically");

      const db = database();
      try {
        const intent = db.prepare("SELECT state,released_at releasedAt FROM workspace_start_intent WHERE id=?").get(result.runId) as { state: string; releasedAt: string | null };
        assert.equal(intent.state, "START_UNKNOWN");
        assert.equal(intent.releasedAt, null, "ownership stays held until it is reconciled");
      } finally { db.close(); }
      assert.equal((await f.control.read())!.record.state, "STARTING", "the record does not advance on an unknown outcome");
    } finally { f.dispose(); }
  });

  await t.test("Run: a known no-spawn failure preserves the acceptance and releases the reservation", async () => {
    const f = fixture("tm-t1-h1-nospawn");
    try {
      const offer = await publishedOffer(f);
      await claimed(f, offer);
      const result = await startReceiverRun(f.control, {
        env: f.env, itemId: f.itemId, offer, commandIdPrefix: "b-nospawn",
        clone: { directory: f.clone, worktreeRoot: f.worktreeRoot },
        spawn: async () => ({ kind: "no_spawn", reason: "the provider binary is missing" }),
      });
      assert.equal(result.kind, "no_spawn");
      const current = (await f.control.read())!;
      assert.equal(current.record.state, "CLAIMED", "acceptance is preserved until expiry");
      assert.equal(current.record.executor, RECEIVER);
      const db = database();
      try {
        assert.equal((db.prepare("SELECT COUNT(*) n FROM workspace_start_intent WHERE released_at IS NULL").get() as { n: number }).n, 0,
          "the reservation is released rather than stranded");
      } finally { db.close(); }
    } finally { f.dispose(); }
  });

  await t.test("Questions: requirement questions are issued to the requester as actor; access, provider and allowance are asked locally", async () => {
    const f = fixture("tm-t1-h1-questions");
    try {
      const offer = await publishedOffer(f);
      const discovery = await claimed(f, offer);
      if (discovery.kind !== "offer") return;
      const requester = { actorId: `fake-tg-${REQUESTER}-group-${f.itemId}`, chatId: f.groupChat, topicId: null };

      assert.equal(handoverQuestionAudience("requirement"), "requester");
      for (const kind of ["access", "provider", "allowance"] as const) {
        assert.equal(handoverQuestionAudience(kind), "receiver", `${kind} questions are the receiver's own decision`);
      }

      const requirement = postHandoverQuestion({
        env: f.env, itemId: f.itemId, promptId: discovery.promptId, kind: "requirement",
        question: "Should the retry back off per host or per request?", requester,
      });
      assert.equal(requirement.audience, "requester");
      assert.equal(requirement.botId, f.env.botId, "the requirement question is posted by the receiver's own workstation");
      assert.equal(requirement.actorId, requester.actorId, "and issued to the requester as actor, so it applies while env A is stopped");
      for (const action of requirement.actions) {
        assert.equal(workspaces.taskControlAction(action.ref)!.actor_id, requester.actorId);
        assert.equal(workspaces.taskControlAction(action.ref)!.bot_id, f.env.botId);
      }

      const access = postHandoverQuestion({
        env: f.env, itemId: f.itemId, promptId: discovery.promptId, kind: "access",
        question: "Allow Host access for this item and revision?", requester,
      });
      assert.equal(access.audience, "receiver");
      assert.equal(access.actorId, f.env.actorId, "access decisions stay the receiver's own");
      assert.notEqual(access.actorId, requester.actorId);
    } finally { f.dispose(); }
  });

  await t.test("RTC-12: the capability matrix, within limit", async () => {
    const comparison = compareCapabilities(
      { provider: PROVIDER, model: MODEL, hostAccess: false, sandbox: "workspace-write", tools: ["read", "edit"] },
      policyWithin(),
    );
    assert.equal(comparison.outcome, "within_limit");
    assert.equal(comparison.runnable, true);
    assert.equal(comparison.needsLocalGrant, false, "a request inside the receiver's limits starts with no second prompt");
    assert.deepEqual(comparison.additions, []);
    assert.deepEqual(comparison.denied, []);
    assert.deepEqual(comparison.unknown, []);
    assert.deepEqual(
      comparison.requested.slice().sort(),
      capabilityTokens({ provider: PROVIDER, model: MODEL, hostAccess: false, sandbox: "workspace-write", tools: ["read", "edit"] }).slice().sort(),
    );
  });

  await t.test("RTC-12: the capability matrix, a grantable delta is prompted locally with the exact additions", async () => {
    const comparison = compareCapabilities(
      { provider: PROVIDER, model: MODEL, hostAccess: true, sandbox: "workspace-write", tools: ["read", "edit"] },
      { ...policyWithin(), grantable: ["host_access"] },
    );
    assert.equal(comparison.outcome, "delta_grantable");
    assert.equal(comparison.needsLocalGrant, true, "the receiver is prompted locally, for this item and revision only");
    assert.deepEqual(comparison.additions, ["host_access"], "the exact additions are shown, not a widened setting");
    assert.deepEqual(comparison.denied, []);
    assert.deepEqual(comparison.unknown, []);
  });

  await t.test("RTC-12: the capability matrix, a hard local denial is rejected and takes precedence", async () => {
    const comparison = compareCapabilities(
      { provider: PROVIDER, model: MODEL, hostAccess: true, sandbox: "danger-full-access", tools: ["read"] },
      { ...policyWithin(), grantable: ["host_access", "sandbox:danger-full-access"], denied: ["sandbox:danger-full-access"] },
    );
    assert.equal(comparison.outcome, "hard_deny", "deny takes precedence over the same capability being grantable");
    assert.equal(comparison.runnable, false);
    assert.deepEqual(comparison.denied, ["sandbox:danger-full-access"]);
  });

  await t.test("RTC-12: the capability matrix, unknown enforcement is not permission and keeps preparation waiting", async () => {
    const missingPolicy = compareCapabilities(
      { provider: PROVIDER, model: MODEL, hostAccess: false, sandbox: "workspace-write", tools: ["read", "network_fetch"] },
      policyWithin(),
    );
    assert.equal(missingPolicy.outcome, "unknown", "an omitted requirement is not permission");
    assert.equal(missingPolicy.runnable, false);
    assert.deepEqual(missingPolicy.unknown, ["tool:network_fetch"]);

    const unenforceable = compareCapabilities(
      { provider: PROVIDER, model: MODEL, hostAccess: false, sandbox: "workspace-write", tools: ["read"] },
      { ...policyWithin(), unenforceable: ["tool:read"] },
    );
    assert.equal(unenforceable.outcome, "unknown", "a capability the adapter cannot enforce is unknown, not allowed");
    assert.deepEqual(unenforceable.unknown, ["tool:read"]);

    // "Check newly requested tools at runtime": a tool nobody declared is refused
    // at the tool boundary rather than inherited from the accepted comparison.
    const accepted = compareCapabilities(
      { provider: PROVIDER, model: MODEL, hostAccess: false, sandbox: "workspace-write", tools: ["read"] },
      policyWithin(),
    );
    assert.equal(accepted.outcome, "within_limit");
    assertRuntimeCapability(policyWithin(), accepted, "tool:read");
    assert.throws(
      () => assertRuntimeCapability(policyWithin(), accepted, "tool:shell"),
      (error: unknown) => error instanceof WorkspaceError && error.code === "capability_unknown",
    );
  });

  await t.test("RTC-12: a hard denial cannot be overridden from Telegram, and an unknown starts nothing", async () => {
    const cases: Array<[string, ReceiverPolicy]> = [
      ["hard deny", { ...policyWithin(), providers: ["grok"], denied: [`provider:${PROVIDER}`] }],
      ["unknown", { ...policyWithin(), unenforceable: [`provider:${PROVIDER}`] }],
    ];
    for (const [name, policy] of cases) {
      const f = fixture(`tm-t1-h1-rtc12-${name.replace(/\s/g, "-")}`, { policy: () => policy });
      try {
        const offer = await publishedOffer(f);
        const discovery = await discoverHandoverOffer(f.control, f.env);
        assert.equal(discovery.kind, "offer");
        if (discovery.kind !== "offer") return;
        assert.equal(discovery.comparison.runnable, false);
        assert.deepEqual(discovery.card.actions.map(one => one.action), ["decline_offer"],
          `${name}: the card offers no Accept and run, so Telegram cannot override the local decision`);

        const accepted = await acceptHandoverOffer(f.control, { env: f.env, itemId: f.itemId, offer, commandId: "b-forced" });
        assert.equal(accepted.kind, "refused", `${name}: an accept forced past the card is refused`);
        assert.equal((await f.control.read())!.record.state, "OFFERED", `${name}: and claims nothing`);
      } finally { f.dispose(); }
    }
  });

  await t.test("Repository: only the handover branch and the control record change, and no credential or path reaches either", async () => {
    const f = fixture("tm-t1-h1-refs");
    try {
      const offer = await publishedOffer(f);
      await claimed(f, offer);
      await startReceiverRun(f.control, {
        env: f.env, itemId: f.itemId, offer, commandIdPrefix: "b-refs",
        clone: { directory: f.clone, worktreeRoot: f.worktreeRoot }, spawn: spawnStarted,
      });
      const refs = execFileSync("git", ["--git-dir", f.bare, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" })
        .split("\n").filter(one => one !== "").sort();
      assert.deepEqual(refs, [`refs/aw/items/${f.itemId}/control`, `refs/heads/${handoverBranch(f.itemId)}`]);

      const head = (await f.control.read())!.head;
      const dump = execFileSync("git", ["--git-dir", f.bare, "log", "-p", "--all", head], { encoding: "utf8" });
      assert.equal(/sk-ant|ghp_|xai-|Bearer |TELEGRAM_BOT_TOKEN/.test(dump), false, "no credential shape reaches the control record");
      assert.equal(dump.includes(f.clone), false, "and no absolute path from either workstation");
      assert.equal(dump.includes(f.worktreeRoot), false);
      assert.equal(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/.test(dump), false, "and no Telegram bot identifier");
    } finally { f.dispose(); }
  });
});

/* ========================================================================== */
/* TM-T1-H2: contention, failure, partial return and no-reclaim                */
/* ========================================================================== */

test("TM-T1-H2: race, failure, partial return and no-reclaim", async (t) => {
  await t.test("First: a simultaneous accept is decided by the compare-and-swap, not by which tap reached a bot first", async () => {
    const f = fixture("tm-t1-h2-race");
    try {
      const offer = await publishedOffer(f);
      const head = (await f.control.read())!.head;
      const other = secondReceiver(f);

      // Both taps are minted from the same head. The tap that reached its bot
      // second is the one driven to the record first, so arrival order at a bot
      // cannot be what decides it.
      const secondToReachABot = await acceptHandoverOffer(f.control, { env: other, itemId: f.itemId, offer, commandId: "b-accept-sam", fromHead: head });
      const firstToReachABot = await acceptHandoverOffer(f.control, { env: f.env, itemId: f.itemId, offer, commandId: "b-accept-yousef", fromHead: head });

      assert.equal(secondToReachABot.kind, "claimed", "the accept whose shared update landed first wins");
      assert.equal(firstToReachABot.kind, "lost", "and the tap that reached a bot first loses");
      if (firstToReachABot.kind !== "lost") return;
      assert.equal(firstToReachABot.holder, OTHER_RECEIVER, "the loser is told who holds it");
      assert.match(firstToReachABot.reason, /CLAIMED|holds/i);

      const current = (await f.control.read())!;
      assert.equal(current.record.executor, OTHER_RECEIVER, "exactly one accept won");
      assert.equal(workspaces.itemLink(f.itemId)!.role, "executor");

      const db = database();
      try {
        assert.equal((db.prepare("SELECT COUNT(*) n FROM workspace_start_intent WHERE released_at IS NULL").get() as { n: number }).n, 0,
          "the loser starts no run");
        const events = execFileSync("git", ["--git-dir", f.bare, "ls-tree", "--name-only", `${current.head}:events`], { encoding: "utf8" });
        assert.equal(events.includes("b-accept-yousef.json"), false, "and its command is never recorded");
        assert.equal(events.includes("b-accept-sam.json"), true);
      } finally { db.close(); }
      assert.deepEqual(
        execFileSync("ls", [f.worktreeRoot], { encoding: "utf8" }).split("\n").filter(one => one !== ""),
        [], "the loser creates no worktree and leaves no orphan",
      );
    } finally { f.dispose(); }
  });

  await t.test("First: the loser re-reads, its card goes inert, and both taps are answered with their own receipt", async () => {
    const f = fixture("tm-t1-h2-inert");
    try {
      const offer = await publishedOffer(f);
      const discovery = await discoverHandoverOffer(f.control, f.env);
      assert.equal(discovery.kind, "offer");
      if (discovery.kind !== "offer") return;
      const head = (await f.control.read())!.head;
      const other = secondReceiver(f);
      await acceptHandoverOffer(f.control, { env: other, itemId: f.itemId, offer, commandId: "b-sam-wins", fromHead: head });

      const acceptRef = discovery.card.actions.find(one => one.action === "accept_offer")!.ref;
      const lost = await acceptHandoverOffer(f.control, { env: f.env, itemId: f.itemId, offer, commandId: "b-yousef-loses", actionRef: acceptRef, fromHead: head });
      assert.equal(lost.kind, "lost");

      const db = database();
      try {
        const receipt = workspaces.taskControlReceiptForAction(acceptRef);
        assert.equal(receipt, null, "a losing tap is not applied");
        const rejected = db.prepare("SELECT state,error_code errorCode,message FROM task_control_receipt WHERE action_ref=?").get(acceptRef) as { state: string; errorCode: string; message: string } | undefined;
        assert.equal(rejected?.state, "REJECTED", "but it is answered with its own receipt");
        assert.match(rejected!.message, new RegExp(OTHER_RECEIVER, "i"), "which says who holds the item");

        const inert = db.prepare("SELECT payload_json payload FROM telegram_outbox WHERE operation='edit' AND target_outbox_id=? ORDER BY id DESC LIMIT 1").get(discovery.card.outboxId) as { payload: string } | undefined;
        assert.ok(inert, "the loser's card is edited");
        const payload = JSON.parse(inert.payload) as { inert: boolean; actions: unknown[]; reason: string };
        assert.equal(payload.inert, true, "inert");
        assert.deepEqual(payload.actions, [], "with no buttons left");
        assert.match(payload.reason, new RegExp(OTHER_RECEIVER, "i"), "and the reason it gives names the holder");

        const accepts = db.prepare("SELECT COUNT(*) n FROM task_control_receipt WHERE state='APPLIED' AND action_ref IN (SELECT ref FROM task_control_action WHERE action='accept_offer')").get() as { n: number };
        assert.equal(accepts.n <= 1, true, "neither tap is applied twice");
      } finally { db.close(); }
    } finally { f.dispose(); }
  });

  await t.test("Second: a withdraw racing an accept leaves exactly one winner, and a claim that lost stays lost", async () => {
    const f = fixture("tm-t1-h2-withdraw");
    try {
      const offer = await publishedOffer(f);
      const head = (await f.control.read())!.head;
      await applyControlTransition(f.control, {
        event: "withdraw_offer", actor: { personId: REQUESTER }, commandId: "a-withdraw", epoch: 1, fromHead: head,
      });
      const lost = await acceptHandoverOffer(f.control, { env: f.env, itemId: f.itemId, offer, commandId: "b-late-accept", fromHead: head });
      assert.equal(lost.kind, "lost");
      if (lost.kind !== "lost") return;
      assert.equal(lost.record.state, "WITHDRAWN", "the loser re-validates against the state that actually exists");
      assert.equal(lost.holder, null);

      const again = await acceptHandoverOffer(f.control, { env: f.env, itemId: f.itemId, offer, commandId: "b-late-accept-2" });
      assert.equal(again.kind, "lost", "a claim that lost stays lost rather than being retried into existence");
      assert.equal((await f.control.read())!.record.state, "WITHDRAWN");
      assert.equal(workspaces.itemLink(f.itemId), null, "and nothing local is linked");
    } finally { f.dispose(); }
  });

  await t.test("Third: an accept after the 10-minute action expiry is rejected and renews nothing", async () => {
    const f = fixture("tm-t1-h2-expiry");
    try {
      const offer = await publishedOffer(f);
      const discovery = await discoverHandoverOffer(f.control, f.env, { ttlMs: -1 });
      assert.equal(discovery.kind, "offer");
      if (discovery.kind !== "offer") return;
      const acceptRef = discovery.card.actions.find(one => one.action === "accept_offer")!.ref;
      assert.equal(Date.parse(workspaces.taskControlAction(acceptRef)!.expires_at) <= Date.now(), true, "the action has expired");

      const db = database();
      try {
        const edits = () => (db.prepare("SELECT COUNT(*) n FROM telegram_outbox WHERE operation='edit' AND target_outbox_id=?").get(discovery.card.outboxId) as { n: number }).n;
        const before = edits();
        const refused = await acceptHandoverOffer(f.control, { env: f.env, itemId: f.itemId, offer, commandId: "b-expired", actionRef: acceptRef });
        assert.equal(refused.kind, "refused");
        if (refused.kind !== "refused") return;
        assert.match(refused.reason, /expired/i, "the expiry reason is what it gives");
        assert.equal(edits(), before, "no card is renewed automatically");
        assert.equal((await f.control.read())!.record.state, "OFFERED");
      } finally { db.close(); }
    } finally { f.dispose(); }
  });

  await t.test("Fourth: a decline is recorded, that person's card goes inert, and the offer stays OFFERED for anyone else", async () => {
    const f = fixture("tm-t1-h2-decline");
    try {
      const offer = await publishedOffer(f);
      const discovery = await discoverHandoverOffer(f.control, f.env);
      assert.equal(discovery.kind, "offer");
      if (discovery.kind !== "offer") return;
      const before = (await f.control.read())!;
      const declineRef = discovery.card.actions.find(one => one.action === "decline_offer")!.ref;

      const declined = await declineHandoverOffer(f.control, { env: f.env, itemId: f.itemId, commandId: "b-decline", actionRef: declineRef });
      assert.equal(declined.recorded, true, "declining is recorded rather than silent");
      assert.equal(declined.cardInert, true, "and the decliner's own card goes inert");
      assert.equal(declined.recordState, "OFFERED", "and under the open call the offer stays OFFERED for anyone else");

      const after = (await f.control.read())!;
      assert.equal(after.head, before.head, "a per-person decline writes no shared update at all");
      assert.equal(after.record.state, "OFFERED");
      assert.equal(after.record.epoch, 1, "and advances no epoch");

      const receipt = workspaces.taskControlReceiptForAction(declineRef);
      assert.equal(receipt?.state, "APPLIED", "the decline has its own applied receipt");
      assert.equal(receipt?.action, "decline_offer");

      // Anyone else may still accept, which is the whole point of the open call.
      const other = secondReceiver(f);
      const accepted = await acceptHandoverOffer(f.control, { env: other, itemId: f.itemId, offer, commandId: "b-sam-accept" });
      assert.equal(accepted.kind, "claimed", "a remaining member can still accept the offer the decliner left open");
    } finally { f.dispose(); }
  });

  await t.test("Fifth: quota is its own distinct stop reason, never collapsed into anything else (B05)", () => {
    assert.equal(classifyHandoverStop({ quotaExhausted: true }), "quota");
    assert.equal(classifyHandoverStop({ quotaExhausted: true, toolFailed: true }), "quota",
      "quota is not collapsed into a tool failure");
    assert.equal(classifyHandoverStop({ quotaExhausted: true, humanBlocker: true }), "quota",
      "nor into a human blocker");
    assert.equal(classifyHandoverStop({ toolFailed: true }), "tool_failure");
    assert.equal(classifyHandoverStop({ humanBlocker: true }), "human_blocker");
    assert.equal(classifyHandoverStop({ providerFailed: true }), "provider_failure");
    assert.equal(classifyHandoverStop({ cancelled: true }), "cancelled");
    assert.equal(classifyHandoverStop({ completed: true }), "completed");
    assert.equal(classifyHandoverStop({}), "unknown", "and an unknown stop is never classified as quota by default");
    assert.equal(HANDOVER_STOP_REASONS.includes("quota"), true);
  });

  await t.test("Fifth: a partial return by a receiver who cannot finish releases the executor, with no RELEASED state and no eighth action", async () => {
    const f = fixture("tm-t1-h2-partial");
    try {
      const offer = await publishedOffer(f);
      await claimed(f, offer);
      const started = await startReceiverRun(f.control, {
        env: f.env, itemId: f.itemId, offer, commandIdPrefix: "b-partial",
        clone: { directory: f.clone, worktreeRoot: f.worktreeRoot }, spawn: spawnStarted,
      });
      assert.equal(started.kind, "started");
      if (started.kind !== "started") return;

      writeFileSync(join(started.worktree, "task.md"), "half finished\nsome progress\n");
      git(started.worktree, ["config", "user.email", "yousef@invalid"]);
      git(started.worktree, ["config", "user.name", "yousef"]);
      git(started.worktree, ["commit", "-qam", "progress so far"]);
      const resultCommit = git(started.worktree, ["rev-parse", "HEAD"]);

      const returned = await returnHandoverWork(f.control, {
        env: f.env, itemId: f.itemId, commandIdPrefix: "b-return", runId: started.runId,
        stopReason: classifyHandoverStop({ quotaExhausted: true }), resultCommit,
        push: async () => { git(started.worktree, ["push", "-q", f.bare, `HEAD:refs/heads/${handoverBranch(f.itemId)}`]); },
      });
      assert.equal(returned.stopReason, "quota", "the run stopped for quota, as its own reason");
      assert.equal(returned.label, "partial", "the result is published labelled partial");
      assert.equal(returned.record.state, "RETURNED");
      assert.equal(returned.releasedExecutor, true, "and that label is what releases the executor");
      assert.equal(returned.record.executor, null);
      assert.equal(returned.record.resultLabel, "partial");

      assert.equal(
        execFileSync("git", ["--git-dir", f.bare, "rev-parse", `refs/heads/${handoverBranch(f.itemId)}`], { encoding: "utf8" }).trim(),
        resultCommit, "the commits so far are pushed on the same branch",
      );
      const events = execFileSync("git", ["--git-dir", f.bare, "log", "--format=%s", (await f.control.read())!.head], { encoding: "utf8" });
      assert.equal(/RELEASED|release_work/.test(events), false, "no RELEASED state and no eighth action appear in the record");

      const db = database();
      try {
        const actions = db.prepare("SELECT DISTINCT action FROM task_control_action").all() as Array<{ action: string }>;
        assert.equal(actions.some(one => one.action === "release_work"), false, "nor in the database");
        assert.equal((db.prepare("SELECT COUNT(*) n FROM workspace_start_intent WHERE released_at IS NULL").get() as { n: number }).n, 0,
          "and the run has ended");
      } finally { db.close(); }

      assert.equal((await f.control.read())!.record.state, "RETURNED",
        "the item is never silently re-offered and never passed to a third party");
    } finally { f.dispose(); }
  });

  await t.test("Sixth: the requester may request Pause or Cancel, and only the current executor acknowledges the stop", async () => {
    const f = fixture("tm-t1-h2-stop");
    try {
      const offer = await publishedOffer(f);
      await claimed(f, offer);
      const started = await startReceiverRun(f.control, {
        env: f.env, itemId: f.itemId, offer, commandIdPrefix: "b-stop",
        clone: { directory: f.clone, worktreeRoot: f.worktreeRoot }, spawn: spawnStarted,
      });
      assert.equal(started.kind, "started");

      const requested = await requestExecutorStop(f.control, {
        itemId: f.itemId, actor: { personId: REQUESTER }, kind: "pause", commandId: "a-pause",
        roster: f.env.roster,
      });
      assert.equal(requested.record.state, "STOP_REQUESTED", "the request is recorded");
      assert.equal(requested.record.executor, RECEIVER, "and does not take the item back");

      await assert.rejects(
        () => acknowledgeExecutorStop(f.control, { itemId: f.itemId, actor: { personId: REQUESTER }, commandId: "a-ack", writingStopped: true, roster: f.env.roster }),
        (error: unknown) => error instanceof WorkspaceError && error.code === "control_actor_unauthorized",
        "the requester cannot acknowledge physical stop",
      );
      await assert.rejects(
        () => acknowledgeExecutorStop(f.control, { itemId: f.itemId, actor: { personId: RECEIVER }, commandId: "b-ack-unproven", writingStopped: false, roster: f.env.roster }),
        (error: unknown) => error instanceof WorkspaceError && error.code === "control_condition_unmet",
        "and the executor does not release until writing has stopped (B13)",
      );

      const acknowledged = await acknowledgeExecutorStop(f.control, {
        itemId: f.itemId, actor: { personId: RECEIVER }, commandId: "b-ack", writingStopped: true, roster: f.env.roster,
      });
      assert.equal(acknowledged.record.state, "PAUSED", "only the current executor acknowledges it");
    } finally { f.dispose(); }
  });

  await t.test("Sixth: reacquisition needs a validated proof, and without it the requester stays held", async () => {
    const f = fixture("tm-t1-h2-reacquire");
    try {
      const offer = await publishedOffer(f);
      await claimed(f, offer);
      await assert.rejects(
        () => reacquireOwnership(f.control, { itemId: f.itemId, actor: { personId: REQUESTER }, commandId: "a-seize", proof: { noOtherExecutor: true }, roster: f.env.roster }),
        (error: unknown) => error instanceof WorkspaceError && error.code === "control_state_invalid" && error.fields?.state === "CLAIMED",
        "there is no path by which env A takes a claimed item back",
      );

      const head = (await f.control.read())!.head;
      await applyControlTransition(f.control, {
        event: "stop_request", actor: { personId: REQUESTER }, commandId: "a-cancel", epoch: 1, roster: f.env.roster,
        fromHead: head, payload: { reason: "jd wants it back" },
      });
      await applyControlTransition(f.control, {
        event: "stop_proven", actor: { personId: RECEIVER }, commandId: "b-proved", epoch: 1, roster: f.env.roster,
        payload: { writingStopped: true, blocker: "none" },
      });
      await applyControlTransition(f.control, {
        event: "cancel_confirmed", actor: { personId: REQUESTER }, commandId: "a-cancelled", epoch: 1, roster: f.env.roster,
        payload: { activeWriter: false, outstandingStart: false },
      });
      await applyControlTransition(f.control, {
        event: "reopen", actor: { personId: REQUESTER }, commandId: "a-reopen", epoch: 1, roster: f.env.roster,
        payload: { requirementsRevision: "rev-2" },
      });
      assert.equal((await f.control.read())!.record.state, "LOCAL", "reacquisition runs through the table, never around it");
    } finally { f.dispose(); }
  });

  await t.test("Sixth: reacquisition without the proof fails with the current state", async () => {
    const f = fixture("tm-t1-h2-proof");
    try {
      const offer = await publishedOffer(f);
      const head = (await f.control.read())!.head;
      await applyControlTransition(f.control, {
        event: "withdraw_offer", actor: { personId: REQUESTER }, commandId: "a-withdraw", epoch: 1, fromHead: head,
      });
      await assert.rejects(
        () => reacquireOwnership(f.control, { itemId: f.itemId, actor: { personId: REQUESTER }, commandId: "a-unproven", proof: { noOtherExecutor: false }, roster: f.env.roster }),
        (error: unknown) => error instanceof WorkspaceError && error.code === "control_condition_unmet" && error.fields?.state === "WITHDRAWN",
        "where the proof cannot be produced the attempt fails with the current state",
      );
      assert.equal((await f.control.read())!.record.state, "WITHDRAWN", "and jd stays held rather than seizing");
      const ok = await reacquireOwnership(f.control, { itemId: f.itemId, actor: { personId: REQUESTER }, commandId: "a-proven", proof: { noOtherExecutor: true }, roster: f.env.roster });
      assert.equal(ok.record.state, "LOCAL");
      assert.equal(offer.epoch, 1);
    } finally { f.dispose(); }
  });

  await t.test("Sixth: a local completion records a cancel request, does not stop env B, and does not close the item until env B acknowledges", async () => {
    const f = fixture("tm-t1-h2-local-completion");
    try {
      const offer = await publishedOffer(f);
      await claimed(f, offer);
      const started = await startReceiverRun(f.control, {
        env: f.env, itemId: f.itemId, offer, commandIdPrefix: "b-local",
        clone: { directory: f.clone, worktreeRoot: f.worktreeRoot }, spawn: spawnStarted,
      });
      assert.equal(started.kind, "started");

      const cancelRequest = await recordLocalCompletionCancelRequest(f.control, {
        itemId: f.itemId, actor: { personId: REQUESTER }, commandId: "a-local-complete", roster: f.env.roster,
      });
      assert.equal(cancelRequest.cancelRequested, true, "completing locally records a cancel request");
      assert.equal(cancelRequest.record.state, "STOP_REQUESTED");
      assert.equal(cancelRequest.record.executor, RECEIVER, "and does not stop the receiver's run from the requester's side");
      assert.equal(cancelRequest.itemClosed, false, "the item is not closed yet");
      assert.equal(cancelRequest.branchKept, true, "and the branch is kept until the requester deletes it");

      const tooEarly = closeAfterHandover(cancelRequest.record, { itemId: f.itemId, commandId: "a-close-early" });
      assert.equal(tooEarly.closed, false, "closing before the receiver has acknowledged is refused");
      assert.equal(workspaces.itemLink(f.itemId)!.closedAt, null);

      const acknowledged = await acknowledgeExecutorStop(f.control, {
        itemId: f.itemId, actor: { personId: RECEIVER }, commandId: "b-local-ack", writingStopped: true, roster: f.env.roster,
      });
      const closed = closeAfterHandover(acknowledged.record, { itemId: f.itemId, commandId: "a-close" });
      assert.equal(closed.closed, true, "the item closes once the receiver's own workstation has stopped and acknowledged");
      assert.equal(workspaces.itemLink(f.itemId)!.closedAt !== null, true);
      assert.equal(
        execFileSync("git", ["--git-dir", f.bare, "rev-parse", "--verify", "-q", `refs/heads/${handoverBranch(f.itemId)}`], { encoding: "utf8" }).trim().length,
        40, "and the branch is still there",
      );
    } finally { f.dispose(); }
  });

  await t.test("Sixth: no module path stops the other workstation's run", () => {
    // Comments are stripped, so this asserts on what the module does rather than
    // on what it says about itself.
    const code = readFileSync(new URL("./teamHandoverRun.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/remoteStop|stopRemoteRun|forceRelease|seizeOwnership|overrideExecutor/.test(code), false,
      "no path exists by which env A stops env B's run, and no surface offers one");
    assert.equal(/\bRELEASED\b/.test(code), false, "and there is no RELEASED state");
    assert.equal(/\brelease_work\b/.test(code), false, "and no eighth action");
  });

  await t.test("Seventh: a teammate removed from the roster while OFFERED has their card retired, and the offer stays open", async () => {
    const f = fixture("tm-t1-h2-roster");
    try {
      const offer = await publishedOffer(f);
      const discovery = await discoverHandoverOffer(f.control, f.env);
      assert.equal(discovery.kind, "offer");
      if (discovery.kind !== "offer") return;
      const retired = retireHandoverCardsFor({ itemId: f.itemId, personId: RECEIVER, actorIds: [f.env.actorId] });
      assert.equal(retired.actorsDisabled, 1, "their group actor is disabled");
      // Grants on an offered item live on the requester's workstation, which is
      // the other environment, so env B holds none of its own to revoke here.
      assert.equal(retired.grantsRevoked, 0);

      const acceptRef = discovery.card.actions.find(one => one.action === "accept_offer")!.ref;
      assert.equal(Date.parse(workspaces.taskControlAction(acceptRef)!.expires_at) <= Date.now(), true, "so their card goes inert");
      assert.equal((await f.control.read())!.record.state, "OFFERED", "and the offer stays open for a remaining member");

      const other = secondReceiver(f);
      assert.equal((await acceptHandoverOffer(f.control, { env: other, itemId: f.itemId, offer, commandId: "b-sam" })).kind, "claimed");
    } finally { f.dispose(); }
  });

  await t.test("Seventh: a removed member's grants on a claimed item are revoked with their cards", async () => {
    const f = fixture("tm-t1-h2-roster-grants");
    try {
      const offer = await publishedOffer(f);
      await claimed(f, offer);
      workspaces.grantItemCapability({ itemId: f.itemId, personId: RECEIVER, capability: "answer", commandId: "grant-1" });
      workspaces.grantItemCapability({ itemId: f.itemId, personId: RECEIVER, capability: "resume", commandId: "grant-2" });
      const retired = retireHandoverCardsFor({ itemId: f.itemId, personId: RECEIVER, actorIds: [f.env.actorId] });
      assert.equal(retired.grantsRevoked, 2, "their grants are revoked with their cards");
      assert.equal(workspaces.itemGrants(f.itemId, { activeOnly: true }).length, 0);
      assert.equal(workspaces.itemGrants(f.itemId).length, 2, "and the grant history is kept, not deleted");
    } finally { f.dispose(); }
  });

  await t.test("Seventh: Team or handover disabled stops cards applying and leaves the record untouched", async () => {
    const f = fixture("tm-t1-h2-disabled");
    try {
      const before = await publishedOffer(f);
      const head = (await f.control.read())!.head;
      assert.throws(
        () => assertHandoverEnabled({ teamEnabled: false, handoverEnabled: true }),
        (error: unknown) => error instanceof WorkspaceError && error.status === 403 && error.code === "team_disabled",
      );
      assert.throws(
        () => assertHandoverEnabled({ teamEnabled: true, handoverEnabled: false }),
        (error: unknown) => error instanceof WorkspaceError && error.status === 403 && error.code === "handover_disabled",
      );
      assertHandoverEnabled({ teamEnabled: true, handoverEnabled: true });
      assert.equal((await f.control.read())!.head, head, "the record is untouched, so the handover resumes when it is re-enabled");
      assert.equal(before.epoch, 1);
    } finally { f.dispose(); }
  });

  await t.test("Seventh: the gate itself - a handover tap is routed only when Team and handover are both enabled", async () => {
    const f = fixture("tm-t1-h2-gate");
    try {
      const offer = await publishedOffer(f);
      const discovery = await discoverHandoverOffer(f.control, f.env);
      assert.equal(discovery.kind, "offer");
      if (discovery.kind !== "offer") return;
      const acceptRef = discovery.card.actions.find(one => one.action === "accept_offer")!.ref;
      const actor = workspaces.taskControlActorById(f.env.actorId)!;

      const service = (teamEnabled: boolean, handoverEnabled: boolean) => new TaskControlService({
        enabled: true, teamEnabled, handoverEnabled,
        notificationsEnabled: true, remoteActionsEnabled: true,
        transport: "fake_telegram", botId: f.env.botId,
      });
      const tap = (commandId: string) => ({
        ref: acceptRef, transportUserId: actor.transport_user_id, chatId: actor.chat_id,
        topicId: null, botId: f.env.botId, messageId: `handover-${f.itemId}`, commandId,
      });

      const teamOff = await service(false, true).handleCallback(tap("gate-team-off"));
      assert.equal(teamOff.state, "REJECTED");
      assert.equal(teamOff.errorCode, "team_disabled", "Team disabled answers 403 and stops the card applying");

      const handoverOff = await service(true, false).handleCallback(tap("gate-handover-off"));
      assert.equal(handoverOff.state, "REJECTED");
      assert.equal(handoverOff.errorCode, "handover_disabled", "and handover has its own capability, refused on its own");

      const unattached = await service(true, true).handleCallback(tap("gate-no-runtime"));
      assert.equal(unattached.errorCode, "action_not_available", "with both on but no runtime attached, the tap is still refused");

      const routed = service(true, true);
      const seen: string[] = [];
      routed.registerHandoverTapHandler(async handoverTap => {
        seen.push(`${handoverTap.action}:${handoverTap.itemId}:${handoverTap.epoch}`);
        return workspaces.recordTaskControlReceipt({
          commandId: handoverTap.commandId, actionRef: handoverTap.actionRef, state: "APPLIED", message: "Routed.",
        });
      });
      const applied = await routed.handleCallback(tap("gate-routed"));
      assert.equal(applied.state, "APPLIED");
      assert.deepEqual(seen, [`accept_offer:${f.itemId}:1`], "and with both on the tap reaches the handover runtime with its item and epoch");
      assert.equal((await f.control.read())!.head.length, 40, "the record is untouched by any of the refusals");
      assert.equal((await f.control.read())!.record.state, "OFFERED");
    } finally { f.dispose(); }
  });

  await t.test("Standing: Team and handover are both off by default", () => {
    assert.equal(settings.team.enabled, false);
    assert.equal(settings.team.handoverEnabled, false);
  });
});
