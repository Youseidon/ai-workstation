import test from "node:test";
import assert from "node:assert/strict";
import type { OperationsSuite, PipelineDashboardItem, PipelineRecord, PipelineRun, PipelineThroughputDay } from "@hydra/shared";
import { STEP_DISPLAY_STATUSES } from "@hydra/shared";
import { filterDirectory, pageItems, percentage, pipelineEntries, runOutcomes, suiteEntries } from "../../../features/pipeline/lib/dashboard.ts";

function pipeline(id: number, state: PipelineRun["state"] | null = null, suiteIds = [10]): PipelineDashboardItem {
  const run = state === null ? null : { state, currentSuiteId: suiteIds[0] } as PipelineRun;
  return {
    pipeline: {
      id, name: `Pipeline ${id}`, description: "Delivery automation", updatedAt: `2026-11-${String(id).padStart(2, "0")}T00:00:00Z`,
      stages: suiteIds.map((suiteId) => ({ suiteId, suiteName: `Suite ${suiteId}`, suiteKey: `S${suiteId}`, programName: "Website", programKey: "WEB" })),
      active: state === "PLAYING" || state === "PAUSED" || state === "WAITING_HUMAN" ? run : null,
      latest: run,
    } as PipelineRecord,
    completedSteps: 3, totalSteps: 10, attentionCount: 0, lastRunDurationMs: null,
  };
}

function suite(id: number): OperationsSuite {
  return {
    id, name: `Suite ${id}`, key: null, programId: 1, programName: "Website", programKey: "WEB",
    workspaceId: 1, workspaceName: "Workspace", sessions: [],
    counts: Object.fromEntries(STEP_DISPLAY_STATUSES.map((state) => [state, 0])) as OperationsSuite["counts"],
    prompts: [], attentionCount: 0, latestVerification: null, pipeline: null,
  };
}

test("run period includes interrupted outcomes and never reports an empty history as 0%", () => {
  const days: PipelineThroughputDay[] = Array.from({ length: 30 }, (_, i) => ({ date: `2026-11-${i + 1}`, complete: i < 23 ? 2 : 0, stopped: i < 23 ? 0 : 1, total: i < 23 ? 2 : 1 }));
  const week = runOutcomes(days, 7);
  assert.equal(week.total, 7);
  assert.equal(week.rate, 0);
  assert.equal(week.days.length, 7);
  assert.equal(runOutcomes(days, 30).total, 53);
  assert.equal(runOutcomes([], 7).rate, null);
  assert.equal(percentage(0, 0), null);
  assert.equal(percentage(5, 4), 100);
});

test("directory combines search with state filters, keeps attention first and preserves server records", () => {
  const items = [pipeline(1, "COMPLETE"), pipeline(2, "PLAYING"), pipeline(3, "WAITING_HUMAN"), pipeline(4, "INTERRUPTED"), pipeline(5)];
  const entries = pipelineEntries(items);
  assert.deepEqual(filterDirectory(entries, " web ", "running").map((entry) => entry.id), [2]);
  assert.deepEqual(filterDirectory(entries, "", "attention").map((entry) => entry.id), [4, 3]);
  assert.deepEqual(filterDirectory(entries, "", "all").map((entry) => entry.id), [4, 3, 2, 5, 1]);
  assert.equal(filterDirectory(entries, "missing", "all").length, 0);
  assert.deepEqual(items.map((item) => item.pipeline.id), [1, 2, 3, 4, 5]);
  assert.equal(entries[1]?.href, "/pipeline/2");
  assert.equal(entries[4]?.status.label, "Not started");
});

test("suite links prefer the pipeline currently running that suite and retain standalone access", () => {
  const paused = pipeline(1, "PAUSED");
  const runningElsewhere = pipeline(2, "PLAYING", [20, 10]);
  const runningHere = pipeline(3, "PLAYING");
  const rows = suiteEntries([suite(10), suite(99)], [paused, runningElsewhere, runningHere]);
  assert.equal(rows[0]?.href, "/pipeline/3?suite=10");
  assert.equal(rows[1]?.href, "/pipeline/suite/99");
  assert.equal(suiteEntries([suite(10)], [paused])[0]?.href, "/pipeline/1?suite=10");
  assert.equal(suiteEntries([suite(10)], [pipeline(5)])[0]?.href, "/pipeline/5?suite=10");
});

test("pagination keeps every record reachable and clamps after a live list shrinks", () => {
  const records = Array.from({ length: 12 }, (_, i) => i);
  const first = pageItems(records, 0, 5);
  const middle = pageItems(records, 1, 5);
  const last = pageItems(records, 2, 5);
  assert.deepEqual([...first.items, ...middle.items, ...last.items], records);
  assert.equal(last.pages, 3);
  assert.deepEqual(pageItems(records.slice(0, 2), 2, 5), { items: [0, 1], page: 0, pages: 1 });
  assert.deepEqual(pageItems([], 8, 5), { items: [], page: 0, pages: 1 });
});

test("suite verification problems stay visible in the attention filter without a blocked station", () => {
  const target = suite(10);
  target.latestVerification = { id: 1, kind: "AUDIT", state: "RECORDED", verdict: "WARNING", startedAt: "2026-11-26T00:00:00Z", endedAt: "2026-11-26T00:00:00Z" };
  const warnings = filterDirectory(suiteEntries([target], []), "", "attention");
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0]?.status, { label: "Check warnings", tone: "warning" });
  target.latestVerification = { ...target.latestVerification, state: "ERROR", verdict: null };
  assert.equal(filterDirectory(suiteEntries([target], []), "", "attention")[0]?.status.label, "Check error");
  target.latestVerification = { ...target.latestVerification, state: "DONE", verdict: "PASS" };
  assert.equal(filterDirectory(suiteEntries([target], []), "", "attention").length, 0);
});
