import type { NormalizedEvent } from "../contracts/events.ts";

/* -------------------------------------------------------------------------- */
/* Token usage                                                                 */
/* -------------------------------------------------------------------------- */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  /** inputTokens + outputTokens (cached input is already counted in inputTokens). */
  totalTokens: number;
}

export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

/** True when a usage object carries a non-zero token count. */
export function isMeaningfulUsage(usage: TokenUsage | null | undefined): usage is TokenUsage {
  return usage !== null && usage !== undefined && usage.totalTokens > 0;
}

/**
 * Combine two usage snapshots. Empty/zero payloads never clobber a real count;
 * when both are meaningful, keep the larger total (handles incremental vs final).
 */
export function mergeUsage(current: TokenUsage | null, next: TokenUsage | null): TokenUsage | null {
  if (!isMeaningfulUsage(next)) return current;
  if (!isMeaningfulUsage(current)) return next;
  return next.totalTokens >= current.totalTokens ? next : current;
}

/** Best usage from a run's status/result events (ignores zeroed terminal noise). */
export function usageFromEvents(events: readonly NormalizedEvent[]): TokenUsage | null {
  let usage: TokenUsage | null = null;
  for (const event of events) {
    if ((event.type === "status" || event.type === "result") && event.payload.usage !== null) {
      usage = mergeUsage(usage, event.payload.usage);
    }
  }
  return usage;
}
