import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AdapterEvent, ProgramRecord, PromptRecord, SuiteRecord } from "@hydra/shared";
import { setAdapterOverride } from "../../../src/providers/registry.ts";
import type { AgentAdapter, RunOptions } from "../../../src/contracts/agentAdapter.ts";
import { pipelineScheduler } from "../../../src/services/pipeline/pipelineScheduler.ts";
import { checkpointRun, runChangeDetail } from "../../../src/services/workspaces/gitChanges.ts";
import { runHub } from "../../../src/services/runs/runHub.ts";
import { startExecute } from "../../../src/services/runs/runService.ts";
import { resetSettings, updateSettings } from "../../../src/config/settings.ts";
import { workspaces } from "../../../src/repositories/workspaces.ts";

let seq = 0;
const unique = (prefix: string): string => `${prefix}-${process.pid}-${Date.now()}-${(seq += 1)}`;

const TOOL_CALL_CAP = 2;

interface Turn {
  sessionId?: string | null;
  bank?: (runId: string) => void;
  toolCalls?: number;
  post?: (runId: string) => void;
  finish?: boolean;
}

interface Started {
  prompt: string;
  options: RunOptions;
}

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
  execFileSync("git",["init","-q"],{cwd:dir});
  execFileSync("git",["-c","user.name=Fixture","-c","user.email=fixture@example.test","commit","--allow-empty","-qm","Initial"],{cwd:dir});
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

async function settle(workspaceId: number): Promise<void> {
  let quiet = 0;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    quiet = runHub.activeForWorkspace(workspaceId) === undefined ? quiet + 1 : 0;
    if (quiet >= 8) return;
  }
  const stuck = runHub.activeForWorkspace(workspaceId);
  if (stuck !== undefined) {
    await stuck.handle.interrupt();
    runHub.end(stuck.runId, "interrupted");
  }
  throw new Error("runs did not settle");
}

test("a saved prompt run started outside a pipeline appears in Changes", async () => {
  const ctx = fixture();
  const adapter = scriptedProvider([{
    finish: true,
    post: (runId) => {
      writeFileSync(join(ctx.workspace.workDirectory, "standalone.ts"), "export const standalone = true;\n");
      checkpointRun(runId, "Add standalone feature", "claude", null);
    },
  }]);
  setAdapterOverride("claude", adapter);
  try {
    const { runId } = await startExecute({
      workspaceId: ctx.workspace.id,
      provider: "claude",
      model: null,
      promptId: ctx.prompt.id,
    });
    await settle(ctx.workspace.id);

    const changes = workspaces.runChangeSets(ctx.workspace.id);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]?.runId, runId);
    assert.equal(changes[0]?.promptTitle, ctx.prompt.title);
    assert.equal(changes[0]?.pipeline, null);
    assert.equal(changes[0]?.filesChanged, 1);
    assert.equal(changes[0]?.message, "Add standalone feature");
    assert.equal(runChangeDetail(runId).files[0]?.path, "standalone.ts");
  } finally {
    setAdapterOverride("claude", null);
    ctx.cleanup();
  }
});

test("a run stopped by its budget gets one wrap-up turn, on the session it was already having", async () => {
  const ctx = fixture();
  try {
    const { adapter } = await runToBudgetStop(ctx, [
      { sessionId: "sess-abc", toolCalls: 6 },
      { toolCalls: 0, post: (runId) => { workspaces.updateAgentStatus(runId, { requestId: unique("req"), expectedStatus: "IN_PROGRESS", status: "CONTINUE", reason: "Finish the migration in db/003.sql" }); }, finish: true },
    ]);

    const runs = runsFor(ctx.prompt.id);
    assert.equal(runs.length, 2, "expected the source run and exactly one wrap-up");
    const [wrapUp, source] = runs;
    assert.equal(workspaces.wrapupSourceRunId(wrapUp!.id), source!.id);
    assert.equal(workspaces.wrapupSourceRunId(source!.id), null, "the source run is not a wrap-up of anything");
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
    await runToBudgetStop(ctx, [{ sessionId: "sess-loop", toolCalls: 6 }, { toolCalls: 20 }]);
    assert.equal(runsFor(ctx.prompt.id).length, 2);
  } finally {
    ctx.cleanup();
  }
});

