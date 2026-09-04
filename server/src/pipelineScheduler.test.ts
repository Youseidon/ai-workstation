import { emptyBudgetSnapshot } from "./runner.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { DEFAULT_PIPELINE_POLICY, promptNeedsHandoff, type ProgramRecord, type PromptPipelineRule, type PromptRecord, type ProviderId, type SuiteRecord } from "@agent-console/shared";
import { newId } from "./lib/ids.ts";
import { pipelineScheduler, resolveExecuteTarget, setPipelineStationStarter } from "./pipelineScheduler.ts";
import { resetSettings, settings, updateSettings } from "./settings.ts";
import { runContexts } from "./runContext.ts";
import { runHub } from "./runHub.ts";
import type { StartExecuteArgs } from "./runService.ts";
import { startExecute } from "./runService.ts";
import type { RunHandle } from "./runner.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

let seq = 0;

test("completed stations bypass resume handoff", () => {
  assert.equal(promptNeedsHandoff("DONE"), false);
  assert.equal(promptNeedsHandoff("SKIPPED"), false);
  assert.equal(promptNeedsHandoff("IN_PROGRESS"), true);
  assert.equal(promptNeedsHandoff("BLOCKED"), true);
  assert.equal(promptNeedsHandoff("TODO"), true);
});

test("restart after terminal status resumes exactly once at the next station", async () => {
  const ctx = fixture(2);
  const started = stubStarts();
  try {
    const saved = workspaces.createPipeline({
      workspaceId: ctx.workspace.id,
      name: unique("terminal-restart"),
      suiteIds: [ctx.suite.id],
    });
    addNamedSteps(saved.id, ctx.prompts);
    await pipelineScheduler.playNamed(saved.id, { provider: "claude" });
    const firstRunId = workspaces.activePipeline(ctx.suite.id)!.currentRunId!;
    workspaces.updateAgentStatus(firstRunId, {
      requestId: randomUUID(),
      expectedStatus: "IN_PROGRESS",
      status: "DONE",
      reason: "complete before provider exit",
      verificationSummary: "verified",
    });
    workspaces.finishAgentRun(firstRunId, "done");

    // Reproduce a server restart before onExecuteEnded can advance the rail.
    workspaces.interruptPipelinesOnRestart();
    const interrupted = workspaces.latestNamedPipelineRun(saved.id);
    assert.equal(interrupted?.state, "INTERRUPTED");
    assert.equal(interrupted?.currentSuiteId, ctx.suite.id);

    const resumed = await pipelineScheduler.playNamed(saved.id);
    assert.equal(resumed.state, "PLAYING");
    assert.equal(started.length, 2);
    assert.equal(started[0]?.promptId, ctx.prompts[0]!.id);
    assert.equal(started[1]?.promptId, ctx.prompts[1]!.id);
    assert.equal(workspaces.promptOutcome(ctx.prompts[0]!.id).status, "DONE");
    assert.equal(workspaces.promptOutcome(ctx.prompts[1]!.id).status, "IN_PROGRESS");
  } finally {
    ctx.cleanup();
  }
});

