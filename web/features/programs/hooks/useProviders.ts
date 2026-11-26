"use client";

import { apiFetch } from "@/api/http";

import { useEffect, useState } from "react";
import type { ProviderId, ProviderInfo } from "@hydra/shared";

export function useProviders(serverUrl: string): { providers: ProviderInfo[]; firstAvailable: ProviderId | "" } {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await apiFetch(new URL("/api/providers", serverUrl), { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as { providers: ProviderInfo[] };
        if (!cancelled) setProviders(body.providers);
      } catch {
      }
    })();
    return () => { cancelled = true; };
  }, [serverUrl]);
  return { providers, firstAvailable: providers.find((entry) => entry.available)?.id ?? "" };
}
