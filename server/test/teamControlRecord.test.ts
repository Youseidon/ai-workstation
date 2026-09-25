import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import { HANDOVER_ACTIONS, type ProgramRecord, type PromptRecord, type SuiteRecord } from "@agent-console/shared";
import {
  BareGitControlRecordRemote,
  CONTROL_STATES,
  CONTROL_TRANSITIONS,
  OFFER_DEADLINE_MS,
  applyControlTransition,
  controlRef,
  createControlRecord,
  controlTransition,
  expireOfferIfDue,
  handoverBranch,
  newControlRecord,
  type ControlRecord,
  type ControlRecordRemote,
  type ControlState,
  type ControlTransitionInput,
} from "../src/teamControlRecord.ts";
import { WorkspaceError, workspaces } from "../src/workspaces.ts";

/*
 * The suite sets AGENT_CONSOLE_DB and SETTINGS_FILE for the whole process. A
 * child given its own repo root must not inherit them, or it writes to the
 * suite's database instead of the root under test. Same reasoning as
 * dodCommands.ts, which strips AGENT_CONSOLE_DB from verification commands.
 *
 * Deleting them is no longer enough. The database now defaults to the XDG
 * state directory rather than the repo root, so a child with only a repo root
 * resolves the developer's own live database - which the dev-on-live guard in
 * workspaces.ts then refuses outright, and would otherwise have written to.
 * The child is therefore pointed at its own file inside the root under test,
 * which is also the path these migration checks open afterwards.
 */
function childEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_CONSOLE_REPO_ROOT: root,
    AGENT_CONSOLE_DB: join(root, ".agent-console/console.sqlite"),
    SETTINGS_FILE: join(root, ".agent-console/settings.json"),
  };
}


const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function runWorkspaceScript(root: string, source: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "-e", source], {
    cwd: serverDir,
    env: childEnv(root),
    encoding: "utf8",
    timeout: 60_000,
  });
}

function boot(root: string) {
  return runWorkspaceScript(root, "const { workspaces } = await import('./src/workspaces.ts'); workspaces.close();");
}
const ITEM = "awi1_0123456789abcdef01234567";
const REQUESTER = "jd";
const RECEIVER = "yousef";
const OUTSIDER = "stranger";
const ROSTER = [REQUESTER, RECEIVER, "third"];

function bareRepository(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "--bare", "-q", directory]);
  return directory;
}

function gitOut(directory: string, args: string[]) {
  return execFileSync("git", ["--git-dir", directory, ...args], { encoding: "utf8" }).trim();
}

/** Drives the record from LOCAL to the named state so a row can be exercised from a valid predecessor. */
async function drive(remote: ControlRecordRemote, steps: Array<Partial<ControlTransitionInput> & { event: ControlTransitionInput["event"]; actor: { personId: string } }>, prefix: string) {
  let last;
  let index = 0;
  for (const step of steps) {
    index += 1;
    last = await applyControlTransition(remote, {
      commandId: `${prefix}-${index}`,
      roster: ROSTER,
      epoch: (await remote.read())!.record.epoch,
      ...step,
    } as ControlTransitionInput);
  }
  return last!;
}

const OFFER_PAYLOAD = { writersStopped: true, packageVerified: true, branchVerified: true };

/** The whole TM4 walk of protocol.md section 5, as one ordered list of rows. */
const WALK: Array<{ event: ControlTransitionInput["event"]; person: string; payload?: ControlTransitionInput["payload"]; to: ControlState; epoch: number }> = [
  { event: "request_takeover", person: REQUESTER, payload: { sourceHoldPersisted: true }, to: "PREPARING", epoch: 0 },
  { event: "publish_offer", person: REQUESTER, payload: OFFER_PAYLOAD, to: "OFFERED", epoch: 1 },
  { event: "accept_offer", person: RECEIVER, to: "CLAIMED", epoch: 1 },
  { event: "preparation_complete", person: RECEIVER, payload: { policyChecked: true, workspaceReserved: true, startIntentDurable: true }, to: "STARTING", epoch: 1 },
  { event: "run_started", person: RECEIVER, payload: { runId: "run-1" }, to: "RUNNING", epoch: 1 },
  { event: "blocking_decision", person: RECEIVER, payload: { reason: "A requirement question" }, to: "STOP_REQUESTED", epoch: 1 },
  { event: "stop_proven", person: RECEIVER, payload: { writingStopped: true, blocker: "required" }, to: "WAITING_INPUT", epoch: 1 },
  { event: "save_answer", person: REQUESTER, payload: { answer: "Use blue." }, to: "WAITING_INPUT", epoch: 1 },
  { event: "resume", person: RECEIVER, payload: { unresolvedRequired: 0, policyChecked: true, workspaceReserved: true, startIntentDurable: true }, to: "STARTING", epoch: 1 },
  { event: "run_started", person: RECEIVER, payload: { runId: "run-2" }, to: "RUNNING", epoch: 1 },
  { event: "run_ended", person: RECEIVER, payload: { outcome: "partial" }, to: "PAUSED", epoch: 1 },
  { event: "return_work", person: RECEIVER, payload: { resultCommit: "c0ffee", resultLabel: "partial" }, to: "RETURNED", epoch: 1 },
  { event: "request_changes", person: REQUESTER, payload: { ...OFFER_PAYLOAD, requirementsRevision: "rev-2" }, to: "OFFERED", epoch: 2 },
  { event: "accept_offer", person: RECEIVER, to: "CLAIMED", epoch: 2 },
  { event: "preparation_complete", person: RECEIVER, payload: { policyChecked: true, workspaceReserved: true, startIntentDurable: true }, to: "STARTING", epoch: 2 },
  { event: "run_started", person: RECEIVER, payload: { runId: "run-3" }, to: "RUNNING", epoch: 2 },
  { event: "run_ended", person: RECEIVER, payload: { outcome: "full" }, to: "PAUSED", epoch: 2 },
  { event: "return_work", person: RECEIVER, payload: { resultCommit: "dec0de", resultLabel: "full" }, to: "RETURNED", epoch: 2 },
  { event: "apply_result", person: REQUESTER, payload: { baselineValidated: true }, to: "APPLYING", epoch: 3 },
  { event: "application_reconciled", person: REQUESTER, payload: { acceptanceMet: true }, to: "COMPLETED", epoch: 3 },
];

