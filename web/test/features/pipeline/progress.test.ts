import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_STATUS_CATALOG, defaultPromptPipelineRule, type OperationsPrompt, type OperationsSuite, type PipelineFlowchartView } from "@hydra/shared";
import { enabledPipelineItems, progressLabel, projectSuiteProgress } from "../../../features/pipeline/lib/progress.ts";

const item = (id: number, state: OperationsPrompt["operationalState"], children: OperationsPrompt[] = []): OperationsPrompt => ({
  prompt: { id }, operationalState: state, attention: false, humanIntervention: null, children,
} as OperationsPrompt);
const suite = (prompts: OperationsPrompt[]): OperationsSuite => ({ id: 7, prompts, counts: { DONE: 999 }, attentionCount: 999 } as OperationsSuite);
const flow = (ids: number[], pipelineId = 1): PipelineFlowchartView => ({
  pipelineId, suiteId: 7, steps: ids.map((id) => ({ ...defaultPromptPipelineRule(id), enabled: true })),
} as PipelineFlowchartView);
const project = (ops: OperationsSuite | null, chart: PipelineFlowchartView | null) => projectSuiteProgress(ops, chart, DEFAULT_STATUS_CATALOG);

test("completion uses enabled steps of the named pipeline, ignoring global counts and unrelated prompts", () => {
  const ops = suite([item(1, "DONE"), item(2, "READY"), item(3, "SKIPPED")]);
  assert.deepEqual(project(ops, flow([1, 3])), { known: true, done: 2, total: 2, skipped: 1, attention: 0, complete: true });
  assert.equal(project(ops, flow([1, 2], 2)).complete, false);
  const chart = flow([1, 2]);
  chart.steps[1] = { ...defaultPromptPipelineRule(2), enabled: false };
  assert.equal(project(ops, chart).complete, true);
});

test("reset, execution changes, and refreshed snapshots remove and restore completion without a local toggle", () => {
  const chart = flow([1, 2]);
  const finished = suite([item(1, "DONE"), item(2, "SKIPPED")]);
  assert.equal(project(finished, chart).complete, true);
  for (const state of ["READY", "WORKING", "FAILED", "BLOCKED", "RECOVERY_NEEDED", "WAITING_DEPENDENCY"] as const) {
    const next = suite([item(1, "DONE"), item(2, state)]);
    assert.equal(project(next, chart).complete, false, state);
    assert.equal(project(next, chart).done, 1, state);
  }
  assert.equal(project(structuredClone(finished), structuredClone(chart)).complete, true);
  assert.equal(chart.steps.length, 2, "projection never mutates pipeline membership");
});

test("empty suites, absent flowcharts and partial operations cannot claim successful completion", () => {
  for (const result of [project(suite([]), flow([])), project(null, flow([1])), project(suite([item(1, "DONE")]), null), project(suite([item(1, "DONE")]), flow([1, 2]))]) {
    assert.equal(result.complete, false);
  }
  assert.equal(progressLabel(project(suite([]), flow([]))), "No enabled steps");
  assert.equal(progressLabel(project(null, flow([1]))), "Progress unavailable");
});

test("terminal semantics come from the supplied status catalog; skipped settles but is disclosed", () => {
  const chart = flow([1]);
  assert.equal(project(suite([item(1, "SKIPPED")]), chart).complete, true);
  assert.match(progressLabel(project(suite([item(1, "SKIPPED")]), chart)), /1 skipped/);
  const catalog = DEFAULT_STATUS_CATALOG.map((entry) => entry.id === "READY" ? { ...entry, isTerminal: true } : entry);
  assert.equal(projectSuiteProgress(suite([item(1, "READY")]), chart, catalog).complete, true);
});

test("attention includes enabled descendants and pending approval; unrelated suite work is excluded", () => {
  const blocked = { ...item(4, "BLOCKED"), attention: true };
  const gated = { ...item(5, "DONE"), humanIntervention: { status: "PENDING" } } as OperationsPrompt;
  const unrelated = { ...item(9, "BLOCKED"), attention: true };
  const result = project(suite([item(1, "DONE", [blocked, gated]), unrelated]), flow([1]));
  assert.equal(result.attention, 2);
  assert.equal(result.complete, false);
  assert.equal(project(suite([item(1, "DONE"), unrelated]), flow([1])).complete, true);
});

test("the shared projection preserves execution order, nesting, and membership while filtering suite work", () => {
  const nested = item(5, "READY");
  const first = item(1, "DONE", [nested]);
  const second = item(2, "READY");
  const chart = flow([2, 1]);
  const result = enabledPipelineItems(suite([first, item(9, "BLOCKED"), second]), chart);
  assert.deepEqual(result.map((entry) => entry.prompt.id), [2, 1]);
  assert.equal(result[1]?.children[0], nested);
  assert.deepEqual(chart.steps.map((step) => step.promptId), [2, 1]);
});
