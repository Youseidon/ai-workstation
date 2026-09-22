import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { respondAndContinue, saveHumanResponse } from "../src/humanInput.ts";
import { setPipelineStationStarter } from "../src/pipelineScheduler.ts";
import { coolingFor, resetProviderHealth } from "../src/providerHealth.ts";
import { workspaces } from "../src/workspaces.ts";

function fixture() {
  // A station start that fails now marks its provider cooling, and that store
  // is process-global. Without this, one test's failed start makes the next
  // test's station unstartable for no reason of its own.
  resetProviderHealth();
  const dir = mkdtempSync(join(tmpdir(), "human-input-"));
  const workspace = workspaces.create({ name: dir, workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: "Task", content: "Use an owner-supplied list" }) as PromptRecord;
  const runId = `run-${workspace.id}`;
  workspaces.beginAgentRun({ runId, workspaceId: workspace.id, promptId: prompt.id, provider: "claude", model: null, tokenHash: runId, expiresAt: new Date(Date.now() + 60000).toISOString(), role: "execute" });
  // Upstream's end-of-run ladder records UNREPORTED, not BLOCKED, when a run ends
  // without posting a status, so the block this test needs is posted explicitly.
  workspaces.updateAgentStatus(runId, {
    requestId: `blocked-${runId}`, expectedStatus: "IN_PROGRESS", status: "BLOCKED",
    reason: "The owner must supply the trade directory.",
    verificationSummary: "Supply the owner's trade directory.",
  });
  workspaces.finishAgentRun(runId, "done");
  workspaces.respondToBlockedPrompt(prompt.id, { content: "Octoport, seafood trade" });
  const handoff = workspaces.createHandoff({ id: `handoff-${workspace.id}`, workspaceId: workspace.id, promptId: prompt.id, sourceRunId: runId, provider: "claude", model: null });
  // This handoff follows the earlier response; use deterministic timestamps.
  workspaces.updateHandoff(handoff.id, { state: "READY", recommendation: "WAIT_FOR_HUMAN", completedAt: new Date(Date.now() + 1000).toISOString() });
  return { workspace, suite, prompt, handoff, cleanup() { workspaces.remove(workspace.id); rmSync(dir, { recursive: true, force: true }); } };
}

