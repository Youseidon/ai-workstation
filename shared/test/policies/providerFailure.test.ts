import test from "node:test";
import assert from "node:assert/strict";
import {
  COOLING_MINUTES,
  TRANSIENT_PATTERNS,
  classifyFailure,
  coolingMinutesFor,
  exhaustedUsageWindow,
  quotaCoolingMinutes,
} from "../../src/policies/providerFailure";

/**
 * Real strings taken from live history (and close cousins). The two quoted in
 * the redesign plan must stay: Codex capacity, Claude weekly-limit exit.
 */
const CASES: Array<{
  id: string;
  errorText: string;
  toolCalls: number;
  startFailed?: boolean;
  expectClass: "transient_provider" | "crash";
  expectId: string | null;
}> = [
  {
    id: "capacity",
    errorText: "Selected model is at capacity. Please try a different model.",
    toolCalls: 0,
    expectClass: "transient_provider",
    expectId: "capacity",
  },
  {
    id: "capacity-overloaded",
    errorText: "The model is overloaded. Please try another model.",
    toolCalls: 0,
    expectClass: "transient_provider",
    expectId: "capacity",
  },
  {
    id: "quota",
    errorText: "You've hit your weekly limit. process exited with code 1",
    toolCalls: 0,
    expectClass: "transient_provider",
    expectId: "quota",
  },
  // The four below are verbatim from one afternoon in which every provider ran
  // out in turn. Three of them matched nothing, so the run was read as a crash
  // about the work and continued on the provider that had just refused it.
  {
    id: "quota-codex",
    errorText: "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 5:22 PM.",
    toolCalls: 29,
    expectClass: "transient_provider",
    expectId: "quota",
  },
  {
    id: "quota-kilo",
    errorText: "Payment Required: {\"error\":{\"title\":\"Paid Model - Credits Required\",\"message\":\"Add credits to continue, or switch to a free model\",\"balance\":-0.054359},\"error_type\":\"usage_limit_exceeded\"}",
    toolCalls: 154,
    expectClass: "transient_provider",
    expectId: "quota",
  },
  {
    id: "quota-cursor",
    errorText: "cursor-agent exited unexpectedly (code 1)\nActionRequiredError: Increase limits for faster responses You're out of usage. Switch to Auto, or ask your admin to increase your limit to continue.",
    toolCalls: 12,
    expectClass: "transient_provider",
    expectId: "quota",
  },
  {
    id: "rate_limit-claude",
    errorText: "Claude Code run failed\nError: Claude Code process exited with code 1\nClaude reported: rate_limit",
    toolCalls: 60,
    expectClass: "transient_provider",
    expectId: "rate_limit",
  },
  {
    id: "rate_limit",
    errorText: "Error 429: rate limit exceeded — too many requests",
    toolCalls: 0,
    expectClass: "transient_provider",
    expectId: "rate_limit",
  },
  {
    id: "auth",
    errorText: "unauthorized: not logged in — login required",
    toolCalls: 0,
    expectClass: "transient_provider",
    expectId: "auth",
  },
  {
    id: "network",
    errorText: "fetch failed: ECONNRESET socket hang up",
    toolCalls: 0,
    expectClass: "transient_provider",
    expectId: "network",
  },
  {
    id: "start_failed",
    errorText: "spawn EACCES",
    toolCalls: 0,
    startFailed: true,
    expectClass: "transient_provider",
    expectId: "start_failed",
  },
  {
    id: "died_before_work",
    errorText: "process exited with code 1",
    toolCalls: 0,
    expectClass: "transient_provider",
    expectId: "died_before_work",
  },
  {
    id: "crash-after-work",
    errorText: "Segmentation fault",
    toolCalls: 40,
    expectClass: "crash",
    expectId: null,
  },
];

test("reported caps block until the last exhausted window resets; unknown usage stays eligible", () => {
  const now = Date.parse("2026-11-19T00:00:00Z");
  const session = { kind: "session" as const, durationMinutes: 300, usedPercent: 100, resetsAt: "2026-11-19T05:00:00Z" };
  const weekly = { kind: "weekly" as const, durationMinutes: 10080, usedPercent: 100, resetsAt: "2026-11-23T00:00:00Z" };
  const usage = { provider: "claude" as const, available: true, reason: null, plan: null, fetchedAt: "2026-11-19T00:00:00Z", windows: [session, weekly], credits: null };
  assert.deepEqual(exhaustedUsageWindow(usage, now), weekly);
  assert.deepEqual(exhaustedUsageWindow({ ...usage, windows: [session] }, now), session);
  assert.equal(exhaustedUsageWindow(usage, Date.parse("2026-11-24T00:00:00Z")), null);
  assert.equal(exhaustedUsageWindow({ ...usage, available: false }, now), null);
  assert.equal(exhaustedUsageWindow({ ...usage, windows: [{ ...session, usedPercent: 99.9 }, { ...weekly, usedPercent: null }] }, now), null);
  assert.ok(exhaustedUsageWindow({ ...usage, windows: [{ ...weekly, resetsAt: null }] }, now));
});

test("quota errors at startup retain their real class and named window", () => {
  for (const text of ["You've hit your 5-hour limit", "five hour usage limit exceeded", "session_limit reached", "weekly_limit exceeded"]) {
    assert.equal(classifyFailure({ errorText: text, toolCalls: 0, startFailed: true }).id, "quota", text);
    assert.equal(quotaCoolingMinutes(text), text.includes("weekly") ? 10080 : 300);
  }
  assert.equal(quotaCoolingMinutes("usage_limit_exceeded"), undefined);
});

test("classifyFailure enumerates every transient pattern with live error strings", () => {
  const seen = new Set<string>();
  for (const row of CASES) {
    const result = classifyFailure({
      errorText: row.errorText,
      toolCalls: row.toolCalls,
      startFailed: row.startFailed === true,
    });
    assert.equal(result.class, row.expectClass, row.id);
    assert.equal(result.id, row.expectId, row.id);
    if (row.expectId !== null) seen.add(row.expectId);
  }
  for (const pattern of TRANSIENT_PATTERNS) {
    assert.ok(seen.has(pattern.id), `pattern ${pattern.id} has no live-string case`);
  }
  assert.ok(seen.has("start_failed"));
  assert.ok(seen.has("died_before_work"));
});

test("a genuine crash after tool calls is never transient", () => {
  const result = classifyFailure({
    errorText: "Selected model is at capacity. Please try a different model.",
    toolCalls: 40,
    startFailed: false,
  });
  // Pattern still matches — capacity mid-run is still the provider. Confirm the
  // zero-tool-call crash path separately: with no pattern and tool calls, crash.
  assert.equal(result.class, "transient_provider");
  assert.equal(result.id, "capacity");

  const crash = classifyFailure({
    errorText: "boom",
    toolCalls: 40,
    startFailed: false,
  });
  assert.equal(crash.class, "crash");
  assert.equal(crash.id, null);
});

test("cooling minutes cover every pattern id plus start/died", () => {
  for (const row of TRANSIENT_PATTERNS) {
    assert.ok(COOLING_MINUTES[row.id] !== undefined, row.id);
    assert.ok(coolingMinutesFor(row.id) > 0, row.id);
  }
  assert.equal(coolingMinutesFor("start_failed"), 5);
  assert.equal(coolingMinutesFor("died_before_work"), 5);
});
