import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { respondAndContinue, saveHumanResponse } from "./humanInput.ts";
import { setPipelineStationStarter } from "./pipelineScheduler.ts";
import { workspaces } from "./workspaces.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "human-input-"));
  const workspace = workspaces.create({ name: dir, workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: "Task", content: "Use an owner-supplied list" }) as PromptRecord;
  const runId = `run-${workspace.id}`;
  workspaces.beginAgentRun({ runId, workspaceId: workspace.id, promptId: prompt.id, provider: "claude", model: null, tokenHash: runId, expiresAt: new Date(Date.now() + 60000).toISOString(), role: "execute" });
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


for (const restarted of [false, true]) test(`answers resume their owning named pipeline${restarted ? " after a server restart" : ""} without duplicate execution`, async () => {
  const f = fixture();
  let starts = 0;
  try {
    workspaces.addPipelineStep(f.prompt.id, { provider: "claude" });
    const pipeline = workspaces.createPipeline({ workspaceId: f.workspace.id, name: "Pipeline", suiteIds: [f.suite.id] });
    const named = workspaces.createNamedPipelineRun({ id: `named-${f.workspace.id}`, pipelineId: pipeline.id, workspaceId: f.workspace.id, playProvider: "claude", playModel: null });
    const suite = workspaces.createPipelineRun({ id: `suite-${f.workspace.id}`, suiteId: f.suite.id, workspaceId: f.workspace.id, playProvider: "claude", playModel: null, pipelineRunId: named.id });
    workspaces.updatePipelineRun(suite.id, { state: "WAITING_HUMAN", currentPromptId: f.prompt.id });
    workspaces.updateNamedPipelineRun(named.id, { state: "WAITING_HUMAN", currentSuiteId: f.suite.id, currentSuiteRunId: suite.id });
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
    workspaces.addPipelineStep(f.prompt.id, { provider: "claude" });
    const suite = workspaces.createPipelineRun({ id: `suite-${f.workspace.id}`, suiteId: f.suite.id, workspaceId: f.workspace.id, playProvider: "claude", playModel: null });
    workspaces.updatePipelineRun(suite.id, { state: "WAITING_HUMAN", currentPromptId: f.prompt.id });
    setPipelineStationStarter(async () => { throw new Error("Agent unavailable"); });
    await new Promise(resolve => setTimeout(resolve, 5));
    workspaces.updateHandoff(f.handoff.id, { completedAt: new Date().toISOString() });
    const result = await respondAndContinue(f.prompt.id, { content: "Use directory.example", provider: "claude" });
    assert.equal(result.started, false);
    assert.match(result.error!, /Agent unavailable/);
    const count = workspaces.promptActivity(f.prompt.id).remarks.length;
    setPipelineStationStarter(async () => ({ runId: "retry-successor" }));
    const retry = await respondAndContinue(f.prompt.id, { responseId: result.responseId, provider: "claude" });
    assert.equal(retry.started, true, retry.error);
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
    workspaces.addPipelineStep(f.prompt.id, { provider: "claude" });
    const suite = workspaces.createPipelineRun({ id: `saved-${f.workspace.id}`, suiteId: f.suite.id, workspaceId: f.workspace.id, playProvider: "claude", playModel: null });
    workspaces.updatePipelineRun(suite.id, { state: "WAITING_HUMAN", currentPromptId: f.prompt.id });
    const expectedRevision = await currentQuestion(f);
    const saved = await saveHumanResponse(f.prompt.id, { content: "Use the approved directory", expectedRevision });
    assert.equal(saved.started, false);
    assert.equal(saved.runId, null);
    const activity = workspaces.promptActivity(f.prompt.id);
    assert.equal(activity.humanInput.savedResponseId, saved.responseId);
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

test("failed resume keeps the saved-answer hold and allows a later explicit retry", async () => {
  const f = fixture();
  try {
    workspaces.addPipelineStep(f.prompt.id, { provider: "claude" });
    const suite = workspaces.createPipelineRun({ id: `held-${f.workspace.id}`, suiteId: f.suite.id, workspaceId: f.workspace.id, playProvider: "claude", playModel: null });
    workspaces.updatePipelineRun(suite.id, { state: "WAITING_HUMAN", currentPromptId: f.prompt.id });
    const saved = await saveHumanResponse(f.prompt.id, { content: "Approved", expectedRevision: await currentQuestion(f) });
    setPipelineStationStarter(async () => { throw new Error("No allowance available"); });
    const failed = await respondAndContinue(f.prompt.id, { responseId: saved.responseId, expectedRevision: saved.revision, provider: "claude" });
    assert.equal(failed.started, false);
    assert.match(failed.error!, /No allowance/);
    assert.equal(workspaces.humanInputState(f.prompt.id).savedResponseId, saved.responseId);
    setPipelineStationStarter(async () => ({ runId: "available-now" }));
    const retried = await respondAndContinue(f.prompt.id, { responseId: saved.responseId, expectedRevision: failed.revision, provider: "claude" });
    assert.equal(retried.started, true, retried.error);
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
