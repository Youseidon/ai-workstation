/**
 * The turn a run gets after its budget stops it.
 *
 * 23 execute runs on the owner's install were killed mid-work by a budget.
 * Every one was interrupted with no wrap-up, no notes and no status, and its
 * station landed UNREPORTED with the stop reason as its only record — one work
 * item died that way four times in twenty minutes with nothing written to disk.
 * Each test here is one of the promises made in exchange for that.
 *
 * Real SQLite, the real runner, the real status ledger; only the provider is a
 * stand-in, so what is asserted is what the app actually does rather than what
 * a mock was told to say.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AdapterEvent, ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { setAdapterOverride } from "../src/adapters/registry.ts";
import type { AgentAdapter, RunOptions } from "../src/adapters/types.ts";
import { pipelineScheduler } from "../src/pipelineScheduler.ts";
import { runHub } from "../src/runHub.ts";
import { startExecute } from "../src/runService.ts";
import { resetSettings, updateSettings } from "../src/settings.ts";
import { workspaces } from "../src/workspaces.ts";

let seq = 0;
const unique = (prefix: string): string => `${prefix}-${process.pid}-${Date.now()}-${(seq += 1)}`;

/** The cap every test here trips, low enough that two tool calls reach it. */
const TOOL_CALL_CAP = 2;

interface Turn {
  /** Session id the provider announces on its first status event. */
  sessionId?: string | null;
  /** Banked as a PROGRESS remark before any tool call, so a budget stop cannot beat it. */
  bank?: (runId: string) => void;
  /** Tool calls to make before idling — more than the cap trips the budget. */
  toolCalls?: number;
  /** What the agent does through the door before it finishes, if anything. */
  post?: (runId: string) => void;
  /** End on a `result` rather than idling until interrupted. */
  finish?: boolean;
}

/** What each turn was actually asked to do, kept for the assertions. */
interface Started {
  prompt: string;
  options: RunOptions;
}

/**
 * A provider whose turns are scripted. Each `run()` consumes the next turn, so
 * one adapter covers a source run and the wrap-up that follows it, and what
 * each turn was started with is kept for the resume and brief assertions.
 */
