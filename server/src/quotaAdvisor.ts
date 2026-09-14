import type { ProviderId, ProviderUsage, QuotaWarning, UsageWindowKind } from "@agent-console/shared";
import { harnessSeams } from "./harnessSeams.ts";

export interface QuotaAdvisorOptions {
  thresholdRemainingPercent?: number;
  freshnessMs?: number;
  now?: Date;
}

const DEFAULT_THRESHOLD_REMAINING = 5;
const DEFAULT_FRESHNESS_MS = 10 * 60 * 1000;

function windowIdentity(provider: ProviderId, kind: UsageWindowKind, resetsAt: string | null): string {
  return `${provider}:${kind}:${resetsAt ?? "unreported-reset"}`;
}

function warningId(provider: ProviderId, kind: UsageWindowKind, identity: string): string {
  return `quota_${provider}_${kind}_${Buffer.from(identity).toString("base64url")}`;
}

export function quotaWarnings(
  usage: readonly ProviderUsage[],
  previous: readonly QuotaWarning[] = [],
  options: QuotaAdvisorOptions = {},
): QuotaWarning[] {
  const threshold = options.thresholdRemainingPercent ?? DEFAULT_THRESHOLD_REMAINING;
  const freshnessMs = options.freshnessMs ?? harnessSeams.quotaFreshnessMs ?? DEFAULT_FRESHNESS_MS;
  const now = options.now ?? new Date();
  const seen = new Set(previous.map((warning) => `${warning.provider}:${warning.windowKind}:${warning.windowIdentity}`));
  const warnings: QuotaWarning[] = [];
  for (const provider of usage) {
    if (!provider.available || provider.fetchedAt === null) continue;
    const fetchedMs = Date.parse(provider.fetchedAt);
    if (!Number.isFinite(fetchedMs)) continue;
    const freshness = now.getTime() - fetchedMs <= freshnessMs ? "fresh" : "stale";
    if (freshness !== "fresh") continue;
    for (const window of provider.windows) {
      if (window.usedPercent === null) continue;
      const used = Math.max(0, Math.min(100, window.usedPercent));
      const remaining = 100 - used;
      if (remaining > threshold) continue;
      const identity = windowIdentity(provider.provider, window.kind, window.resetsAt);
      const dedupeKey = `${provider.provider}:${window.kind}:${identity}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      warnings.push({
        id: warningId(provider.provider, window.kind, identity),
        provider: provider.provider,
        windowKind: window.kind,
        windowIdentity: identity,
        remainingPercent: remaining,
        usedPercent: used,
        fetchedAt: provider.fetchedAt,
        freshness,
        message: `${provider.provider} ${window.kind} quota is at ${remaining.toFixed(1)}% remaining.`,
        choices: [
          { id: "continue", label: "Continue" },
          { id: "prepare_pause", label: "Prepare to pause" },
          { id: "review_takeover", label: "Review takeover" },
        ],
      });
    }
  }
  return warnings;
}