test("a TODO task with an unanswered handoff stays in attention and accepts a follow-up", async () => {
  const f = fixture();
  try {
    const item = workspaces.promptActivity(f.prompt.id).item;
    assert.equal(item.prompt.status, "TODO");
    assert.equal(item.prompt.ready, false);
    assert.equal(item.operationalState, "AWAITING_RESPONSE");
    assert.equal(item.attention, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    // Keep the handoff newer than the old answer, but older than this answer.
    workspaces.updateHandoff(f.handoff.id, { completedAt: new Date().toISOString() });
    const response = workspaces.respondToBlockedPrompt(f.prompt.id, { content: "Use the supplied trade directory" });
    assert.equal(response.kind, "HUMAN_RESPONSE");
    assert.equal(workspaces.pendingHumanQuestion(f.prompt.id), null);
    assert.equal(workspaces.promptActivity(f.prompt.id).item.operationalState, "READY");
    assert.equal(workspaces.resolvePrompt(f.workspace.id, f.prompt.id).ready, true);
    const history = workspaces.promptActivity(f.prompt.id);
    assert.equal(history.events[0]?.previousStatus, "TODO");
  } finally { f.cleanup(); }
});


/**
 * A suite pipeline run parked on the fixture's work item, waiting for a human.
 *
 * Upstream's flowchart steps hang off a named pipeline rather than the suite,
 * so a suite run with no named parent resolves no steps and completes on its
 * first advance instead of starting a station. Every parked run below is
 * therefore parented and stepped, the way a played one is.
 */
function parked(f: ReturnType<typeof fixture>, label: string) {
  const pipeline = workspaces.createPipeline({ workspaceId: f.workspace.id, name: `Pipeline ${label}`, suiteIds: [f.suite.id] });
  workspaces.addNamedPipelineStep(pipeline.id, f.prompt.id, { provider: "claude" });
  const named = workspaces.createNamedPipelineRun({ id: `${label}-named-${f.workspace.id}`, pipelineId: pipeline.id, workspaceId: f.workspace.id, playProvider: "claude", playModel: null });
  const suite = workspaces.createPipelineRun({ id: `${label}-${f.workspace.id}`, suiteId: f.suite.id, workspaceId: f.workspace.id, playProvider: "claude", playModel: null, pipelineRunId: named.id });
  workspaces.updatePipelineRun(suite.id, { state: "WAITING_HUMAN", currentPromptId: f.prompt.id });
  workspaces.updateNamedPipelineRun(named.id, { state: "WAITING_HUMAN", currentSuiteId: f.suite.id, currentSuiteRunId: suite.id });
  return { pipeline, named, suite };
}

for (const restarted of [false, true]) test(`answers resume their owning named pipeline${restarted ? " after a server restart" : ""} without duplicate execution`, async () => {
  const f = fixture();
  let starts = 0;
  try {
    const { pipeline, named, suite } = parked(f, "named");
    if (restarted) {
      workspaces.updatePipelineRun(suite.id, { state: "INTERRUPTED", stopReason: "server_restart", endedAt: new Date().toISOString() });
      workspaces.updateNamedPipelineRun(named.id, { state: "INTERRUPTED", stopReason: "server_restart", endedAt: new Date().toISOString() });
    }
    setPipelineStationStarter(async args => {
      starts++;
      assert.equal(workspaces.pipelineById(args.pipelineRunId!)?.suiteId, f.suite.id);
      assert.equal(args.provider, "claude", "preserve the pipeline's assigned agent");
      const runId = `successor-${f.workspace.id}`;
      workspaces.beginAgentRun({ runId, workspaceId: f.workspace.id, promptId: f.prompt.id, provider: args.provider, model: null, tokenHash: runId, expiresAt: new Date(Date.now() + 60000).toISOString(), role: "execute" });
      return { runId };
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    workspaces.updateHandoff(f.handoff.id, { completedAt: new Date().toISOString() });
    const result = await respondAndContinue(f.prompt.id, { content: "Use directory.example", provider: "codex" });
    assert.equal(result.started, true, result.error);
    assert.equal(workspaces.activeNamedPipelineRun(pipeline.id)?.state, "PLAYING");
    const replay = await respondAndContinue(f.prompt.id, { responseId: result.responseId, provider: "codex" });
    assert.equal(replay.runId, result.runId);
    assert.equal(starts, 1);
  } finally { setPipelineStationStarter(null); f.cleanup(); }
});

test("failed continuation preserves the answer and retries without another human response", async () => {
  const f = fixture();
  try {
    parked(f, "suite");
    setPipelineStationStarter(async () => { throw new Error("Agent unavailable"); });
    await new Promise(resolve => setTimeout(resolve, 5));
    workspaces.updateHandoff(f.handoff.id, { completedAt: new Date().toISOString() });
    const result = await respondAndContinue(f.prompt.id, { content: "Use directory.example", provider: "claude" });
    // A station that cannot start no longer fails the resume: upstream parks the
    // pipeline on `no_provider_available` so it can start itself once a provider
    // is free again, rather than discarding an answer that was already applied
    // and making the person press Resume a second time. The question this test
    // asks is unchanged - the answer survives and the retry needs no new one -
    // and the failure is still recorded rather than swallowed.
    assert.equal(result.started, true, result.error);
    const parkedRun = workspaces.activePipeline(f.suite.id);
    assert.equal(parkedRun?.state, "WAITING_HUMAN");
    assert.equal(parkedRun?.waitReason, "no_provider_available");
    assert.equal(parkedRun?.currentRunId, null);
    assert.notEqual(coolingFor("claude"), null, "the failed start is recorded against the provider");
    const count = workspaces.promptActivity(f.prompt.id).remarks.length;
    // The retry is what the title is about, so it is checked by what the station
    // did rather than by the reported flag, which is now true either way.
    let retries = 0;
    resetProviderHealth();
    setPipelineStationStarter(async () => { retries++; return { runId: "retry-successor" }; });
    const retry = await respondAndContinue(f.prompt.id, { responseId: result.responseId, provider: "claude" });
    assert.equal(retry.started, true, retry.error);
    assert.equal(retries, 1, "the station started on the retry, with no new human response");
    assert.equal(workspaces.activePipeline(f.suite.id)?.currentRunId, "retry-successor");
    assert.equal(workspaces.promptActivity(f.prompt.id).remarks.length, count);
    await assert.rejects(respondAndContinue(f.prompt.id, { responseId: -1, provider: "claude" }), /no longer current/);
  } finally { setPipelineStationStarter(null); f.cleanup(); }
});

async function currentQuestion(f: ReturnType<typeof fixture>) {
  await new Promise(resolve => setTimeout(resolve, 5));
  workspaces.updateHandoff(f.handoff.id, { completedAt: new Date().toISOString() });
  return workspaces.humanInputState(f.prompt.id).revision;
}

test("save-only needs no provider and durably blocks task starts until explicit resume", async () => {
  const f = fixture();
  let starts = 0;
  try {
    const { suite } = parked(f, "saved");
    const expectedRevision = await currentQuestion(f);
    const saved = await saveHumanResponse(f.prompt.id, { content: "Use the approved directory", expectedRevision });
    assert.equal(saved.started, false);
    assert.equal(saved.runId, null);
    const activity = workspaces.promptActivity(f.prompt.id);
    assert.equal(activity.humanInput.savedResponseId, saved.responseId);
    assert.equal(activity.remarks.find(entry => entry.id === saved.responseId)?.source, "local");
    assert.equal(activity.item.prompt.humanResponseHeld, true);
    assert.equal(activity.item.prompt.ready, false);
    assert.equal(activity.item.operationalState, "AWAITING_RESPONSE");
    assert.equal(workspaces.pipelineById(suite.id)?.state, "WAITING_HUMAN");
    assert.throws(() => workspaces.beginAgentRun({ runId: "automatic-start", workspaceId: f.workspace.id, promptId: f.prompt.id, provider: "claude", model: null, tokenHash: "test", expiresAt: new Date().toISOString() }), /Resume with saved answer/);
    setPipelineStationStarter(async () => {
      starts++;
      const runId = `resumed-${f.workspace.id}`;
      workspaces.beginAgentRun({ runId, workspaceId: f.workspace.id, promptId: f.prompt.id, provider: "claude", model: null, tokenHash: "test", expiresAt: new Date().toISOString() });
      return { runId };
    });
    const resumed = await respondAndContinue(f.prompt.id, { responseId: saved.responseId, expectedRevision: saved.revision, provider: "claude" });
    assert.equal(resumed.started, true, resumed.error);
    assert.equal(starts, 1);
    assert.equal(workspaces.humanInputState(f.prompt.id).savedResponseId, null);
    const replay = await respondAndContinue(f.prompt.id, { responseId: saved.responseId, provider: "claude" });
    assert.equal(replay.runId, resumed.runId);
    assert.equal(starts, 1);
  } finally { setPipelineStationStarter(null); f.cleanup(); }
});

test("failed resume parks the station rather than the answer, and allows a later explicit retry", async () => {
  const f = fixture();
  let retries = 0;
  try {
    parked(f, "held");
    const saved = await saveHumanResponse(f.prompt.id, { content: "Approved", expectedRevision: await currentQuestion(f) });
    setPipelineStationStarter(async () => { throw new Error("No allowance available"); });
    const failed = await respondAndContinue(f.prompt.id, { responseId: saved.responseId, expectedRevision: saved.revision, provider: "claude" });
    // The saved answer is no longer re-held on a failed start, because upstream's
    // start no longer fails: a provider with no allowance is a transient capacity
    // fact, so the pipeline parks on `no_provider_available` and can start itself
    // when one frees up, instead of putting an applied answer back in the
    // person's hands for a problem that was never theirs. The recoverable state
    // is still asserted, on the pipeline rather than on the answer.
    assert.equal(failed.started, true, failed.error);
    const held = workspaces.activePipeline(f.suite.id);
    assert.equal(held?.state, "WAITING_HUMAN");
    assert.equal(held?.waitReason, "no_provider_available");
    assert.equal(held?.currentRunId, null);
    assert.notEqual(coolingFor("claude"), null, "the failed start is recorded against the provider");
    assert.equal(workspaces.promptOutcome(f.prompt.id).status, "TODO", "the answer stays applied");
    resetProviderHealth();
    setPipelineStationStarter(async () => { retries++; return { runId: "available-now" }; });
    // The answer was applied, so the revision moved on with it; the retry carries
    // the current one, as any surface offering Resume would.
    const retried = await respondAndContinue(f.prompt.id, { responseId: saved.responseId, expectedRevision: workspaces.humanInputState(f.prompt.id).revision, provider: "claude" });
    assert.equal(retried.started, true, retried.error);
    assert.equal(retries, 1, "the explicit retry starts the station with no new human response");
    assert.equal(workspaces.activePipeline(f.suite.id)?.currentRunId, "available-now");
  } finally { setPipelineStationStarter(null); f.cleanup(); }
});

test("a fresh answer whose resume fails stays current and can be resumed later", async () => {
  const f = fixture();
  let retries = 0;
  try {
    parked(f, "fresh");
    setPipelineStationStarter(async () => { throw new Error("Provider claude is disabled"); });
    const failed = await respondAndContinue(f.prompt.id, { content: "Ship it", expectedRevision: await currentQuestion(f), provider: "claude" });
    // Same change as the test above: a station that cannot start parks the
    // pipeline instead of failing the answer, so the answer is applied and the
    // item is TODO rather than held. What still has to hold is that this exact
    // response remains the current one and resumes the work later.
    assert.equal(failed.started, true, failed.error);
    const activity = workspaces.promptActivity(f.prompt.id);
    assert.equal(activity.humanInput.savedResponseId, null);
    assert.equal(activity.item.prompt.humanResponseHeld, false);
    assert.equal(activity.item.prompt.status, "TODO");
    assert.equal(activity.item.operationalState, "READY");
    assert.equal(workspaces.activePipeline(f.suite.id)?.waitReason, "no_provider_available");
    resetProviderHealth();
    setPipelineStationStarter(async () => { retries++; return { runId: "available-now" }; });
    const retried = await respondAndContinue(f.prompt.id, { responseId: failed.responseId, expectedRevision: workspaces.humanInputState(f.prompt.id).revision, provider: "claude" });
    assert.equal(retried.started, true, retried.error);
    assert.equal(retries, 1, "the same response resumes the work without a new one");
    await assert.rejects(respondAndContinue(f.prompt.id, { responseId: -1, provider: "claude" }), /no longer current/);
  } finally { setPipelineStationStarter(null); f.cleanup(); }
});

for (const change of ["task", "question"] as const) test(`a changed ${change} rejects a stale answer without changing history`, async () => {
  const f = fixture();
  try {
    const expectedRevision = await currentQuestion(f);
    if (change === "task") workspaces.updateChild("prompt", f.prompt.id, { content: "Use a different acceptance criterion" });
    else workspaces.updateHandoff(f.handoff.id, { completedAt: new Date(Date.now() + 1000).toISOString() });
    const count = workspaces.promptActivity(f.prompt.id).remarks.length;
    await assert.rejects(saveHumanResponse(f.prompt.id, { content: "Old answer", expectedRevision }), /task or question changed/);
    await assert.rejects(respondAndContinue(f.prompt.id, { content: "Old answer", expectedRevision, provider: "claude" }), /task or question changed/);
    assert.equal(workspaces.promptActivity(f.prompt.id).remarks.length, count);
    assert.equal(workspaces.humanInputState(f.prompt.id).savedResponseId, null);
  } finally { f.cleanup(); }
});

test("two competing answers to one revision save only once", async () => {
  const f = fixture();
  try {
    const expectedRevision = await currentQuestion(f);
    const before = workspaces.promptActivity(f.prompt.id).remarks.length;
    const results = await Promise.allSettled([
      saveHumanResponse(f.prompt.id, { content: "First", expectedRevision }),
      saveHumanResponse(f.prompt.id, { content: "Second", expectedRevision }),
    ]);
    assert.equal(results[0]?.status, "fulfilled");
    assert.equal(results[1]?.status, "rejected");
    assert.equal(workspaces.promptActivity(f.prompt.id).remarks.length, before + 1);
  } finally { f.cleanup(); }
});

test("save rejects missing/invalid revision and empty content without releasing the question", async () => {
  const f = fixture();
  try {
    const expectedRevision = await currentQuestion(f);
    await assert.rejects(saveHumanResponse(f.prompt.id, { content: "Answer" }), /current question/);
    await assert.rejects(saveHumanResponse(f.prompt.id, { content: "Answer", expectedRevision: null }), /valid question revision/);
    await assert.rejects(saveHumanResponse(f.prompt.id, { content: " ", expectedRevision }), /content/);
    assert.equal(workspaces.humanInputState(f.prompt.id).revision, expectedRevision);
    assert.notEqual(workspaces.pendingHumanQuestion(f.prompt.id), null);
  } finally { f.cleanup(); }
});
