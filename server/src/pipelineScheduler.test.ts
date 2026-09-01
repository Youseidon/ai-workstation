import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { ProgramRecord, PromptPipelineRule, PromptRecord, ProviderId, SuiteRecord } from "@agent-console/shared";
import { newId } from "./lib/ids.ts";
import { pipelineScheduler, resolveExecuteTarget, setPipelineStationStarter } from "./pipelineScheduler.ts";
import { runContexts } from "./runContext.ts";
import { runHub } from "./runHub.ts";
import type { StartExecuteArgs } from "./runService.ts";
import { startExecute } from "./runService.ts";
import type { RunHandle } from "./runner.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${seq}`;
}

function fixture(promptCount = 2) {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const workspace = workspaces.create({ name: unique("ws"), description: "", workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: unique("prog"), overview: "" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: unique("suite"), overview: "" }) as SuiteRecord;
  const prompts: PromptRecord[] = [];
  for (let index = 0; index < promptCount; index++) {
    prompts.push(workspaces.createChild("prompt", suite.id, { title: unique(`p${index}`), content: `do ${index}` }) as PromptRecord);
  }
  for (const prompt of prompts) workspaces.addPipelineStep(prompt.id, { provider: "claude" });
  return {
    dir,
    workspace,
    program,
    suite,
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

async function endStation(args: {
  runId: string;
  promptId: number;
  workspaceId: number;
  outcome: "DONE" | "human" | "process";
}): Promise<void> {
  if (args.outcome === "DONE") {
    workspaces.updateAgentStatus(args.runId, {
      requestId: randomUUID(),
      expectedStatus: "IN_PROGRESS",
      status: "DONE",
      reason: "ok",
      verificationSummary: "verified",
    });
    workspaces.finishAgentRun(args.runId, "done");
    await pipelineScheduler.onExecuteEnded({ runId: args.runId, workspaceId: args.workspaceId, promptId: args.promptId, processState: "done" });
    return;
  }
  if (args.outcome === "human") {
    workspaces.updateAgentStatus(args.runId, {
      requestId: randomUUID(),
      expectedStatus: "IN_PROGRESS",
      status: "BLOCKED",
      reason: "need a decision",
      verificationSummary: "answer the question",
    });
    workspaces.finishAgentRun(args.runId, "done");
    await pipelineScheduler.onExecuteEnded({ runId: args.runId, workspaceId: args.workspaceId, promptId: args.promptId, processState: "done" });
    return;
  }
  workspaces.finishAgentRun(args.runId, "error");
  await pipelineScheduler.onExecuteEnded({ runId: args.runId, workspaceId: args.workspaceId, promptId: args.promptId, processState: "error" });
}

test("schema version 8 creates pipeline tables without rewriting agent_run.role", () => {
  const db = new Database(workspaces.databasePath, { readonly: true });
  try {
    const version = (db.prepare("SELECT MAX(version) version FROM schema_migration").get() as { version: number }).version;
    assert.ok(version >= 8);
    const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as Array<{ name: string }>).map((row) => row.name));
    assert.ok(names.has("prompt_pipeline_rule"));
    assert.ok(names.has("suite_pipeline_run"));
    assert.ok(names.has("suite_pipeline_active_uq"));
    const columns = db.prepare("PRAGMA table_info(suite)").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "default_provider"));
    assert.ok(columns.some((column) => column.name === "default_model"));
  } finally {
    db.close();
  }
  const source = readFileSync(new URL("./workspaces.ts", import.meta.url), "utf8");
  const migration8 = source.slice(source.indexOf("if(version<8)"), source.indexOf("migrate();"));
  assert.doesNotMatch(migration8, /agent_run/);
  assert.match(source, /stop_reason='server_restart'/);
  assert.match(source, /WAITING_HUMAN/);
});

test("missing rules are filled with today's manual-loop defaults", () => {
  const ctx = fixture(1);
  try {
    const rule = workspaces.pipelineRule(ctx.prompts[0]!.id);
    assert.deepEqual(rule, {
      promptId: ctx.prompts[0]!.id,
      provider: "claude",
      model: null,
      onDone: "continue",
      onBlocked: "wait",
      retryLimit: 1,
      recoverProvider: null,
      recoverModel: null,
      enabled: true,
      stepOrder: 0,
    });
    const snapshot = workspaces.operations(ctx.workspace.id);
    const prompt = snapshot.suites[0]?.prompts[0];
    assert.equal(prompt?.pipelineRule.onDone, "continue");
    assert.equal(prompt?.pipelineRule.onBlocked, "wait");
    assert.equal(snapshot.suites[0]?.pipeline?.defaults.defaultProvider, null);
    assert.equal(snapshot.suites[0]?.pipeline?.active, null);
  } finally {
    ctx.cleanup();
  }
});

