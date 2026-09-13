import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderUsage, QuotaWarning } from "@agent-console/shared";
import { quotaWarnings } from "./quotaAdvisor.ts";

function usage(usedPercent: number, fetchedAt: string, resetsAt = "2026-09-13T10:00:00.000Z"): ProviderUsage {
  return {
    provider: "claude",
    available: true,
    reason: null,
    plan: "fake",
    fetchedAt,
    windows: [{ kind: "session", durationMinutes: 300, usedPercent, resetsAt }],
    credits: null,
  };
}

test("quota advisor emits one fresh five-percent warning with advisory choices only", () => {
  const now = new Date("2026-09-13T09:00:00.000Z");
  const warnings = quotaWarnings([usage(95, now.toISOString())], [], { now });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.remainingPercent, 5);
  assert.deepEqual(warnings[0]!.choices.map((choice) => choice.id), ["continue", "prepare_pause", "review_takeover"]);
});

test("quota advisor skips stale, unavailable, missing, and above-threshold windows", () => {
  const now = new Date("2026-09-13T09:00:00.000Z");
  assert.equal(quotaWarnings([usage(95, "2026-09-13T08:00:00.000Z")], [], { now }).length, 0);
  assert.equal(quotaWarnings([usage(94.9, now.toISOString())], [], { now }).length, 0);
  assert.equal(quotaWarnings([{ ...usage(95, now.toISOString()), available: false }], [], { now }).length, 0);
  assert.equal(quotaWarnings([{ ...usage(95, now.toISOString()), windows: [{ kind: "session", durationMinutes: 300, usedPercent: null, resetsAt: null }] }], [], { now }).length, 0);
});

test("quota advisor dedupes by provider window identity", () => {
  const now = new Date("2026-09-13T09:00:00.000Z");
  const first = quotaWarnings([usage(96, now.toISOString())], [], { now });
  const second = quotaWarnings([usage(97, now.toISOString())], first as QuotaWarning[], { now });
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  const next = quotaWarnings([usage(97, now.toISOString(), "2026-09-13T15:00:00.000Z")], first, { now });
  assert.equal(next.length, 1);
});