function scriptedProvider(turns: Turn[]): AgentAdapter & { seen: Started[] } {
  const seen: Started[] = [];
  let index = 0;
  const stops = new Map<string, () => void>();
  const interrupted = new Set<string>();
  const adapter = {
    id: "claude" as const,
    label: "Claude Code",
    transport: "sdk" as const,
    reportsTokens: true,
    permissionMode: "bypassPermissions",
    model: null,
    seen,
    checkAvailability: async () => ({ available: true, reason: null, version: null, binary: null }),
    isAvailable: async () => true,
    getVersion: async () => null,
    getAccountUsage: async () => ({ provider: "claude", available: false, reason: null, windows: [] }) as never,
    async *run(prompt: string, opts: RunOptions): AsyncGenerator<AdapterEvent, void> {
      seen.push({ prompt, options: opts });
      const turn = turns[index] ?? {};
      index += 1;
      if (turn.sessionId !== undefined && turn.sessionId !== null) {
        yield { type: "status", payload: { state: "running", detail: "session", sessionId: turn.sessionId } };
        await Promise.resolve();
      }
      turn.bank?.(opts.runId);
      for (let call = 0; call < (turn.toolCalls ?? 0); call += 1) {
        if (interrupted.has(opts.runId)) return;
        yield { type: "tool_use", payload: { toolUseId: `t${call}`, name: "Read", summary: "read", input: { path: `f${call}` } } };
        await Promise.resolve();
        if (interrupted.has(opts.runId)) return;
        yield { type: "tool_result", payload: { toolUseId: `t${call}`, name: "Read", isError: false, summary: "ok", output: "ok", exitCode: 0 } };
        await Promise.resolve();
      }
      turn.post?.(opts.runId);
      if (turn.finish === true || interrupted.has(opts.runId)) {
        yield { type: "result", payload: { state: "done" } };
        return;
      }
      await new Promise<void>((resolve) => stops.set(opts.runId, resolve));
    },
    async interrupt(runId: string): Promise<void> {
      interrupted.add(runId);
      stops.get(runId)?.();
    },
  };
  return adapter as unknown as AgentAdapter & { seen: Started[] };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wrap-up-"));
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

const runsFor = (promptId: number) =>
  workspaces.promptHistory(promptId).runs as Array<{ id: string; state: string; startedAt: string }>;

const events = (promptId: number) =>
  workspaces.promptHistory(promptId).events as Array<{
    newStatus: string; previousStatus: string; reason: string;
    actorType: string; trigger?: string | null; ruleId?: string | null;
    evidence?: Record<string, unknown> | null;
  }>;

const remarks = (promptId: number) =>
  workspaces.promptHistory(promptId).remarks as Array<{ kind: string; content: string; runId: string | null }>;

/**
 * Runs a work item to a budget stop and waits for the wrap-up turn to finish.
 *
 * `startExecute` resolves as soon as the run starts, and the wrap-up is started
 * from the source run's `onEnd`, so the settle point is the workspace going
 * quiet — that is also exactly the moment the pipeline may be told.
 */
async function runToBudgetStop(ctx: ReturnType<typeof fixture>, turns: Turn[]): Promise<{ adapter: AgentAdapter & { seen: Started[] } }> {
  const adapter = scriptedProvider(turns);
  setAdapterOverride("claude", adapter);
  updateSettings({ "budget.maxToolCalls": TOOL_CALL_CAP });
  try {
    await startExecute({ workspaceId: ctx.workspace.id, provider: "claude", model: null, promptId: ctx.prompt.id });
    await settle(ctx.workspace.id);
  } finally {
    resetSettings(["budget.maxToolCalls"]);
    setAdapterOverride("claude", null);
  }
  return { adapter };
}

/**
 * Waits until this workspace has been quiet for a moment.
 *
 * "Nothing running" is briefly true between the source run ending and the
 * wrap-up starting — the second is launched from the first's `onEnd` — so a
 * single check is not enough, and a quiet window is what actually distinguishes
 * "finished" from "in between the two".
 */
async function settle(workspaceId: number): Promise<void> {
  let quiet = 0;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    quiet = runHub.activeForWorkspace(workspaceId) === undefined ? quiet + 1 : 0;
    if (quiet >= 8) return;
  }
  // Never leave a run live: the workspace writer lock is per directory, so one
  // stuck run would fail every test after this one with `workspace_busy` and
  // hide whichever assertion actually broke.
  const stuck = runHub.activeForWorkspace(workspaceId);
  if (stuck !== undefined) {
    await stuck.handle.interrupt();
    runHub.end(stuck.runId, "interrupted");
  }
  throw new Error("runs did not settle");
}

/* ------------------------------------------------------------------ */
/* A budget stop earns exactly one turn                                */
/* ------------------------------------------------------------------ */

test("a run stopped by its budget gets one wrap-up turn, on the session it was already having", async () => {
  const ctx = fixture();
  try {
    const { adapter } = await runToBudgetStop(ctx, [
      { sessionId: "sess-abc", toolCalls: 6 },
      { toolCalls: 0, post: (runId) => { workspaces.updateAgentStatus(runId, { requestId: unique("req"), expectedStatus: "IN_PROGRESS", status: "CONTINUE", reason: "Finish the migration in db/003.sql" }); }, finish: true },
    ]);

    const runs = runsFor(ctx.prompt.id);
    assert.equal(runs.length, 2, "expected the source run and exactly one wrap-up");
    const [wrapUp, source] = runs; // promptHistory is newest first
    assert.equal(workspaces.wrapupSourceRunId(wrapUp!.id), source!.id);
    assert.equal(workspaces.wrapupSourceRunId(source!.id), null, "the source run is not a wrap-up of anything");
    // The point of banking the session id: the turn continues the conversation
    // rather than paying to rebuild it.
    assert.equal(workspaces.runSessionId(source!.id), "sess-abc");
    assert.equal(adapter.seen.length, 2);
    assert.equal(adapter.seen[0]!.options.resumeSessionId ?? null, null, "the source run started a fresh session");
    assert.equal(adapter.seen[1]!.options.resumeSessionId, "sess-abc", "the wrap-up did not resume the stopped run's session");
  } finally {
    ctx.cleanup();
  }
});

