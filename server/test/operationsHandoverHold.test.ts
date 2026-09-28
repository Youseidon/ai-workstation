import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OperationsPrompt, OperationsSnapshot, OperationsSuite, ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { config } from "../src/config.ts";
import {
  BareGitControlRecordRemote,
  applyControlTransition,
  controlRef,
  createControlRecord,
  type ControlOutcome,
  type ControlTransitionInput,
} from "../src/teamControlRecord.ts";
import { mintItemId } from "../src/teamItems.ts";
import { handleWorkspaceApi } from "../src/workspaceApi.ts";
import { workspaces } from "../src/workspaces.ts";

/*
 * M-16 (docs/telegram-task-control/team-gap-register.md), the alignment jd
 * re-scoped this task to on 2026-09-28.
 *
 * P-A5 closed the loss - the owner could answer, run and complete an item a
 * teammate was holding, and those actions worked. What was left is that the
 * owner's surfaces still *said* the item needed the owner, kept it on the
 * attention list for the whole handover, and offered the buttons P-A5 now
 * refuses. They cannot know better, because nothing in the snapshot carries the
 * handover: `operationalState` says BLOCKED, which is true and is not the
 * missing fact.
 *
 * So `/api/operations` carries the fact. This file is that route's proof, and it
 * drives the route rather than the helper, because a field filled in a function
 * nothing calls is exactly the "present but not wired" shape this track has hit
 * three times.
 *
 * The **executor** link case below is the load-bearing one. P-A5 found that a
 * guard over every item link refuses the receiver's own run and breaks handover
 * outright, so a receiver's own prompt must read null here even while the very
 * same record is live.
 */

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${seq}`;
}

/** Drives a route the way the HTTP server would, without opening a socket. */
async function call(path: string): Promise<{ status: number; body: OperationsSnapshot }> {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.method = "GET";
  req.headers = { "content-type": "application/json" };
  let status = 0;
  let raw = "";
  const res = Object.assign(new EventEmitter(), {
    writeHead(code: number) { status = code; return res; },
    end(chunk?: string) { raw = chunk ?? ""; return res; },
    setHeader() { return res; },
    writableEnded: false,
  }) as unknown as ServerResponse;
  const handled = await handleWorkspaceApi(req, res, new URL(path, "http://127.0.0.1"));
  assert.equal(handled, true, `GET ${path} was not routed`);
  return { status, body: JSON.parse(raw) as OperationsSnapshot };
}

const REQUESTER = "jd";
const RECEIVER = "yousef";
const ROSTER = [REQUESTER, RECEIVER];
const OFFER_PAYLOAD = { writersStopped: true, packageVerified: true, branchVerified: true };

/**
 * The one bare clone `liveHandoverHolding` reads, at the path it computes from
 * `config.repoRoot`. Nothing is injected: if the product looked somewhere else,
 * every "held" assertion below would read null and fail.
 *
 * `teamResultApply.test.ts` and `telegramLiveRuntime.test.ts` already write under
 * this directory for the same reason, so this is the established seam rather than
 * a new one. It is created only if absent and removed only if this file created
 * it; otherwise just the item's own ref is dropped.
 */
const controlBare = join(config.repoRoot, ".agent-console", "handover", "control.git");
const createdBare = !existsSync(controlBare);
const mintedRefs: string[] = [];

function openBare(): void {
  if (!existsSync(controlBare)) {
    mkdirSync(join(config.repoRoot, ".agent-console", "handover"), { recursive: true });
    execFileSync("git", ["init", "--bare", "-q", controlBare]);
  }
}

function dropRefs(): void {
  for (const ref of mintedRefs) {
    execFileSync("git", ["--git-dir", controlBare, "update-ref", "-d", ref], { encoding: "utf8" });
  }
  mintedRefs.length = 0;
  if (createdBare) rmSync(controlBare, { recursive: true, force: true });
}

interface Fixture {
  workspaceId: number;
  suiteId: number;
  promptId: number;
  /** The execute run the fixture opened, still RUNNING when `block` is false. */
  runId: string;
  cleanup(): void;
}

/**
 * A work item an agent parked BLOCKED for a person, which is the state a
 * handover is published from and the exact state M-16 was observed in on
 * 2026-09-28: `operationalState` reports `BLOCKED`, whose catalog entry is
 * labelled "Needs you" and sets `needsAttention`. So `attention` starts true and
 * clearing it is observable rather than vacuous.
 */
function fixture(options: { block?: boolean } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "m16-"));
  const workspace = workspaces.create({ name: unique("ws"), description: "", workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: unique("prog"), overview: "" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: unique("suite"), overview: "" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: unique("p0"), content: "do it" }) as PromptRecord;
  const runId = `run-${randomUUID()}`;
  workspaces.beginAgentRun({
    runId, workspaceId: workspace.id, promptId: prompt.id,
    provider: "claude", model: null, tokenHash: randomUUID(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(), role: "execute",
  });
  workspaces.markAgentRunRunning(runId);
  /*
   * `block: false` leaves the item IN_PROGRESS with this run still open, which is
   * the only state an agent may decompose from - `beginAgentRun` moves TODO to
   * IN_PROGRESS and does not move BLOCKED, so a decompose after the block is
   * refused outright.
   */
  if (options.block !== false) {
    workspaces.updateAgentStatus(runId, {
      requestId: unique("status"), expectedStatus: "IN_PROGRESS", status: "BLOCKED",
      reason: "The release colour is a product decision and only a person can make it.",
      verificationSummary: "Choose blue or green and say which.",
    });
    workspaces.finishAgentRun(runId, "done");
  }
  return {
    workspaceId: workspace.id,
    suiteId: suite.id,
    promptId: prompt.id,
    runId,
    cleanup() { workspaces.remove(workspace.id); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** The control record for a fresh item, at LOCAL, with its ref remembered for cleanup. */
async function record(): Promise<{ itemId: string; remote: BareGitControlRecordRemote; created: ControlOutcome }> {
  openBare();
  const itemId = mintItemId();
  const remote = new BareGitControlRecordRemote(controlBare, itemId);
  const created = await createControlRecord(remote, { itemId, requester: REQUESTER, commandId: unique("create") });
  mintedRefs.push(controlRef(itemId));
  return { itemId, remote, created };
}

/** Drives the given events in order from the record's current epoch. */
async function drive(
  remote: BareGitControlRecordRemote,
  from: ControlOutcome,
  rows: Array<{ event: ControlTransitionInput["event"]; person: string; payload?: ControlTransitionInput["payload"] }>,
): Promise<ControlOutcome> {
  let previous = from;
  for (const row of rows) {
    previous = await applyControlTransition(remote, {
      event: row.event,
      actor: { personId: row.person },
      commandId: unique(row.event),
      epoch: previous.record.epoch,
      roster: ROSTER,
      payload: row.payload,
    });
  }
  return previous;
}

/** The rows that take a fresh record to RUNNING with the receiver as executor. */
const TO_RUNNING: Array<{ event: ControlTransitionInput["event"]; person: string; payload?: ControlTransitionInput["payload"] }> = [
  { event: "request_takeover", person: REQUESTER, payload: { sourceHoldPersisted: true } },
  { event: "publish_offer", person: REQUESTER, payload: OFFER_PAYLOAD },
  { event: "accept_offer", person: RECEIVER },
  { event: "preparation_complete", person: RECEIVER, payload: { policyChecked: true, workspaceReserved: true, startIntentDurable: true } },
  { event: "run_started", person: RECEIVER, payload: { runId: "run-1" } },
];

async function suiteFor(f: Fixture): Promise<OperationsSuite> {
  const answer = await call(`/api/operations?workspace=${f.workspaceId}`);
  assert.equal(answer.status, 200);
  const suite = answer.body.suites.find(entry => entry.id === f.suiteId);
  assert.ok(suite !== undefined, "the fixture's suite is in the snapshot");
  return suite;
}

function promptIn(suite: OperationsSuite, promptId: number): OperationsPrompt {
  const found = suite.prompts.find(entry => entry.prompt.id === promptId)
    ?? suite.prompts.flatMap(entry => entry.children).find(entry => entry.prompt.id === promptId);
  assert.ok(found !== undefined, `prompt ${promptId} is in the snapshot`);
  return found;
}

test("M-16: /api/operations carries the live handover holding each item, and takes a held one off the attention list", async (t) => {
  try {
    await t.test("No handover at all: the field is null and the item still needs the owner", async () => {
      const f = fixture();
      try {
        const suite = await suiteFor(f);
        const entry = promptIn(suite, f.promptId);
        assert.equal(entry.heldByTeammate, null);
        assert.equal(entry.operationalState, "BLOCKED", "the fixture is an item an agent parked for a person");
        assert.equal(entry.attention, true, "which is on the owner's attention list, as it should be");
        assert.equal(suite.attentionCount, 1);
      } finally { f.cleanup(); }
    });

    await t.test("A record that exists but is not live: LOCAL is not a handover", async () => {
      const f = fixture();
      try {
        const { itemId, created } = await record();
        workspaces.createItemLink({ itemId, promptId: f.promptId, role: "requester", epoch: 1, controlHead: created.head });
        assert.equal(created.record.state, "LOCAL");

        const entry = promptIn(await suiteFor(f), f.promptId);
        assert.equal(entry.heldByTeammate, null, "a control record is not by itself a live handover");
        assert.equal(entry.attention, true);
      } finally { dropRefs(); f.cleanup(); }
    });

    await t.test("Live on the requester's link: the field names the holder and attention is cleared", async () => {
      const f = fixture();
      try {
        const { itemId, remote, created } = await record();
        const running = await drive(remote, created, TO_RUNNING);
        assert.equal(running.record.state, "RUNNING");
        assert.equal(running.record.executor, RECEIVER, "the receiver is the executor on the shared record");
        workspaces.createItemLink({ itemId, promptId: f.promptId, role: "requester", epoch: running.record.epoch, controlHead: running.head });

        const suite = await suiteFor(f);
        const entry = promptIn(suite, f.promptId);
        /*
         * `executorLabel` is null here because this fixture caches no team roster,
         * so there is no name to resolve - which is the fallback jd's answer of
         * 2026-09-28 asks for: an id is a poor label, a wrong name is worse. The
         * row below this suite proves the resolved case.
         */
        assert.deepEqual(entry.heldByTeammate, { itemId, state: "RUNNING", executor: RECEIVER, executorLabel: null },
          "the route carries the item, the control state and who holds it");
        assert.equal(entry.attention, false, "a teammate's work is not the owner's attention");
        assert.equal(suite.attentionCount, 0,
          "and the suite's count goes with it, or the chip disagrees with the list behind it");
        assert.equal(entry.operationalState, "BLOCKED",
          "the display status is untouched: the item really is blocked, and that was never the defect");
      } finally { dropRefs(); f.cleanup(); }
    });

    await t.test("An open offer nobody has accepted: held, with no executor to name", async () => {
      const f = fixture();
      try {
        const { itemId, remote, created } = await record();
        const offered = await drive(remote, created, TO_RUNNING.slice(0, 2));
        assert.equal(offered.record.state, "OFFERED");
        workspaces.createItemLink({ itemId, promptId: f.promptId, role: "requester", epoch: offered.record.epoch, controlHead: offered.head });

        const entry = promptIn(await suiteFor(f), f.promptId);
        assert.deepEqual(entry.heldByTeammate, { itemId, state: "OFFERED", executor: null, executorLabel: null },
          "OFFERED is a live handover with nobody holding it yet, which is what P-A5's guard also refuses");
        assert.equal(entry.attention, false);
      } finally { dropRefs(); f.cleanup(); }
    });

    /*
     * The one that breaks handover if it is wrong. A receiver that accepts an
     * offer creates an item link on **its own** prompt with role `executor`, so
     * a route that read every link would tell the receiver its own work item was
     * held by someone else and take away its own buttons.
     */
    await t.test("The executor's own link reads null, even while that very record is live", async () => {
      const f = fixture();
      try {
        const { itemId, remote, created } = await record();
        const running = await drive(remote, created, TO_RUNNING);
        assert.equal(running.record.state, "RUNNING", "the same live record as the requester case above");
        workspaces.createItemLink({ itemId, promptId: f.promptId, role: "executor", epoch: running.record.epoch, controlHead: running.head });

        const suite = await suiteFor(f);
        const entry = promptIn(suite, f.promptId);
        assert.equal(entry.heldByTeammate, null, "the receiver is not a teammate holding its own work");
        assert.equal(entry.attention, true, "and its own item stays on its own attention list");
        assert.equal(suite.attentionCount, 1);
      } finally { dropRefs(); f.cleanup(); }
    });

    await t.test("A handover that is over: the field goes back to null and so does attention", async () => {
      const f = fixture();
      try {
        const { itemId, remote, created } = await record();
        const withdrawn = await drive(remote, created, [
          ...TO_RUNNING.slice(0, 2),
          { event: "withdraw_offer", person: REQUESTER },
        ]);
        assert.equal(withdrawn.record.state, "WITHDRAWN", "a settled state outside LIVE_HANDOVER_STATES");
        workspaces.createItemLink({ itemId, promptId: f.promptId, role: "requester", epoch: withdrawn.record.epoch, controlHead: withdrawn.head });

        const suite = await suiteFor(f);
        const entry = promptIn(suite, f.promptId);
        assert.equal(entry.heldByTeammate, null);
        assert.equal(entry.attention, true, "the item is the owner's again");
        assert.equal(suite.attentionCount, 1);
      } finally { dropRefs(); f.cleanup(); }
    });

    /*
     * A sub-step is an `OperationsPrompt` that hangs off `children` rather than
     * appearing in `suite.prompts`, and an item link is keyed by prompt id with
     * nothing stopping a sub-step carrying one. A route that walked only the
     * station roots would leave a held sub-step saying "Needs you".
     */
    await t.test("A held sub-step is reached too, not only a station root", async () => {
      const f = fixture({ block: false });
      try {
        const decomposed = workspaces.decomposePrompt(f.runId, {
          requestId: randomUUID(),
          resumeBrief: "Two slices remain.",
          children: [{ title: unique("child"), content: "the slice" }, { title: unique("sibling"), content: "the other slice" }],
        }) as { children: Array<{ id: number }> };
        const childId = decomposed.children[0]!.id;

        const { itemId, remote, created } = await record();
        const running = await drive(remote, created, TO_RUNNING);
        workspaces.createItemLink({ itemId, promptId: childId, role: "requester", epoch: running.record.epoch, controlHead: running.head });

        const suite = await suiteFor(f);
        assert.deepEqual(promptIn(suite, childId).heldByTeammate, { itemId, state: "RUNNING", executor: RECEIVER, executorLabel: null },
          "the walk reaches children, not just station roots");
        assert.equal(promptIn(suite, f.promptId).heldByTeammate, null, "and the station it hangs off is not held");
      } finally { dropRefs(); f.cleanup(); }
    });
  } finally {
    dropRefs();
  }
});

test("M-16: the route resolves the holder's roster name, and falls back to the id when the roster has none", async () => {
  const f = fixture();
  try {
    const { itemId, remote, created } = await record();
    const running = await drive(remote, created, TO_RUNNING);
    workspaces.createItemLink({ itemId, promptId: f.promptId, role: "requester", epoch: running.record.epoch, controlHead: running.head });

    // No cached roster yet: nothing to resolve, so the id stands.
    assert.equal(promptIn(await suiteFor(f), f.promptId).heldByTeammate?.executorLabel, null,
      "with no roster cached there is no name, and the surfaces fall back to the id");

    /*
     * Now a roster that knows the holder. jd's answer of 2026-09-28: resolve the
     * label, because the control record stores person ids - right for a shared
     * machine-readable record, wrong for a badge - and the roster is where the
     * names already are.
     */
    workspaces.upsertTeamRoster({
      teamId: "awt1_m16labelfixture01",
      groupChatId: "-1001",
      remoteUrl: "https://example.invalid/team.git",
      revision: "r1",
      record: { members: [{ personId: RECEIVER, personLabel: "Yousef" }] },
    });
    assert.equal(promptIn(await suiteFor(f), f.promptId).heldByTeammate?.executorLabel, "Yousef",
      "the route resolves the roster's own name for the holder");

    // A roster that carries the person but no label for them resolves nothing
    // rather than an empty string, which is the B5 shape.
    workspaces.upsertTeamRoster({
      teamId: "awt1_m16labelfixture01",
      groupChatId: "-1001",
      remoteUrl: "https://example.invalid/team.git",
      revision: "r2",
      record: { members: [{ personId: RECEIVER }] },
    });
    assert.equal(promptIn(await suiteFor(f), f.promptId).heldByTeammate?.executorLabel, null,
      "a member with no personLabel resolves to null, never to an empty badge");
  } finally {
    dropRefs();
    f.cleanup();
  }
});
