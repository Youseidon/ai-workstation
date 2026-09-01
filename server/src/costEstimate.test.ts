import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  estimateCost,
  formatUsd,
  mergeUsage,
  usageFromEvents,
  type NormalizedEvent,
  type TokenUsage,
} from "@agent-console/shared";

const sampleUsage: TokenUsage = {
  inputTokens: 1_000_000,
  outputTokens: 500_000,
  cachedInputTokens: 200_000,
  reasoningOutputTokens: 0,
  totalTokens: 1_500_000,
};

describe("estimateCost", () => {
  it("returns null when usage is missing", () => {
    const cost = estimateCost(null, "claude", "claude-sonnet-5");
    assert.equal(cost.usd, null);
    assert.equal(cost.rateSource, "none");
  });

  it("prices uncached + cached input and output at list rates", () => {
    // Sonnet: $3 / $15 / $0.30 cache → (800k*3 + 200k*0.3 + 500k*15) / 1e6
    const cost = estimateCost(sampleUsage, "claude", "claude-sonnet-5");
    assert.equal(cost.rateSource, "model");
    assert.ok(cost.usd !== null);
    assert.ok(Math.abs(cost.usd! - (2.4 + 0.06 + 7.5)) < 1e-9);
  });

  it("falls back to provider defaults for unknown models", () => {
    const cost = estimateCost(sampleUsage, "claude", "mystery-model");
    assert.equal(cost.rateSource, "provider_default");
    assert.ok(cost.usd !== null && cost.usd > 0);
  });
});

describe("formatUsd", () => {
  it("formats tiny amounts", () => {
    assert.equal(formatUsd(0.001), "<$0.01");
    assert.equal(formatUsd(0), "$0");
    assert.equal(formatUsd(12.345), "$12.35");
  });
});

describe("usageFromEvents", () => {
  it("keeps the latest non-zero status/result usage", () => {
    const events = [
      event("status", { inputTokens: 10, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 11 }),
      event("result", { inputTokens: 20, outputTokens: 5, cachedInputTokens: 2, reasoningOutputTokens: 0, totalTokens: 25 }),
    ];
    assert.deepEqual(usageFromEvents(events), {
      inputTokens: 20,
      outputTokens: 5,
      cachedInputTokens: 2,
      reasoningOutputTokens: 0,
      totalTokens: 25,
    });
  });

  it("ignores zeroed terminal events that follow a real count", () => {
    const good: TokenUsage = {
      inputTokens: 17_484_078,
      outputTokens: 124_808,
      cachedInputTokens: 17_100_741,
      reasoningOutputTokens: 0,
      totalTokens: 17_608_886,
    };
    const zero: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    };
    const events = [event("result", good), event("result", zero), event("status", zero)];
    assert.deepEqual(usageFromEvents(events), good);
  });
});

describe("mergeUsage", () => {
  it("prefers meaningful usage over zeros", () => {
    const good = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 110 };
    const zero = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
    assert.deepEqual(mergeUsage(good, zero), good);
    assert.deepEqual(mergeUsage(zero, good), good);
  });
});

function event(type: "status" | "result", usage: TokenUsage): NormalizedEvent {
  if (type === "status") {
    return {
      id: "e",
      runId: "r",
      provider: "claude",
      model: null,
      timestamp: new Date().toISOString(),
      type: "status",
      payload: { state: "running", elapsedMs: 1, usage, detail: null },
    };
  }
  return {
    id: "e",
    runId: "r",
    provider: "claude",
    model: null,
    timestamp: new Date().toISOString(),
    type: "result",
    payload: { state: "done", elapsedMs: 1, usage, text: null, exitCode: 0 },
  };
}
