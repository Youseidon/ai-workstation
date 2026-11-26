"use client";

import { apiFetch } from "@/api/http";

import { useCallback, useEffect, useState } from "react";
import type { ProviderId, ProviderUsage } from "@hydra/shared";
import { SERVER_URL } from "../../../api/serverUrl";

export function useProviderUsage(enabled: boolean) {
  const [usage, setUsage] = useState<Record<ProviderId, ProviderUsage> | null>(
    null,
  );
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL("/api/providers/usage", SERVER_URL);
      if (force) url.searchParams.set("refresh", "1");
      const response = await apiFetch(url, { cache: "no-store" });
      if (!response.ok)
        throw new Error(`usage request failed (${response.status})`);
      const body = (await response.json()) as { usage: ProviderUsage[] };
      const next = {} as Record<ProviderId, ProviderUsage>;
      for (const entry of body.usage) next[entry.provider] = entry;
      setUsage(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCheckedAt(Date.now());
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

  return { usage, loading, error, refresh, checkedAt };
}
