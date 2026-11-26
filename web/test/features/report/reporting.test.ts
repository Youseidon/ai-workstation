import test from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, type SessionUsageRow } from "@hydra/shared";
import { breakdownGroups, buildTimeline, estimateLabel, filterBreakdown, measureSessions, metricValue, percentLabel, providerGroups, ratio, reportCsv, selectSessions, tokensValue } from "../../../features/report/lib/reporting.ts";

function session(id: string, overrides: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    id, workspaceId: 1, workspaceName: "Hydra", promptId: 1, promptKey: "P1", promptTitle: "Build the report",
    suiteId: 1, suiteName: "Reporting", programId: 1, programName: "Console", provider: "codex", model: "test-model", role: "execute", state: "DONE",
    startedAt: "2026-11-26T10:00:00Z", endedAt: "2026-11-26T10:15:00Z",
    usage: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 },
    cost: { usd: 0.25, rates: null, rateSource: "model" }, ...overrides,
  };
}

const SNAPSHOT = "2026-11-26T12:00:00Z";

test("recorded input includes cache and output includes reasoning without counting either twice", () => {
  const measured = measureSessions([session("one"), session("two")]);
  assert.equal(measured.totals.totalTokens, 240);
  assert.equal(measured.totals.inputTokens, 200);
  assert.equal(measured.totals.outputTokens, 40);
  assert.equal(measured.cachedInput, 160);
  assert.equal(measured.totals.reasoningOutputTokens, 10);
  assert.equal(ratio(measured.cachedInput, measured.totals.inputTokens), 80);
});

test("missing usage, unknown pricing and observed zero remain different", () => {
  const missing = session("missing", { usage: null, cost: { usd: null, rates: null, rateSource: "none" } });
  const unknown = session("unknown", { provider: "other", cost: { usd: null, rates: null, rateSource: "none" } });
  const zero = session("zero", { usage: emptyUsage(), cost: { usd: 0, rates: null, rateSource: "provider_default" } });
  assert.equal(tokensValue(measureSessions([missing])), null);
  assert.equal(tokensValue(measureSessions([zero])), 0);
  assert.equal(estimateLabel(measureSessions([missing])), "—");
  assert.equal(estimateLabel(measureSessions([unknown])), "—");
  assert.equal(estimateLabel(measureSessions([zero])), "$0");
  const combined = measureSessions([missing, unknown, zero, session("known")]);
  assert.equal(combined.totals.sessionCount, 4);
  assert.equal(combined.totals.sessionsWithUsage, 3);
  assert.equal(combined.priced, 2);
  assert.equal(combined.modelRates, 1);
  assert.equal(combined.defaultRates, 1);
  assert.equal(combined.unpricedUsage, 1);
  assert.equal(combined.totals.estimatedUsd, 0.25);
  assert.equal(estimateLabel(measureSessions([session("tiny", { cost: { usd: 0.000001, rates: null, rateSource: "model" } })])), "<$0.01");
});

test("calendar windows use UTC start timestamps and the server snapshot, not the browser clock", () => {
  const sessions = [session("old", { startedAt: "2026-11-19T23:59:59Z" }), session("edge", { startedAt: "2026-11-20T00:00:00Z" }), session("offset", { startedAt: "2026-11-20T01:00:00+11:00" }), session("today"), session("future", { startedAt: "2026-11-26T13:00:00Z" }), session("invalid", { startedAt: "not-a-date" })];
  assert.deepEqual(selectSessions(sessions, SNAPSHOT, 7, "all").map((row) => row.id), ["edge", "today"]);
  assert.equal(selectSessions(sessions, SNAPSHOT, "all", "all").length, 6);
  assert.equal(selectSessions(sessions, SNAPSHOT, 7, "claude").length, 0);
  assert.equal(buildTimeline(sessions, SNAPSHOT, "all").undated, 1);
});

test("provider shares compare the same unit and include unknown providers without inventing cost", () => {
  const sessions = [session("a"), session("b", { provider: "claude", cost: { usd: 0.75, rates: null, rateSource: "provider_default" } }), session("c", { provider: "unknown", cost: { usd: null, rates: null, rateSource: "none" } })];
  const total = measureSessions(sessions);
  const groups = providerGroups(sessions);
  const [codex, claude, unknown] = groups;
  assert(codex && claude && unknown);
  assert.equal(total.totals.estimatedUsd, 1);
  assert.equal(ratio(metricValue(codex.measure, "cost") ?? 0, total.totals.estimatedUsd), 25);
  assert.equal(ratio(metricValue(claude.measure, "cost") ?? 0, total.totals.estimatedUsd), 75);
  assert.equal(metricValue(unknown.measure, "cost"), null);
  assert.equal(groups.reduce((sum, group) => sum + group.measure.totals.totalTokens, 0), 360);
  assert.equal(percentLabel(ratio(0, 0)), "—");
  assert.equal(percentLabel(0.01), "<0.1%");
  assert.equal(percentLabel(ratio(1999, 2000)), ">99.9%");
});

