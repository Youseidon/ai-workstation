/**
 * Claims from docs/pipeline-redesign/prompts/08-cleanup.md §1:
 * a run with 10 000 events keeps eventsPerRun, with the last keepFinalEvents
 * intact and in order; aged runs thin to the final tail only.
 */

import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { NormalizedEvent, ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { newId } from "../src/lib/ids.ts";
import { sweepRunEvents } from "../src/retention.ts";
import { runContexts } from "../src/runContext.ts";
import { workspaces } from "../src/workspaces.ts";

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

function event(n: number): NormalizedEvent {
  return {
    type: "assistant_text",
    timestamp: new Date(1_700_000_000_000 + n).toISOString(),
    payload: { kind: "response", text: `event-${n}` },
  };
}

/** Tests need an old ended_at; the public API always stamps "now". */
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
    for (let i = 0; i < total; i += 1) workspaces.recordAgentEvent(runId, event(i));
    workspaces.finishAgentRun(runId, "done");

    const before = workspaces.runEventIdsOldestFirst(runId);
    assert.equal(before.length, total);

    const result = await sweepRunEvents({ pauseMs: 0 });
    // The shared test database may hold other runs; assert on this run only.
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
    for (let i = 0; i < 500; i += 1) workspaces.recordAgentEvent(runId, event(i));
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
