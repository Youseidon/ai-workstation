import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { newId } from "./lib/ids.ts";
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