test("pipeline PATCH treats explicit null as a clear, not as missing", () => {
  const ctx = fixture(1);
  try {
    workspaces.updateSuitePipelineDefaults(ctx.suite.id, { defaultProvider: "claude", defaultModel: "claude-sonnet-5" });
    assert.equal(workspaces.suitePipelineDefaults(ctx.suite.id).defaultProvider, "claude");
    workspaces.updateSuitePipelineDefaults(ctx.suite.id, { defaultProvider: null, defaultModel: null });
    const defaults = workspaces.suitePipelineDefaults(ctx.suite.id);
    assert.equal(defaults.defaultProvider, null);
    assert.equal(defaults.defaultModel, null);
    workspaces.upsertPipelineRule(ctx.prompts[0]!.id, { provider: "codex", model: "gpt-5.4" });
    workspaces.upsertPipelineRule(ctx.prompts[0]!.id, { provider: null, model: null });
    const rule = workspaces.pipelineRule(ctx.prompts[0]!.id);
    assert.equal(rule.provider, null);
    assert.equal(rule.model, null);
  } finally {
    ctx.cleanup();
  }
});

test("retry bounds and recover validation reject unknown chips", () => {
  const ctx = fixture(1);
  try {
    assert.throws(() => workspaces.upsertPipelineRule(ctx.prompts[0]!.id, { retryLimit: 0 }), (error: unknown) => error instanceof WorkspaceError && error.status === 422);
    assert.throws(() => workspaces.upsertPipelineRule(ctx.prompts[0]!.id, { retryLimit: 6 }), (error: unknown) => error instanceof WorkspaceError && error.status === 422);
    workspaces.upsertPipelineRule(ctx.prompts[0]!.id, { retryLimit: 1 });
    workspaces.upsertPipelineRule(ctx.prompts[0]!.id, { retryLimit: 5 });
    assert.throws(() => workspaces.upsertPipelineRule(ctx.prompts[0]!.id, { onDone: "next" }), (error: unknown) => error instanceof WorkspaceError && error.status === 422);
    assert.throws(() => workspaces.upsertPipelineRule(ctx.prompts[0]!.id, { onBlocked: "continue" }), (error: unknown) => error instanceof WorkspaceError && error.status === 422);
    assert.throws(
      () => workspaces.upsertPipelineRule(ctx.prompts[0]!.id, { onBlocked: "recover" }),
      (error: unknown) => error instanceof WorkspaceError && error.status === 422 && error.fields?.recoverProvider === "Required",
    );
    const rule = workspaces.upsertPipelineRule(ctx.prompts[0]!.id, { onBlocked: "recover", recoverProvider: "cursor", recoverModel: "auto" });
    assert.equal(rule.recoverProvider, "cursor");
  } finally {
    ctx.cleanup();
  }
});

test("flowchart order is independent of suite sort, and unlisted prompts are skipped", async () => {
  const ctx = fixture(3);
  const started = stubStarts();
  try {
    workspaces.removePipelineStep(ctx.prompts[1]!.id);
    workspaces.reorderPipelineSteps(ctx.suite.id, [ctx.prompts[2]!.id, ctx.prompts[0]!.id]);
    const playing = await pipelineScheduler.play(ctx.suite.id, {});
    assert.equal(started[0]?.promptId, ctx.prompts[2]!.id);
    await endStation({ runId: playing.currentRunId!, promptId: ctx.prompts[2]!.id, workspaceId: ctx.workspace.id, outcome: "DONE" });
    const mid = workspaces.activePipeline(ctx.suite.id);
    assert.equal(started[1]?.promptId, ctx.prompts[0]!.id);
    await endStation({ runId: mid!.currentRunId!, promptId: ctx.prompts[0]!.id, workspaceId: ctx.workspace.id, outcome: "DONE" });
    assert.equal(workspaces.latestPipeline(ctx.suite.id)?.state, "COMPLETE");
    assert.equal(workspaces.promptOutcome(ctx.prompts[1]!.id).status, "TODO");
  } finally {
    ctx.cleanup();
  }
});

