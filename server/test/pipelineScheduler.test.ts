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
import { WorkspaceError, workspaces } from "../src/workspaces.ts";

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

test("answering a human question resumes the parked pipeline and starts its station", async () => {
  const ctx = fixture(1);
  const started = stubStarts();
  try {
    const promptId = ctx.prompts[0]!.id;
    await pipelineScheduler.playNamed(ctx.pipeline.id, { provider: "claude" });
    const firstRunId = workspaces.activePipeline(ctx.suite.id)!.currentRunId!;
    workspaces.updateAgentStatus(firstRunId, {
      requestId: randomUUID(),
      expectedStatus: "IN_PROGRESS",
      status: "BLOCKED",
      reason: "need a decision",
      verificationSummary: "Choose the deployment region",
    });
    workspaces.finishAgentRun(firstRunId, "done");
    await pipelineScheduler.onExecuteEnded({
      runId: firstRunId,
      workspaceId: ctx.workspace.id,
      promptId,
      processState: "done",
    });

    workspaces.respondToBlockedPrompt(promptId, { content: "Deploy to Sydney." });
    await pipelineScheduler.onPromptResponded(promptId);

    const resumed = workspaces.activePipeline(ctx.suite.id)!;
    assert.equal(resumed.state, "PLAYING");
    assert.equal(resumed.waitReason, null);
    assert.notEqual(resumed.currentRunId, firstRunId);
    assert.ok(resumed.currentRunId !== null);
    assert.equal(workspaces.promptOutcome(promptId).status, "IN_PROGRESS");
    assert.equal(started.length, 2);
  } finally {
    ctx.cleanup();
  }
});

