import test from "node:test";
import assert from "node:assert/strict";
import {
  COOLING_MINUTES,
  TRANSIENT_PATTERNS,
  classifyFailure,
  coolingMinutesFor,
} from "../src/providerFailure";

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