test("the wrap-up is never given a wrap-up of its own", async () => {
  const ctx = fixture();
  try {
    // Both turns run past their own ceiling — the wrap-up's is its own fixed 12
    // tool calls, not the station's. A stopped wrap-up simply ends: otherwise it
    // would start another, and an item could spend its way through an unbounded
    // chain of short runs, each one stopped by the same cap.
    await runToBudgetStop(ctx, [{ sessionId: "sess-loop", toolCalls: 6 }, { toolCalls: 20 }]);
    assert.equal(runsFor(ctx.prompt.id).length, 2);
  } finally {
    ctx.cleanup();
  }
});

test("a provider that never named a session gets a written brief instead of a resume", async () => {
  const ctx = fixture();
  try {
    // No session id anywhere: the turn cannot continue a conversation, so it is
    // told what a new session cannot know. Told nothing, it would open with no
    // idea which work item it was speaking for.
    const { adapter } = await runToBudgetStop(ctx, [
      {
        // Banked before the tool calls, exactly as a real run is told to: a
        // remark filed after the budget trips is a remark that never happens.
        bank: (runId) => {
          workspaces.addAgentRemark(runId, { requestId: unique("req"), kind: "PROGRESS", content: "Ported handler 2 of 9; ports 3-9 remain." });
        },
        toolCalls: 6,
      },
      { toolCalls: 0, finish: true },
    ]);

    assert.equal(adapter.seen[1]!.options.resumeSessionId ?? null, null, "a session that was never named must not be resumed");
    const prompt = adapter.seen[1]!.prompt;
    assert.match(prompt, /fresh session/i, "the turn was not told it is starting cold");
    assert.match(prompt, /budget_tool_calls:2/, "the turn was not told why it was stopped");
    assert.match(prompt, /Ported handler 2 of 9/, "the banked progress was not carried into the brief");
    assert.match(prompt, new RegExp(ctx.prompt.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the work item was not named");
  } finally {
    ctx.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* Nothing concludes anything until the turn has had its say           */
/* ------------------------------------------------------------------ */

test("the stopped run writes no ledger row while a wrap-up is pending", async () => {
  const ctx = fixture();
  try {
    let duringWrapUp: ReturnType<typeof events> = [];
    await runToBudgetStop(ctx, [
      { sessionId: "sess-defer", toolCalls: 6 },
      {
        toolCalls: 0,
        post: () => { duringWrapUp = events(ctx.prompt.id); },
        finish: true,
      },
    ]);

    // While the wrap-up was running, the item was still IN_PROGRESS and the
    // source run's ending had recorded nothing. That is what makes the turn
    // possible at all: had the transition fired, the item would have left
    // IN_PROGRESS and the wrap-up's own post would have been refused.
    assert.equal(duringWrapUp.filter((event) => event.newStatus === "UNREPORTED").length, 0);
    assert.equal(duringWrapUp.at(0)?.newStatus, "IN_PROGRESS");
  } finally {
    ctx.cleanup();
  }
});

test("a wrap-up that says nothing leaves the station UNREPORTED, with the budget stop that caused it", async () => {
  const ctx = fixture();
  try {
    await runToBudgetStop(ctx, [{ sessionId: "sess-silent", toolCalls: 6 }, { toolCalls: 0, finish: true }]);

    const outcome = workspaces.promptOutcome(ctx.prompt.id);
    assert.equal(outcome.status, "UNREPORTED");
    // Never DONE and never FAILED: a turn that was offered and not taken says
    // no more about the work than a run that was killed outright.
    assert.match(outcome.result, /budget_tool_calls:2/);

    const decided = events(ctx.prompt.id).find((event) => event.newStatus === "UNREPORTED");
    assert.equal(decided?.ruleId, "run-ended-no-post");
    const runs = runsFor(ctx.prompt.id);
    // The ledger attributes the run that ran out of budget, not the four-minute
    // turn that followed it — otherwise "why is this red" leads to the wrong run.
    assert.equal(decided?.evidence?.wrapupOf, runs[1]!.id);
    assert.equal(decided?.evidence?.wrapupStopReason, "budget_tool_calls:2");
  } finally {
    ctx.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* What the turn can say                                               */
/* ------------------------------------------------------------------ */

test("a wrap-up that posts DONE closes the item exactly as any other DONE does", async () => {
  const ctx = fixture();
  try {
    await runToBudgetStop(ctx, [
      { sessionId: "sess-done", toolCalls: 6 },
      {
        toolCalls: 0,
        post: (runId) => {
          workspaces.updateAgentStatus(runId, {
            requestId: unique("req"), expectedStatus: "IN_PROGRESS", status: "DONE",
            reason: "Finished", verificationSummary: "npm test: 283 passing.",
          });
        },
        finish: true,
      },
    ]);

    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "DONE");
    const posted = events(ctx.prompt.id).find((event) => event.newStatus === "DONE");
    // Same door, same gate, same ledger row as a DONE posted by a run that was
    // never stopped — a wrap-up is a normal execute run with a short prompt.
    assert.equal(posted?.actorType, "AGENT");
    assert.equal(posted?.trigger, "agent_post");
    assert.equal(posted?.ruleId, "agent-done");
  } finally {
    ctx.cleanup();
  }
});

test("a wrap-up that posts CONTINUE leaves a brief and sends the item back to TODO", async () => {
  const ctx = fixture();
  try {
    await runToBudgetStop(ctx, [
      { sessionId: "sess-cont", toolCalls: 6 },
      {
        toolCalls: 0,
        post: (runId) => {
          workspaces.updateAgentStatus(runId, {
            requestId: unique("req"), expectedStatus: "IN_PROGRESS", status: "CONTINUE",
            reason: "Ports 3-8 of src/api are untouched; copy the shape of port 2.",
          });
        },
        finish: true,
      },
    ]);

    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "TODO");
    assert.equal(workspaces.latestStatusTrigger(ctx.prompt.id), "agent_continue");
    const brief = remarks(ctx.prompt.id).find((remark) => remark.kind === "CONTINUATION");
    assert.match(brief?.content ?? "", /Ports 3-8/);
    // Written by the wrap-up run, so the transcript it came from is one click
    // away rather than being attributed to the run that never wrote it.
    assert.equal(brief?.runId, runsFor(ctx.prompt.id)[0]!.id);
  } finally {
    ctx.cleanup();
  }
});

test("the pipeline hears about the stopped run only once the wrap-up has finished", async () => {
  const ctx = fixture();
  const real = pipelineScheduler.onExecuteEnded;
  const told: Array<{ runId: string; runsAtTheTime: number; statusAtTheTime: string }> = [];
  // Spied rather than asserted after the fact: the claim is about *when* the
  // scheduler is told, and by the time the run is over both orderings look the
  // same from the database.
  pipelineScheduler.onExecuteEnded = async (args) => {
    told.push({
      runId: args.runId,
      runsAtTheTime: runsFor(ctx.prompt.id).length,
      statusAtTheTime: workspaces.promptOutcome(ctx.prompt.id).status,
    });
    return real.call(pipelineScheduler, args);
  };
  try {
    await runToBudgetStop(ctx, [
      { sessionId: "sess-order", toolCalls: 6 },
      {
        toolCalls: 0,
        post: (runId) => {
          workspaces.updateAgentStatus(runId, {
            requestId: unique("req"), expectedStatus: "IN_PROGRESS", status: "CONTINUE",
            reason: "Wire the remaining two handlers.",
          });
        },
        finish: true,
      },
    ]);

    assert.equal(told.length, 1, "the wrap-up's own end must not fire a second advance");
    // The source run's id, because the scheduler's `currentRunId` guard keys on
    // the run it started — told about the wrap-up instead, it would decide the
    // notification was stale and do nothing at all.
    assert.equal(told[0]!.runId, runsFor(ctx.prompt.id)[1]!.id);
    // And by then the wrap-up had run and its status was in: a scheduler told
    // any earlier would have acted on IN_PROGRESS with one run on record.
    assert.equal(told[0]!.runsAtTheTime, 2);
    assert.equal(told[0]!.statusAtTheTime, "TODO");
  } finally {
    pipelineScheduler.onExecuteEnded = real;
    ctx.cleanup();
  }
});