test("play fails when the flowchart is empty", async () => {
  const ctx = fixture(1);
  try {
    workspaces.removePipelineStep(ctx.prompts[0]!.id);
    await assert.rejects(() => pipelineScheduler.play(ctx.suite.id, { provider: "claude" }), (error: unknown) => error instanceof WorkspaceError && error.code === "empty_pipeline");
  } finally {
    ctx.cleanup();
  }
});

test("onDone continue then COMPLETE", async () => {
  const ctx = fixture(2);
  const started = stubStarts();
  try {
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    assert.equal(playing.state, "PLAYING");
    assert.equal(started.length, 1);
    assert.equal(started[0]?.promptId, ctx.prompts[0]!.id);
    await endStation({ runId: playing.currentRunId!, promptId: ctx.prompts[0]!.id, workspaceId: ctx.workspace.id, outcome: "DONE" });
    const mid = workspaces.activePipeline(ctx.suite.id);
    assert.equal(mid?.state, "PLAYING");
    assert.equal(started.length, 2);
    assert.equal(started[1]?.promptId, ctx.prompts[1]!.id);
    await endStation({ runId: mid!.currentRunId!, promptId: ctx.prompts[1]!.id, workspaceId: ctx.workspace.id, outcome: "DONE" });
    const latest = workspaces.latestPipeline(ctx.suite.id);
    assert.equal(latest?.state, "COMPLETE");
    assert.equal(workspaces.activePipeline(ctx.suite.id), null);
  } finally {
    ctx.cleanup();
  }
});

test("onDone stop leaves remaining prompts untouched", async () => {
  const ctx = fixture(2);
  stubStarts();
  try {
    workspaces.upsertPipelineRule(ctx.prompts[0]!.id, { onDone: "stop" });
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    await endStation({ runId: playing.currentRunId!, promptId: ctx.prompts[0]!.id, workspaceId: ctx.workspace.id, outcome: "DONE" });
    const latest = workspaces.latestPipeline(ctx.suite.id)!;
    assert.equal(latest.state, "STOPPED");
    assert.equal(latest.stopReason, "on_done_stop");
    assert.equal(workspaces.promptOutcome(ctx.prompts[1]!.id).status, "TODO");
  } finally {
    ctx.cleanup();
  }
});

test("onDone skip_rest skips remaining stations", async () => {
  const ctx = fixture(3);
  stubStarts();
  try {
    workspaces.upsertPipelineRule(ctx.prompts[0]!.id, { onDone: "skip_rest" });
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    await endStation({ runId: playing.currentRunId!, promptId: ctx.prompts[0]!.id, workspaceId: ctx.workspace.id, outcome: "DONE" });
    const latest = workspaces.latestPipeline(ctx.suite.id)!;
    assert.equal(latest.state, "STOPPED");
    assert.equal(latest.stopReason, "skip_rest");
    assert.equal(workspaces.promptOutcome(ctx.prompts[0]!.id).status, "DONE");
    assert.equal(workspaces.promptOutcome(ctx.prompts[1]!.id).status, "SKIPPED");
    assert.equal(workspaces.promptOutcome(ctx.prompts[2]!.id).status, "SKIPPED");
  } finally {
    ctx.cleanup();
  }
});

test("onBlocked wait parks the pipeline for a human", async () => {
  const ctx = fixture(2);
  stubStarts();
  try {
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    await endStation({ runId: playing.currentRunId!, promptId: ctx.prompts[0]!.id, workspaceId: ctx.workspace.id, outcome: "human" });
    const waiting = workspaces.activePipeline(ctx.suite.id);
    assert.equal(waiting?.state, "WAITING_HUMAN");
    assert.equal(waiting?.currentPromptId, ctx.prompts[0]!.id);
    assert.equal(workspaces.promptOutcome(ctx.prompts[0]!.id).status, "BLOCKED");
  } finally {
    ctx.cleanup();
  }
});

