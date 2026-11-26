import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { STATUS_TRIGGERS } from "@hydra/shared";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@hydra/shared";
import { newId } from "../../src/utils/ids.ts";
import { runContexts } from "../../src/services/runs/runContext.ts";
import { workspaces, WorkspaceError } from "../../src/repositories/workspaces.ts";
import { decide, endOfRunReason, endOfRunSignal } from "../../src/domain/pipeline/statusTransition.ts";

let seq = 0;
const unique = (prefix: string): string => `${prefix}-${process.pid}-${Date.now()}-${(seq += 1)}`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "status-ledger-"));
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
  return runId;
}

const events = (promptId: number) =>
  workspaces.promptHistory(promptId).events as Array<{
    newStatus: string; previousStatus: string; reason: string;
    actorType: string; trigger?: string | null; ruleId?: string | null;
  }>;

test("a run that ends cleanly without posting is UNREPORTED, never DONE and never FAILED", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    workspaces.finishAgentRun(runId, "done");

    const status = workspaces.promptOutcome(ctx.prompt.id).status;
    assert.equal(status, "UNREPORTED");
    assert.notEqual(status, "DONE");
    assert.notEqual(status, "FAILED");
    assert.notEqual(status, "BLOCKED");
  } finally {
    ctx.cleanup();
  }
});

test("a crashed process is FAILED, and a clean exit never is", () => {
  const crashed = fixture();
  try {
    const runId = beginExecute(crashed.prompt.id, crashed.workspace.id);
    workspaces.markAgentRunRunning(runId);
    workspaces.finishAgentRun(runId, "error");
    assert.equal(workspaces.promptOutcome(crashed.prompt.id).status, "FAILED");
  } finally {
    crashed.cleanup();
  }

  const clean = fixture();
  try {
    const runId = beginExecute(clean.prompt.id, clean.workspace.id);
    workspaces.markAgentRunRunning(runId);
    workspaces.finishAgentRun(runId, "done");
    assert.notEqual(workspaces.promptOutcome(clean.prompt.id).status, "FAILED");
  } finally {
    clean.cleanup();
  }
});

test("an agent cannot turn an in-workspace repair into a human blocker", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    assert.throws(
      () => workspaces.updateAgentStatus(runId, {
        requestId: unique("status"), expectedStatus: "IN_PROGRESS", status: "BLOCKED",
        reason: "The verification script has a fixed-sleep race.",
        verificationSummary: "Update the Verify command in the work-item database and requeue it.",
      }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "recoverable_blocker",
    );
    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "IN_PROGRESS");
  } finally { ctx.cleanup(); }
});

test("an agent cannot ask a human to repair tracker scope or choose a speculative mapping", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    assert.throws(
      () => workspaces.updateAgentStatus(runId, {
        requestId: unique("status"), expectedStatus: "IN_PROGRESS", status: "BLOCKED",
        reason: "The saved work-item scope names routes that are absent from the authoritative catalog.",
        verificationSummary: "Update the saved database work item with actual route IDs, or choose one of three speculative route mappings and requeue it.",
      }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "recoverable_blocker",
    );
    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "IN_PROGRESS");
  } finally { ctx.cleanup(); }
});

test("a budget stop is resumable, not a crash", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    workspaces.finishAgentRun(runId, "done", "", {
      usage: null, toolCalls: 12, toolOutputBytes: 0, stopReason: "budget_input_tokens:4000000",
    });
    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "UNREPORTED");
    assert.match(workspaces.promptOutcome(ctx.prompt.id).result, /budget/i);
  } finally {
    ctx.cleanup();
  }
});

test("a status the agent posted is left exactly as posted", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    workspaces.updateAgentStatus(runId, {
      requestId: unique("req"), expectedStatus: "IN_PROGRESS", status: "DONE",
      reason: "Finished", verificationSummary: "npm test: 188 passing.",
    });
    workspaces.finishAgentRun(runId, "error");
    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "DONE");

    const posted = events(ctx.prompt.id).find((e) => e.newStatus === "DONE");
    assert.equal(posted?.actorType, "AGENT");
    assert.equal(posted?.trigger, "agent_post");
  } finally {
    ctx.cleanup();
  }
});

