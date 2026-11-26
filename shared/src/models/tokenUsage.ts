import type { NormalizedEvent } from "../contracts/events.ts";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
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

export function isMeaningfulUsage(usage: TokenUsage | null | undefined): usage is TokenUsage {
  return usage !== null && usage !== undefined && usage.totalTokens > 0;
}

export function mergeUsage(current: TokenUsage | null, next: TokenUsage | null): TokenUsage | null {
  if (!isMeaningfulUsage(next)) return current;
  if (!isMeaningfulUsage(current)) return next;
  return next.totalTokens >= current.totalTokens ? next : current;
}

export function usageFromEvents(events: readonly NormalizedEvent[]): TokenUsage | null {
  let usage: TokenUsage | null = null;
  for (const event of events) {
    if ((event.type === "status" || event.type === "result") && event.payload.usage !== null) {
      usage = mergeUsage(usage, event.payload.usage);
    }
  }
  return usage;
}
