"use client";

import { useCallback, useEffect, useState } from "react";
import type { ProviderId, ProviderUsage } from "@agent-console/shared";
import { SERVER_URL } from "./serverUrl";

export function useProviderUsage(enabled: boolean) {
  const [usage, setUsage] = useState<Record<ProviderId, ProviderUsage> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (force = false) => {
    setError(null);
    try {
      const url = new URL("/api/providers/usage", SERVER_URL);
      if (force) url.searchParams.set("refresh", "1");
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`usage request failed (${response.status})`);
      const body = (await response.json()) as { usage: ProviderUsage[] };
      const next = {} as Record<ProviderId, ProviderUsage>;
      for (const entry of body.usage) next[entry.provider] = entry;
      setUsage(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh(false);
    const timer = setInterval(() => void refresh(false), 60_000);
    return () => clearInterval(timer);
  }, [enabled, refresh]);

  return { usage, loading, error, refresh };
}