test("every status change records what caused it and which rule decided", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    workspaces.finishAgentRun(runId, "done");
    workspaces.resetPromptToTodo(ctx.prompt.id, "operator retried");
    const second = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(second);
    workspaces.finishAgentRun(second, "error");

    const all = events(ctx.prompt.id);
    assert.ok(all.length >= 5, `expected a full history, got ${all.length}`);
    for (const event of all) {
      assert.ok(
        event.trigger != null && (STATUS_TRIGGERS as readonly string[]).includes(event.trigger),
        `a ${event.previousStatus} → ${event.newStatus} change recorded no known cause`,
      );
      assert.ok(event.reason.length > 0, `a ${event.newStatus} change recorded no sentence`);
    }

    const decided = all.filter((e) => e.newStatus === "UNREPORTED" || e.newStatus === "FAILED");
    assert.equal(decided.length, 2);
    assert.deepEqual(decided.map((e) => e.ruleId).sort(), ["run-crashed", "run-ended-no-post"]);
  } finally {
    ctx.cleanup();
  }
});

test("a status change writes exactly one ledger row", () => {
  const ctx = fixture();
  try {
    const before = events(ctx.prompt.id).length;
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    assert.equal(events(ctx.prompt.id).length, before + 1);
    workspaces.markAgentRunRunning(runId);
    workspaces.finishAgentRun(runId, "done");
    assert.equal(events(ctx.prompt.id).length, before + 2);
  } finally {
    ctx.cleanup();
  }
});

test("a run stopped under budget with a wrap-up pending records nothing yet", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    const before = events(ctx.prompt.id).length;
    workspaces.finishAgentRun(runId, "done", "", {
      usage: null, toolCalls: 40, toolOutputBytes: 0, stopReason: "budget_tool_calls:1000", sessionId: "sess-1",
    }, { deferStatus: true });

    assert.equal(events(ctx.prompt.id).length, before, "the deferred ending wrote a ledger row anyway");
    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "IN_PROGRESS");
    const run = (workspaces.promptHistory(ctx.prompt.id).runs as Array<{ id: string; state: string; endedAt: string | null }>)[0]!;
    assert.equal(run.state, "DONE");
    assert.ok(run.endedAt !== null);
    assert.equal(workspaces.runSessionId(runId), "sess-1");
  } finally {
    ctx.cleanup();
  }
});

test("a wrap-up that cannot be started leaves the item exactly where it would have been", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    workspaces.finishAgentRun(runId, "done", "", {
      usage: null, toolCalls: 40, toolOutputBytes: 0, stopReason: "budget_wall_clock_ms:5400000", sessionId: null,
    }, { deferStatus: true });
    workspaces.applyDeferredRunEnd(runId);

    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "UNREPORTED");
    const decided = events(ctx.prompt.id).find((event) => event.newStatus === "UNREPORTED");
    assert.equal(decided?.ruleId, "run-ended-no-post");
    assert.match(workspaces.promptOutcome(ctx.prompt.id).result, /budget_wall_clock_ms/);

    const settled = events(ctx.prompt.id).length;
    workspaces.applyDeferredRunEnd(runId);
    assert.equal(events(ctx.prompt.id).length, settled);
  } finally {
    ctx.cleanup();
  }
});

test("the agent API refuses any status but the three it may post", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    for (const status of ["WORKING", "READY", "RECOVERY_NEEDED", "UNREPORTED", "FAILED", "NEEDS_REVIEW", "SKIPPED"]) {
      assert.throws(
        () => workspaces.updateAgentStatus(runId, {
          requestId: unique("req"), expectedStatus: "IN_PROGRESS", status,
          reason: "trying it on", verificationSummary: "none",
        }),
        `${status} was accepted from an agent`,
      );
    }
    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "IN_PROGRESS");
  } finally {
    ctx.cleanup();
  }
});

