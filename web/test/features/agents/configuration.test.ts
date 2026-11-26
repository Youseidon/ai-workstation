import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderInfo, ProviderUsage } from "@hydra/shared";
import {
  sharedSettingsGroups,
  providerAvailability,
  providerInstalled,
  usageState,
} from "../../../features/agents/lib/configuration.ts";

test("the actual directory derivation keeps every dynamic shared group and its name", () => {
  assert.deepEqual(
    sharedSettingsGroups([
      "Model access",
      "General",
      "Run budgets",
      "Codex CLI",
      "Pipeline policy",
      "Retention",
      "Unknown new group",
    ]),
    [
      "General",
      "Run budgets",
      "Pipeline policy",
      "Retention",
      "Unknown new group",
    ],
  );
});
test("enablement, availability and connection state are independent", () => {
  const available = { available: true } as ProviderInfo;
  const unavailable = { available: false } as ProviderInfo;
  assert.equal(providerAvailability(available, true, true), "Available");
  assert.equal(providerAvailability(unavailable, true, true), "Unavailable");
  assert.equal(
    providerAvailability(available, false, true),
    "Not eligible · disabled",
  );
  assert.equal(
    providerAvailability(available, null, true),
    "Checking settings",
  );
  assert.equal(providerAvailability(available, true, false), "Last known");
});
test("usage distinguishes missing, unavailable, failed, loading, zero, stale and quotas", () => {
  const now = Date.parse("2026-11-26T00:00:00Z");
  const usage: ProviderUsage = {
    provider: "codex",
    available: true,
    reason: null,
    plan: "Plus",
    fetchedAt: new Date(now).toISOString(),
    windows: [
      { kind: "weekly", usedPercent: 0, durationMinutes: null, resetsAt: null },
    ],
    credits: null,
  };
  assert.equal(usageState(null, false, null, now).label, "Usage not reported");
  assert.equal(usageState(null, false, "offline", now).label, "Usage failed");
  assert.equal(
    usageState(usage, false, "offline", now).label,
    "Usage stale · refresh failed",
  );
  assert.equal(usageState(null, true, null, now).label, "Loading usage…");
  assert.equal(usageState(usage, true, null, now).label, "Refreshing usage…");
  assert.equal(
    usageState({ ...usage, available: false }, false, null, now).label,
    "Usage unavailable",
  );
  assert.equal(usageState(usage, false, null, now).label, "weekly 0%");
  assert.equal(
    usageState(usage, false, null, now + 301_000).label,
    "Usage stale",
  );
  assert.equal(
    usageState({ ...usage, fetchedAt: null }, false, null, now).label,
    "Usage stale",
  );
  assert.equal(
    usageState(
      { ...usage, windows: [{ ...usage.windows[0], usedPercent: 100 }] },
      false,
      null,
      now,
    ).label,
    "Quota reached",
  );
  assert.equal(
    usageState(
      { ...usage, windows: [{ ...usage.windows[0], usedPercent: null }] },
      false,
      null,
      now,
    ).label,
    "Usage not reported",
  );
  assert.equal(
    usageState(
      {
        ...usage,
        windows: [
          ...usage.windows,
          {
            kind: "session",
            usedPercent: 45,
            durationMinutes: 300,
            resetsAt: null,
          },
        ],
      },
      false,
      null,
      now,
    ).label,
    "2 usage windows",
  );
});

test("installation is independent of authentication, enablement and missing version metadata", () => {
  assert.equal(
    providerInstalled({
      installed: true,
      available: false,
      binary: null,
      version: null,
      transport: "sdk",
    } as ProviderInfo),
    true,
  );
  assert.equal(
    providerInstalled({
      installed: false,
      available: false,
      binary: null,
      version: null,
      transport: "sdk",
    } as ProviderInfo),
    false,
  );
  assert.equal(
    providerInstalled({
      available: false,
      binary: "/fixture/codex",
      version: null,
      transport: "spawn",
    } as ProviderInfo),
    true,
  );
  assert.equal(
    providerInstalled({
      available: false,
      binary: null,
      version: null,
      transport: "spawn",
    } as ProviderInfo),
    false,
  );
});
