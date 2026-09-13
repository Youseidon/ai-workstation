"use client";

import { useCallback, useEffect, useState } from "react";
import type { ProviderId, ProviderUsage, QuotaWarning } from "@agent-console/shared";
import { SERVER_URL } from "./serverUrl";

export function groupQuotaWarnings(warnings: readonly QuotaWarning[]): Record<ProviderId, QuotaWarning[]> {
  const nextWarnings = {} as Record<ProviderId, QuotaWarning[]>;
  const seen = new Set<string>();
  for (const warning of warnings) {
    const key = `${warning.provider}:${warning.windowKind}:${warning.windowIdentity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nextWarnings[warning.provider] = [...(nextWarnings[warning.provider] ?? []), warning];
  }
  return nextWarnings;
}

export function useProviderUsage(enabled: boolean) {
  const [usage, setUsage] = useState<Record<ProviderId, ProviderUsage> | null>(null);
  const [warnings, setWarnings] = useState<Record<ProviderId, QuotaWarning[]> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (force = false) => {
    setError(null);
    try {
      const url = new URL("/api/providers/usage", SERVER_URL);
      if (force) url.searchParams.set("refresh", "1");
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`usage request failed (${response.status})`);
      const body = (await response.json()) as { usage: ProviderUsage[]; warnings?: QuotaWarning[] };
      const next = {} as Record<ProviderId, ProviderUsage>;
      for (const entry of body.usage) next[entry.provider] = entry;
      setUsage(next);
      setWarnings(groupQuotaWarnings(body.warnings ?? []));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const initial = setTimeout(() => void refresh(false), 0);
    const timer = setInterval(() => void refresh(false), 60_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [enabled, refresh]);

  return { usage, warnings, loading, error, refresh };
}
