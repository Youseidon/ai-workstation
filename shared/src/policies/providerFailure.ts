/**
 * How a provider run failed, as a table rather than an `if` chain.
 *
 * A capacity / quota / auth / network failure says nothing about the work. The
 * scheduler swaps to the next provider on the station's fallback list instead
 * of spending a continuation or parking. Rows are enumerated by a test with
 * real error strings from live history, and rendered in the Rules panel.
 */

import type { ProviderUsage, ProviderUsageWindow } from "../contracts/providers.ts";

export type FailureClass = "transient_provider" | "crash" | "unknown";

/** Only reported, exhausted windows block a start. Unknown usage stays usable. */
export function exhaustedUsageWindow(usage: ProviderUsage, now = Date.now()): ProviderUsageWindow | null {
  if (!usage.available) return null;
  const exhausted = usage.windows.filter((window) => window.usedPercent !== null && window.usedPercent >= 100
    && (window.resetsAt === null || !Number.isFinite(Date.parse(window.resetsAt)) || Date.parse(window.resetsAt) > now));
  // All exhausted windows must reset before the account can be used again.
  const resetAt = (window: ProviderUsageWindow): number => {
    const parsed = window.resetsAt === null ? NaN : Date.parse(window.resetsAt);
    return Number.isFinite(parsed) ? parsed : Infinity;
  };
  return exhausted.sort((a, b) => resetAt(b) - resetAt(a))[0] ?? null;
}

/** Conservative retry window when a CLI names the cap but supplies no reset instant. */
export function quotaCoolingMinutes(text: string): number | undefined {
  if (/weekly|seven[ _-]?day|7[ _-]?day/i.test(text)) return 7 * 24 * 60;
  if (/five[ _-]?hour|5[ _-]?(?:hour|hr)|session[ _-]?limit/i.test(text)) return 5 * 60;
  return undefined;
}

export const TRANSIENT_PATTERNS: readonly { id: string; pattern: RegExp; because: string }[] = [
  { id: "capacity", pattern: /at capacity|overloaded|try (a different|another) model/i, because: "The provider reported it is at capacity." },
  // Quota before rate limit: a message that says both gets the longer cooling.
  // Separators are loose on purpose — providers write `usage limit`,
  // `usage_limit_exceeded`, `rate_limit` and `rate-limit` for the same thing.
  { id: "quota", pattern: /quota|usage[ _-]?limit|weekly[ _-]?limit|(?:five|5)[ _-]?(?:hour|hr).*limit|session[ _-]?limit|out of usage|hit your (?:\w+ )?limit|limit reached|credit|payment required|\b402\b|insufficient.*balance/i, because: "The account is out of allowance for now." },
  { id: "rate_limit", pattern: /rate[ _-]?limit|too many requests|\b429\b/i, because: "The provider rate-limited the run." },
  { id: "auth", pattern: /unauthori[sz]ed|\b401\b|not logged in|login required|invalid.*api key/i, because: "The provider rejected the credentials." },
  { id: "network", pattern: /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed/i, because: "The provider could not be reached." },
];

/**
 * How long a provider stays off the fallback list after each failure id.
 * Kept next to the patterns so the Rules panel and `markCooling` share one table.
 */
export const COOLING_MINUTES: Readonly<Record<string, number>> = {
  capacity: 10,
  rate_limit: 10,
  quota: 60,
  auth: 60,
  network: 2,
  start_failed: 5,
  died_before_work: 5,
};

export function coolingMinutesFor(id: string): number {
  return COOLING_MINUTES[id] ?? 5;
}

/**
 * Classify a finished (or never-started) run.
 *
 * Rules, in order: any explicit provider error; a start failure; zero tool
 * calls (the agent never got to the work); otherwise a crash. A crash after
 * real tool use is not transient — that is about the work, not the provider.
 */
export function classifyFailure(args: {
  errorText: string;
  toolCalls: number;
  startFailed: boolean;
}): { class: FailureClass; id: string | null; because: string } {
  const text = args.errorText ?? "";
  for (const row of TRANSIENT_PATTERNS) {
    if (row.pattern.test(text)) {
      return { class: "transient_provider", id: row.id, because: row.because };
    }
  }
  if (args.startFailed) {
    return { class: "transient_provider", id: "start_failed", because: "The agent process failed to start." };
  }
  if (args.toolCalls === 0) {
    return {
      class: "transient_provider",
      id: "died_before_work",
      because: "The agent never made a tool call, so nothing about the work was learned.",
    };
  }
  return {
    class: "crash",
    id: null,
    because: "The agent process failed after it had started work.",
  };
}
