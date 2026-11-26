/**
 * `/btw`: operator notes to a working run, delivered through the inbox for
 * headless providers, natively where the adapter allows, and settled when the
 * run ends before the agent read them.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { NormalizedEvent, ProgramRecord, PromptRecord, ProviderId, SuiteRecord } from "@hydra/shared";
import { getAdapter } from "../../../src/providers/registry.ts";
import { newId } from "../../../src/utils/ids.ts";
import { runContexts } from "../../../src/services/runs/runContext.ts";
import { runHub } from "../../../src/services/runs/runHub.ts";
import { agentReply, drainInbox, sendBtw } from "../../../src/services/runs/runMessages.ts";
import { emptyBudgetSnapshot } from "../../../src/services/runs/runner.ts";
import type { RunHandle } from "../../../src/contracts/runs.ts";
import { WorkspaceError, workspaces } from "../../../src/repositories/workspaces.ts";

let seq = 0;
const unique = (prefix: string) => `${prefix}-${process.pid}-${Date.now()}-${(seq += 1)}`;

function liveRun(provider: ProviderId) {
  const workspace = workspaces.create({ name: unique("ws"), workDirectory: mkdtempSync(join(tmpdir(), "btw-")) });
  const program = workspaces.createChild("program", workspace.id, { name: unique("prog") }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: unique("suite") }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: "Build", content: "Build it." }) as PromptRecord;
  const runId = newId("run");
  const credential = runContexts.create(runId, workspace.id, prompt.id);
  workspaces.beginAgentRun({ runId, workspaceId: workspace.id, promptId: prompt.id, provider, model: null, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt });
  const events: NormalizedEvent[] = [];
  const unsubscribe = runHub.subscribe((message) => { if (message.kind === "event" && message.event.runId === runId) events.push(message.event); });
  runHub.start({
    handle: {
      runId, provider, model: null, role: "execute", permissionMode: null, budget: emptyBudgetSnapshot,
      sessionId: () => null,
      interrupt: async () => { runHub.end(runId, "interrupted"); },
      done: Promise.resolve("interrupted"),
    } satisfies RunHandle,
    workspace,
    source: { type: "saved", promptId: prompt.id, promptKey: null, title: "Build", programName: "p", suiteName: "s" },
    role: "execute",
  });
  return { runId, events, finish: () => { runHub.end(runId, "done"); unsubscribe(); } };
}

test("a headless run gets the note through its inbox, exactly once", async () => {
  const run = liveRun("cursor");
  try {
    const sent = await sendBtw(run.runId, { text: "I already built it. Skip the build." });
    assert.equal(sent.delivery, "inbox");
    assert.equal(sent.state, "QUEUED");

    const first = drainInbox(run.runId);
    assert.deepEqual(first.map((message) => message.text), ["I already built it. Skip the build."]);
    assert.equal(first[0]!.state, "DELIVERED");
    assert.deepEqual(drainInbox(run.runId), [], "a note is handed over once");

    const states = run.events.filter((event) => event.type === "operator_message").map((event) => event.type === "operator_message" ? event.payload.state : null);
    assert.deepEqual(states, ["QUEUED", "DELIVERED"], "the operator sees it land");
  } finally {
    run.finish();
  }
});

test("the agent's reply is recorded and shown, and never blocks", () => {
  const run = liveRun("cursor");
  try {
    const reply = agentReply(run.runId, { text: "Understood — skipping the build and wiring the frontend." });
    assert.equal(reply.direction, "AGENT");
    assert.ok(run.events.some((event) => event.type === "agent_message" && event.payload.text.startsWith("Understood")));
    assert.equal(workspaces.runMessages(run.runId).length, 1);
  } finally {
    run.finish();
  }
});

test("a note the agent never read is marked superseded when the run ends", async () => {
  const run = liveRun("grok");
  const sent = await sendBtw(run.runId, { text: "Too late for this one." });
  run.finish();
  const [row] = workspaces.runMessages(run.runId);
  assert.equal(row!.id, sent.id);
  assert.equal(row!.state, "SUPERSEDED");
});

test("a provider with an open input channel takes the note live", async () => {
  const run = liveRun("claude");
  const adapter = getAdapter("claude");
  const original = adapter.sendUserMessage;
  const received: string[] = [];
  adapter.sendUserMessage = async (_runId, text) => { received.push(text); return true; };
  try {
    const sent = await sendBtw(run.runId, { text: "Use the staging database." });
    assert.equal(sent.delivery, "native");
    assert.equal(sent.state, "DELIVERED");
    assert.match(received[0]!, /Use the staging database\./);
    assert.deepEqual(drainInbox(run.runId), [], "nothing is left for the inbox");
  } finally {
    adapter.sendUserMessage = original;
    run.finish();
  }
});

test("a live channel that refuses falls back to the inbox", async () => {
  const run = liveRun("claude");
  const adapter = getAdapter("claude");
  const original = adapter.sendUserMessage;
  adapter.sendUserMessage = async () => false;
  try {
    const sent = await sendBtw(run.runId, { text: "Fallback please." });
    assert.equal(sent.delivery, "inbox");
    assert.equal(sent.state, "QUEUED");
    assert.equal(drainInbox(run.runId).length, 1);
  } finally {
    adapter.sendUserMessage = original;
    run.finish();
  }
});

test("btw is refused once the run is gone, and for empty text", async () => {
  const run = liveRun("cursor");
  await assert.rejects(sendBtw(run.runId, { text: "   " }), (error: unknown) => error instanceof WorkspaceError && error.code === "validation_error");
  run.finish();
  await assert.rejects(sendBtw(run.runId, { text: "Anyone there?" }), (error: unknown) => error instanceof WorkspaceError && error.code === "run_not_active");
});
