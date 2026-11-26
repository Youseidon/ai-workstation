/**
 * The stop center's three actions. The incident behind them: a bare interrupt
 * of a pipeline station ended with no status, the scheduler read that as
 * unfinished work and launched a fresh agent, so every extra click on Stop
 * killed one agent and started another.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProgramRecord, PromptRecord, ProviderId, SuiteRecord } from "@hydra/shared";
import { newId } from "../../src/utils/ids.ts";
import { pipelineScheduler, setPipelineStationStarter } from "../../src/services/pipeline/pipelineScheduler.ts";
import { runContexts } from "../../src/services/runs/runContext.ts";
import { runHub } from "../../src/services/runs/runHub.ts";
import { emptyBudgetSnapshot } from "../../src/services/runs/runner.ts";
import type { RunHandle } from "../../src/contracts/runs.ts";
import type { StartExecuteArgs } from "../../src/contracts/runRequests.ts";
import { workspaces } from "../../src/repositories/workspaces.ts";

let seq = 0;
const unique = (prefix: string) => `${prefix}-${process.pid}-${Date.now()}-${(seq += 1)}`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "stop-agent-"));
  const workspace = workspaces.create({ name: unique("ws"), workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: unique("prog") }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: unique("suite") }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: "Build backend", content: "Build it." }) as PromptRecord;
  const pipeline = workspaces.createPipeline({ workspaceId: workspace.id, name: unique("pipe"), suiteIds: [suite.id] });
  workspaces.addNamedPipelineStep(pipeline.id, prompt.id, { provider: "cursor" });

  const started: StartExecuteArgs[] = [];
  // Each station is a live run whose interrupt ends it the way a real one
  // does: the run row closes, the hub forgets it, the scheduler is told.
  setPipelineStationStarter(async (args) => {
    started.push({ ...args });
    const runId = newId("run");
    const credential = runContexts.create(runId, args.workspaceId, args.promptId!);
    workspaces.beginAgentRun({ runId, workspaceId: args.workspaceId, promptId: args.promptId!, provider: args.provider, model: args.model, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute" });
    workspaces.markAgentRunRunning(runId);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    runHub.start({
      handle: {
        runId, provider: args.provider as ProviderId, model: args.model, role: "execute", permissionMode: null, budget: emptyBudgetSnapshot,
        sessionId: () => `session-of-${runId}`,
        interrupt: async () => {
          workspaces.finishAgentRun(runId, "interrupted");
          runHub.end(runId, "interrupted");
          await pipelineScheduler.onExecuteEnded({ runId, workspaceId: args.workspaceId, promptId: args.promptId!, processState: "interrupted" });
          finish();
        },
        done: done.then(() => "interrupted"),
      } as unknown as RunHandle,
      workspace: { id: workspace.id, name: workspace.name, workDirectory: workspace.workDirectory },
      source: { type: "saved", promptId: args.promptId!, promptKey: null, title: "Build backend", programName: "p", suiteName: "s" },
      role: "execute",
    });
    return { runId };
  });
  return {
    workspace, suite, prompt, pipeline, started,
    async cleanup() {
      const active = workspaces.activePipeline(suite.id);
      if (active?.currentRunId) runHub.end(active.currentRunId, "interrupted");
      await pipelineScheduler.stopNamed(pipeline.id).catch(() => undefined);
      setPipelineStationStarter(null);
      workspaces.remove(workspace.id);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("force-stopping a station pauses the pipeline instead of starting a new agent", async () => {
  const ctx = fixture();
  try {
    await pipelineScheduler.playNamed(ctx.pipeline.id, { provider: "cursor" });
    const first = workspaces.activePipeline(ctx.suite.id)!.currentRunId!;

    assert.deepEqual(await pipelineScheduler.stopAgent(first), { stopped: true, pipelinePaused: true });
    assert.equal(runHub.has(first), false);
    assert.equal(ctx.started.length, 1, "no successor was launched");
    assert.equal(workspaces.activePipeline(ctx.suite.id)!.state, "PAUSED");
    assert.equal(workspaces.activeNamedPipelineRun(ctx.pipeline.id)!.state, "PAUSED");
    assert.equal(workspaces.continuationCount(ctx.prompt.id), 0, "an operator stop spends no allowance");

    // The second and third clicks of an impatient operator.
    assert.equal((await pipelineScheduler.stopAgent(first)).stopped, false);
    assert.equal((await pipelineScheduler.stopAgent(first)).stopped, false);
    assert.equal(ctx.started.length, 1);

    await pipelineScheduler.playNamed(ctx.pipeline.id);
    assert.equal(ctx.started.length, 2, "Resume continues the station");
    assert.equal(ctx.started[1]!.promptId, ctx.prompt.id);
  } finally {
    await ctx.cleanup();
  }
});

test("a graceful pause leaves the agent working and starts nothing after it", async () => {
  const ctx = fixture();
  try {
    await pipelineScheduler.playNamed(ctx.pipeline.id, { provider: "cursor" });
    const first = workspaces.activePipeline(ctx.suite.id)!.currentRunId!;

    const paused = await pipelineScheduler.pauseNamed(ctx.pipeline.id, { mode: "graceful" });
    assert.equal(paused.state, "PAUSED");
    assert.equal(runHub.has(first), true, "the agent keeps its step");
    assert.equal(workspaces.activePipeline(ctx.suite.id)!.currentRunId, first);

    // Changing one's mind mid-pause: force-stop the agent that was finishing.
    assert.deepEqual(await pipelineScheduler.stopAgent(first), { stopped: true, pipelinePaused: true });
    assert.equal(ctx.started.length, 1);
    assert.equal(workspaces.activePipeline(ctx.suite.id)!.state, "PAUSED");
  } finally {
    await ctx.cleanup();
  }
});

test("an immediate pause interrupts the agent without spending an allowance", async () => {
  const ctx = fixture();
  try {
    await pipelineScheduler.playNamed(ctx.pipeline.id, { provider: "cursor" });
    const first = workspaces.activePipeline(ctx.suite.id)!.currentRunId!;
    await pipelineScheduler.pauseNamed(ctx.pipeline.id, { mode: "immediate" });
    assert.equal(runHub.has(first), false);
    assert.equal(ctx.started.length, 1);
    assert.equal(workspaces.continuationCount(ctx.prompt.id), 0);
  } finally {
    await ctx.cleanup();
  }
});

test("stopping the pipeline with interruptAgent ends the run and the agent", async () => {
  const ctx = fixture();
  try {
    await pipelineScheduler.playNamed(ctx.pipeline.id, { provider: "cursor" });
    const first = workspaces.activePipeline(ctx.suite.id)!.currentRunId!;
    const stopped = await pipelineScheduler.stopNamed(ctx.pipeline.id, { interruptAgent: true });
    assert.equal(stopped.state, "STOPPED");
    assert.equal(runHub.has(first), false);
    assert.equal(ctx.started.length, 1);
  } finally {
    await ctx.cleanup();
  }
});

test("a run no pipeline owns is simply stopped", async () => {
  const ctx = fixture();
  const runId = newId("run");
  runHub.start({
    handle: { runId, provider: "cursor", model: null, role: "execute", permissionMode: null, budget: emptyBudgetSnapshot, sessionId: () => null, interrupt: async () => { runHub.end(runId, "interrupted"); }, done: Promise.resolve("interrupted") } as unknown as RunHandle,
    workspace: { id: ctx.workspace.id, name: ctx.workspace.name, workDirectory: ctx.workspace.workDirectory },
    source: { type: "custom", displayText: "chat" },
    role: "execute",
  });
  try {
    assert.deepEqual(await pipelineScheduler.stopAgent(runId), { stopped: true, pipelinePaused: false });
    assert.equal(runHub.has(runId), false);
  } finally {
    runHub.end(runId, "interrupted");
    await ctx.cleanup();
  }
});