test("timeline keeps at most 30 buckets, conserves values and distinguishes unreported days", () => {
  const sessions = [session("a", { startedAt: "2025-01-01T00:00:00Z" }), session("b"), session("missing", { usage: null, cost: { usd: null, rates: null, rateSource: "none" } })];
  const timeline = buildTimeline(sessions, SNAPSHOT, "all");
  assert(timeline.buckets.length <= 30);
  assert(timeline.bucketDays > 1);
  assert.equal(timeline.buckets.reduce((sum, bucket) => sum + bucket.measure.totals.totalTokens, 0), 240);
  assert.equal(timeline.buckets.reduce((sum, bucket) => sum + bucket.measure.totals.sessionCount, 0), 3);
  const missing = sessions[2];
  assert(missing);
  const week = buildTimeline([missing], SNAPSHOT, 7);
  assert.equal(week.buckets.length, 7);
  assert.equal(week.buckets.at(-1)?.measure.totals.sessionsWithoutUsage, 1);
  const last = week.buckets.at(-1);
  assert(last);
  assert.equal(metricValue(last.measure, "tokens"), null);
});

test("breakdowns conserve every session, keep unassigned work reachable and link to real records", () => {
  const sessions = [session("a"), session("b", { promptId: 2, promptKey: "P2" }), session("custom / 1", { promptId: null, suiteId: null, programId: null })];
  for (const view of ["suites", "tasks", "sessions"] as const) {
    const groups = breakdownGroups(sessions, view);
    assert.equal(groups.reduce((sum, group) => sum + group.measure.totals.sessionCount, 0), 3);
    assert.equal(groups.reduce((sum, group) => sum + group.measure.totals.estimatedUsd, 0), 0.75);
  }
  const suites = breakdownGroups(sessions, "suites");
  assert.equal(suites[0]?.href, "/pipeline/suite/1");
  assert.equal(suites[1]?.id, "unassigned");
  assert.equal(breakdownGroups(sessions, "tasks")[1]?.href, "/pipeline/open?prompt=2");
  assert.equal(breakdownGroups(sessions, "sessions")[2]?.href, "/activity?run=custom%20%2F%201");
  assert.equal(filterBreakdown(suites, " REPORTING ", "tokens").length, 1);
});

test("sorting keeps measured zero above missing values and does not mutate source records", () => {
  const groups = breakdownGroups([session("missing", { usage: null, cost: { usd: null, rates: null, rateSource: "none" } }), session("zero", { usage: emptyUsage(), cost: { usd: 0, rates: null, rateSource: "model" } }), session("known")], "sessions");
  assert.deepEqual(filterBreakdown(groups, "", "cost").map((group) => group.id), ["known", "zero", "missing"]);
  assert.deepEqual(groups.map((group) => group.id), ["missing", "zero", "known"]);
});

test("recent sorting compares instants across offsets and keeps invalid timestamps last", () => {
  const groups = breakdownGroups([session("offset", { startedAt: "2026-11-26T11:00:00+11:00" }), session("utc", { startedAt: "2026-11-26T10:00:00Z" }), session("invalid", { startedAt: "bad-date" })], "sessions");
  assert.deepEqual(filterBreakdown(groups, "", "recent").map((group) => group.id), ["utc", "offset", "invalid"]);
});

test("CSV preserves tiny estimates and missing cells, escapes quotes, and neutralizes formulas", () => {
  const csv = reportCsv([session("tiny", { promptTitle: '=HYPERLINK("https://invalid")', cost: { usd: 0.000001, rates: { inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10 }, rateSource: "model" } }), session("missing", { usage: null, model: null, cost: { usd: null, rates: null, rateSource: "none" } }), session("multi", { promptTitle: 'line one\nline "two"' })]);
  assert(csv.includes('"0.000001"'));
  assert(csv.includes('"model","1.25","0.125","10"'));
  assert(csv.includes('"\'=HYPERLINK(""https://invalid"")"'));
  assert(csv.includes('"line one\nline ""two"""'));
  assert(csv.includes('"","","","","","","none"'));
  assert.equal(csv.split("\r\n").length, 4);
});