test("onBlocked retry retries then stops on process-failure exhaustion", async () => {
  const ctx = fixture(1);
  const started = stubStarts();
  try {
    workspaces.upsertPipelineRule(ctx.prompts[0]!.id, { onBlocked: "retry", retryLimit: 1 });
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    await endStation({ runId: playing.currentRunId!, promptId: ctx.prompts[0]!.id, workspaceId: ctx.workspace.id, outcome: "process" });
    const retrying = workspaces.activePipeline(ctx.suite.id);
    assert.equal(retrying?.state, "PLAYING");
    assert.equal(retrying?.attempt, 1);
    assert.equal(started.length, 2);
    await endStation({ runId: retrying!.currentRunId!, promptId: ctx.prompts[0]!.id, workspaceId: ctx.workspace.id, outcome: "process" });
    const latest = workspaces.latestPipeline(ctx.suite.id)!;
    assert.equal(latest.state, "STOPPED");
    assert.equal(latest.stopReason, "retry_exhausted");
  } finally {
    ctx.cleanup();
  }
});

test("retry exhaustion on a human BLOCKED waits instead of stopping", async () => {
  const ctx = fixture(1);
  stubStarts();
  try {
    workspaces.upsertPipelineRule(ctx.prompts[0]!.id, { onBlocked: "retry", retryLimit: 1 });
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    await endStation({ runId: playing.currentRunId!, promptId: ctx.prompts[0]!.id, workspaceId: ctx.workspace.id, outcome: "human" });
    const retrying = workspaces.activePipeline(ctx.suite.id)!;
    await endStation({ runId: retrying.currentRunId!, promptId: ctx.prompts[0]!.id, workspaceId: ctx.workspace.id, outcome: "human" });
    const waiting = workspaces.activePipeline(ctx.suite.id);
    assert.equal(waiting?.state, "WAITING_HUMAN");
    assert.equal(waiting?.stopReason, "retry_exhausted");
  } finally {
    ctx.cleanup();
  }
});

test("onBlocked recover is one-shot then recover_exhausted", async () => {
  const ctx = fixture(1);
  const started = stubStarts();
  try {
    workspaces.upsertPipelineRule(ctx.prompts[0]!.id, { onBlocked: "recover", recoverProvider: "grok", recoverModel: "grok-4.6" });
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    assert.equal(started[0]?.provider, "claude");
    await endStation({ runId: playing.currentRunId!, promptId: ctx.prompts[0]!.id, workspaceId: ctx.workspace.id, outcome: "human" });
    const recovering = workspaces.activePipeline(ctx.suite.id);
    assert.equal(recovering?.recovering, true);
    assert.equal(started.length, 2);
    assert.equal(started[1]?.provider, "grok");
    assert.equal(started[1]?.model, "grok-4.6");
    await endStation({ runId: recovering!.currentRunId!, promptId: ctx.prompts[0]!.id, workspaceId: ctx.workspace.id, outcome: "human" });
    const latest = workspaces.latestPipeline(ctx.suite.id)!;
    assert.equal(latest.state, "STOPPED");
    assert.equal(latest.stopReason, "recover_exhausted");
  } finally {
    ctx.cleanup();
  }
});

test("onBlocked skip advances and does not satisfy dependents", async () => {
  const ctx = fixture(0);
  const started = stubStarts();
  const firstKey = unique("A");
  const secondKey = unique("B");
  try {
    workspaces.importProgram(ctx.workspace.id, {
      key: unique("P"),
      name: unique("Imported"),
      overview: "",
      workspaceDescription: "",
      suites: [{
        key: unique("S"),
        name: unique("Imported suite"),
        prompts: [
          { key: firstKey, title: unique("First"), content: "A", status: "TODO", completedAt: null, result: "", isGate: false },
          { key: secondKey, title: unique("Second"), content: "B", status: "TODO", completedAt: null, result: "", isGate: false },
        ],
      }],
      dependencies: [{ promptKey: secondKey, dependsOnKey: firstKey }],
      gates: [],
      warnings: [],
    });
    const tree = workspaces.tree(ctx.workspace.id);
    const suite = tree.programs.flatMap((program) => program.suites).find((item) => item.prompts.some((prompt) => prompt.externalKey === firstKey))!;
    const first = suite.prompts.find((prompt) => prompt.externalKey === firstKey)!;
    const second = suite.prompts.find((prompt) => prompt.externalKey === secondKey)!;
    workspaces.addPipelineStep(first.id, { provider: "claude" });
    workspaces.addPipelineStep(second.id, { provider: "claude" });
    workspaces.upsertPipelineRule(first.id, { onBlocked: "skip" });
    const playing = await pipelineScheduler.play(suite.id, { provider: "claude" });
    assert.equal(started[0]?.promptId, first.id);
    await endStation({ runId: playing.currentRunId!, promptId: first.id, workspaceId: ctx.workspace.id, outcome: "human" });
    const latest = workspaces.latestPipeline(suite.id)!;
    assert.equal(workspaces.promptOutcome(first.id).status, "SKIPPED");
    assert.equal(workspaces.promptOutcome(second.id).status, "TODO");
    const options = workspaces.promptOptions(ctx.workspace.id);
    const secondOption = options.find((item) => item.id === second.id)!;
    assert.equal(secondOption.ready, false);
    assert.ok(secondOption.blockedBy.includes(firstKey));
    assert.equal(latest.state, "STOPPED");
    assert.equal(latest.stopReason, "blocked_on_dependencies");
  } finally {
    ctx.cleanup();
  }
});

