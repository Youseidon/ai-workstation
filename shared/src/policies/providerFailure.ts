import type { ProviderUsage, ProviderUsageWindow } from "../contracts/providers.ts";

export type FailureClass = "transient_provider" | "crash" | "unknown";

export function exhaustedUsageWindow(usage: ProviderUsage, now = Date.now()): ProviderUsageWindow | null {
  if (!usage.available) return null;
  const exhausted = usage.windows.filter((window) => window.usedPercent !== null && window.usedPercent >= 100
    && (window.resetsAt === null || !Number.isFinite(Date.parse(window.resetsAt)) || Date.parse(window.resetsAt) > now));
  const resetAt = (window: ProviderUsageWindow): number => {
    const parsed = window.resetsAt === null ? NaN : Date.parse(window.resetsAt);
    return Number.isFinite(parsed) ? parsed : Infinity;
  };
  return exhausted.sort((a, b) => resetAt(b) - resetAt(a))[0] ?? null;
}

export function quotaCoolingMinutes(text: string): number | undefined {
  if (/weekly|seven[ _-]?day|7[ _-]?day/i.test(text)) return 7 * 24 * 60;
  if (/five[ _-]?hour|5[ _-]?(?:hour|hr)|session[ _-]?limit/i.test(text)) return 5 * 60;
  return undefined;
}

export const TRANSIENT_PATTERNS: readonly { id: string; pattern: RegExp; because: string }[] = [
  { id: "capacity", pattern: /at capacity|overloaded|try (a different|another) model/i, because: "The provider reported it is at capacity." },
  { id: "quota", pattern: /quota|usage[ _-]?limit|weekly[ _-]?limit|(?:five|5)[ _-]?(?:hour|hr).*limit|session[ _-]?limit|out of usage|hit your (?:\w+ )?limit|limit reached|credit|payment required|\b402\b|insufficient.*balance/i, because: "The account is out of allowance for now." },
  { id: "rate_limit", pattern: /rate[ _-]?limit|too many requests|\b429\b/i, because: "The provider rate-limited the run." },
  { id: "auth", pattern: /unauthori[sz]ed|\b401\b|not logged in|login required|invalid.*api key/i, because: "The provider rejected the credentials." },
  { id: "network", pattern: /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed/i, because: "The provider could not be reached." },
];

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