function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${seq}`;
}

function addNamedSteps(pipelineId: number, prompts: PromptRecord[]) {
  for (const prompt of prompts) workspaces.addNamedPipelineStep(pipelineId, prompt.id, { provider: "claude" });
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
    // Isolate the rule. A run that ends without posting a status is normally
    // audited before any rule applies (see completionAudit.test.ts); this test
    // is about what retry does once that audit has had its say.
    updateSettings({ "pipeline.auditOnBlocked": "off" });
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
    resetSettings(["pipeline.auditOnBlocked"]);
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
    // D5: a parked run has not stopped, so the reason lives in waitReason.
    assert.equal(waiting?.waitReason, "retry_exhausted");
    assert.equal(waiting?.stopReason, null);
  } finally {
    ctx.cleanup();
  }
});

test("autoHandoffOnBlocked is off by default: a blocked station just parks", async () => {
  const ctx = fixture(2);
  stubStarts();
  try {
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    await endStation({ runId: playing.currentRunId!, promptId: ctx.prompts[0]!.id, workspaceId: ctx.workspace.id, outcome: "human" });
    const parked = workspaces.activePipeline(ctx.suite.id);
    assert.equal(parked?.state, "WAITING_HUMAN");
    assert.equal(parked?.waitReason, null, "nothing should have been summoned");
    assert.equal(workspaces.handoffsForPrompt(ctx.prompts[0]!.id).length, 0);
  } finally {
    ctx.cleanup();
  }
});

test("autoHandoffOnBlocked parks normally when no handoff can be started", async () => {
  const ctx = fixture(2);
  stubStarts();
  try {
    // No provider is actually available in the test process, so scheduleHandoff
    // declines. The run must still park cleanly rather than claim a handoff is
    // running — a wait reason that never resolves would strand the operator.
    updateSettings({ "pipeline.autoHandoffOnBlocked": true });
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    await endStation({ runId: playing.currentRunId!, promptId: ctx.prompts[0]!.id, workspaceId: ctx.workspace.id, outcome: "human" });
    const parked = workspaces.activePipeline(ctx.suite.id);
    assert.equal(parked?.state, "WAITING_HUMAN");
    assert.equal(parked?.stopReason, null);
    assert.ok(
      parked?.waitReason === null || parked?.waitReason === "handoff_running",
      `unexpected wait reason ${String(parked?.waitReason)}`,
    );
  } finally {
    resetSettings(["pipeline.autoHandoffOnBlocked"]);
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

test("decompose hands off to sub-steps in order, then resumes the parent for final integration", async () => {
  const ctx = fixture(1);
  const started = stubStarts();
  try {
    const parent = ctx.prompts[0]!;
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    const runId = playing.currentRunId!;
    assert.equal(started.length, 1);
    assert.equal(started[0]?.promptId, parent.id);

    const result = workspaces.decomposePrompt(runId, {
      requestId: randomUUID(),
      resumeBrief: "Established X and Y; two slices remain.",
      children: [
        { title: unique("slice-a"), content: "Do slice A" },
        { title: unique("slice-b"), content: "Do slice B" },
      ],
    }) as { children: Array<{ id: number }> };
    assert.equal(result.children.length, 2);
    assert.equal(workspaces.promptOutcome(parent.id).status, "TODO");
    const decomposedOptions = new Map(workspaces.promptOptions(ctx.workspace.id).map((item) => [item.id, item]));
    assert.equal(decomposedOptions.get(parent.id)?.ready, false);
    assert.equal(decomposedOptions.get(result.children[0]!.id)?.ready, true);
    assert.equal(decomposedOptions.get(result.children[1]!.id)?.ready, false);

    workspaces.finishAgentRun(runId, "done");
    await pipelineScheduler.onExecuteEnded({ runId, workspaceId: ctx.workspace.id, promptId: parent.id, processState: "done" });

    // The first sub-step is now the running station, never the parent itself.
    assert.equal(started.length, 2);
    const childA = result.children[0]!.id;
    assert.equal(started[1]?.promptId, childA);
    const runA = workspaces.activePipeline(ctx.suite.id)!.currentRunId!;
    await endStation({ runId: runA, promptId: childA, workspaceId: ctx.workspace.id, outcome: "DONE" });

    // Second sub-step runs next; the parent still has not resumed.
    assert.equal(started.length, 3);
    const childB = result.children[1]!.id;
    assert.equal(started[2]?.promptId, childB);
    assert.equal(workspaces.promptOutcome(parent.id).status, "TODO");
    const runB = workspaces.activePipeline(ctx.suite.id)!.currentRunId!;
    await endStation({ runId: runB, promptId: childB, workspaceId: ctx.workspace.id, outcome: "DONE" });

    // Both sub-steps are done: the parent itself runs again for the real finish.
    assert.equal(started.length, 4);
    assert.equal(started[3]?.promptId, parent.id);
    assert.equal(workspaces.promptOutcome(parent.id).status, "IN_PROGRESS");

    const finalRunId = workspaces.activePipeline(ctx.suite.id)!.currentRunId!;
    await endStation({ runId: finalRunId, promptId: parent.id, workspaceId: ctx.workspace.id, outcome: "DONE" });
    assert.equal(workspaces.promptOutcome(parent.id).status, "DONE");
    assert.equal(workspaces.latestPipeline(ctx.suite.id)!.state, "COMPLETE");

    // Sub-steps nest under the station in the board view; they are never their own flowchart step.
    const snapshot = workspaces.operations(ctx.workspace.id);
    const suiteOps = snapshot.suites.find((item) => item.id === ctx.suite.id)!;
    assert.equal(suiteOps.prompts.length, 1);
    assert.equal(suiteOps.prompts[0]!.children.length, 2);
    assert.deepEqual(suiteOps.prompts[0]!.children.map((item) => item.prompt.id), [childA, childB]);
    const pipelineView = workspaces.pipeline(ctx.suite.id);
    assert.equal(pipelineView.available.some((item) => item.id === childA || item.id === childB), false);
  } finally {
    ctx.cleanup();
  }
});

test("a blocked sub-step applies the parent's on_blocked policy, not its own", async () => {
  const ctx = fixture(1);
  const started = stubStarts();
  try {
    const parent = ctx.prompts[0]!;
    workspaces.upsertPipelineRule(parent.id, { onBlocked: "wait" });
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    const result = workspaces.decomposePrompt(playing.currentRunId!, {
      requestId: randomUUID(),
      resumeBrief: "One slice is enough to demonstrate the blocked path.",
      children: [
        { title: unique("slice-a"), content: "Do slice A" },
        { title: unique("slice-b"), content: "Do slice B" },
      ],
    }) as { children: Array<{ id: number }> };
    workspaces.finishAgentRun(playing.currentRunId!, "done");
    await pipelineScheduler.onExecuteEnded({ runId: playing.currentRunId!, workspaceId: ctx.workspace.id, promptId: parent.id, processState: "done" });

    const childA = result.children[0]!.id;
    const runA = workspaces.activePipeline(ctx.suite.id)!.currentRunId!;
    await endStation({ runId: runA, promptId: childA, workspaceId: ctx.workspace.id, outcome: "human" });

    // The station's on_blocked="wait" applies to the sub-step, not a default.
    const waiting = workspaces.latestPipeline(ctx.suite.id)!;
    assert.equal(waiting.state, "WAITING_HUMAN");
    assert.equal(waiting.currentPromptId, childA);
    assert.equal(workspaces.promptOutcome(childA).status, "BLOCKED");
    // The parent is untouched: still mid-decompose, not itself blocked.
    assert.equal(workspaces.promptOutcome(parent.id).status, "TODO");
    assert.equal(started.length, 2);
  } finally {
    ctx.cleanup();
  }
});

function beginRun(runId: string, workspaceId: number, promptId: number): void {
  workspaces.beginAgentRun({
    runId,
    workspaceId,
    promptId,
    provider: "claude",
    model: null,
    tokenHash: `hash-${runId}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    role: "execute",
  });
}