test("the end-of-run signal never contradicts what the agent already said", () => {
  for (const status of ["DONE", "BLOCKED", "SKIPPED", "TODO"] as const) {
    for (const outcome of ["done", "error", "interrupted"] as const) {
      assert.equal(
        endOfRunSignal({ status, outcome, stopReason: null }), null,
        `a ${outcome} ending overrode a posted ${status}`,
      );
    }
  }
});

test("only an in-flight item is concluded from how its process ended", () => {
  assert.equal(endOfRunSignal({ status: "IN_PROGRESS", outcome: "done", stopReason: null }), "run_ended_no_post");
  assert.equal(endOfRunSignal({ status: "IN_PROGRESS", outcome: "interrupted", stopReason: null }), "run_ended_no_post");
  assert.equal(endOfRunSignal({ status: "IN_PROGRESS", outcome: "error", stopReason: null }), "run_crashed");
  assert.equal(endOfRunSignal({ status: "IN_PROGRESS", outcome: "error", stopReason: "budget_wall_clock" }), "run_ended_no_post");
});

test("each ending explains itself in a sentence an operator can act on", () => {
  const crashed = endOfRunReason({ status: "IN_PROGRESS", outcome: "error", stopReason: null });
  assert.match(crashed, /observed failure/i);
  const budget = endOfRunReason({ status: "IN_PROGRESS", outcome: "done", stopReason: "budget_tool_calls:200" });
  assert.match(budget, /resume from there/i);
  const memory = endOfRunReason({ status: "IN_PROGRESS", outcome: "error", stopReason: "resource_memory_limit:4294967296" });
  assert.match(memory, /memory limit reached/i);
  assert.match(memory, /descendant process tree/i);
  const silent = endOfRunReason({ status: "IN_PROGRESS", outcome: "done", stopReason: null });
  assert.match(silent, /unknown/i);
});

test("the decision names a row, and the row lands where the ladder says", () => {
  assert.equal(decide("run_ended_no_post").to, "UNREPORTED");
  assert.equal(decide("run_ended_no_post").row.id, "run-ended-no-post");
  assert.equal(decide("run_crashed").to, "FAILED");
  assert.equal(decide("run_start_failed").to, "FAILED");
});

test("a parent surfaces the worst outcome underneath it, without taking it on", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    workspaces.decomposePrompt(runId, {
      requestId: unique("req"),
      resumeBrief: "split it",
      children: [
        { title: unique("a"), content: "first slice" },
        { title: unique("b"), content: "second slice" },
      ],
    });

    const children = workspaces.promptOptions(ctx.workspace.id).filter((p) => p.parentPromptId === ctx.prompt.id);
    assert.equal(children.length, 2);

    const first = beginExecute(children[0]!.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(first);
    workspaces.finishAgentRun(first, "error");
    const second = beginExecute(children[1]!.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(second);
    workspaces.finishAgentRun(second, "done");

    const suite = workspaces.operations(ctx.workspace.id).suites[0]!;
    const parent = suite.prompts.find((p) => p.prompt.id === ctx.prompt.id)!;

    assert.equal(parent.childAttention, "FAILED");
    assert.equal(parent.childAttentionCount, 1);

    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "TODO");
  } finally {
    ctx.cleanup();
  }
});

test("children that all finished cleanly propagate nothing", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    workspaces.decomposePrompt(runId, {
      requestId: unique("req"), resumeBrief: "split it",
      children: [{ title: unique("a"), content: "one" }, { title: unique("b"), content: "two" }],
    });
    for (const child of workspaces.promptOptions(ctx.workspace.id).filter((p) => p.parentPromptId === ctx.prompt.id)) {
      const run = beginExecute(child.id, ctx.workspace.id);
      workspaces.markAgentRunRunning(run);
      workspaces.updateAgentStatus(run, {
        requestId: unique("req"), expectedStatus: "IN_PROGRESS", status: "DONE",
        reason: "done", verificationSummary: "checked it",
      });
    }
    const suite = workspaces.operations(ctx.workspace.id).suites[0]!;
    const parent = suite.prompts.find((p) => p.prompt.id === ctx.prompt.id)!;
    assert.equal(parent.childAttention, null);
    assert.equal(parent.childAttentionCount, 0);
  } finally {
    ctx.cleanup();
  }
});
