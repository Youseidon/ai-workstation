import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProviderUsage, QuotaWarning } from "@agent-console/shared";
import { groupQuotaWarnings } from "@/lib/providerUsage";
import { UsageBlock } from "./usage";

function usage(usedPercent: number | null = 40): ProviderUsage {
  return {
    provider: "claude",
    available: true,
    reason: null,
    plan: "fake",
    fetchedAt: "2026-09-13T09:00:00.000Z",
    windows: [{ kind: "session", durationMinutes: 300, usedPercent, resetsAt: "2026-09-13T10:00:00.000Z" }],
    credits: null,
  };
}

function warning(overrides: Partial<QuotaWarning> = {}): QuotaWarning {
  return {
    id: "quota_claude_session_one",
    provider: "claude",
    windowKind: "session",
    windowIdentity: "claude:session:2026-09-13T10:00:00.000Z",
    remainingPercent: 5,
    usedPercent: 95,
    fetchedAt: "2026-09-13T09:00:00.000Z",
    freshness: "fresh",
    message: "claude session quota is at 5.0% remaining.",
    choices: [
      { id: "continue", label: "Continue" },
      { id: "prepare_pause", label: "Prepare to pause" },
      { id: "review_takeover", label: "Review takeover" },
    ],
    ...overrides,
  };
}

function render(props: Partial<React.ComponentProps<typeof UsageBlock>> = {}) {
  return renderToStaticMarkup(
    <UsageBlock usage={usage()} warnings={[]} loading={false} available={true} {...props} />,
  );
}

test("healthy quota shows no warning", () => {
  const html = render();
  assert.equal(html.includes('data-testid="quota-warning"'), false);
  assert.match(html, /40%/);
});

test("fresh five-percent warning renders advisory choices as display-only text", () => {
  const html = render({ usage: usage(95), warnings: [warning()] });
  assert.match(html, /data-testid="quota-warning"/);
  assert.match(html, /5\.0% remaining/);
  assert.match(html, /Choices: Continue/);
  assert.equal(/<(button|a|input|select)\b/i.test(html), false);
  assert.equal(/pause|switch provider|spend|delegate|take over|stop|start/i.test(html.replace("Prepare to pause", "").replace("Review takeover", "")), false);
});

test("stale, unavailable, and missing usage surfaces do not warn", () => {
  assert.equal(render({ usage: null, warnings: [warning()] }).includes('data-testid="quota-warning"'), false);
  assert.equal(render({ usage: { ...usage(95), available: false }, warnings: [warning()] }).includes('data-testid="quota-warning"'), false);
  assert.equal(render({ usage: { ...usage(null), windows: [], credits: null }, warnings: [warning()] }).includes('data-testid="quota-warning"'), false);
});

test("repeated same provider window reset identity dedupes before display", () => {
  const first = warning({ id: "first" });
  const duplicate = warning({ id: "second" });
  const nextReset = warning({
    id: "third",
    windowIdentity: "claude:session:2026-09-13T15:00:00.000Z",
  });
  const grouped = groupQuotaWarnings([first, duplicate, nextReset]);
  assert.deepEqual(grouped.claude?.map(item => item.id), ["first", "third"]);
});

test("warning markup is constrained for narrow and wide layouts", () => {
  const html = render({ usage: usage(95), warnings: [warning({ message: "x".repeat(220) })] });
  assert.match(html, /min-w-0/);
  assert.match(html, /break-words/);
  for (const viewport of [390, 1280]) {
    assert(viewport > 0);
    assert.equal(html.includes("overflow-x"), false);
  }
});
