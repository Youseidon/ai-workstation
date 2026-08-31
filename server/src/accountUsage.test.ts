import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyUsageWindow,
  parseClaudeUsage,
  parseCodexRateLimits,
  parseGrokCredits,
} from "./adapters/accountUsage.ts";

test("classifyUsageWindow maps duration to the window the provider reported", () => {
  assert.equal(classifyUsageWindow(15), "session");
  assert.equal(classifyUsageWindow(300), "session");
  assert.equal(classifyUsageWindow(1440), "daily");
  assert.equal(classifyUsageWindow(10080), "weekly");
  assert.equal(classifyUsageWindow(43200), "monthly");
  assert.equal(classifyUsageWindow(null), null);
  assert.equal(classifyUsageWindow(0), null);
});

test("parseClaudeUsage reads the 5-hour session and weekly windows, not invented daily", () => {
  const parsed = parseClaudeUsage({
    five_hour: { utilization: 42, resets_at: "2026-09-01T12:00:00Z" },
    seven_day: { utilization: 0.18, resets_at: "2026-09-07T00:00:00Z" },
    seven_day_opus: { utilization: 9, resets_at: "2026-09-06T00:00:00Z" },
    extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 12.5, currency: "USD" },
  });
  assert.deepEqual(
    parsed.windows.map((window) => window.kind),
    ["session", "weekly"],
  );
  assert.equal(parsed.windows[0]?.usedPercent, 42);
  assert.equal(parsed.windows[1]?.usedPercent, 18);
  assert.equal(parsed.credits?.enabled, true);
  assert.equal(parsed.credits?.used, 12.5);
  assert.equal(parsed.credits?.limit, 100);
});

test("parseClaudeUsage prefers the structured limits array and skips model-scoped weeks", () => {
  const parsed = parseClaudeUsage({
    limits: [
      { kind: "session", percent: 11, resets_at: "2026-09-01T18:00:00Z" },
      { kind: "weekly_all", percent: 27, resets_at: "2026-09-08T00:00:00Z" },
      { kind: "weekly_scoped", percent: 40, resets_at: "2026-09-08T00:00:00Z" },
    ],
  });
  assert.deepEqual(
    parsed.windows.map((window) => window.kind),
    ["session", "weekly"],
  );
  assert.equal(parsed.windows[0]?.usedPercent, 11);
  assert.equal(parsed.windows[1]?.usedPercent, 27);
});

test("parseCodexRateLimits classifies primary/secondary by windowDurationMins", () => {
  const parsed = parseCodexRateLimits({
    rateLimits: {
      planType: "plus",
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1780000000 },
      secondary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 1780600000 },
      credits: { hasCredits: true, unlimited: false, balance: "12.5" },
    },
  });
  assert.equal(parsed.plan, "plus");
  assert.equal(parsed.windows[0]?.kind, "session");
  assert.equal(parsed.windows[0]?.usedPercent, 25);
  assert.equal(parsed.windows[1]?.kind, "weekly");
  assert.equal(parsed.windows[1]?.usedPercent, 8);
  assert.equal(parsed.credits?.balance, 12.5);
});

test("parseCodexRateLimits prefers the codex bucket when several exist", () => {
  const parsed = parseCodexRateLimits({
    rateLimits: {
      primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1780000000 },
    },
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1780000000 },
        secondary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 1780600000 },
      },
    },
  });
  assert.equal(parsed.windows[0]?.usedPercent, 10);
  assert.equal(parsed.windows[1]?.usedPercent, 2);
});

test("parseGrokCredits reads the weekly pool and skips fabricating a daily window", () => {
  const parsed = parseGrokCredits({
    config: {
      creditUsagePercent: 34,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-26T00:00:00Z",
        end: "2026-09-02T00:00:00Z",
      },
      onDemandCap: { val: 5000 },
      onDemandUsed: { val: 300 },
      subscriptionTierDisplay: "SuperGrok Heavy",
    },
  });
  assert.equal(parsed.plan, "SuperGrok Heavy");
  assert.equal(parsed.windows.length, 1);
  assert.equal(parsed.windows[0]?.kind, "weekly");
  assert.equal(parsed.windows[0]?.usedPercent, 34);
  assert.equal(parsed.credits?.limit, 50);
  assert.equal(parsed.credits?.used, 3);
});
