import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type ProgramRecord, type PromptRecord, type PromptStatus, type SuiteRecord } from "@agent-console/shared";
import { newId } from "../src/lib/ids.ts";
import { decideExecuteEnded, pipelineScheduler, resolveExecuteTarget, resolveFallbackProviders, setPipelineStationStarter } from "../src/pipelineScheduler.ts";
import { resetSettings, updateSettings } from "../src/settings.ts";
import { runContexts } from "../src/runContext.ts";
import type { StartExecuteArgs } from "../src/runService.ts";
import { workspaces } from "../src/workspaces.ts";

let seq = 0;

function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${seq}`;
}

/**
 * Every (status × trigger) cell the decision table answers, including the
 * tripwire for pairs the scheduler must not guess at.
 */
test("decideExecuteEnded enumerates the continuation-loop decision table", () => {
  const rows: Array<{ status: PromptStatus; trigger: string | null; action: string; detail?: string }> = [
    { status: "DONE", trigger: "agent_post", action: "applyOnDone" },
    { status: "DONE", trigger: null, action: "applyOnDone" },
    { status: "SKIPPED", trigger: "operator_skip", action: "advance" },
    { status: "SKIPPED", trigger: null, action: "advance" },
    { status: "BLOCKED", trigger: "agent_post", action: "park", detail: "human_question" },
    { status: "TODO", trigger: "agent_decompose", action: "advance" },
    { status: "TODO", trigger: "agent_continue", action: "continuation", detail: "agent_continue" },
    { status: "UNREPORTED", trigger: "run_ended_without_post", action: "continuation", detail: "unfinished" },
    { status: "UNREPORTED", trigger: null, action: "continuation", detail: "unfinished" },
    { status: "FAILED", trigger: "run_crashed", action: "continuation", detail: "unfinished" },
    { status: "FAILED", trigger: "run_start_failed", action: "continuation", detail: "unfinished" },
    { status: "NEEDS_REVIEW", trigger: "dod_unmet", action: "continuation", detail: "unfinished" },
    { status: "NEEDS_REVIEW", trigger: null, action: "continuation", detail: "unfinished" },
    // Tripwires — pairs the table does not cover must stop the rail.
    { status: "BLOCKED", trigger: "run_ended_without_post", action: "terminate", detail: "unexpected_status:BLOCKED" },
    { status: "TODO", trigger: "operator_retry", action: "terminate", detail: "unexpected_status:TODO" },
    { status: "TODO", trigger: null, action: "terminate", detail: "unexpected_status:TODO" },
    { status: "FAILED", trigger: "budget_exhausted", action: "terminate", detail: "unexpected_status:FAILED" },
    { status: "FAILED", trigger: null, action: "terminate", detail: "unexpected_status:FAILED" },
    { status: "IN_PROGRESS", trigger: "run_started", action: "terminate", detail: "unexpected_status:IN_PROGRESS" },
  ];

  for (const row of rows) {
    const decision = decideExecuteEnded(row.status, row.trigger);
    assert.equal(decision.action, row.action, `${row.status}/${row.trigger}`);
    if (decision.action === "park") assert.equal(decision.waitReason, row.detail);
    if (decision.action === "continuation") assert.equal(decision.causeKind, row.detail);
    if (decision.action === "terminate") assert.equal(decision.stopReason, row.detail);
  }
});

test("resolveExecuteTarget prefers the play target when asked, else the station rule", () => {
  const rule = { promptId: 1, provider: "claude" as const, model: "m1", fallbackProviders: [] as import("@agent-console/shared").ProviderId[], onDone: "continue" as const, onUnfinished: "continue" as const, enabled: true, stepOrder: 0 };
  assert.deepEqual(
    resolveExecuteTarget({ preferPlayTarget: true, rule, playProvider: "codex", playModel: "x", defaultProvider: null, defaultModel: null }),
    { provider: "codex", model: "x" },
  );
  assert.deepEqual(
    resolveExecuteTarget({ rule, playProvider: null, playModel: null, defaultProvider: "grok", defaultModel: null }),
    { provider: "claude", model: "m1" },
  );
  assert.equal(
    resolveExecuteTarget({ rule: { ...rule, provider: null }, playProvider: null, playModel: null, defaultProvider: null, defaultModel: null }),
    null,
  );
});

function fixture(promptCount = 1) {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
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
    program,
    suite,
    pipeline,
    prompts,
    cleanup() {
      setPipelineStationStarter(null);
      resetSettings();
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

test("UNREPORTED continues up to maxContinuations then parks continuations_exhausted when review is off", async () => {
  const ctx = fixture(1);
  const started = stubStarts();
  updateSettings({ "pipeline.maxContinuations": 2, "pipeline.reviewAfterContinuations": false });
  try {
    const promptId = ctx.prompts[0]!.id;
    await pipelineScheduler.playNamed(ctx.pipeline.id, { provider: "claude" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const live = workspaces.activePipeline(ctx.suite.id)!;
      assert.equal(live.state, "PLAYING");
      const runId = live.currentRunId!;
      workspaces.finishAgentRun(runId, "done");
      await pipelineScheduler.onExecuteEnded({ runId, workspaceId: ctx.workspace.id, promptId, processState: "done" });
      assert.equal(workspaces.continuationCount(promptId), attempt + 1);
    }
    const live = workspaces.activePipeline(ctx.suite.id)!;
    const runId = live.currentRunId!;
    workspaces.finishAgentRun(runId, "done");
    await pipelineScheduler.onExecuteEnded({ runId, workspaceId: ctx.workspace.id, promptId, processState: "done" });
    const parked = workspaces.activePipeline(ctx.suite.id)!;
    assert.equal(parked.state, "WAITING_HUMAN");
    assert.equal(parked.waitReason, "continuations_exhausted");
    assert.equal(started.length, 3); // initial + 2 continuations
  } finally {
    ctx.cleanup();
  }
});

test("agent_post BLOCKED parks human_question and is never continued", async () => {
  const ctx = fixture(1);
  stubStarts();
  try {
    const promptId = ctx.prompts[0]!.id;
    await pipelineScheduler.playNamed(ctx.pipeline.id, { provider: "claude" });
    const runId = workspaces.activePipeline(ctx.suite.id)!.currentRunId!;
    workspaces.updateAgentStatus(runId, {
      requestId: randomUUID(),
      expectedStatus: "IN_PROGRESS",
      status: "BLOCKED",
      reason: "need a decision",
      verificationSummary: "Pick which payment provider to use",
    });
    workspaces.finishAgentRun(runId, "done");
    await pipelineScheduler.onExecuteEnded({ runId, workspaceId: ctx.workspace.id, promptId, processState: "done" });
    const parked = workspaces.activePipeline(ctx.suite.id)!;
    assert.equal(parked.state, "WAITING_HUMAN");
    assert.equal(parked.waitReason, "human_question");
    assert.equal(workspaces.continuationCount(promptId), 0);
  } finally {
    ctx.cleanup();
  }
});

test("a continuation after a refused done carries the Verify failure in its brief", async () => {
  const { runDefinitionOfDoneCommands } = await import("../src/definitionOfDone.ts");
  const ctx = fixture(1);
  stubStarts();
  updateSettings({ "pipeline.maxContinuations": 2, "pipeline.reviewAfterContinuations": false });
  try {
    const promptId = ctx.prompts[0]!.id;
    workspaces.updateChild("prompt", promptId, {
      content: "## Verify\n```sh\necho verify-tail-xyz >&2; exit 1\n```\n",
    });
    await pipelineScheduler.playNamed(ctx.pipeline.id, { provider: "claude" });
    const runId = workspaces.activePipeline(ctx.suite.id)!.currentRunId!;
    await runDefinitionOfDoneCommands(promptId, runId);
    const failures = workspaces.agentDoneVerificationFailures(promptId);
    assert.ok(failures !== null);
    workspaces.recordVerificationFailureRemark(promptId, runId, failures!);
    workspaces.addAgentRemark(runId, {
      requestId: randomUUID(), kind: "PROGRESS", content: "ported half the handlers",
    });
    // Run ends without a final status → UNREPORTED → continuation.
    workspaces.finishAgentRun(runId, "done");
    await pipelineScheduler.onExecuteEnded({ runId, workspaceId: ctx.workspace.id, promptId, processState: "done" });
    assert.equal(workspaces.continuationCount(promptId), 1);
    const brief = workspaces.latestContinuationRemark(promptId) ?? "";
    assert.match(brief, /verify-tail-xyz/);
    assert.match(brief, /Last refused verification/);
    assert.match(brief, /ported half the handlers/);
  } finally {
    ctx.cleanup();
  }
});

test("resolveFallbackProviders: station → suite → house", () => {
  const rule = {
    promptId: 1,
    provider: "claude" as const,
    model: null,
    fallbackProviders: ["codex" as const],
    onDone: "continue" as const,
    onUnfinished: "continue" as const,
    enabled: true,
    stepOrder: 0,
  };
  assert.deepEqual(
    resolveFallbackProviders({ rule, suiteFallbackProviders: ["grok"], houseFallbackProviders: ["cursor"] }),
    ["codex"],
  );
  assert.deepEqual(
    resolveFallbackProviders({
      rule: { ...rule, fallbackProviders: [] },
      suiteFallbackProviders: ["grok"],
      houseFallbackProviders: ["cursor"],
    }),
    ["grok"],
  );
  assert.deepEqual(
    resolveFallbackProviders({
      rule: { ...rule, fallbackProviders: [] },
      suiteFallbackProviders: [],
      houseFallbackProviders: ["cursor", "claude"],
    }),
    ["cursor", "claude"],
  );
});

test("capacity failure swaps to the next fallback without consuming a continuation", async () => {
  const { setAdapterOverride } = await import("../src/adapters/registry.ts");
  const { resetProviderHealth, coolingFor } = await import("../src/providerHealth.ts");
  resetProviderHealth();

  const available = {
    available: true,
    reason: null,
    version: null,
    binary: null,
  };
  const stubAdapter = (id: "claude" | "codex") => ({
    id,
    label: id,
    transport: "sdk" as const,
    reportsTokens: true,
    permissionMode: "bypass",
    model: null,
    checkAvailability: async () => available,
    isAvailable: async () => true,
    getVersion: async () => null,
    getAccountUsage: async () => ({ provider: id, available: false, reason: null, windows: [] }) as never,
    async *run() {},
    interrupt: async () => {},
  });
  setAdapterOverride("claude", stubAdapter("claude"));
  setAdapterOverride("codex", stubAdapter("codex"));

  const ctx = fixture(1);
  const started: StartExecuteArgs[] = [];
  let claudeAttempts = 0;
  setPipelineStationStarter(async (args) => {
    started.push({ ...args });
    if (args.provider === "claude") {
      claudeAttempts += 1;
      throw new Error("Selected model is at capacity. Please try a different model.");
    }
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

  try {
    const promptId = ctx.prompts[0]!.id;
    workspaces.upsertNamedPipelineRule(ctx.pipeline.id, promptId, {
      provider: "claude",
      fallbackProviders: ["codex"],
    });
    await pipelineScheduler.playNamed(ctx.pipeline.id, { provider: "claude" });
    const live = workspaces.activePipeline(ctx.suite.id)!;
    assert.equal(live.state, "PLAYING");
    assert.equal(live.currentRunId !== null, true);
    assert.equal(started.at(-1)?.provider, "codex");
    assert.equal(claudeAttempts, 1);
    assert.equal(workspaces.continuationCount(promptId), 0);
    const events = workspaces.promptHistory(promptId).events as Array<{ trigger: string | null; ruleId: string | null }>;
    assert.ok(events.some((e) => e.trigger === "provider_fallback" && e.ruleId === "provider-fallback"));
    assert.ok(coolingFor("claude") !== null);
  } finally {
    setAdapterOverride("claude", null);
    setAdapterOverride("codex", null);
    resetProviderHealth();
    ctx.cleanup();
  }
});

test("when every fallback is cooling, a continuation that cannot start parks no_provider_available", async () => {
  const { setAdapterOverride } = await import("../src/adapters/registry.ts");
  const { resetProviderHealth, markCooling } = await import("../src/providerHealth.ts");
  resetProviderHealth();
  markCooling("claude", "capacity", 60, "test");
  markCooling("codex", "capacity", 60, "test");
  markCooling("cursor", "capacity", 60, "test");
  markCooling("grok", "capacity", 60, "test");
  markCooling("copilot", "capacity", 60, "test");

  const available = { available: true, reason: null, version: null, binary: null };
  const stubAdapter = (id: "claude" | "codex") => ({
    id,
    label: id,
    transport: "sdk" as const,
    reportsTokens: true,
    permissionMode: "bypass",
    model: null,
    checkAvailability: async () => available,
    isAvailable: async () => true,
    getVersion: async () => null,
    getAccountUsage: async () => ({ provider: id, available: false, reason: null, windows: [] }) as never,
    async *run() {},
    interrupt: async () => {},
  });
  setAdapterOverride("claude", stubAdapter("claude"));
  setAdapterOverride("codex", stubAdapter("codex"));

  const ctx = fixture(1);
  setPipelineStationStarter(async () => {
    throw new Error("Selected model is at capacity. Please try a different model.");
  });
  updateSettings({ "pipeline.maxContinuations": 2, "pipeline.reviewAfterContinuations": false });

  try {
    const promptId = ctx.prompts[0]!.id;
    workspaces.upsertNamedPipelineRule(ctx.pipeline.id, promptId, {
      provider: "claude",
      fallbackProviders: ["codex"],
    });
    // Play with everything cooling: startCurrentStation should park.
    await pipelineScheduler.playNamed(ctx.pipeline.id, { provider: "claude" });
    const parked = workspaces.activePipeline(ctx.suite.id)!;
    assert.equal(parked.state, "WAITING_HUMAN");
    assert.equal(parked.waitReason, "no_provider_available");
  } finally {
    setAdapterOverride("claude", null);
    setAdapterOverride("codex", null);
    resetProviderHealth();
    ctx.cleanup();
  }
});

test("agent_continue keeps re-queueing without spending the unfinished allowance or parking", async () => {
  const ctx = fixture(1);
  const started = stubStarts();
  updateSettings({ "pipeline.maxContinuations": 2, "pipeline.reviewAfterContinuations": false });
  try {
    const promptId = ctx.prompts[0]!.id;
    await pipelineScheduler.playNamed(ctx.pipeline.id, { provider: "claude" });
    // Far more agent continues than N — the rail must stay PLAYING.
    for (let i = 0; i < 6; i++) {
      const live = workspaces.activePipeline(ctx.suite.id)!;
      assert.equal(live.state, "PLAYING", `loop ${i}`);
      const runId = live.currentRunId!;
      workspaces.updateAgentStatus(runId, {
        requestId: randomUUID(),
        expectedStatus: "IN_PROGRESS",
        status: "CONTINUE",
        reason: `slice ${i + 1} banked; more endpoints remain`,
      });
      workspaces.finishAgentRun(runId, "done");
      await pipelineScheduler.onExecuteEnded({ runId, workspaceId: ctx.workspace.id, promptId, processState: "done" });
      assert.equal(workspaces.continuationCount(promptId), 0, `agent continue must not spend allowance (loop ${i})`);
    }
    const after = workspaces.activePipeline(ctx.suite.id)!;
    assert.equal(after.state, "PLAYING");
    assert.equal(after.waitReason, null);
    assert.ok(started.length >= 7); // initial + 6 continues
  } finally {
    ctx.cleanup();
  }
});

test("Resume after continuations_exhausted grants a fresh unfinished allowance", async () => {
  const ctx = fixture(1);
  stubStarts();
  updateSettings({ "pipeline.maxContinuations": 2, "pipeline.reviewAfterContinuations": false });
  try {
    const promptId = ctx.prompts[0]!.id;
    await pipelineScheduler.playNamed(ctx.pipeline.id, { provider: "claude" });
    // Exhaust with UNREPORTED endings (these do spend the allowance).
    for (let attempt = 0; attempt < 2; attempt++) {
      const live = workspaces.activePipeline(ctx.suite.id)!;
      const runId = live.currentRunId!;
      workspaces.finishAgentRun(runId, "done");
      await pipelineScheduler.onExecuteEnded({ runId, workspaceId: ctx.workspace.id, promptId, processState: "done" });
    }
    {
      const live = workspaces.activePipeline(ctx.suite.id)!;
      const runId = live.currentRunId!;
      workspaces.finishAgentRun(runId, "done");
      await pipelineScheduler.onExecuteEnded({ runId, workspaceId: ctx.workspace.id, promptId, processState: "done" });
    }
    const parked = workspaces.activePipeline(ctx.suite.id)!;
    assert.equal(parked.state, "WAITING_HUMAN");
    assert.equal(parked.waitReason, "continuations_exhausted");
    assert.equal(workspaces.continuationCount(promptId), 2);

    // Resume must reset the count and start the station again.
    await pipelineScheduler.playNamed(ctx.pipeline.id, {});
    assert.equal(workspaces.continuationCount(promptId), 0);
    const resumed = workspaces.activePipeline(ctx.suite.id)!;
    assert.equal(resumed.state, "PLAYING");
    assert.equal(resumed.waitReason, null);
    assert.ok(resumed.currentRunId !== null);

    // One unfinished ending after Resume counts as attempt 1, not an immediate re-park.
    const runId = resumed.currentRunId!;
    workspaces.finishAgentRun(runId, "done");
    await pipelineScheduler.onExecuteEnded({ runId, workspaceId: ctx.workspace.id, promptId, processState: "done" });
    assert.equal(workspaces.continuationCount(promptId), 1);
    const stillGoing = workspaces.activePipeline(ctx.suite.id)!;
    assert.equal(stillGoing.state, "PLAYING");
  } finally {
    ctx.cleanup();
  }
});