test("operator skip of a TODO item does not unblock dependents", () => {
  const ctx = fixture(0);
  const firstKey = unique("A");
  const secondKey = unique("B");
  try {
    workspaces.importProgram(ctx.workspace.id, {
      key: unique("P"),
      name: unique("Imported"),
      overview: "",
      workspaceDescription: "",
      suites: [{
        key: unique("S"),
        name: unique("Imported suite"),
        prompts: [
          { key: firstKey, title: unique("First"), content: "A", status: "TODO", completedAt: null, result: "", isGate: false },
          { key: secondKey, title: unique("Second"), content: "B", status: "TODO", completedAt: null, result: "", isGate: false },
        ],
      }],
      dependencies: [{ promptKey: secondKey, dependsOnKey: firstKey }],
      gates: [],
      warnings: [],
    });
    const tree = workspaces.tree(ctx.workspace.id);
    const suite = tree.programs.flatMap((program) => program.suites).find((item) => item.prompts.some((prompt) => prompt.externalKey === firstKey))!;
    const first = suite.prompts.find((prompt) => prompt.externalKey === firstKey)!;
    const second = suite.prompts.find((prompt) => prompt.externalKey === secondKey)!;
    workspaces.skipPrompt(first.id, "USER", "Operator skipped this station.");
    const secondOption = workspaces.promptOptions(ctx.workspace.id).find((item) => item.id === second.id)!;
    assert.equal(secondOption.ready, false);
    assert.ok(secondOption.blockedBy.includes(firstKey));
  } finally {
    ctx.cleanup();
  }
});

test("cannot Play two suites in one workspace", async () => {
  const ctx = fixture(1);
  stubStarts();
  let suiteB: SuiteRecord | undefined;
  try {
    suiteB = workspaces.createChild("suite", ctx.program.id, { name: unique("suiteB"), overview: "" }) as SuiteRecord;
    const other = workspaces.createChild("prompt", suiteB.id, { title: unique("other"), content: "other" }) as PromptRecord;
    workspaces.addPipelineStep(other.id, { provider: "codex" });
    await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    await assert.rejects(
      () => pipelineScheduler.play(suiteB!.id, { provider: "codex" }),
      (error: unknown) => error instanceof WorkspaceError && error.status === 409 && error.code === "workspace_busy",
    );
  } finally {
    ctx.cleanup();
  }
});

test("startExecute refuses when another pipeline owns the workspace", async () => {
  const ctx = fixture(1);
  try {
    const pipeline = workspaces.createPipelineRun({
      id: newId("pipe"),
      suiteId: ctx.suite.id,
      workspaceId: ctx.workspace.id,
      playProvider: "claude",
      playModel: null,
    });
    workspaces.updatePipelineRun(pipeline.id, { currentPromptId: ctx.prompts[0]!.id });
    await assert.rejects(
      () => startExecute({ workspaceId: ctx.workspace.id, provider: "not-a-provider", model: null, prompt: "x" }),
      (error: unknown) => error instanceof WorkspaceError && error.status === 409 && error.code === "workspace_busy",
    );
  } finally {
    ctx.cleanup();
  }
});

