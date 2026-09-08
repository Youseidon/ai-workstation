import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { newId } from "../src/lib/ids.ts";
import { pipelineScheduler, setPipelineStationStarter } from "../src/pipelineScheduler.ts";
import { runContexts } from "../src/runContext.ts";
import { runHub } from "../src/runHub.ts";
import { emptyBudgetSnapshot, type RunHandle } from "../src/runner.ts";
import type { StartExecuteArgs } from "../src/runService.ts";
import { workspaces } from "../src/workspaces.ts";

/*
 * `runHub.stopAll` latches the hub closed for the life of the process, so these
 * tests share a file of their own: anything asserting normal scheduling after
 * one of them ran would see a hub that never reopens.
 */

let seq = 0;

function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${seq}`;
}

function fixture(promptCount = 2) {
  const dir = mkdtempSync(join(tmpdir(), "shutdown-"));
  const workspace = workspaces.create({ name: unique("ws"), description: "", workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: unique("prog"), overview: "" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: unique("suite"), overview: "" }) as SuiteRecord;
  const prompts: PromptRecord[] = [];
  for (let index = 0; index < promptCount; index++) {
    prompts.push(workspaces.createChild("prompt", suite.id, { title: unique(`p${index}`), content: `do ${index}` }) as PromptRecord);
  }
  const pipeline = workspaces.createPipeline({ workspaceId: workspace.id, name: unique("pipe"), suiteIds: [suite.id] });
  for (const prompt of prompts) workspaces.addNamedPipelineStep(pipeline.id, prompt.id, { provider: "claude" });
  return {
    dir,
    workspace,
    suite,
    pipeline,
    prompts,
    cleanup() {
      setPipelineStationStarter(null);
      workspaces.remove(workspace.id);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function stubStarts(): StartExecuteArgs[] {
  const started: StartExecuteArgs[] = [];
  setPipelineStationStarter(async (args) => {
    started.push({ ...args });
    const runId = newId("run");
    const promptId = args.promptId;
    if (promptId === undefined) throw new Error("pipeline stub requires promptId");
    const credential = runContexts.create(runId, args.workspaceId, promptId);
    workspaces.beginAgentRun({
      runId,
      workspaceId: args.workspaceId,
      promptId,
      provider: args.provider,
      model: args.model,
      tokenHash: credential.tokenHash,
      expiresAt: credential.expiresAt,
      role: "execute",
    });
    workspaces.markAgentRunRunning(runId);
    return { runId };
  });
  return started;
}

function registerRun(runId: string, workspace: { id: number; name: string; workDirectory: string }, onInterrupt: () => void): void {
  runHub.start({
    handle: {
      runId,
      provider: "claude",
      model: null,
      role: "execute",
      permissionMode: null,
      budget: emptyBudgetSnapshot,
      sessionId: () => null,
      interrupt: async () => { onInterrupt(); runHub.end(runId, "interrupted"); },
      done: Promise.resolve("interrupted"),
    } satisfies RunHandle,
    workspace,
    source: { type: "custom", displayText: "station" },
    role: "execute",
  });
}

test("shutdown interrupts every live run instead of orphaning it", async () => {
  const ctx = fixture(1);
  try {
    const workspace = { id: ctx.workspace.id, name: ctx.workspace.name, workDirectory: ctx.workspace.workDirectory };
    const interrupted: string[] = [];
    const first = newId("run");
    const second = newId("run");
    registerRun(first, workspace, () => interrupted.push(first));
    registerRun(second, workspace, () => interrupted.push(second));
    assert.equal(runHub.isClosing(), false);

    await runHub.stopAll();

    assert.deepEqual(interrupted.sort(), [first, second].sort());
    assert.equal(runHub.has(first), false);
    assert.equal(runHub.has(second), false);
    assert.equal(runHub.isClosing(), true);
  } finally {
    ctx.cleanup();
  }
});

/*
 * The station's run ends because the server is going down, not because the work
 * finished. Advancing here would spawn the successor into a process that is
 * about to exit — the orphaned-agent bug, re-entered through the back door.
 */
test("a run ending during shutdown does not advance the pipeline", async () => {
  const ctx = fixture(2);
  const started = stubStarts();
  try {
    await pipelineScheduler.playNamed(ctx.pipeline.id, { provider: "claude" });
    const playing = workspaces.activePipeline(ctx.suite.id)!;
    const runId = playing.currentRunId!;
    assert.equal(started.length, 1);

    await runHub.stopAll();
    await pipelineScheduler.onExecuteEnded({
      runId,
      workspaceId: ctx.workspace.id,
      promptId: ctx.prompts[0]!.id,
      processState: "interrupted",
    });

    assert.equal(started.length, 1, "no successor may be started while shutting down");
    const active = workspaces.activePipeline(ctx.suite.id);
    // Left PLAYING on purpose: the next boot marks it interrupted with a
    // server_restart reason, which is what the recover/resume flow reads.
    assert.equal(active?.state, "PLAYING");
    assert.equal(active?.currentPromptId, ctx.prompts[0]!.id);
  } finally {
    ctx.cleanup();
  }
});
