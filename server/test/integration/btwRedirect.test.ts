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
import { sendBtw } from "../../src/services/runs/runMessages.ts";
import { emptyBudgetSnapshot } from "../../src/services/runs/runner.ts";
import type { RunHandle } from "../../src/contracts/runs.ts";
import type { StartExecuteArgs } from "../../src/contracts/runRequests.ts";
import { WorkspaceError, workspaces } from "../../src/repositories/workspaces.ts";

let seq = 0;
const unique = (prefix: string) => `${prefix}-${process.pid}-${Date.now()}-${(seq += 1)}`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "btw-redirect-"));
  const workspace = workspaces.create({ name: unique("ws"), workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: unique("prog") }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: unique("suite") }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: "Build backend", content: "Build it." }) as PromptRecord;
  const pipeline = workspaces.createPipeline({ workspaceId: workspace.id, name: unique("pipe"), suiteIds: [suite.id] });
  workspaces.addNamedPipelineStep(pipeline.id, prompt.id, { provider: "cursor" });

  const started: StartExecuteArgs[] = [];
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

test("interrupt & deliver resumes the same session with the note and spends no allowance", async () => {
  const ctx = fixture();
  try {
    await pipelineScheduler.playNamed(ctx.pipeline.id, { provider: "cursor" });
    const first = workspaces.activePipeline(ctx.suite.id)!.currentRunId!;
    assert.equal(ctx.started.length, 1);

    const message = await sendBtw(first, { text: "I already ran the build manually. Skip it.", interrupt: true });
    assert.equal(message.delivery, "resume");

    assert.equal(ctx.started.length, 2, "the station restarted");
    assert.deepEqual(ctx.started[1]!.redirect, { sessionId: `session-of-${first}`, text: "I already ran the build manually. Skip it." });
    assert.equal(ctx.started[1]!.promptId, ctx.prompt.id);
    assert.equal(workspaces.continuationCount(ctx.prompt.id), 0, "an operator interrupt is not an unfinished ending");
    const [row] = workspaces.runMessages(first);
    assert.equal(row!.state, "DELIVERED");
    assert.deepEqual(workspaces.promptBriefings(ctx.prompt.id), [], "a resumed session needs no briefing");
  } finally {
    await ctx.cleanup();
  }
});

test("interrupt & deliver is refused for a run no pipeline owns", async () => {
  const ctx = fixture();
  const runId = newId("run");
  const credential = runContexts.create(runId, ctx.workspace.id, ctx.prompt.id);
  workspaces.beginAgentRun({ runId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "cursor", model: null, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt });
  runHub.start({
    handle: { runId, provider: "cursor", model: null, role: "execute", permissionMode: null, budget: emptyBudgetSnapshot, sessionId: () => null, interrupt: async () => { runHub.end(runId, "interrupted"); }, done: Promise.resolve("interrupted") } as unknown as RunHandle,
    workspace: { id: ctx.workspace.id, name: ctx.workspace.name, workDirectory: ctx.workspace.workDirectory },
    source: { type: "custom", displayText: "chat" },
    role: "execute",
  });
  try {
    await assert.rejects(sendBtw(runId, { text: "Stop please", interrupt: true }), (error: unknown) => error instanceof WorkspaceError && error.code === "btw_interrupt_pipeline_only");
    assert.equal(runHub.has(runId), true, "the run keeps working");
  } finally {
    runHub.end(runId, "interrupted");
    await ctx.cleanup();
  }
});