test("pause does not interrupt; stop does", async () => {
  const ctx = fixture(2);
  const started = stubStarts();
  try {
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    const paused = await pipelineScheduler.pause(ctx.suite.id);
    assert.equal(paused.state, "PAUSED");
    assert.equal(paused.currentRunId, playing.currentRunId);
    await endStation({ runId: paused.currentRunId!, promptId: ctx.prompts[0]!.id, workspaceId: ctx.workspace.id, outcome: "DONE" });
    const still = workspaces.activePipeline(ctx.suite.id);
    assert.equal(still?.state, "PAUSED");
    assert.equal(started.length, 1);
    assert.equal(still?.currentPromptId, ctx.prompts[1]!.id);

    const resumed = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    assert.equal(resumed.state, "PLAYING");
    assert.equal(started.length, 2);

    let interrupted = false;
    const runId = resumed.currentRunId!;
    runHub.start({
      handle: {
        runId,
        provider: "claude",
        model: null,
        role: "execute",
        permissionMode: null,
        interrupt: async () => { interrupted = true; },
        done: Promise.resolve("interrupted"),
      } satisfies RunHandle,
      workspace: { id: ctx.workspace.id, name: ctx.workspace.name, workDirectory: ctx.workspace.workDirectory },
      source: { type: "custom", displayText: "station" },
      role: "execute",
    });
    const stopped = await pipelineScheduler.stop(ctx.suite.id);
    assert.equal(stopped.state, "STOPPED");
    assert.equal(stopped.stopReason, "operator_stop");
    assert.equal(interrupted, true);
    if (runHub.has(runId)) runHub.end(runId, "interrupted");
  } finally {
    ctx.cleanup();
  }
});

test("recoverAbandonedRuns marks active pipelines INTERRUPTED", async () => {
  const ctx = fixture(1);
  stubStarts();
  try {
    await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    assert.equal(workspaces.activePipeline(ctx.suite.id)?.state, "PLAYING");
    workspaces.interruptPipelinesOnRestart();
    assert.equal(workspaces.activePipeline(ctx.suite.id), null);
    const latest = workspaces.latestPipeline(ctx.suite.id);
    assert.equal(latest?.state, "INTERRUPTED");
    assert.equal(latest?.stopReason, "server_restart");
  } finally {
    ctx.cleanup();
  }
});

test("attempt only resets on a new Play, not on resume", async () => {
  const ctx = fixture(1);
  stubStarts();
  try {
    workspaces.upsertPipelineRule(ctx.prompts[0]!.id, { onBlocked: "retry", retryLimit: 1 });
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    await endStation({ runId: playing.currentRunId!, promptId: ctx.prompts[0]!.id, workspaceId: ctx.workspace.id, outcome: "human" });
    const retried = workspaces.activePipeline(ctx.suite.id)!;
    assert.equal(retried.attempt, 1);
    await endStation({ runId: retried.currentRunId!, promptId: ctx.prompts[0]!.id, workspaceId: ctx.workspace.id, outcome: "human" });
    const waiting = workspaces.activePipeline(ctx.suite.id)!;
    assert.equal(waiting.state, "WAITING_HUMAN");
    assert.equal(waiting.attempt, 1);
    workspaces.respondToBlockedPrompt(ctx.prompts[0]!.id, { content: "try this" });
    const resumed = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    assert.equal(resumed.id, waiting.id);
    assert.equal(resumed.attempt, 1);
    assert.equal(resumed.state, "PLAYING");
  } finally {
    ctx.cleanup();
  }
});

