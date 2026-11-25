import test from "node:test";
import assert from "node:assert/strict";
import type { OperationsSnapshot, PipelineFlowchartView, PipelineRecord } from "@agent-console/shared";
import type { RunStatus } from "../../lib/agentConsole";
import { fleetClock, fleetMetadata, runOrigin, waitingElapsed } from "../../lib/fleet";

const run = { runId: "run-1", provider: "codex", role: "execute", model: "actual-model", startedAt: "2026-11-20T00:00:00Z", elapsedMs: 90000,
  workspace: { id: 1, name: "Project" }, source: { type: "saved", promptId: 5, promptKey: "P5", title: "Build API", programName: "Platform", suiteName: "Implementation" } } as RunStatus;
const operations = { suites: [{ id: 10, workspaceId: 1, workspaceName: "Project", name: "Implementation", programName: "Platform", prompts: [{ prompt: { id: 5, title: "Build API" }, children: [], pipelineRule: { provider: "claude", model: null } }],
  pipeline: { active: { id: "suite-run", pipelineRunId: "named-run", currentRunId: "run-1", state: "PLAYING", currentPromptId: 5, playProvider: "codex", playModel: "codex-only" }, defaults: { defaultProvider: "codex", defaultModel: "codex-only" } } }] } as unknown as OperationsSnapshot;
const pipelines = [{ id: 7, name: "Release", active: { id: "named-run" } }] as PipelineRecord[];

test("pipeline ownership follows the exact recorded run, even when suites are reused", () => {
  const result = fleetMetadata(operations, [...pipelines, { id: 8, name: "Other pipeline", active: { id: "other-run" } } as PipelineRecord], [run]);
  assert.equal(result.origins[run.runId].context, "Release / Implementation");
  assert.equal(result.origins[run.runId].href, "/pipeline/7?workspace=1&suite=10");
  assert.deepEqual(fleetMetadata(operations, pipelines, [{ ...run, runId: "unrelated" }]).origins, {});
});

test("a pipeline-owned run names its pipeline, suite and step, with the station for a sub-step", () => {
  const ops = structuredClone(operations) as unknown as { suites: Array<Record<string, unknown> & { prompts: unknown[] }> };
  ops.suites[0].key = "S2";
  ops.suites[0].prompts = [{ prompt: { id: 4, externalKey: "S2-01", title: "Station", parentPromptId: null },
    children: [{ prompt: { id: 5, externalKey: "S2-01.3", title: "Build API", parentPromptId: 4 }, children: [] }] }];
  const place = fleetMetadata(ops as unknown as OperationsSnapshot, pipelines, [run]).origins[run.runId].pipeline;
  assert.deepEqual(place, { name: "Release", suiteKey: "S2", suiteName: "Implementation", stationKey: "S2-01", stepKey: "S2-01.3", stepTitle: "Build API" });
  assert.equal(runOrigin(run).pipeline, undefined, "runs outside a pipeline carry no pipeline place");
});

test("queued tasks retain provider/model ownership and disappear when a live announcement wins the race", () => {
  const queued = structuredClone(operations);
  queued.suites[0].pipeline!.active!.currentRunId = null;
  const chart = { steps: [{ promptId: 5, provider: "claude", model: null }], defaults: { defaultProvider: "codex", defaultModel: "codex-only" }, subSteps: [] } as unknown as PipelineFlowchartView;
  const result = fleetMetadata(queued, pipelines, [], { "suite-run": chart });
  assert.equal(result.queued.length, 1);
  assert.equal(result.queued[0].provider, "claude");
  assert.equal(result.queued[0].model, null, "a Codex default model must not follow a Claude override");
  assert.equal(fleetMetadata(queued, pipelines, []).queued[0].provider, null, "baseline operations rules cannot stand in for scoped assignments");
  assert.equal(fleetMetadata(queued, pipelines, [run]).queued.length, 0);
  queued.suites[0].pipeline!.active!.state = "PAUSED";
  assert.equal(fleetMetadata(queued, pipelines, []).queued.length, 0, "paused work is not waiting to launch");
});

test("custom prompts and consults retain their source identity without metadata", () => {
  assert.equal(runOrigin({ ...run, source: { type: "custom", displayText: "Prompt", title: "My task" } }).title, "My task");
  assert.equal(runOrigin({ ...run, role: "consult", source: { type: "custom", displayText: "Research" } }).kind, "Consult");
  assert.equal(runOrigin(run).kind, "Saved prompt", "suite membership alone must not imply pipeline ownership");
});

test("waiting time uses server elapsed time and remains distinct from total duration", () => {
  const request = { runId: run.runId, requestId: "q", heading: "Question", questions: [], requestedAt: "2026-11-20T00:01:00Z" };
  assert.equal(waitingElapsed(run, request), 30000);
  assert.equal(waitingElapsed({ ...run, clockAt: "2026-11-20T00:01:15Z", startedAt: "2099-01-01T00:00:00Z" }, request), 15000, "server samples ignore client clock skew");
  assert.equal(waitingElapsed(run, { ...request, requestedAt: undefined }), null);
  assert.equal(waitingElapsed({ ...run, elapsedMs: 1000 }, request), 0);
  assert.equal(fleetClock(90000), "01:30");
  assert.equal(fleetClock(3601000), "1:00:01");
});