test("a sub-step that decomposes runs its grandchildren before resuming", async () => {
  const ctx = fixture(1);
  const started = stubStarts();
  try {
    const parent = ctx.prompts[0]!;
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    const children = workspaces.decomposePrompt(playing.currentRunId!, {
      requestId: randomUUID(),
      resumeBrief: "The first slice may need a second split.",
      children: [
        { title: unique("slice-a"), content: "Do slice A" },
        { title: unique("slice-b"), content: "Do slice B" },
      ],
    }) as { children: Array<{ id: number }> };
    workspaces.finishAgentRun(playing.currentRunId!, "done");
    await pipelineScheduler.onExecuteEnded({ runId: playing.currentRunId!, workspaceId: ctx.workspace.id, promptId: parent.id, processState: "done" });

    const childA = children.children[0]!.id;
    const childARun = workspaces.activePipeline(ctx.suite.id)!.currentRunId!;
    const grandchildren = workspaces.decomposePrompt(childARun, {
      requestId: randomUUID(),
      resumeBrief: "Split A into two independently verifiable pieces.",
      children: [
        { title: unique("grandchild-a"), content: "Do A1" },
        { title: unique("grandchild-b"), content: "Do A2" },
      ],
    }) as { children: Array<{ id: number }> };
    workspaces.finishAgentRun(childARun, "done");
    await pipelineScheduler.onExecuteEnded({ runId: childARun, workspaceId: ctx.workspace.id, promptId: childA, processState: "done" });

    assert.equal(started.at(-1)?.promptId, grandchildren.children[0]!.id);
    let runId = workspaces.activePipeline(ctx.suite.id)!.currentRunId!;
    await endStation({ runId, promptId: grandchildren.children[0]!.id, workspaceId: ctx.workspace.id, outcome: "DONE" });
    assert.equal(started.at(-1)?.promptId, grandchildren.children[1]!.id);
    runId = workspaces.activePipeline(ctx.suite.id)!.currentRunId!;
    await endStation({ runId, promptId: grandchildren.children[1]!.id, workspaceId: ctx.workspace.id, outcome: "DONE" });

    assert.equal(started.at(-1)?.promptId, childA);
    assert.equal(workspaces.promptOutcome(childA).status, "IN_PROGRESS");
  } finally {
    ctx.cleanup();
  }
});