test("scheduler starts executes only, never consults, and pause never stops the child", () => {
  const source = readFileSync(new URL("./pipelineScheduler.ts", import.meta.url), "utf8");
  assert.match(source, /startExecute/);
  assert.doesNotMatch(source, /startConsult|startRun\(/);
  const pauseAt = source.indexOf("async pause(");
  const stopAt = source.indexOf("async stop(");
  const pause = source.slice(pauseAt, stopAt);
  const stop = source.slice(stopAt, source.indexOf("async onExecuteEnded"));
  assert.doesNotMatch(pause, /runHub\.stop/);
  assert.match(stop, /runHub\.stop/);
});

test("provider resolution uses station then play then suite then adapter", () => {
  const rule: PromptPipelineRule = {
    promptId: 1,
    provider: null,
    model: null,
    onDone: "continue",
    onBlocked: "wait",
    retryLimit: 1,
    recoverProvider: null,
    recoverModel: null,
    enabled: true,
    stepOrder: 0,
  };
  const base: {
    recovering: boolean;
    rule: PromptPipelineRule;
    playProvider: ProviderId | null;
    playModel: string | null;
    defaultProvider: ProviderId | null;
    defaultModel: string | null;
  } = {
    recovering: false,
    rule,
    playProvider: null,
    playModel: null,
    defaultProvider: null,
    defaultModel: null,
  };
  assert.equal(resolveExecuteTarget(base), null);
  assert.equal(resolveExecuteTarget({ ...base, playProvider: "claude" })?.provider, "claude");
  assert.equal(resolveExecuteTarget({ ...base, defaultProvider: "codex" })?.provider, "codex");
  assert.equal(
    resolveExecuteTarget({
      ...base,
      rule: { ...base.rule, provider: "grok", model: "grok-4.6" },
      playProvider: "claude",
      defaultProvider: "codex",
    })?.provider,
    "grok",
  );
  const recover = resolveExecuteTarget({
    ...base,
    recovering: true,
    rule: { ...base.rule, provider: "claude", recoverProvider: "grok", recoverModel: "grok-4.6" },
    playProvider: "claude",
  });
  assert.deepEqual(recover, { provider: "grok", model: "grok-4.6" });
});

test("schema version 11 creates named pipeline tables", () => {
  const db = new Database(workspaces.databasePath, { readonly: true });
  try {
    const version = (db.prepare("SELECT MAX(version) version FROM schema_migration").get() as { version: number }).version;
    assert.ok(version >= 11);
    const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all() as Array<{ name: string }>).map((row) => row.name));
    assert.ok(names.has("pipeline"));
    assert.ok(names.has("pipeline_stage"));
    assert.ok(names.has("pipeline_run"));
    assert.ok(names.has("pipeline_run_active_uq"));
    const columns = db.prepare("PRAGMA table_info(suite_pipeline_run)").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "pipeline_run_id"));
  } finally {
    db.close();
  }
});

test("named pipeline CRUD saves stages per workspace and keeps a run archive", async () => {
  const ctx = fixture(1);
  let otherDir: string | null = null;
  try {
    const saved = workspaces.createPipeline({
      workspaceId: ctx.workspace.id,
      name: unique("launch"),
      description: "nightly",
      suiteIds: [ctx.suite.id],
    });
    assert.equal(saved.workspaceId, ctx.workspace.id);
    assert.equal(saved.stages.length, 1);
    assert.equal(saved.stages[0]?.suiteId, ctx.suite.id);
    assert.equal(saved.active, null);
    const listed = workspaces.listPipelines(ctx.workspace.id);
    assert.ok(listed.some((item) => item.id === saved.id));
    const renamed = workspaces.updatePipeline(saved.id, { name: unique("launch-v2") });
    assert.equal(renamed.stages.length, 1);
    const empty = workspaces.updatePipeline(saved.id, { suiteIds: [] });
    assert.equal(empty.stages.length, 0);
    workspaces.updatePipeline(saved.id, { suiteIds: [ctx.suite.id] });

    const other = workspaces.create({ name: unique("ws2"), description: "", workDirectory: (otherDir = mkdtempSync(join(tmpdir(), "pipe-"))) });
    const otherProgram = workspaces.createChild("program", other.id, { name: unique("prog"), overview: "" }) as ProgramRecord;
    const otherSuite = workspaces.createChild("suite", otherProgram.id, { name: unique("suite"), overview: "" }) as SuiteRecord;
    assert.throws(
      () => workspaces.createPipeline({ workspaceId: ctx.workspace.id, name: unique("cross"), suiteIds: [otherSuite.id] }),
      (error: unknown) => error instanceof WorkspaceError && error.status === 422,
    );
    workspaces.remove(other.id);

    workspaces.deletePipeline(saved.id);
    assert.throws(() => workspaces.getPipeline(saved.id), (error: unknown) => error instanceof WorkspaceError && error.status === 404);
  } finally {
    ctx.cleanup();
    if (otherDir !== null) rmSync(otherDir, { recursive: true, force: true });
  }
});

