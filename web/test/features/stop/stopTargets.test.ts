import test from "node:test";
import assert from "node:assert/strict";
import type { OperationsSnapshot, PipelineRecord } from "@hydra/shared";
import type { RunStatus } from "@/models/runs";
import { actionSettled, phaseOf, stopTargets } from "../../../features/stop/lib/stopTargets";

const station = { runId: "run-1", provider: "codex", role: "execute", model: null, startedAt: "2026-11-20T00:00:00Z", elapsedMs: 0,
  workspace: { id: 1, name: "Project" }, source: { type: "saved", promptId: 5, promptKey: "P5", title: "Build API", programName: "Platform", suiteName: "Implementation" } } as RunStatus;
const chat = { ...station, runId: "run-chat", source: { type: "custom", displayText: "hi" } } as RunStatus;

function snapshot(state: string, currentRunId: string | null) {
  return { suites: [{ id: 10, workspaceId: 1, workspaceName: "Project", name: "Implementation", programName: "Platform",
    prompts: [{ prompt: { id: 5, externalKey: "P5", title: "Build API" }, children: [] }],
    pipeline: { active: { id: "suite-run", pipelineRunId: "named-run", currentRunId, state, currentPromptId: 5 } } }] } as unknown as OperationsSnapshot;
}
const pipelines = [{ id: 7, name: "Release", active: { id: "named-run" } }] as PipelineRecord[];

test("a pipeline's station agent is listed under the pipeline, not as a loose agent", () => {
  const targets = stopTargets(snapshot("PLAYING", "run-1"), pipelines, [station, chat]);
  assert.equal(targets.pipelines.length, 1);
  const [target] = targets.pipelines;
  assert.equal(target!.pipelineId, 7);
  assert.equal(target!.name, "Release");
  assert.equal(target!.run?.runId, "run-1");
  assert.equal(target!.stepTitle, "P5");
  assert.equal(target!.phase, "running");
  assert.deepEqual(targets.agents.map((run) => run.runId), ["run-chat"]);
});

test("a graceful pause reads as pausing while the agent finishes, then paused", () => {
  assert.equal(stopTargets(snapshot("PAUSED", "run-1"), pipelines, [station]).pipelines[0]!.phase, "pausing");
  assert.equal(stopTargets(snapshot("PAUSED", null), pipelines, []).pipelines[0]!.phase, "paused");
  assert.equal(phaseOf("WAITING_HUMAN", null), "waiting");
  assert.equal(phaseOf("PLAYING", null), "waiting", "between steps nothing is running to stop");
});

test("a suite played on its own has no pipeline id, so only its agent can be stopped here", () => {
  const target = stopTargets(snapshot("PLAYING", "run-1"), [], [station]).pipelines[0]!;
  assert.equal(target.pipelineId, null);
  assert.equal(target.name, "Implementation");
});

test("a stop is settled only once the agent has left the live list", () => {
  const playing = stopTargets(snapshot("PLAYING", "run-1"), pipelines, [station]).pipelines[0]!;
  const paused = stopTargets(snapshot("PAUSED", "run-1"), pipelines, [station]).pipelines[0]!;
  assert.equal(actionSettled("forceStop", { pipeline: paused, runId: "run-1" }, [station]), false);
  assert.equal(actionSettled("forceStop", { pipeline: paused, runId: "run-1" }, []), true);
  assert.equal(actionSettled("stopAgent", { runId: "run-chat" }, [chat]), false);
  assert.equal(actionSettled("pause", { pipeline: playing, runId: "run-1" }, [station]), false);
  assert.equal(actionSettled("pause", { pipeline: paused, runId: "run-1" }, [station]), true, "pause is done when the rail holds, even while the agent finishes");
  assert.equal(actionSettled("stopPipeline", { pipeline: playing, runId: "run-1" }, [station]), false);
  assert.equal(actionSettled("stopPipeline", { runId: "run-1" }, [station]), false, "the pipeline ended but its agent is still exiting");
  assert.equal(actionSettled("stopPipeline", { runId: "run-1" }, []), true);
  assert.equal(actionSettled("resume", { pipeline: paused, runId: null }, []), false);
  assert.equal(actionSettled("resume", { pipeline: playing, runId: null }, []), true);
});