test("play resumes a stopped decomposed station at its next child", async () => {
  const ctx = fixture(1);
  const started = stubStarts();
  try {
    const parent = ctx.prompts[0]!;
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    const result = workspaces.decomposePrompt(playing.currentRunId!, {
      requestId: randomUUID(),
      resumeBrief: "Resume at the first child after an interruption.",
      children: [
        { title: unique("slice-a"), content: "Do slice A" },
        { title: unique("slice-b"), content: "Do slice B" },
      ],
    }) as { children: Array<{ id: number }> };
    workspaces.finishAgentRun(playing.currentRunId!, "done");
    workspaces.updatePipelineRun(playing.id, {
      state: "STOPPED",
      stopReason: "start_failed",
      endedAt: new Date().toISOString(),
      currentRunId: null,
    });

    const resumed = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    assert.equal(resumed.state, "PLAYING");
    assert.equal(started.at(-1)?.promptId, result.children[0]!.id);
  } finally {
    ctx.cleanup();
  }
});

test("decompose validates child count and refuses a third level of nesting", () => {
  const ctx = fixture(1);
  try {
    const top = ctx.prompts[0]!.id;
    beginRun("run-decompose-validate", ctx.workspace.id, top);
    assert.throws(() => workspaces.decomposePrompt("run-decompose-validate", {
      requestId: randomUUID(),
      resumeBrief: "not enough children",
      children: [{ title: "only one", content: "..." }],
    }), (error: unknown) => error instanceof WorkspaceError && error.code === "validation_error");

    // depth 0 -> 1: allowed.
    const first = workspaces.decomposePrompt("run-decompose-validate", {
      requestId: randomUUID(),
      resumeBrief: "splitting once",
      children: [{ title: unique("child-a"), content: "a" }, { title: unique("child-b"), content: "b" }],
    }) as { children: Array<{ id: number }> };
    const child = first.children[0]!.id;

    // depth 1 -> 2: still allowed.
    beginRun("run-decompose-child", ctx.workspace.id, child);
    const second = workspaces.decomposePrompt("run-decompose-child", {
      requestId: randomUUID(),
      resumeBrief: "splitting the sub-step once more",
      children: [{ title: unique("grandchild-a"), content: "a" }, { title: unique("grandchild-b"), content: "b" }],
    }) as { children: Array<{ id: number }> };
    const grandchild = second.children[0]!.id;

    // depth 2 -> 3: refused.
    beginRun("run-decompose-grandchild", ctx.workspace.id, grandchild);
    assert.throws(() => workspaces.decomposePrompt("run-decompose-grandchild", {
      requestId: randomUUID(),
      resumeBrief: "should not be allowed",
      children: [{ title: unique("great-a"), content: "a" }, { title: unique("great-b"), content: "b" }],
    }), (error: unknown) => error instanceof WorkspaceError && error.code === "decompose_depth_exceeded");
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
        budget: emptyBudgetSnapshot,
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

test("onRestart=resumeSameRun adopts the interrupted run instead of starting a fresh one", async () => {
  const ctx = fixture(2);
  stubStarts();
  try {
    updateSettings({ "pipeline.onRestart": "resumeSameRun" });
    const first = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    const stationRunId = first.currentRunId!;
    workspaces.interruptPipelinesOnRestart();
    assert.equal(workspaces.latestPipeline(ctx.suite.id)?.state, "INTERRUPTED");
    // A restart also strands the station's own run, which has to be cleared
    // before anything can start it — the "Recover station" control's job.
    workspaces.recoverPrompt(ctx.prompts[0]!.id, stationRunId);

    const resumed = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    assert.equal(resumed.id, first.id, "should have picked the same run back up");
    assert.equal(resumed.state, "PLAYING");
    assert.equal(resumed.stopReason, null, "adopting must clear the restart reason");
  } finally {
    resetSettings(["pipeline.onRestart"]);
    ctx.cleanup();
  }
});

test("onRestart=newRun leaves the interrupted run in the archive", async () => {
  const ctx = fixture(2);
  stubStarts();
  try {
    const first = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    const stationRunId = first.currentRunId!;
    workspaces.interruptPipelinesOnRestart();
    workspaces.recoverPrompt(ctx.prompts[0]!.id, stationRunId);
    const second = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    assert.notEqual(second.id, first.id, "the default must start a fresh run");
    assert.equal(second.state, "PLAYING");
  } finally {
    ctx.cleanup();
  }
});

/*
 * D4: retry and recover both reset the prompt and spend an attempt before
 * starting anything. Pausing used to slip between those writes and the start,
 * burning a retry the operator never saw run.
 */
test("pausing a station that blocks does not spend a retry", async () => {
  const ctx = fixture(2);
  stubStarts();
  try {
    workspaces.upsertPipelineRule(ctx.prompts[0]!.id, { onBlocked: "retry", retryLimit: 3 });
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    await pipelineScheduler.pause(ctx.suite.id);
    await endStation({
      runId: playing.currentRunId!,
      promptId: ctx.prompts[0]!.id,
      workspaceId: ctx.workspace.id,
      outcome: "human",
    });
    const held = workspaces.activePipeline(ctx.suite.id);
    assert.equal(held?.state, "PAUSED", "the run should still be held");
    assert.equal(held?.attempt, 0, "a held run must not spend an attempt");
    assert.equal(workspaces.promptOutcome(ctx.prompts[0]!.id).status, "BLOCKED", "the station must not be reset while held");
  } finally {
    ctx.cleanup();
  }
});

/*
 * D5: retry exhaustion parks the run for a human. It is not stopped, so the
 * reason belongs in `waitReason`; writing it to `stopReason` meant the status
 * bar dropped it, because that field is only rendered on a terminal run.
 */
test("retry exhaustion parks with a waitReason and leaves stopReason clear", async () => {
  const ctx = fixture(2);
  stubStarts();
  try {
    workspaces.upsertPipelineRule(ctx.prompts[0]!.id, { onBlocked: "retry", retryLimit: 1 });
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    await endStation({ runId: playing.currentRunId!, promptId: ctx.prompts[0]!.id, workspaceId: ctx.workspace.id, outcome: "human" });
    const retrying = workspaces.activePipeline(ctx.suite.id)!;
    await endStation({ runId: retrying.currentRunId!, promptId: ctx.prompts[0]!.id, workspaceId: ctx.workspace.id, outcome: "human" });
    const live = workspaces.activePipeline(ctx.suite.id)!;
    assert.equal(live.state, "WAITING_HUMAN");
    assert.equal(live.waitReason, "retry_exhausted");
    assert.equal(live.stopReason, null, "a parked run has not stopped");
    assert.equal(live.endedAt, null);
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

test("scheduler starts executes only, never consults", () => {
  const source = readFileSync(new URL("./pipelineScheduler.ts", import.meta.url), "utf8");
  assert.match(source, /startExecute/);
  assert.doesNotMatch(source, /startConsult|startRun\(/);
});

/**
 * Whether Pause and Stop interrupt the running agent is operator policy now, so
 * these assert the behaviour under each setting rather than grepping the source
 * for `runHub.stop` — which pinned one answer and broke the moment the other
 * became reachable.
 */
async function withRunningAgent(
  ctx: ReturnType<typeof fixture>,
  runId: string,
  body: () => Promise<void>,
): Promise<boolean> {
  let interrupted = false;
  runHub.start({
    handle: {
      runId,
      provider: "claude",
      model: null,
      role: "execute",
      permissionMode: null,
      budget: emptyBudgetSnapshot,
      interrupt: async () => { interrupted = true; },
      done: Promise.resolve("interrupted"),
    } satisfies RunHandle,
    workspace: { id: ctx.workspace.id, name: ctx.workspace.name, workDirectory: ctx.workspace.workDirectory },
    source: { type: "custom", displayText: "station" },
    role: "execute",
  });
  try {
    await body();
  } finally {
    if (runHub.has(runId)) runHub.end(runId, "interrupted");
  }
  return interrupted;
}

test("pauseMode=immediate interrupts the agent but keeps the run resumable", async () => {
  const ctx = fixture(2);
  stubStarts();
  try {
    updateSettings({ "pipeline.pauseMode": "immediate" });
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    const runId = playing.currentRunId!;
    const interrupted = await withRunningAgent(ctx, runId, async () => {
      const paused = await pipelineScheduler.pause(ctx.suite.id);
      // The difference from Stop: still PAUSED, so still active and resumable.
      assert.equal(paused.state, "PAUSED");
      assert.notEqual(workspaces.activePipeline(ctx.suite.id), null);
    });
    assert.equal(interrupted, true, "immediate pause should interrupt the agent");
  } finally {
    resetSettings(["pipeline.pauseMode"]);
    ctx.cleanup();
  }
});

test("pauseMode=graceful leaves the agent alone", async () => {
  const ctx = fixture(2);
  stubStarts();
  try {
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    const runId = playing.currentRunId!;
    const interrupted = await withRunningAgent(ctx, runId, async () => {
      assert.equal((await pipelineScheduler.pause(ctx.suite.id)).state, "PAUSED");
    });
    assert.equal(interrupted, false, "the default pause must not interrupt");
  } finally {
    ctx.cleanup();
  }
});

test("stopInterruptsAgent=false ends the run without killing the agent", async () => {
  const ctx = fixture(2);
  stubStarts();
  try {
    updateSettings({ "pipeline.stopInterruptsAgent": false });
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    const runId = playing.currentRunId!;
    const interrupted = await withRunningAgent(ctx, runId, async () => {
      const stopped = await pipelineScheduler.stop(ctx.suite.id);
      assert.equal(stopped.state, "STOPPED");
      assert.equal(stopped.stopReason, "operator_stop");
    });
    assert.equal(interrupted, false, "stop should have left the agent running");
  } finally {
    resetSettings(["pipeline.stopInterruptsAgent"]);
    ctx.cleanup();
  }
});

test("the resolved policy falls back to built-in defaults for junk values", () => {
  try {
    updateSettings({ "pipeline.maxHandoffGenerations": 0 });
    assert.equal(settings.pipelinePolicy.maxHandoffGenerations, DEFAULT_PIPELINE_POLICY.maxHandoffGenerations);
    updateSettings({ "pipeline.maxHandoffGenerations": 5 });
    assert.equal(settings.pipelinePolicy.maxHandoffGenerations, 5);
  } finally {
    resetSettings(["pipeline.maxHandoffGenerations"]);
  }
  assert.deepEqual(settings.pipelinePolicy, DEFAULT_PIPELINE_POLICY);
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
    const saved = workspaces.createPipeline({
      workspaceId: ctx.workspace.id,
      name: unique("mission"),
      suiteIds: [ctx.suite.id, suiteB.id],
    });
    addNamedSteps(saved.id, ctx.prompts);
    workspaces.addNamedPipelineStep(saved.id, promptB.id, { provider: "claude" });
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
    const saved = workspaces.createPipeline({
      workspaceId: ctx.workspace.id,
      name: unique("handoff-target"),
      suiteIds: [ctx.suite.id],
    });
    workspaces.upsertNamedPipelineRule(saved.id, ctx.prompts[0]!.id, { provider: "grok", model: "grok-4.5" });
    workspaces.upsertNamedPipelineRule(saved.id, ctx.prompts[1]!.id, { provider: "grok", model: "grok-4.5" });

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
    addNamedSteps(saved.id, ctx.prompts);
    await pipelineScheduler.playNamed(saved.id, { provider: "claude" });
    const stopped = await pipelineScheduler.stopNamed(saved.id);
    assert.equal(stopped.state, "STOPPED");
    assert.equal(stopped.stopReason, "operator_stop");
    assert.equal(workspaces.listPipelineRuns(saved.id)[0]?.state, "STOPPED");
  } finally {
    ctx.cleanup();
  }
});

test("a pipeline can pin a different agent on one sub-step without touching the station", async () => {
  const ctx = fixture(1);
  const started = stubStarts();
  try {
    const parent = ctx.prompts[0]!;
    const saved = workspaces.createPipeline({
      workspaceId: ctx.workspace.id,
      name: unique("sub-step-override"),
      suiteIds: [ctx.suite.id],
    });
    workspaces.addNamedPipelineStep(saved.id, parent.id, { provider: "claude", model: "claude-opus-5" });

    await pipelineScheduler.playNamed(saved.id);
    const runId = workspaces.activePipeline(ctx.suite.id)!.currentRunId!;
    const result = workspaces.decomposePrompt(runId, {
      requestId: randomUUID(),
      resumeBrief: "Two slices remain.",
      children: [
        { title: unique("slice-a"), content: "Do slice A" },
        { title: unique("slice-b"), content: "Do slice B" },
      ],
    }) as { children: Array<{ id: number }> };
    const childA = result.children[0]!.id;
    const childB = result.children[1]!.id;

    // Nothing is pinned yet: both sub-steps report the station's rule.
    const inherited = workspaces.namedPipelineSubStepRules(saved.id, ctx.suite.id);
    assert.deepEqual(inherited.map((entry) => entry.promptId), [childA, childB]);
    assert.deepEqual(inherited.map((entry) => entry.inherited), [true, true]);
    assert.equal(inherited[0]!.rule.provider, "claude");
    assert.equal(inherited[0]!.rule.model, "claude-opus-5");
    assert.equal(inherited[0]!.depth, 1);
    assert.equal(inherited[0]!.parentPromptId, parent.id);

    // Pin the first slice to another agent.
    workspaces.upsertNamedPipelineRule(saved.id, childA, { provider: "codex", model: "gpt-x" });
    const pinned = workspaces.namedPipelineSubStepRules(saved.id, ctx.suite.id);
    assert.deepEqual(pinned.map((entry) => entry.inherited), [false, true]);
    assert.equal(pinned[0]!.rule.provider, "codex");
    assert.equal(pinned[1]!.rule.provider, "claude");
    // The station itself is untouched, and the sub-step never becomes a step.
    assert.equal(workspaces.pipelineRule(parent.id, saved.id).provider, "claude");
    assert.deepEqual(
      workspaces.enabledNamedPipelineSteps(saved.id, ctx.suite.id).map((step) => step.promptId),
      [parent.id],
    );
    // Sub-step overrides share the pipeline_step table, so every count over it
    // has to stay on stations or the board reports a rail that does not exist.
    assert.equal(workspaces.getPipeline(saved.id).stages[0]!.stepCount, 1);

    // The scheduler honours the pin when it starts that slice.
    workspaces.finishAgentRun(runId, "done");
    await pipelineScheduler.onExecuteEnded({ runId, workspaceId: ctx.workspace.id, promptId: parent.id, processState: "done" });
    assert.equal(started.at(-1)?.promptId, childA);
    assert.equal(started.at(-1)?.provider, "codex");
    assert.equal(started.at(-1)?.model, "gpt-x");

    // The next slice still follows the station.
    const runA = workspaces.activePipeline(ctx.suite.id)!.currentRunId!;
    await endStation({ runId: runA, promptId: childA, workspaceId: ctx.workspace.id, outcome: "DONE" });
    assert.equal(started.at(-1)?.promptId, childB);
    assert.equal(started.at(-1)?.provider, "claude");

    // Dropping the override puts the slice back on the station's agent.
    workspaces.removeNamedPipelineStep(saved.id, childA);
    assert.equal(workspaces.pipelineRule(childA, saved.id).provider, "claude");
    assert.equal(workspaces.namedPipelineSubStepRules(saved.id, ctx.suite.id)[0]!.inherited, true);
  } finally {
    ctx.cleanup();
  }
});

test("a pinned sub-step keeps the station's on_done and cannot join the flowchart", async () => {
  const ctx = fixture(1);
  stubStarts();
  try {
    const parent = ctx.prompts[0]!;
    const saved = workspaces.createPipeline({
      workspaceId: ctx.workspace.id,
      name: unique("sub-step-policy"),
      suiteIds: [ctx.suite.id],
    });
    workspaces.addNamedPipelineStep(saved.id, parent.id, { provider: "claude" });
    workspaces.upsertNamedPipelineRule(saved.id, parent.id, { onDone: "skip_rest" });

    await pipelineScheduler.playNamed(saved.id);
    const runId = workspaces.activePipeline(ctx.suite.id)!.currentRunId!;
    const result = workspaces.decomposePrompt(runId, {
      requestId: randomUUID(),
      resumeBrief: "Two slices remain.",
      children: [
        { title: unique("slice-a"), content: "Do slice A" },
        { title: unique("slice-b"), content: "Do slice B" },
      ],
    }) as { children: Array<{ id: number }> };
    const childA = result.children[0]!.id;

    // A sub-step may pin its own blocked policy, but on_done stays the station's.
    workspaces.upsertNamedPipelineRule(saved.id, childA, { provider: "codex", onBlocked: "retry", retryLimit: 3 });
    const rule = workspaces.pipelineRule(childA, saved.id);
    assert.equal(rule.onBlocked, "retry");
    assert.equal(rule.retryLimit, 3);
    assert.equal(rule.onDone, "skip_rest");

    assert.throws(
      () => workspaces.addNamedPipelineStep(saved.id, childA, { provider: "codex" }),
      (error: unknown) => error instanceof WorkspaceError && error.status === 422,
    );

    // And the nested view still hands the board a rule for it.
    const flowchart = workspaces.namedPipelineFlowchart(saved.id, ctx.suite.id);
    assert.equal(flowchart.steps.length, 1);
    assert.equal(flowchart.subSteps.length, 2);
    assert.equal(flowchart.subSteps.find((entry) => entry.promptId === childA)?.rule.provider, "codex");
  } finally {
    ctx.cleanup();
  }
});