test("named pipeline play advances suites, surfaces blocked, and keeps history", async () => {
  const ctx = fixture(1);
  stubStarts();
  let suiteB: SuiteRecord | null = null;
  try {
    suiteB = workspaces.createChild("suite", ctx.program.id, { name: unique("suiteB"), overview: "" }) as SuiteRecord;
    const promptB = workspaces.createChild("prompt", suiteB.id, { title: unique("b"), content: "second" }) as PromptRecord;
    workspaces.addPipelineStep(promptB.id, { provider: "claude" });
    const saved = workspaces.createPipeline({
      workspaceId: ctx.workspace.id,
      name: unique("mission"),
      suiteIds: [ctx.suite.id, suiteB.id],
    });
    const playing = await pipelineScheduler.playNamed(saved.id, { provider: "claude" });
    assert.equal(playing.state, "PLAYING");
    assert.equal(playing.currentSuiteId, ctx.suite.id);
    const live = workspaces.getPipeline(saved.id);
    assert.equal(live.active?.id, playing.id);

    await endStation({
      runId: workspaces.activePipeline(ctx.suite.id)!.currentRunId!,
      promptId: ctx.prompts[0]!.id,
      workspaceId: ctx.workspace.id,
      outcome: "human",
    });
    assert.equal(workspaces.activeNamedPipelineRun(saved.id)?.state, "WAITING_HUMAN");

    workspaces.respondToBlockedPrompt(ctx.prompts[0]!.id, { content: "go on" });
    const resumed = await pipelineScheduler.playNamed(saved.id, { provider: "claude" });
    assert.equal(resumed.id, playing.id);
    assert.equal(resumed.state, "PLAYING");

    await endStation({
      runId: workspaces.activePipeline(ctx.suite.id)!.currentRunId!,
      promptId: ctx.prompts[0]!.id,
      workspaceId: ctx.workspace.id,
      outcome: "DONE",
    });
    const afterFirst = workspaces.activeNamedPipelineRun(saved.id);
    assert.equal(afterFirst?.state, "PLAYING");
    assert.equal(afterFirst?.currentSuiteId, suiteB.id);

    await endStation({
      runId: workspaces.activePipeline(suiteB.id)!.currentRunId!,
      promptId: promptB.id,
      workspaceId: ctx.workspace.id,
      outcome: "DONE",
    });
    assert.equal(workspaces.activeNamedPipelineRun(saved.id), null);
    const latest = workspaces.latestNamedPipelineRun(saved.id);
    assert.equal(latest?.state, "COMPLETE");
    const archive = workspaces.listPipelineRuns(saved.id);
    assert.equal(archive.length, 1);
    assert.equal(archive[0]?.stages.length, 2);
    assert.equal(archive[0]?.stages[0]?.suiteRun?.state, "COMPLETE");
    assert.equal(archive[0]?.stages[1]?.suiteRun?.state, "COMPLETE");
  } finally {
    ctx.cleanup();
  }
});

test("named pipeline handoff target overrides the current station provider once", async () => {
  const ctx = fixture(2);
  const started = stubStarts();
  try {
    workspaces.upsertPipelineRule(ctx.prompts[0]!.id, { provider: "grok", model: "grok-4.5" });
    workspaces.upsertPipelineRule(ctx.prompts[1]!.id, { provider: "grok", model: "grok-4.5" });
    const saved = workspaces.createPipeline({
      workspaceId: ctx.workspace.id,
      name: unique("handoff-target"),
      suiteIds: [ctx.suite.id],
    });

    await pipelineScheduler.playNamed(saved.id, {
      provider: "claude",
      model: "claude-sonnet-5",
      preferPlayTarget: true,
    });
    assert.equal(started[0]?.provider, "claude");
    assert.equal(started[0]?.model, "claude-sonnet-5");

    await endStation({
      runId: workspaces.activePipeline(ctx.suite.id)!.currentRunId!,
      promptId: ctx.prompts[0]!.id,
      workspaceId: ctx.workspace.id,
      outcome: "DONE",
    });
    assert.equal(started[1]?.provider, "grok");
    assert.equal(started[1]?.model, "grok-4.5");
  } finally {
    ctx.cleanup();
  }
});

test("named pipeline stop records operator_stop in the archive", async () => {
  const ctx = fixture(1);
  stubStarts();
  try {
    const saved = workspaces.createPipeline({
      workspaceId: ctx.workspace.id,
      name: unique("abort"),
      suiteIds: [ctx.suite.id],
    });
    await pipelineScheduler.playNamed(saved.id, { provider: "claude" });
    const stopped = await pipelineScheduler.stopNamed(saved.id);
    assert.equal(stopped.state, "STOPPED");
    assert.equal(stopped.stopReason, "operator_stop");
    assert.equal(workspaces.listPipelineRuns(saved.id)[0]?.state, "STOPPED");
  } finally {
    ctx.cleanup();
  }
});
