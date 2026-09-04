import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { newId } from "./lib/ids.ts";
import { operationalState } from "./operationalState.ts";
import { runContexts } from "./runContext.ts";
import { workspaces } from "./workspaces.ts";

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${seq}`;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "direct-retry-"));
  const workspace = workspaces.create({ name: unique("ws"), description: "", workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: unique("prog"), overview: "" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: unique("suite"), overview: "" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: unique("p"), content: "do work" }) as PromptRecord;
  return {
    dir,
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
    runId,
    workspaceId,
    promptId,
    provider: "claude",
    model: null,
    tokenHash: credential.tokenHash,
    expiresAt: credential.expiresAt,
    role: "execute",
  });
  return runId;
}

test("canDirectRetry is true for launch failures with no meaningful work", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.finishAgentRun(runId, "error");
    assert.equal(workspaces.canDirectRetry(ctx.prompt.id), true);
  } finally {
    ctx.cleanup();
  }
});

test("canDirectRetry is true when only thinking output was recorded", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.recordAgentEvent(runId, {
      id: "evt-1",
      runId,
      provider: "claude",
      model: null,
      timestamp: new Date().toISOString(),
      type: "assistant_text",
      payload: { blockId: "b1", delta: true, text: "hmm", kind: "thinking" },
    });
    workspaces.finishAgentRun(runId, "error");
    assert.equal(workspaces.runProducedWork(runId), false);
    assert.equal(workspaces.canDirectRetry(ctx.prompt.id), true);
  } finally {
    ctx.cleanup();
  }
});

test("canDirectRetry is true when only a usage-limit message was emitted", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.recordAgentEvent(runId, {
      id: "evt-1",
      runId,
      provider: "claude",
      model: null,
      timestamp: new Date().toISOString(),
      type: "assistant_text",
      payload: { blockId: "b1", delta: false, text: "You're out of extra usage · resets 11:40pm", kind: "message" },
    });
    workspaces.finishAgentRun(runId, "error");
    assert.equal(workspaces.canDirectRetry(ctx.prompt.id), true);
  } finally {
    ctx.cleanup();
  }
});

test("canDirectRetry is false after tool use", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.recordAgentEvent(runId, {
      id: "evt-1",
      runId,
      provider: "claude",
      model: null,
      timestamp: new Date().toISOString(),
      type: "tool_use",
      payload: { toolUseId: "t1", name: "Bash", summary: "ls", input: { command: "ls" } },
    });
    workspaces.finishAgentRun(runId, "error");
    assert.equal(workspaces.canDirectRetry(ctx.prompt.id), false);
  } finally {
    ctx.cleanup();
  }
});

test("canDirectRetry is true for interrupted system failures", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.finishAgentRun(runId, "interrupted");
    assert.equal(workspaces.canDirectRetry(ctx.prompt.id), true);
  } finally {
    ctx.cleanup();
  }
});

test("canDirectRetry is true for abandoned STARTING runs", () => {
  const ctx = fixture();
  try {
    beginExecute(ctx.prompt.id, ctx.workspace.id);
    assert.equal(workspaces.resolvePrompt(ctx.workspace.id, ctx.prompt.id).status, "IN_PROGRESS");
    assert.equal(workspaces.canDirectRetry(ctx.prompt.id), true);
  } finally {
    ctx.cleanup();
  }
});

test("canDirectRetry is false for agent-posted human blockers", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    workspaces.updateAgentStatus(runId, {
      requestId: randomUUID(),
      expectedStatus: "IN_PROGRESS",
      status: "BLOCKED",
      reason: "need a decision",
      verificationSummary: "answer the question",
    });
    workspaces.finishAgentRun(runId, "done");
    assert.equal(workspaces.canDirectRetry(ctx.prompt.id), false);
  } finally {
    ctx.cleanup();
  }
});

test("promptActivity exposes directRetry", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.finishAgentRun(runId, "error");
    assert.equal(workspaces.promptActivity(ctx.prompt.id).directRetry, true);
  } finally {
    ctx.cleanup();
  }
});

test("a later handoff run does not hide an interrupted developer run", () => {
  const ctx = fixture();
  try {
    const executeId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.finishAgentRun(executeId, "interrupted");
    const handoffId = newId("run");
    workspaces.beginHandoffAgentRun({
      runId: handoffId,
      workspaceId: ctx.workspace.id,
      promptId: ctx.prompt.id,
      provider: "copilot",
      model: null,
      tokenHash: "test-token",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    workspaces.finishAgentRun(handoffId, "error");

    const prompt = workspaces.resolvePrompt(ctx.workspace.id, ctx.prompt.id);
    assert.equal(prompt.currentRun?.id, executeId);
    assert.equal(prompt.recoverable, true);
    assert.equal(workspaces.recoveryRunId(ctx.prompt.id), executeId);
  } finally {
    ctx.cleanup();
  }
});

/*
 * A budget stop is not a question. The harness ends the run, banks its work and
 * marks the station BLOCKED — an operator resumes that; they cannot answer it.
 * Classification reads the actor on the status event, so it no longer depends
 * on how the stop reason happens to be worded.
 */
test("a budget-stopped run is recoverable, not awaiting a human answer", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    workspaces.finishAgentRun(runId, "done", "", {
      usage: null,
      toolCalls: 40,
      toolOutputBytes: 0,
      stopReason: "budget_input_tokens:4000000",
    });
    const prompt = workspaces.promptOptions(ctx.workspace.id).find((item) => item.id === ctx.prompt.id)!;
    // A budget stop is deliberate and resumable. The run ended without saying
    // what it achieved, which is UNREPORTED — not BLOCKED, which would claim a
    // human was asked something, and not FAILED, which would claim a crash.
    assert.equal(prompt.status, "UNREPORTED");
    // Still recoverable — the Recover button is offered — but it is *shown* as
    // what it is. This used to display "Recovery needed", because the overlay
    // fired on `recoverable` alone and masked the stored status; that threw
    // away the distinction between a run that said nothing and one that
    // crashed, at the very last step.
    assert.equal(prompt.recoverable, true);
    assert.equal(operationalState(prompt), "UNREPORTED");
  } finally {
    ctx.cleanup();
  }
});

test("a budget-stopped station can be recovered and replayed", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    workspaces.finishAgentRun(runId, "done", "", {
      usage: null,
      toolCalls: 40,
      toolOutputBytes: 0,
      stopReason: "budget_wall_clock_ms:2700000",
    });
    workspaces.recoverPrompt(ctx.prompt.id, runId);
    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "TODO");
  } finally {
    ctx.cleanup();
  }
});

test("an agent-posted BLOCKED still asks for a human answer", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    workspaces.updateAgentStatus(runId, {
      requestId: randomUUID(),
      expectedStatus: "IN_PROGRESS",
      status: "BLOCKED",
      reason: "Which staging database should this point at?",
      verificationSummary: "none — waiting on the answer",
    });
    workspaces.finishAgentRun(runId, "done");
    const prompt = workspaces.promptOptions(ctx.workspace.id).find((item) => item.id === ctx.prompt.id)!;
    assert.equal(prompt.recoverable, false);
    assert.equal(operationalState(prompt), "BLOCKED");
    assert.throws(() => workspaces.recoverPrompt(ctx.prompt.id, runId), /not an abandoned or system-interrupted run/);
  } finally {
    ctx.cleanup();
  }
});