test("TM-T0-6: the item control record builds protocol.md section 5, arbitrates races and recovers", async (t) => {
  await t.test("Ref namespace: a custom ref outside refs/heads, whose divergent update the host rejects", async () => {
    const directory = bareRepository("tm-t0-6-ns-");
    try {
      assert.equal(controlRef(ITEM), `refs/aw/items/${ITEM}/control`);
      assert.equal(controlRef(ITEM).startsWith("refs/heads/"), false);
      assert.equal(handoverBranch(ITEM), `aw/handover/${ITEM}`);
      const remote = new BareGitControlRecordRemote(directory, ITEM);
      const created = await createControlRecord(remote, { itemId: ITEM, requester: REQUESTER, commandId: "ns-create" });
      assert.equal(created.record.state, "LOCAL");
      assert.equal(gitOut(directory, ["show-ref"]).includes(`refs/aw/items/${ITEM}/control`), true);
      assert.equal(gitOut(directory, ["for-each-ref", "--format=%(refname)", "refs/heads/"]), "");

      // A divergent update from the same parent, offered against a head that is no
      // longer current, is what the host rejects; that rejection is the compare-and-swap.
      const head = created.head;
      await drive(remote, [{ event: "request_takeover", actor: { personId: REQUESTER }, payload: { sourceHoldPersisted: true } }], "ns");
      const divergent = spawnSync("git", ["--git-dir", directory, "update-ref", controlRef(ITEM), head, head], { encoding: "utf8" });
      assert.notEqual(divergent.status, 0, "a stale expected head is refused");
      assert.equal(gitOut(directory, ["rev-parse", controlRef(ITEM)]) !== head, true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  await t.test("Lifecycle: every TM4 transition from a valid predecessor, in order", async () => {
    const directory = bareRepository("tm-t0-6-walk-");
    try {
      const remote = new BareGitControlRecordRemote(directory, ITEM);
      let previous = await createControlRecord(remote, { itemId: ITEM, requester: REQUESTER, commandId: "walk-create" });
      assert.equal(previous.record.epoch, 0, "the initial source owns epoch 0");
      let step = 0;
      for (const row of WALK) {
        step += 1;
        const from = previous.record.state;
        // An unauthorized actor is refused from the same valid predecessor, and writes nothing.
        await assert.rejects(
          () => applyControlTransition(remote, { event: row.event, actor: { personId: OUTSIDER }, commandId: `walk-denied-${step}`, epoch: previous.record.epoch, roster: ROSTER, payload: row.payload }),
          (error: unknown) => error instanceof WorkspaceError && error.code === "control_actor_unauthorized" && error.fields?.state === from,
          `${row.event} refuses an unauthorized actor`,
        );
        assert.equal((await remote.read())!.record.lastCommandId !== `walk-denied-${step}`, true);
        const applied = await applyControlTransition(remote, { event: row.event, actor: { personId: row.person }, commandId: `walk-${step}`, epoch: previous.record.epoch, roster: ROSTER, payload: row.payload });
        assert.equal(applied.record.state, row.to, `${row.event} from ${from}`);
        assert.equal(applied.record.epoch, row.epoch, `${row.event} leaves epoch ${row.epoch}`);
        assert.equal(applied.event.fromState, from);
        assert.equal(applied.event.toState, row.to);
        previous = applied;
      }
      assert.equal(previous.record.state, "COMPLETED");
      assert.equal(previous.record.executor, null, "COMPLETED holds no executor");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  await t.test("Lifecycle: every remaining TM4 transition of the table", async () => {
    const cases: Array<{ name: string; steps: Array<{ event: ControlTransitionInput["event"]; person: string; payload?: ControlTransitionInput["payload"] }>; to: ControlState }> = [
      { name: "decline", steps: [{ event: "request_takeover", person: REQUESTER, payload: { sourceHoldPersisted: true } }, { event: "publish_offer", person: REQUESTER, payload: OFFER_PAYLOAD }, { event: "decline_offer", person: RECEIVER }], to: "WITHDRAWN" },
      { name: "withdraw", steps: [{ event: "request_takeover", person: REQUESTER, payload: { sourceHoldPersisted: true } }, { event: "publish_offer", person: REQUESTER, payload: OFFER_PAYLOAD }, { event: "withdraw_offer", person: REQUESTER }], to: "WITHDRAWN" },
      {
        name: "withdrawn to cancelled",
        steps: [{ event: "request_takeover", person: REQUESTER, payload: { sourceHoldPersisted: true } }, { event: "publish_offer", person: REQUESTER, payload: OFFER_PAYLOAD }, { event: "withdraw_offer", person: REQUESTER }, { event: "cancel_confirmed", person: REQUESTER, payload: { activeWriter: false, outstandingStart: false } }],
        to: "CANCELLED",
      },
      {
        name: "paused to cancelled",
        steps: [
          { event: "request_takeover", person: REQUESTER, payload: { sourceHoldPersisted: true } },
          { event: "publish_offer", person: REQUESTER, payload: OFFER_PAYLOAD },
          { event: "accept_offer", person: RECEIVER },
          { event: "preparation_complete", person: RECEIVER, payload: { policyChecked: true, workspaceReserved: true, startIntentDurable: true } },
          { event: "run_started", person: RECEIVER, payload: { runId: "run-c" } },
          { event: "run_ended", person: RECEIVER, payload: { outcome: "error" } },
          { event: "cancel_confirmed", person: REQUESTER, payload: { activeWriter: false, outstandingStart: false } },
        ],
        to: "CANCELLED",
      },
      {
        name: "stop request then pause",
        steps: [
          { event: "request_takeover", person: REQUESTER, payload: { sourceHoldPersisted: true } },
          { event: "publish_offer", person: REQUESTER, payload: OFFER_PAYLOAD },
          { event: "accept_offer", person: RECEIVER },
          { event: "stop_request", person: REQUESTER, payload: { reason: "Pause requested" } },
          { event: "stop_proven", person: RECEIVER, payload: { writingStopped: true, blocker: "none" } },
        ],
        to: "PAUSED",
      },
      {
        name: "partial application stays resumable",
        steps: [
          { event: "request_takeover", person: REQUESTER, payload: { sourceHoldPersisted: true } },
          { event: "publish_offer", person: REQUESTER, payload: OFFER_PAYLOAD },
          { event: "accept_offer", person: RECEIVER },
          { event: "preparation_complete", person: RECEIVER, payload: { policyChecked: true, workspaceReserved: true, startIntentDurable: true } },
          { event: "run_started", person: RECEIVER, payload: { runId: "run-p" } },
          { event: "run_ended", person: RECEIVER, payload: { outcome: "partial" } },
          { event: "return_work", person: RECEIVER, payload: { resultCommit: "abc", resultLabel: "partial" } },
          { event: "apply_result", person: REQUESTER, payload: { baselineValidated: true } },
          { event: "application_reconciled", person: REQUESTER, payload: { acceptanceMet: false } },
        ],
        to: "PAUSED",
      },
    ];
    for (const one of cases) {
      const directory = bareRepository("tm-t0-6-rows-");
      try {
        const remote = new BareGitControlRecordRemote(directory, ITEM);
        const slug = one.name.replace(/\s+/g, "-");
        await createControlRecord(remote, { itemId: ITEM, requester: REQUESTER, commandId: `${slug}-create` });
        const last = await drive(remote, one.steps.map(step => ({ event: step.event, actor: { personId: step.person }, payload: step.payload })), slug);
        assert.equal(last.record.state, one.to, one.name);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  await t.test("Authorization: an invalid predecessor is refused for every row of the table", () => {
    const base = newControlRecord({ itemId: ITEM, requester: REQUESTER, now: new Date("2026-09-21T00:00:00.000Z") });
    let checked = 0;
    for (const row of CONTROL_TRANSITIONS) {
      for (const state of CONTROL_STATES) {
        if (row.from.includes(state)) continue;
        checked += 1;
        const record: ControlRecord = { ...base, state, epoch: 1, executor: RECEIVER, offerDeadline: new Date("2099-01-01T00:00:00.000Z").toISOString(), resultLabel: "full" };
        assert.throws(
          () => controlTransition(record, { event: row.event, actor: { personId: REQUESTER }, commandId: `x-${row.event}-${state}`, epoch: 1, roster: ROSTER, payload: { sourceHoldPersisted: true, writersStopped: true, packageVerified: true, branchVerified: true, policyChecked: true, workspaceReserved: true, startIntentDurable: true, runId: "r", writingStopped: true, answer: "a", unresolvedRequired: 0, outcome: "full", resultCommit: "c", resultLabel: "full", baselineValidated: true, acceptanceMet: true, requirementsRevision: "rev", activeWriter: false, outstandingStart: false, noOtherExecutor: true, spawnOutcome: "known", reason: "r" } }),
          (error: unknown) => error instanceof WorkspaceError && error.code === "control_state_invalid" && error.fields?.state === state,
          `${row.event} must be refused from ${state}`,
        );
      }
    }
    assert.ok(checked > 0);
  });

  await t.test("Authorization: a stale epoch can never become valid again", async () => {
    const directory = bareRepository("tm-t0-6-epoch-");
    try {
      const remote = new BareGitControlRecordRemote(directory, ITEM);
      await createControlRecord(remote, { itemId: ITEM, requester: REQUESTER, commandId: "epoch-create" });
      await drive(remote, [
        { event: "request_takeover", actor: { personId: REQUESTER }, payload: { sourceHoldPersisted: true } },
        { event: "publish_offer", actor: { personId: REQUESTER }, payload: OFFER_PAYLOAD },
      ], "epoch");
      const current = (await remote.read())!.record;
      assert.equal(current.epoch, 1, "publication advances the epoch");
      await assert.rejects(
        () => applyControlTransition(remote, { event: "accept_offer", actor: { personId: RECEIVER }, commandId: "epoch-stale", epoch: 0, roster: ROSTER }),
        (error: unknown) => error instanceof WorkspaceError && error.code === "control_stale_epoch" && error.fields?.state === "OFFERED" && error.fields?.epoch === "1",
        "a command bound to a superseded epoch is refused",
      );
      await drive(remote, [{ event: "withdraw_offer", actor: { personId: REQUESTER } }], "epoch-w");
      const withdrawn = (await remote.read())!.record;
      assert.equal(withdrawn.epoch, 2, "withdrawal advances the epoch");
      await drive(remote, [{ event: "reacquire", actor: { personId: REQUESTER }, payload: { noOtherExecutor: true } }], "epoch-r");
      assert.equal((await remote.read())!.record.epoch, 3, "source reacquisition advances the epoch");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  await t.test("Repository: one single-parent commit per transition, state.json and one event each", async () => {
    const directory = bareRepository("tm-t0-6-repo-");
    try {
      const remote = new BareGitControlRecordRemote(directory, ITEM);
      await createControlRecord(remote, { itemId: ITEM, requester: REQUESTER, commandId: "repo-create" });
      await drive(remote, [
        { event: "request_takeover", actor: { personId: REQUESTER }, payload: { sourceHoldPersisted: true } },
        { event: "publish_offer", actor: { personId: REQUESTER }, payload: OFFER_PAYLOAD },
        { event: "accept_offer", actor: { personId: RECEIVER } },
      ], "repo");
      const ref = controlRef(ITEM);
      const commits = gitOut(directory, ["rev-list", ref]).split("\n");
      assert.equal(commits.length, 4, "one commit for the record and one per transition");
      for (const line of gitOut(directory, ["rev-list", "--parents", ref]).split("\n")) {
        const parts = line.split(" ");
        assert.ok(parts.length <= 2, "every control commit has at most one parent");
      }
      const tree = gitOut(directory, ["ls-tree", "--name-only", ref]).split("\n").sort();
      assert.deepEqual(tree, ["events", "state.json"]);
      const events = gitOut(directory, ["ls-tree", "--name-only", `${ref}:events`]).split("\n").sort();
      assert.deepEqual(events, ["repo-1.json", "repo-2.json", "repo-3.json", "repo-create.json"]);
      const state = JSON.parse(gitOut(directory, ["cat-file", "blob", `${ref}:state.json`])) as ControlRecord;
      assert.deepEqual(
        { state: state.state, epoch: state.epoch, requester: state.requester, executor: state.executor, branch: state.branch, lastCommandId: state.lastCommandId },
        { state: "CLAIMED", epoch: 1, requester: REQUESTER, executor: RECEIVER, branch: handoverBranch(ITEM), lastCommandId: "repo-3" },
      );
      const event = JSON.parse(gitOut(directory, ["cat-file", "blob", `${ref}:events/repo-3.json`])) as { commandId: string; fromState: string; toState: string; parent: string | null };
      assert.equal(event.commandId, "repo-3");
      assert.equal(event.fromState, "OFFERED");
      assert.equal(event.toState, "CLAIMED");
      assert.equal(event.parent, commits[1], "the event names the parent control commit");

      // Every earlier head is still an ancestor: nothing was rewritten or dropped.
      for (const commit of commits.slice(1)) {
        assert.equal(spawnSync("git", ["--git-dir", directory, "merge-base", "--is-ancestor", commit, commits[0]!]).status, 0);
      }
      const source = readFileSync(new URL("../src/teamControlRecord.ts", import.meta.url), "utf8");
      assert.doesNotMatch(source, /--force|force-with-lease|push\s+-f|update-ref\s+-d|"-d"|--delete|"merge"/, "no code path force-pushes, deletes control history or merges two state.json files");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  await t.test("Race: two accepts from the same head, exactly one winner, and the loser re-validates", async () => {
    const directory = bareRepository("tm-t0-6-race-");
    try {
      const remote = new BareGitControlRecordRemote(directory, ITEM);
      await createControlRecord(remote, { itemId: ITEM, requester: REQUESTER, commandId: "race-create" });
      await drive(remote, [
        { event: "request_takeover", actor: { personId: REQUESTER }, payload: { sourceHoldPersisted: true } },
        { event: "publish_offer", actor: { personId: REQUESTER }, payload: OFFER_PAYLOAD },
      ], "race");
      const head = (await remote.read())!.head;
      const both = await Promise.allSettled([
        applyControlTransition(remote, { event: "accept_offer", actor: { personId: RECEIVER }, commandId: "race-accept-b", epoch: 1, roster: ROSTER, fromHead: head }),
        applyControlTransition(remote, { event: "accept_offer", actor: { personId: "third" }, commandId: "race-accept-c", epoch: 1, roster: ROSTER, fromHead: head }),
      ]);
      const winners = both.filter(one => one.status === "fulfilled");
      const losers = both.filter(one => one.status === "rejected");
      assert.equal(winners.length, 1, "exactly one accept wins");
      assert.equal(losers.length, 1, "exactly one accept loses");
      const rejection = (losers[0] as PromiseRejectedResult).reason as WorkspaceError;
      assert.equal(rejection.code, "control_conflict");
      assert.equal(rejection.fields?.state, "CLAIMED", "the loser is told the state that actually exists");
      const settled = (await remote.read())!.record;
      assert.equal(settled.state, "CLAIMED");
      const winner = (winners[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof applyControlTransition>>>).value;
      assert.equal(settled.executor, winner.record.executor);
      assert.equal(settled.lastCommandId, winner.event.commandId);
      // The claim that lost stays lost: retrying it is refused against the state that exists.
      await assert.rejects(
        () => applyControlTransition(remote, { event: "accept_offer", actor: { personId: settled.executor === RECEIVER ? "third" : RECEIVER }, commandId: "race-retry", epoch: 1, roster: ROSTER }),
        (error: unknown) => error instanceof WorkspaceError && error.code === "control_state_invalid" && error.fields?.state === "CLAIMED",
      );
      assert.equal(gitOut(directory, ["ls-tree", "--name-only", `${controlRef(ITEM)}:events`]).split("\n").length, 4, "the lost claim recorded no event");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  await t.test("Uncertain push: resolved by looking for the command id, never by blind retry", async () => {
    const directory = bareRepository("tm-t0-6-uncertain-");
    try {
      const inner = new BareGitControlRecordRemote(directory, ITEM);
      let appends = 0;
      let hideOutcome = false;
      const remote: ControlRecordRemote = {
        read: () => inner.read(),
        readEvent: (commandId: string) => inner.readEvent(commandId),
        async append(expected, record, event) {
          appends += 1;
          const result = await inner.append(expected, record, event);
          return hideOutcome ? "uncertain" : result;
        },
      };
      await createControlRecord(remote, { itemId: ITEM, requester: REQUESTER, commandId: "unc-create" });
      await drive(remote, [{ event: "request_takeover", actor: { personId: REQUESTER }, payload: { sourceHoldPersisted: true } }], "unc");
      hideOutcome = true;
      const before = appends;
      const resolved = await applyControlTransition(remote, { event: "publish_offer", actor: { personId: REQUESTER }, commandId: "unc-publish", epoch: 0, roster: ROSTER, payload: OFFER_PAYLOAD });
      assert.equal(appends - before, 1, "the uncertain push is not retried blindly");
      assert.equal(resolved.applied, false, "the outcome already present is returned rather than re-applied");
      assert.equal(resolved.record.state, "OFFERED");
      assert.equal(resolved.event.commandId, "unc-publish");
      const events = gitOut(directory, ["ls-tree", "--name-only", `${controlRef(ITEM)}:events`]).split("\n");
      assert.equal(events.filter(name => name === "unc-publish.json").length, 1, "no event is recorded twice");
      hideOutcome = false;
      // A re-delivery of the same command id returns the recorded outcome and writes nothing.
      const replay = await applyControlTransition(remote, { event: "publish_offer", actor: { personId: REQUESTER }, commandId: "unc-publish", epoch: 0, roster: ROSTER, payload: OFFER_PAYLOAD });
      assert.equal(replay.applied, false);
      assert.equal(replay.event.commandId, "unc-publish");
      assert.equal(gitOut(directory, ["rev-list", "--count", controlRef(ITEM)]), "3");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  await t.test("Expiry: recorded, not inferred, and powerless against an existing claim", async () => {
    const published = new Date("2026-09-21T00:00:00.000Z");
    const directory = bareRepository("tm-t0-6-expiry-");
    try {
      const remote = new BareGitControlRecordRemote(directory, ITEM);
      await createControlRecord(remote, { itemId: ITEM, requester: REQUESTER, commandId: "exp-create", now: published });
      await drive(remote, [
        { event: "request_takeover", actor: { personId: REQUESTER }, payload: { sourceHoldPersisted: true }, now: published },
        { event: "publish_offer", actor: { personId: REQUESTER }, payload: OFFER_PAYLOAD, now: published },
      ], "exp");
      const offered = (await remote.read())!.record;
      assert.equal(offered.offerDeadline, new Date(published.getTime() + OFFER_DEADLINE_MS).toISOString(), "the offer carries the deadline it was published with, 24 hours by default");
      assert.equal(OFFER_DEADLINE_MS, 24 * 60 * 60 * 1000);

      // Before the deadline nothing is written.
      const early = await expireOfferIfDue(remote, { actor: { personId: REQUESTER }, commandId: "exp-early", roster: ROSTER, now: new Date(published.getTime() + 60_000) });
      assert.equal(early.expired, false);
      assert.equal(gitOut(directory, ["rev-list", "--count", controlRef(ITEM)]), "3");

      const late = new Date(published.getTime() + OFFER_DEADLINE_MS + 1000);
      const expired = await expireOfferIfDue(remote, { actor: { personId: REQUESTER }, commandId: "exp-expire", roster: ROSTER, now: late });
      assert.equal(expired.expired, true, "expiry moves OFFERED to WITHDRAWN through the same validated shared update");
      assert.equal(expired.outcome!.record.state, "WITHDRAWN");
      assert.equal(expired.outcome!.event.event, "expire_offer");
      assert.equal(expired.outcome!.event.commandId, "exp-expire", "expiry carries its own command id, so it is recorded rather than inferred");

      // A second evaluation returns the existing outcome and writes nothing further.
      const again = await expireOfferIfDue(remote, { actor: { personId: REQUESTER }, commandId: "exp-expire-again", roster: ROSTER, now: late });
      assert.equal(again.expired, false);
      assert.equal(again.record.state, "WITHDRAWN");
      assert.equal(gitOut(directory, ["rev-list", "--count", controlRef(ITEM)]), "4", "the second evaluation writes nothing further");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    const claimed = bareRepository("tm-t0-6-expiry-claim-");
    try {
      const remote = new BareGitControlRecordRemote(claimed, ITEM);
      await createControlRecord(remote, { itemId: ITEM, requester: REQUESTER, commandId: "clm-create", now: published });
      await drive(remote, [
        { event: "request_takeover", actor: { personId: REQUESTER }, payload: { sourceHoldPersisted: true }, now: published },
        { event: "publish_offer", actor: { personId: REQUESTER }, payload: OFFER_PAYLOAD, now: published },
        { event: "accept_offer", actor: { personId: RECEIVER }, now: published },
      ], "clm");
      const late = new Date(published.getTime() + OFFER_DEADLINE_MS + 1000);
      const attempt = await expireOfferIfDue(remote, { actor: { personId: REQUESTER }, commandId: "clm-expire", roster: ROSTER, now: late });
      assert.equal(attempt.expired, false, "expiry cannot affect a claim that already exists");
      assert.equal(attempt.record.state, "CLAIMED");
      assert.equal(attempt.record.executor, RECEIVER);
      await assert.rejects(
        () => applyControlTransition(remote, { event: "expire_offer", actor: { personId: REQUESTER }, commandId: "clm-expire-forced", epoch: 1, roster: ROSTER, now: late }),
        (error: unknown) => error instanceof WorkspaceError && error.code === "control_state_invalid" && error.fields?.state === "CLAIMED",
        "the expiry attempt is refused with the current state",
      );
      // An expired offer does not end the item: the requester may publish a fresh offer at a new epoch.
      const reoffer = bareRepository("tm-t0-6-reoffer-");
      try {
        const second = new BareGitControlRecordRemote(reoffer, ITEM);
        await createControlRecord(second, { itemId: ITEM, requester: REQUESTER, commandId: "ro-create", now: published });
        await drive(second, [
          { event: "request_takeover", actor: { personId: REQUESTER }, payload: { sourceHoldPersisted: true }, now: published },
          { event: "publish_offer", actor: { personId: REQUESTER }, payload: OFFER_PAYLOAD, now: published },
        ], "ro");
        const late2 = new Date(published.getTime() + OFFER_DEADLINE_MS + 1000);
        await expireOfferIfDue(second, { actor: { personId: REQUESTER }, commandId: "ro-expire", roster: ROSTER, now: late2 });
        const back = await drive(second, [
          { event: "reacquire", actor: { personId: REQUESTER }, payload: { noOtherExecutor: true }, now: late2 },
          { event: "request_takeover", actor: { personId: REQUESTER }, payload: { sourceHoldPersisted: true }, now: late2 },
          { event: "publish_offer", actor: { personId: REQUESTER }, payload: OFFER_PAYLOAD, now: late2 },
        ], "ro2");
        assert.equal(back.record.state, "OFFERED");
        assert.equal(back.record.epoch, 4, "the fresh offer is published at a new epoch");
      } finally {
        rmSync(reoffer, { recursive: true, force: true });
      }
    } finally {
      rmSync(claimed, { recursive: true, force: true });
    }
  });

  await t.test("Durable: control_head is written on every accepted transition and read back", async () => {
    const directory = bareRepository("tm-t0-6-durable-");
    const workDirectory = mkdtempSync(join(tmpdir(), "tm-t0-6-ws-"));
    const workspace = workspaces.create({ name: workDirectory, workDirectory });
    try {
      const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
      const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
      const prompt = workspaces.createChild("prompt", suite.id, { title: "Handover item", content: "Needs help" }) as PromptRecord;
      const link = workspaces.createItemLink({ promptId: prompt.id, role: "requester", epoch: 1 });
      assert.equal(link.controlHead, null, "control_head starts as the placeholder it has always been");
      const remote = new BareGitControlRecordRemote(directory, link.itemId);
      const created = await createControlRecord(remote, { itemId: link.itemId, requester: REQUESTER, commandId: "dur-create" });
      assert.equal(workspaces.itemLink(link.itemId)!.controlHead, created.head, "the record head is written back to item_link");
      const after = await drive(remote, [
        { event: "request_takeover", actor: { personId: REQUESTER }, payload: { sourceHoldPersisted: true } },
        { event: "publish_offer", actor: { personId: REQUESTER }, payload: OFFER_PAYLOAD },
      ], "dur");
      const stored = workspaces.itemLink(link.itemId)!;
      assert.equal(stored.controlHead, after.head, "every accepted transition updates control_head");
      assert.equal(stored.epoch, 1, "item_link follows the record's epoch once it is published");

      // A workstation whose local row is behind re-reads the record and does not
      // re-apply a command id already present in it.
      workspaces.updateItemControlHead({ itemId: link.itemId, controlHead: created.head });
      const replay = await applyControlTransition(remote, { event: "publish_offer", actor: { personId: REQUESTER }, commandId: "dur-2", epoch: 0, roster: ROSTER, payload: OFFER_PAYLOAD });
      assert.equal(replay.applied, false, "a command id already in the record is not applied twice");
      assert.equal(workspaces.itemLink(link.itemId)!.controlHead, after.head, "the behind workstation catches up to the record");
      assert.equal(gitOut(directory, ["rev-list", "--count", controlRef(link.itemId)]), "3");
    } finally {
      workspaces.remove(workspace.id);
      rmSync(workDirectory, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  await t.test("Durable: control_head survives a restart", () => {
    const root = mkdtempSync(join(tmpdir(), "tm-t0-6-restart-"));
    try {
      mkdirSync(join(root, ".agent-console"), { recursive: true });
      mkdirSync(join(root, "workspace"));
      const bare = bareRepository("tm-t0-6-restart-git-");
      const written = spawnSync(process.execPath, ["--import", "tsx", "-e", `
        const { workspaces } = await import('./src/workspaces.ts');
        const { BareGitControlRecordRemote, applyControlTransition, createControlRecord } = await import('./src/teamControlRecord.ts');
        const workspace = workspaces.create({ name: 'control-restart', workDirectory: ${JSON.stringify(join(root, "workspace"))} });
        const program = workspaces.createChild('program', workspace.id, { name: 'Program' });
        const suite = workspaces.createChild('suite', program.id, { name: 'Suite' });
        const prompt = workspaces.createChild('prompt', suite.id, { title: 'Handover item', content: 'Needs help' });
        const link = workspaces.createItemLink({ promptId: prompt.id, role: 'requester', epoch: 1 });
        const remote = new BareGitControlRecordRemote(${JSON.stringify(bare)}, link.itemId);
        await createControlRecord(remote, { itemId: link.itemId, requester: 'jd', commandId: 'restart-create' });
        const moved = await applyControlTransition(remote, { event: 'request_takeover', actor: { personId: 'jd' }, commandId: 'restart-1', epoch: 0, roster: ['jd','yousef'], payload: { sourceHoldPersisted: true } });
        process.stdout.write(JSON.stringify({ itemId: link.itemId, head: moved.head }));
        workspaces.close();
      `], { cwd: serverDir, env: childEnv(root), encoding: "utf8", timeout: 60_000 });
      assert.equal(written.status, 0, written.stderr);
      const { itemId, head } = JSON.parse(written.stdout.slice(written.stdout.indexOf("{"))) as { itemId: string; head: string };
      const reread = spawnSync(process.execPath, ["--import", "tsx", "-e", `
        const { workspaces } = await import('./src/workspaces.ts');
        process.stdout.write(JSON.stringify(workspaces.itemLink(${JSON.stringify(itemId)})));
        workspaces.close();
      `], { cwd: serverDir, env: childEnv(root), encoding: "utf8", timeout: 60_000 });
      assert.equal(reread.status, 0, reread.stderr);
      const link = JSON.parse(reread.stdout.slice(reread.stdout.indexOf("{"))) as { controlHead: string };
      assert.equal(link.controlHead, head, "control_head is read back after restart");
      rmSync(bare, { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("Failure: an unreachable repository records nothing and says what it is waiting for", async () => {
    const directory = bareRepository("tm-t0-6-offline-");
    const workDirectory = mkdtempSync(join(tmpdir(), "tm-t0-6-offline-ws-"));
    const workspace = workspaces.create({ name: workDirectory, workDirectory });
    try {
      const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
      const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
      const prompt = workspaces.createChild("prompt", suite.id, { title: "Offline item", content: "Needs help" }) as PromptRecord;
      const link = workspaces.createItemLink({ promptId: prompt.id, role: "requester", epoch: 1 });
      const online = new BareGitControlRecordRemote(directory, link.itemId);
      await createControlRecord(online, { itemId: link.itemId, requester: REQUESTER, commandId: "off-create" });
      const head = workspaces.itemLink(link.itemId)!.controlHead;

      const cut: ControlRecordRemote = {
        async read() { throw new WorkspaceError(503, "control_unreachable", "Waiting for the project repository to become reachable."); },
        async readEvent() { throw new WorkspaceError(503, "control_unreachable", "Waiting for the project repository to become reachable."); },
        async append() { throw new WorkspaceError(503, "control_unreachable", "Waiting for the project repository to become reachable."); },
      };
      await assert.rejects(
        () => applyControlTransition(cut, { event: "request_takeover", actor: { personId: REQUESTER }, commandId: "off-1", epoch: 0, roster: ROSTER, payload: { sourceHoldPersisted: true } }),
        (error: unknown) => error instanceof WorkspaceError && error.code === "control_unreachable" && /waiting for/i.test(error.message),
      );
      assert.equal(workspaces.itemLink(link.itemId)!.controlHead, head, "the cut workstation records nothing");
      assert.equal(gitOut(directory, ["rev-list", "--count", controlRef(link.itemId)]), "1");
      // The other environment is unaffected and writes to the same record.
      const moved = await applyControlTransition(online, { event: "request_takeover", actor: { personId: REQUESTER }, commandId: "off-2", epoch: 0, roster: ROSTER, payload: { sourceHoldPersisted: true } });
      assert.equal(moved.record.state, "PREPARING");
    } finally {
      workspaces.remove(workspace.id);
      rmSync(workDirectory, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  await t.test("Records carry no credential, token or absolute path", async () => {
    const directory = bareRepository("tm-t0-6-sweep-");
    try {
      const remote = new BareGitControlRecordRemote(directory, ITEM);
      await createControlRecord(remote, { itemId: ITEM, requester: REQUESTER, commandId: "sweep-create" });
      await drive(remote, [
        { event: "request_takeover", actor: { personId: REQUESTER }, payload: { sourceHoldPersisted: true } },
        { event: "publish_offer", actor: { personId: REQUESTER }, payload: OFFER_PAYLOAD },
      ], "sweep");
      const dump = gitOut(directory, ["log", "-p", "--format=%s%n%an%n%ae", controlRef(ITEM)]);
      assert.doesNotMatch(dump, /ghp_|github_pat_|xox[baprs]-|bot\d{6,}:|-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      assert.doesNotMatch(dump, /:\/\/[^/\s]*@/, "no credential-bearing URL reaches the record");
      assert.doesNotMatch(dump, /\/home\/|\/Users\//, "no absolute path reaches the record");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

test("TM-T0-5-29: migration 29 adds exactly the seven handover actions and rebuilds the table once", () => {
  const root = mkdtempSync(join(tmpdir(), "tm4-migration-29-"));
  try {
    mkdirSync(join(root, ".agent-console"), { recursive: true });
    mkdirSync(join(root, "workspace"));
    const booted = boot(root);
    assert.equal(booted.status, 0, booted.stderr);
    const seeded = runWorkspaceScript(root, `
      const { workspaces } = await import('./src/workspaces.ts');
      const workspace = workspaces.create({ name: 'migration-29', workDirectory: ${JSON.stringify(join(root, "workspace"))} });
      const program = workspaces.createChild('program', workspace.id, { name: 'Program' });
      // Two blocked tasks, because saving an answer moves its own prompt out of
      // BLOCKED; a Save answer card and an Answer and resume card that had to
      // share one prompt could not both still apply.
      const seedBlocked = (label) => {
        const suite = workspaces.createChild('suite', program.id, { name: 'Suite ' + label });
        const prompt = workspaces.createChild('prompt', suite.id, { title: 'Pending card ' + label, content: 'Answer once' });
        const runId = 'm29-source-run-' + label;
        workspaces.beginAgentRun({ runId, workspaceId: workspace.id, promptId: prompt.id, provider: 'claude', model: null, tokenHash: 'm29-' + label, expiresAt: '2099-01-01T00:00:00.000Z', role: 'execute' });
        // The end-of-run ladder records UNREPORTED, not BLOCKED, for a run that
        // ends without posting a status, so the block is posted explicitly.
        workspaces.updateAgentStatus(runId, {
          requestId: 'blockreq-' + label + '-m29', expectedStatus: 'IN_PROGRESS', status: 'BLOCKED',
          reason: 'The owner must answer before this can continue.',
          verificationSummary: 'Answer the pending question.',
        });
        workspaces.finishAgentRun(runId, 'done');
        const priorAnswer = workspaces.respondToBlockedPrompt(prompt.id, { content: 'Prior answer' });
        const handoff = workspaces.createHandoff({ id: 'm29-handoff-' + label, workspaceId: workspace.id, promptId: prompt.id, sourceRunId: runId, provider: 'claude', model: null });
        // The question must complete strictly after the prior answer, or
        // pendingHumanQuestion counts that answer as having answered it and the
        // card is refused as prompt_not_blocked.
        workspaces.updateHandoff(handoff.id, { state: 'READY', recommendation: 'WAIT_FOR_HUMAN', completedAt: new Date(Date.parse(priorAnswer.createdAt) + 1).toISOString() });
        // A suite run is a stage of a named pipeline run and its stations are
        // that pipeline's steps; a free-standing one has no station to resume.
        const flowchart = workspaces.createPipeline({ workspaceId: workspace.id, name: 'Flowchart ' + label, suiteIds: [suite.id] });
        workspaces.addNamedPipelineStep(flowchart.id, prompt.id, { provider: 'claude' });
        const named = workspaces.createNamedPipelineRun({ id: 'm29-named-' + label, pipelineId: flowchart.id, workspaceId: workspace.id, playProvider: 'claude', playModel: null });
        const pipeline = workspaces.createPipelineRun({ id: 'm29-pipeline-' + label, suiteId: suite.id, workspaceId: workspace.id, playProvider: 'claude', playModel: null, pipelineRunId: named.id });
        workspaces.updatePipelineRun(pipeline.id, { state: 'WAITING_HUMAN', currentPromptId: prompt.id });
        workspaces.updateNamedPipelineRun(named.id, { state: 'WAITING_HUMAN', currentSuiteId: suite.id, currentSuiteRunId: pipeline.id });
        return prompt;
      };
      const savePrompt = seedBlocked('save');
      const resumePrompt = seedBlocked('resume');
      const actor = workspaces.upsertTaskControlActor({ id: 'm29-actor', transport: 'fake_telegram', transportUserId: '101', chatId: '42', label: 'jd' });
      const group = workspaces.upsertTeamGroupActor({ id: 'm29-group-actor', transport: 'fake_telegram', transportUserId: '202', chatId: 'group-29', label: 'yousef' });
      const item = workspaces.createItemLink({ promptId: savePrompt.id, role: 'requester', epoch: 1, controlHead: 'head-before-29' });
      // A pre-upgrade Save answer card and a pre-upgrade Answer and resume card.
      workspaces.createTaskControlAction({ ref: 'm29-save', action: 'save_human_response', promptId: savePrompt.id, actorId: actor.id, chatId: '42', botId: 'telegram-m29', messageId: 'card-29-save', expectedRevision: workspaces.humanInputState(savePrompt.id).revision, provider: 'claude', expiresAt: '2099-01-01T00:00:00.000Z' });
      workspaces.createTaskControlAction({ ref: 'm29-resume', action: 'answer_and_resume', promptId: resumePrompt.id, actorId: actor.id, chatId: '42', botId: 'telegram-m29', messageId: 'card-29-resume', expectedRevision: workspaces.humanInputState(resumePrompt.id).revision, provider: 'claude', expiresAt: '2099-01-01T00:00:00.000Z' });
      for (const action of ['resume_saved', 'grant', 'revoke', 'close_thread']) {
        workspaces.createTaskControlAction({ ref: 'm29-' + action, action, promptId: savePrompt.id, actorId: group.id, chatId: 'group-29', botId: 'telegram-m29', messageId: 'card-29-' + action, expectedRevision: workspaces.humanInputState(savePrompt.id).revision, expiresAt: '2099-01-01T00:00:00.000Z', subjectKind: 'item', itemId: item.itemId, payload: action === 'grant' || action === 'revoke' ? { personId: 'yousef', capabilities: ['answer'] } : undefined });
      }
      workspaces.recordTaskControlReceipt({ commandId: 'm29-receipt-applied', actionRef: 'm29-grant', state: 'APPLIED', message: 'Granted answer.' });
      workspaces.grantItemCapability({ itemId: item.itemId, personId: 'yousef', capability: 'answer', commandId: 'm29-grant-command' });
      workspaces.close();
    `);
    assert.equal(seeded.status, 0, seeded.stderr);

    const file = join(root, ".agent-console/console.sqlite");
    const database = new Database(file);
    database.pragma("foreign_keys = OFF");
    // Return task_control_action to its migration-28 shape, keeping every row,
    // the way the 25, 26 and 27 cases fake a downgrade.
    database.exec(`
      CREATE TABLE task_control_action_v28 (
        ref TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK(action IN ('save_human_response','answer_and_resume','resume_saved','grant','revoke','close_thread')),
        prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL REFERENCES task_control_actor(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL,
        topic_id TEXT,
        bot_id TEXT NOT NULL,
        message_id TEXT,
        expected_revision TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        applied_command_id TEXT,
        subject_kind TEXT NOT NULL DEFAULT 'task' CHECK(subject_kind IN ('task','item')),
        item_id TEXT REFERENCES item_link(item_id) ON DELETE CASCADE,
        payload_json TEXT,
        CHECK((subject_kind='task' AND item_id IS NULL) OR (subject_kind='item' AND item_id IS NOT NULL))
      );
      INSERT INTO task_control_action_v28 SELECT ref,action,prompt_id,actor_id,chat_id,topic_id,bot_id,message_id,expected_revision,provider,model,expires_at,created_at,applied_command_id,subject_kind,item_id,payload_json FROM task_control_action;
      DROP TABLE task_control_action;
      ALTER TABLE task_control_action_v28 RENAME TO task_control_action;
      CREATE INDEX task_control_action_prompt_idx ON task_control_action(prompt_id, created_at);
      -- Migration 52 is what the reconcile a641b0c renumbered this migration 29 to.
      DELETE FROM schema_migration WHERE version=52;
    `);
    const beforeActions = database.prepare("SELECT * FROM task_control_action ORDER BY ref").all();
    const beforeReceipts = database.prepare("SELECT * FROM task_control_receipt ORDER BY command_id").all();
    const beforeItemLinks = database.prepare("SELECT item_id,prompt_id,role,epoch,control_head,closed_at,closed_command_id FROM item_link ORDER BY item_id").all();
    const beforeOutbox = database.prepare("SELECT id,anchor FROM telegram_outbox ORDER BY id").all();
    const beforeGrants = database.prepare("SELECT * FROM item_grant ORDER BY rowid").all();
    const beforeIndex = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='task_control_action_prompt_idx'").get();
    assert.equal(beforeActions.length, 6, "six pre-upgrade cards, one per prior action");
    database.close();

    // Twice, because a migration that is not idempotent rebuilds again or trips
    // over its own table on the second boot.
    for (const run of [1, 2]) {
      const migrated = boot(root);
      assert.equal(migrated.status, 0, `boot ${run}: ${migrated.stderr}`);
      const check = new Database(file);
      try {
        assert.deepEqual(check.prepare("SELECT * FROM task_control_action ORDER BY ref").all(), beforeActions, `boot ${run} preserves every action row byte for byte`);
        assert.deepEqual(check.prepare("SELECT * FROM task_control_receipt ORDER BY command_id").all(), beforeReceipts, `boot ${run} preserves receipts`);
        assert.deepEqual(check.prepare("SELECT item_id,prompt_id,role,epoch,control_head,closed_at,closed_command_id FROM item_link ORDER BY item_id").all(), beforeItemLinks, `boot ${run} preserves item links, including F02's closed columns`);
        assert.deepEqual(check.prepare("SELECT id,anchor FROM telegram_outbox ORDER BY id").all(), beforeOutbox, `boot ${run} preserves F07's telegram_outbox.anchor`);
        assert.deepEqual(check.prepare("SELECT * FROM item_grant ORDER BY rowid").all(), beforeGrants, `boot ${run} preserves grants`);
        assert.deepEqual(check.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='task_control_action_prompt_idx'").get(), beforeIndex, `boot ${run} preserves the action index`);
        assert.deepEqual(check.prepare("SELECT version FROM schema_migration WHERE version=52").all(), [{ version: 52 }], "migration 29 (renumbered 52) is recorded exactly once");
        assert.deepEqual(check.pragma("foreign_key_check"), [], `boot ${run} leaves no foreign-key violation`);
        assert.deepEqual(
          check.prepare("PRAGMA table_info(task_control_action)").all().map(column => (column as { name: string }).name),
          ["ref", "action", "prompt_id", "actor_id", "chat_id", "topic_id", "bot_id", "message_id", "expected_revision", "provider", "model", "expires_at", "created_at", "applied_command_id", "subject_kind", "item_id", "payload_json"],
          `boot ${run} preserves the column list`,
        );
        assert.equal((check.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='item_link'").get() as { sql: string }).sql.includes("control_head"), true, "item_link keeps control_head");

        // The check accepts every prior action plus exactly the seven handover
        // actions, and rejects an eighth.
        const itemId = (beforeItemLinks[0] as { item_id: string }).item_id;
        const insert = (action: string) => check.prepare(
          "INSERT INTO task_control_action(ref,action,prompt_id,actor_id,chat_id,bot_id,expected_revision,expires_at,created_at,subject_kind,item_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        ).run(`probe-${run}-${action}`, action, (beforeActions[0] as { prompt_id: number }).prompt_id, (beforeActions[0] as { actor_id: string }).actor_id, "42", "telegram-m29", "rev", "2099-01-01T00:00:00.000Z", "2026-09-21T00:00:00.000Z", "item", itemId);
        for (const action of ["save_human_response", "answer_and_resume", "resume_saved", "grant", "revoke", "close_thread", ...HANDOVER_ACTIONS]) {
          assert.doesNotThrow(() => insert(action), `boot ${run} accepts ${action}`);
        }
        assert.equal(HANDOVER_ACTIONS.length, 7, "there are exactly seven handover actions");
        assert.equal((HANDOVER_ACTIONS as readonly string[]).includes("release_work"), false, "there is no release action");
        for (const eighth of ["release_work", "release", "reassign", "handover"]) {
          assert.throws(() => insert(eighth), /CHECK constraint failed/, `boot ${run} rejects ${eighth}`);
        }
        check.prepare("DELETE FROM task_control_action WHERE ref LIKE ?").run(`probe-${run}-%`);
        assert.deepEqual(check.prepare("SELECT * FROM task_control_action ORDER BY ref").all(), beforeActions, `boot ${run} is byte-for-byte equivalent to migration 28's data`);
      } finally {
        check.close();
      }
    }

    // A pre-upgrade Save answer card and a pre-upgrade Answer and resume card
    // each still apply exactly once, and duplicate delivery returns the original.
    const applied = runWorkspaceScript(root, `
      const { setPipelineStationStarter } = await import('./src/pipelineScheduler.ts');
      const { TaskControlService } = await import('./src/taskControl.ts');
      const { workspaces } = await import('./src/workspaces.ts');
      let starts = 0;
      setPipelineStationStarter(async () => {
        starts++;
        const workspace = workspaces.list()[0];
        const prompt = workspaces.tree(workspace.id).programs[0].suites[1].prompts[0];
        const runId = 'm29-resumed-run';
        workspaces.beginAgentRun({ runId, workspaceId: workspace.id, promptId: prompt.id, provider: 'claude', model: null, tokenHash: 'm29-resumed', expiresAt: '2099-01-01T00:00:00.000Z' });
        return { runId };
      });
      const control = new TaskControlService({ enabled: true, notificationsEnabled: true, remoteActionsEnabled: true, transport: 'fake_telegram', botId: 'telegram-m29' });
      const save = { ref: 'm29-save', transportUserId: '101', chatId: '42', botId: 'telegram-m29', messageId: 'card-29-save', commandId: 'm29-save-command', content: 'Use blue.' };
      const firstSave = await control.handleCallback(save);
      const duplicateSave = await control.handleCallback({ ...save, commandId: 'm29-save-duplicate' });
      const resume = { ref: 'm29-resume', transportUserId: '101', chatId: '42', botId: 'telegram-m29', messageId: 'card-29-resume', commandId: 'm29-resume-command', content: 'Use green.' };
      const firstResume = await control.handleCallback(resume);
      const duplicateResume = await control.handleCallback({ ...resume, commandId: 'm29-resume-duplicate' });
      if (firstSave.state !== 'APPLIED' || duplicateSave.commandId !== firstSave.commandId) process.exitCode = 2;
      if (firstResume.state !== 'APPLIED' || !firstResume.started || duplicateResume.commandId !== firstResume.commandId || starts !== 1) process.exitCode = 3;
      setPipelineStationStarter(null);
      workspaces.close();
    `);
    assert.equal(applied.status, 0, applied.stderr);
    const restarted = boot(root);
    assert.equal(restarted.status, 0, restarted.stderr);
    const final = new Database(file, { readonly: true });
    try {
      assert.deepEqual(final.prepare("SELECT command_id,state,started FROM task_control_receipt WHERE action_ref='m29-save'").all(), [{ command_id: "m29-save-command", state: "APPLIED", started: 0 }], "the pre-upgrade Save answer card applies exactly once");
      assert.deepEqual(final.prepare("SELECT command_id,state,started,run_id FROM task_control_receipt WHERE action_ref='m29-resume'").all(), [{ command_id: "m29-resume-command", state: "APPLIED", started: 1, run_id: "m29-resumed-run" }], "the pre-upgrade Answer and resume card applies exactly once");
      assert.deepEqual(final.prepare("SELECT version FROM schema_migration WHERE version=52").all(), [{ version: 52 }], "a second boot duplicates no migration row");
      assert.deepEqual(final.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='task_control_action_prompt_idx'").all(), [{ name: "task_control_action_prompt_idx" }], "a second boot duplicates no index");
    } finally {
      final.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