test("a provider that never named a session gets a written brief instead of a resume", async () => {
  const ctx = fixture();
  try {
    const { adapter } = await runToBudgetStop(ctx, [
      {
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
    assert.match(outcome.result, /budget_tool_calls:2/);

    const decided = events(ctx.prompt.id).find((event) => event.newStatus === "UNREPORTED");
    assert.equal(decided?.ruleId, "run-ended-no-post");
    const runs = runsFor(ctx.prompt.id);
    assert.equal(decided?.evidence?.wrapupOf, runs[1]!.id);
    assert.equal(decided?.evidence?.wrapupStopReason, "budget_tool_calls:2");
  } finally {
    ctx.cleanup();
  }
});

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
    assert.equal(brief?.runId, runsFor(ctx.prompt.id)[0]!.id);
  } finally {
    ctx.cleanup();
  }
});

test("the pipeline hears about the stopped run only once the wrap-up has finished", async () => {
  const ctx = fixture();
  const real = pipelineScheduler.onExecuteEnded;
  const told: Array<{ runId: string; runsAtTheTime: number; statusAtTheTime: string }> = [];
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
    assert.equal(told[0]!.runId, runsFor(ctx.prompt.id)[1]!.id);
    assert.equal(told[0]!.runsAtTheTime, 2);
    assert.equal(told[0]!.statusAtTheTime, "TODO");
  } finally {
    pipelineScheduler.onExecuteEnded = real;
    ctx.cleanup();
  }
});

test("a wrap-up that cannot launch closes its own run row", async () => {
  const ctx = fixture();
  const real = pipelineScheduler.onExecuteEnded;
  const told: string[] = [];
  pipelineScheduler.onExecuteEnded = async (args) => { told.push(args.runId); };
  try {
    await runToBudgetStop(ctx, [
      {
        sessionId: "sess-doomed",
        toolCalls: 6,
        bank: () => {
          setAdapterOverride("claude", {
            get id(): never { throw new Error("No professional model is available for claude"); },
          } as unknown as AgentAdapter);
        },
      },
    ]);

    const runs = runsFor(ctx.prompt.id);
    assert.equal(runs.length, 2, "expected the source run and the wrap-up that failed to launch");
    const [wrapUp, source] = runs;
    assert.equal(wrapUp!.state, "ERROR", "the wrap-up row was left open");
    assert.equal(workspaces.agentRunActive(wrapUp!.id), false);
    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "UNREPORTED");
    assert.deepEqual(told, [source!.id], "the pipeline was not told the station ended");
  } finally {
    pipelineScheduler.onExecuteEnded = real;
    setAdapterOverride("claude", null);
    ctx.cleanup();
  }
});

test("a run row with no live process behind it does not refuse the next start", async () => {
  const ctx = fixture();
  const adapter = scriptedProvider([{ finish: true }]);
  setAdapterOverride("claude", adapter);
  try {
    const abandoned = unique("run-abandoned");
    workspaces.beginWrapUpRun({
      runId: abandoned, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null,
      tokenHash: "x", expiresAt: new Date(Date.now() + 60_000).toISOString(), sourceRunId: unique("run-source"), sessionId: null,
    });
    assert.equal(workspaces.agentRunActive(abandoned), true);

    const { runId } = await startExecute({ workspaceId: ctx.workspace.id, provider: "claude", model: null, promptId: ctx.prompt.id });
    await settle(ctx.workspace.id);

    assert.notEqual(runId, abandoned);
    assert.equal(workspaces.agentRunActive(abandoned), false, "the abandoned row was left holding the work item");
    assert.equal(runsFor(ctx.prompt.id).find((run) => run.id === abandoned)!.state, "INTERRUPTED");
    assert.equal(adapter.seen.length, 1, "the new run never reached the provider");
  } finally {
    setAdapterOverride("claude", null);
    ctx.cleanup();
  }
});
