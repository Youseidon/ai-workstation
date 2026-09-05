import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { respondAndContinue } from "./humanInput.ts";
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


test("answers resume their owning named pipeline and duplicate submissions do not start another run", async () => {
  const f = fixture();
  let starts = 0;
  try {
    workspaces.addPipelineStep(f.prompt.id, { provider: "claude" });
    const pipeline = workspaces.createPipeline({ workspaceId: f.workspace.id, name: "Pipeline", suiteIds: [f.suite.id] });
    const named = workspaces.createNamedPipelineRun({ id: `named-${f.workspace.id}`, pipelineId: pipeline.id, workspaceId: f.workspace.id, playProvider: "claude", playModel: null });
    const suite = workspaces.createPipelineRun({ id: `suite-${f.workspace.id}`, suiteId: f.suite.id, workspaceId: f.workspace.id, playProvider: "claude", playModel: null, pipelineRunId: named.id });
    workspaces.updatePipelineRun(suite.id, { state: "WAITING_HUMAN", currentPromptId: f.prompt.id });
    workspaces.updateNamedPipelineRun(named.id, { state: "WAITING_HUMAN", currentSuiteId: f.suite.id, currentSuiteRunId: suite.id });
    setPipelineStationStarter(async args => {
      starts++;
      assert.equal(args.pipelineRunId, suite.id);
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