test("answering after a server restart revives the interrupted human-wait pipeline", async () => {
  const ctx = fixture(1);
  const started = stubStarts();
  try {
    const promptId = ctx.prompts[0]!.id;
    await pipelineScheduler.playNamed(ctx.pipeline.id, { provider: "claude" });
    const firstRunId = workspaces.activePipeline(ctx.suite.id)!.currentRunId!;
    workspaces.updateAgentStatus(firstRunId, {
      requestId: randomUUID(),
      expectedStatus: "IN_PROGRESS",
      status: "BLOCKED",
      reason: "need a decision",
      verificationSummary: "Delete or retain the unused routes",
    });
    workspaces.finishAgentRun(firstRunId, "done");
    await pipelineScheduler.onExecuteEnded({
      runId: firstRunId,
      workspaceId: ctx.workspace.id,
      promptId,
      processState: "done",
    });
    const parked = workspaces.activePipeline(ctx.suite.id)!;
    workspaces.updatePipelineRun(parked.id, {
      state: "INTERRUPTED",
      stopReason: "server_restart",
      endedAt: new Date().toISOString(),
    });
    workspaces.updateNamedPipelineRun(parked.pipelineRunId!, {
      state: "INTERRUPTED",
      stopReason: "server_restart",
      endedAt: new Date().toISOString(),
    });

    workspaces.respondToBlockedPrompt(promptId, { content: "Delete them." });
    await pipelineScheduler.onPromptResponded(promptId);

    const resumed = workspaces.activePipeline(ctx.suite.id)!;
    assert.equal(resumed.state, "PLAYING");
    assert.equal(resumed.stopReason, null);
    assert.equal(resumed.waitReason, null);
    assert.ok(resumed.currentRunId !== null);
    assert.equal(workspaces.promptOutcome(promptId).status, "IN_PROGRESS");
    assert.equal(started.length, 2);
    assert.equal(workspaces.namedPipelineRunById(parked.pipelineRunId!)!.state, "PLAYING");
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

/** Adapters that report themselves installed, so the fallback list is not empty by accident. */
async function stubProviders(ids: Array<"claude" | "codex" | "cursor">): Promise<() => void> {
  const { setAdapterOverride } = await import("../src/adapters/registry.ts");
  const available = { available: true, reason: null, version: null, binary: null };
  for (const id of ids) {
    setAdapterOverride(id, {
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
  }
  return () => { for (const id of ids) setAdapterOverride(id, null); };
}

/*
 * The incident: Codex ran out of allowance mid-work and left the tree dirty.
 * Every fallback was then refused by the dirty tree, each refusal was booked as
 * that provider failing to start, and the run parked `no_provider_available`
 * with all of them cooling — so neither Resume nor Retry could start anything.
 */
test("a start the workspace refuses parks with its own reason and blames no provider", async () => {
  const { resetProviderHealth, coolingFor } = await import("../src/providerHealth.ts");
  resetProviderHealth();
  const restore = await stubProviders(["claude", "codex", "cursor"]);
  const ctx = fixture(1);
  const attempts: string[] = [];
  let dirty = true;
  const ok = stubStarts();
  const startOk = async (args: StartExecuteArgs) => {
    // `stubStarts` installed the working starter; borrow it once the tree is clean.
    const runId = newId("run");
    const credential = runContexts.create(runId, args.workspaceId, args.promptId!);
    workspaces.beginAgentRun({ runId, workspaceId: args.workspaceId, promptId: args.promptId!, provider: args.provider, model: args.model, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute" });
    workspaces.markAgentRunRunning(runId);
    ok.push({ ...args });
    return { runId };
  };
  setPipelineStationStarter(async (args) => {
    attempts.push(args.provider);
    if (dirty) throw new WorkspaceError(409, "git_worktree_dirty", "Commit or stash the existing working-tree changes before starting an agent.", undefined, { detail: " M app.ts" });
    return startOk(args);
  });
  try {
    const promptId = ctx.prompts[0]!.id;
    workspaces.upsertNamedPipelineRule(ctx.pipeline.id, promptId, { provider: "claude", fallbackProviders: ["codex", "cursor"] });
    await pipelineScheduler.playNamed(ctx.pipeline.id);
    const parked = workspaces.activePipeline(ctx.suite.id)!;
    assert.equal(parked.state, "WAITING_HUMAN");
    assert.equal(parked.waitReason, "worktree_dirty");
    assert.equal(workspaces.activeNamedPipelineRun(ctx.pipeline.id)?.waitReason, "worktree_dirty");
    // One attempt, no fallback walk, nobody cooled, and the station untouched.
    assert.deepEqual(attempts, ["claude"]);
    for (const id of ["claude", "codex", "cursor"] as const) assert.equal(coolingFor(id), null, `${id} was blamed`);
    assert.equal(workspaces.promptOutcome(promptId).status, "TODO");
    const events = workspaces.promptHistory(promptId).events as Array<{ trigger: string | null }>;
    assert.equal(events.some((event) => event.trigger === "provider_fallback"), false);

    // Still dirty: Resume tries again and parks again, rather than refusing.
    await pipelineScheduler.playNamed(ctx.pipeline.id);
    assert.equal(workspaces.activePipeline(ctx.suite.id)!.waitReason, "worktree_dirty");

    dirty = false;
    await pipelineScheduler.playNamed(ctx.pipeline.id);
    const live = workspaces.activePipeline(ctx.suite.id)!;
    assert.equal(live.state, "PLAYING");
    assert.equal(live.waitReason, null);
    assert.equal(ok.at(-1)?.provider, "claude");
  } finally {
    restore();
    resetProviderHealth();
    ctx.cleanup();
  }
});

test("any other workspace refusal parks start_refused with the code that refused it", async () => {
  const { resetProviderHealth, coolingFor } = await import("../src/providerHealth.ts");
  resetProviderHealth();
  const ctx = fixture(1);
  setPipelineStationStarter(async () => {
    throw new WorkspaceError(409, "git_repository_busy", "Another agent is already writing in this Git repository.");
  });
  try {
    await pipelineScheduler.playNamed(ctx.pipeline.id);
    const parked = workspaces.activePipeline(ctx.suite.id)!;
    assert.equal(parked.state, "WAITING_HUMAN");
    assert.equal(parked.waitReason, "start_refused:git_repository_busy");
    assert.equal(coolingFor("claude"), null);
  } finally {
    resetProviderHealth();
    ctx.cleanup();
  }
});

test("Resume after no_provider_available is a real retry: cooling is cleared and a FAILED station re-queued", async () => {
  const { resetProviderHealth, markCooling, coolingFor } = await import("../src/providerHealth.ts");
  resetProviderHealth();
  const restore = await stubProviders(["claude", "codex", "cursor"]);
  markCooling("codex", "quota", 60, "test");
  markCooling("cursor", "capacity", 60, "test");
  const ctx = fixture(1);
  const started: StartExecuteArgs[] = [];
  let outOfAllowance = true;
  setPipelineStationStarter(async (args) => {
    started.push({ ...args });
    const runId = newId("run");
    const credential = runContexts.create(runId, args.workspaceId, args.promptId!);
    workspaces.beginAgentRun({ runId, workspaceId: args.workspaceId, promptId: args.promptId!, provider: args.provider, model: args.model, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute" });
    if (outOfAllowance) {
      // Died after the run row existed, so the station is left FAILED.
      workspaces.finishAgentRun(runId, "error");
      throw new Error("You've hit your usage limit. Try again at 5:22 PM.");
    }
    workspaces.markAgentRunRunning(runId);
    return { runId };
  });
  try {
    const promptId = ctx.prompts[0]!.id;
    workspaces.upsertNamedPipelineRule(ctx.pipeline.id, promptId, { provider: "claude", fallbackProviders: ["codex", "cursor"] });
    await pipelineScheduler.playNamed(ctx.pipeline.id);
    const parked = workspaces.activePipeline(ctx.suite.id)!;
    assert.equal(parked.state, "WAITING_HUMAN");
    assert.equal(parked.waitReason, "no_provider_available");
    assert.equal(workspaces.promptOutcome(promptId).status, "FAILED");
    assert.equal(coolingFor("claude")?.id, "start_failed");

    // The operator topped up and pressed Resume. Nothing else changed.
    outOfAllowance = false;
    await pipelineScheduler.playNamed(ctx.pipeline.id);
    const live = workspaces.activePipeline(ctx.suite.id)!;
    assert.equal(live.state, "PLAYING");
    assert.equal(live.currentRunId !== null, true);
    assert.equal(started.at(-1)?.provider, "claude");
    assert.equal(coolingFor("claude"), null);
    assert.equal(coolingFor("codex"), null);
    const events = workspaces.promptHistory(promptId).events as Array<{ trigger: string | null; actorType?: string }>;
    assert.ok(events.some((event) => event.trigger === "operator_resume"));
  } finally {
    restore();
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

test("a fresh play skips named stages that are already finished", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pipe-"));
  const workspace = workspaces.create({ name: unique("ws"), description: "", workDirectory: dir });
  try {
    const program = workspaces.createChild("program", workspace.id, { name: unique("prog"), overview: "" }) as ProgramRecord;
    const finishedSuite = workspaces.createChild("suite", program.id, { name: unique("done"), overview: "" }) as SuiteRecord;
    const openSuite = workspaces.createChild("suite", program.id, { name: unique("open"), overview: "" }) as SuiteRecord;
    const donePrompt = workspaces.createChild("prompt", finishedSuite.id, { title: unique("a"), content: "a" }) as PromptRecord;
    const skippedPrompt = workspaces.createChild("prompt", finishedSuite.id, { title: unique("b"), content: "b" }) as PromptRecord;
    const openPrompt = workspaces.createChild("prompt", openSuite.id, { title: unique("c"), content: "c" }) as PromptRecord;
    const pipeline = workspaces.createPipeline({ workspaceId: workspace.id, name: unique("pipe"), suiteIds: [finishedSuite.id, openSuite.id] });
    for (const prompt of [donePrompt, skippedPrompt, openPrompt]) workspaces.addNamedPipelineStep(pipeline.id, prompt.id, { provider: "claude" });
    workspaces.completePrompt(donePrompt.id, "USER", { verificationSummary: "Verified by hand." });
    workspaces.skipPrompt(skippedPrompt.id, "USER", "Not needed.");
    const started = stubStarts();

    const run = await pipelineScheduler.playNamed(pipeline.id, { provider: "claude" });
    assert.equal(run.state, "PLAYING");
    assert.equal(run.currentSuiteId, openSuite.id);
    assert.deepEqual(started.map((args) => args.promptId), [openPrompt.id]);

    // Once every stage is finished, a fresh play is refused instead of recording an empty run.
    const live = workspaces.activePipeline(openSuite.id)!;
    await pipelineScheduler.stopNamed(pipeline.id);
    workspaces.finishAgentRun(live.currentRunId!, "done");
    workspaces.completePrompt(openPrompt.id, "USER", { verificationSummary: "Verified by hand." });
    await assert.rejects(
      pipelineScheduler.playNamed(pipeline.id, {}),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "nothing_ready",
    );
  } finally {
    setPipelineStationStarter(null);
    resetSettings();
    workspaces.remove(workspace.id);
    rmSync(dir, { recursive: true, force: true });
  }
});
