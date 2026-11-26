import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { NormalizedEvent, ProgramRecord, PromptRecord, SuiteRecord } from "@hydra/shared";
import { newId } from "../../src/utils/ids.ts";
import { sweepRunEvents } from "../../src/repositories/retention.ts";
import { runContexts } from "../../src/services/runs/runContext.ts";
import { workspaces } from "../../src/repositories/workspaces.ts";

let seq = 0;
const unique = (prefix: string): string => `${prefix}-${process.pid}-${Date.now()}-${(seq += 1)}`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "retention-"));
  const workspace = workspaces.create({ name: unique("ws"), description: "", workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: unique("prog"), overview: "" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: unique("suite"), overview: "" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: unique("p"), content: "do work" }) as PromptRecord;
  return {
    workspace,
    prompt,
    cleanup() {
      workspaces.remove(workspace.id);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function beginExecute(promptId: number, workspaceId: number): string {
  const runId = newId("run");
  const credential = runContexts.create(runId, workspaceId, promptId);
  workspaces.beginAgentRun({
    runId, workspaceId, promptId, provider: "claude", model: null,
    tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute",
  });
  workspaces.markAgentRunRunning(runId);
  return runId;
}

function event(n: number, runId: string): NormalizedEvent {
  return {
    id: `evt-${n}`,
    runId,
    provider: "claude",
    model: null,
    type: "assistant_text",
    timestamp: new Date(1_700_000_000_000 + n).toISOString(),
    payload: { blockId: `b-${n}`, delta: false, text: `event-${n}`, kind: "message" },
  };
}

function backdateEndedAt(runId: string, iso: string): void {
  const side = new Database(workspaces.databasePath);
  try {
    side.pragma("busy_timeout = 5000");
    side.prepare("UPDATE agent_run SET ended_at=? WHERE id=?").run(iso, runId);
  } finally {
    side.close();
  }
}

test("a run with 10 000 events keeps eventsPerRun with the last keepFinalEvents intact and in order", async () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    const total = 10_000;
    for (let i = 0; i < total; i += 1) workspaces.recordAgentEvent(runId, event(i, runId));
    workspaces.finishAgentRun(runId, "done");

    const before = workspaces.runEventIdsOldestFirst(runId);
    assert.equal(before.length, total);

    const result = await sweepRunEvents({ pauseMs: 0 });
    assert.ok(result.deleted >= total - 4000);
    assert.equal(result.keptFinalIntact, true);

    const after = workspaces.runEventIdsOldestFirst(runId);
    assert.equal(after.length, 4000);
    assert.deepEqual(after.slice(-200), before.slice(-200));
    assert.deepEqual(after, before.slice(-4000));
  } finally {
    ctx.cleanup();
  }
});

test("an aged run is thinned to keepFinalEvents only", async () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    for (let i = 0; i < 500; i += 1) workspaces.recordAgentEvent(runId, event(i, runId));
    workspaces.finishAgentRun(runId, "done");
    const before = workspaces.runEventIdsOldestFirst(runId);
    backdateEndedAt(runId, new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString());

    const result = await sweepRunEvents({ pauseMs: 0 });
    assert.ok(result.deleted >= 500 - 200);
    assert.equal(result.keptFinalIntact, true);

    const after = workspaces.runEventIdsOldestFirst(runId);
    assert.equal(after.length, 200);
    assert.deepEqual(after, before.slice(-200));
  } finally {
    ctx.cleanup();
  }
});

test("session history keeps decision exchanges that predate the transcript cap", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.recordAgentEvent(runId, {
      id: "decision-request", runId, provider: "claude", model: null,
      type: "input_request", timestamp: new Date(1_700_000_000_000).toISOString(),
      payload: {
        requestId: "input-history", heading: "Choose a default",
        questions: [{ id: "scope", prompt: "Which scope?", kind: "text", options: [], required: true, recommendation: null, why: null }],
      },
    });
    workspaces.recordAgentEvent(runId, {
      id: "decision-response", runId, provider: "claude", model: null,
      type: "input_response", timestamp: new Date(1_700_000_000_001).toISOString(),
      payload: { requestId: "input-history", answers: { scope: "Small" } },
    });
    for (let i = 0; i < 3; i += 1) workspaces.recordAgentEvent(runId, event(i + 10, runId));

    const history = workspaces.runEvents(runId, 2);
    assert.deepEqual(history.map((entry) => entry.type), ["input_request", "input_response", "assistant_text", "assistant_text"]);
  } finally {
    ctx.cleanup();
  }
});
