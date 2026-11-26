import type { ProviderId, ProviderInfo, ProviderUsage } from "@hydra/shared";

export const PROVIDER_SETTINGS_GROUP: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  cursor: "Cursor CLI",
  grok: "Grok CLI",
  copilot: "GitHub Copilot",
  kilocode: "Kilo Code",
};

export function sharedSettingsGroups(groups: string[]): string[] {
  const providers = new Set(Object.values(PROVIDER_SETTINGS_GROUP));
  return groups.filter(
    (group) => !providers.has(group) && group !== "Model access",
  );
}

// Detection includes enablement and tier eligibility; it does not expose a separate auth flag.
export function providerAvailability(
  info: ProviderInfo,
  enabled: boolean | null,
  connected: boolean,
) {
  if (!connected) return "Last known";
  if (enabled === null) return "Checking settings";
  if (!enabled) return "Not eligible · disabled";
  return info.available ? "Available" : "Unavailable";
}

export function usageState(
  usage: ProviderUsage | null,
  loading: boolean,
  error: string | null,
  now: number,
) {
  if (error !== null)
    return {
      label: usage === null ? "Usage failed" : "Usage stale · refresh failed",
      tone: "warning",
    } as const;
  if (loading)
    return {
      label: usage === null ? "Loading usage…" : "Refreshing usage…",
      tone: "muted",
    } as const;
  if (usage === null)
    return { label: "Usage not reported", tone: "muted" } as const;
  if (!usage.available)
    return { label: "Usage unavailable", tone: "muted" } as const;
  const stamp = usage.fetchedAt === null ? NaN : Date.parse(usage.fetchedAt);
  if (!Number.isFinite(stamp) || now - stamp > 5 * 60_000)
    return { label: "Usage stale", tone: "warning" } as const;
  if (
    usage.windows.some(
      (window) => window.usedPercent !== null && window.usedPercent >= 100,
    )
  )
    return { label: "Quota reached", tone: "warning" } as const;
  // Never merge a session allowance with a billing-cycle or weekly allowance.
  const reported = usage.windows.filter(
    (window) => window.usedPercent !== null,
  );
  if (reported.length === 1) {
    const window = reported[0];
    if (window !== undefined)
      return {
        label: `${window.kind} ${Math.round(window.usedPercent ?? 0)}%`,
        tone: "muted",
      } as const;
  }
  if (reported.length > 1)
    return {
      label: `${reported.length} usage windows`,
      tone: "muted",
    } as const;
  return {
    label: usage.credits !== null ? "Plan credits" : "Usage not reported",
    tone: "muted",
  } as const;
}
