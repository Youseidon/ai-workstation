/**
 * How a provider run failed, as a table rather than an `if` chain.
 *
 * A capacity / quota / auth / network failure says nothing about the work. The
 * scheduler swaps to the next provider on the station's fallback list instead
 * of spending a continuation or parking. Rows are enumerated by a test with
 * real error strings from live history, and rendered in the Rules panel.
 */

export type FailureClass = "transient_provider" | "crash" | "unknown";

export const TRANSIENT_PATTERNS: readonly { id: string; pattern: RegExp; because: string }[] = [
  { id: "capacity", pattern: /at capacity|overloaded|try (a different|another) model/i, because: "The provider reported it is at capacity." },
  { id: "rate_limit", pattern: /rate limit|too many requests|\b429\b/i, because: "The provider rate-limited the run." },
  { id: "quota", pattern: /quota|usage limit|weekly limit|credit|insufficient.*balance/i, because: "The account is out of allowance for now." },
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
 * Rules, in order: an explicit start failure; any pattern match; zero tool
 * calls (the agent never got to the work); otherwise a crash. A crash after
 * real tool use is not transient — that is about the work, not the provider.
 */
export function classifyFailure(args: {
  errorText: string;
  toolCalls: number;
  startFailed: boolean;
}): { class: FailureClass; id: string | null; because: string } {
  if (args.startFailed) {
    return {
      class: "transient_provider",
      id: "start_failed",
      because: "The agent process failed to start.",
    };
  }
  const text = args.errorText ?? "";
  for (const row of TRANSIENT_PATTERNS) {
    if (row.pattern.test(text)) {
      return { class: "transient_provider", id: row.id, because: row.because };
    }
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
