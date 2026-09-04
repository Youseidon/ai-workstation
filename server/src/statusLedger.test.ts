/**
 * The guarantees the operator is being asked to trust.
 *
 * Each test here corresponds to a claim made on screen: that a status was
 * decided rather than fallen into, that its cause was recorded at the time, and
 * that a run which finished the work is never reported as a failure because it
 * forgot to say so.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { STATUS_TRIGGERS } from "@agent-console/shared";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { newId } from "./lib/ids.ts";
import { runContexts } from "./runContext.ts";
import { workspaces } from "./workspaces.ts";
import { decide, endOfRunReason, endOfRunSignal } from "./statusTransition.ts";

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

/* ------------------------------------------------------------------ */
/* The end-of-run ladder                                               */
/* ------------------------------------------------------------------ */

test("a run that ends cleanly without posting is UNREPORTED, never DONE and never FAILED", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    workspaces.finishAgentRun(runId, "done");

    const status = workspaces.promptOutcome(ctx.prompt.id).status;
    assert.equal(status, "UNREPORTED");
    // Stated as three separate refusals because each is a distinct way the old
    // code could have lied: claiming success, claiming failure, or claiming the
    // agent had asked the operator a question it never asked.
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

test("a budget stop is resumable, not a crash", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    workspaces.finishAgentRun(runId, "done", "", {
      usage: null, toolCalls: 12, toolOutputBytes: 0, stopReason: "budget_input_tokens:4000000",
    });
    // The work up to the cap is real and banked in remarks. Calling it a
    // failure would tell a successor to start over.
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
    // The process ending afterwards must not disturb it: the agent's own post
    // through the audited API is the most direct evidence there is.
    workspaces.finishAgentRun(runId, "error");
    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "DONE");

    const posted = events(ctx.prompt.id).find((e) => e.newStatus === "DONE");
    assert.equal(posted?.actorType, "AGENT");
    assert.equal(posted?.trigger, "agent_post");
  } finally {
    ctx.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* The ledger                                                          */
/* ------------------------------------------------------------------ */

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

    // The two run endings must name the transition row that decided them, so
    // "why is this red" resolves to a row the operator can read.
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
    // beginAgentRun moves TODO → IN_PROGRESS: one transition, one row.
    assert.equal(events(ctx.prompt.id).length, before + 1);
    workspaces.markAgentRunRunning(runId);
    workspaces.finishAgentRun(runId, "done");
    assert.equal(events(ctx.prompt.id).length, before + 2);
  } finally {
    ctx.cleanup();
  }
});

test("the agent API refuses any status but the two it may post", () => {
  const ctx = fixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    // An overlay is recomputed on every read; storing one would let the
    // database and the display disagree the moment the underlying fact
    // changed. An agent must not be able to declare itself under review or
    // unreported either — those are conclusions the app draws, not claims the
    // agent gets to make about itself.
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

/* ------------------------------------------------------------------ */
/* The decision, without a database                                    */
/* ------------------------------------------------------------------ */

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
  // A budget stop is the runner's decision, not the agent's failure.
  assert.equal(endOfRunSignal({ status: "IN_PROGRESS", outcome: "error", stopReason: "budget_wall_clock" }), "run_ended_no_post");
});

test("each ending explains itself in a sentence an operator can act on", () => {
  const crashed = endOfRunReason({ status: "IN_PROGRESS", outcome: "error", stopReason: null });
  assert.match(crashed, /observed failure/i);
  const budget = endOfRunReason({ status: "IN_PROGRESS", outcome: "done", stopReason: "budget_tool_calls:200" });
  assert.match(budget, /resume from there/i);
  const silent = endOfRunReason({ status: "IN_PROGRESS", outcome: "done", stopReason: null });
  assert.match(silent, /unknown/i);
});

test("the decision names a row, and the row lands where the ladder says", () => {
  assert.equal(decide("run_ended_no_post").to, "UNREPORTED");
  assert.equal(decide("run_ended_no_post").row.id, "run-ended-no-post");
  assert.equal(decide("run_crashed").to, "FAILED");
  assert.equal(decide("run_start_failed").to, "FAILED");
});

/* ------------------------------------------------------------------ */
/* What a parent knows about its children                              */
/* ------------------------------------------------------------------ */

test("a parent surfaces the worst outcome underneath it, without taking it on", () => {
  const ctx = fixture();
  try {
    // Decompose the work item, then fail one sub-step and block another.
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
    workspaces.finishAgentRun(first, "error");            // → FAILED
    const second = beginExecute(children[1]!.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(second);
    workspaces.finishAgentRun(second, "done");            // → UNREPORTED

    const suite = workspaces.operations(ctx.workspace.id).suites[0]!;
    const parent = suite.prompts.find((p) => p.prompt.id === ctx.prompt.id)!;

    // FAILED outranks UNREPORTED, so that is what surfaces.
    assert.equal(parent.childAttention, "FAILED");
    assert.equal(parent.childAttentionCount, 1);

    // And the parent's own status is untouched. After a decompose a fresh run
    // resumes the parent for final integration and posts its own outcome;
    // writing a status onto it from its children would pre-empt that decision
    // and assert something nothing had established about the parent's own work.
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
    // Nothing to raise, so the parent is free to be picked up for integration.
    assert.equal(parent.childAttention, null);
    assert.equal(parent.childAttentionCount, 0);
  } finally {
    ctx.cleanup();
  }
});
