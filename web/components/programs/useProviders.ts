"use client";

import { useEffect, useState } from "react";
import type { ProviderId, ProviderInfo } from "@agent-console/shared";

/**
 * The providers this server can start, and the first available one as a
 * default. Panels that start an agent still work by hand without one, so a
 * failed detection is an empty list rather than an error.
 */
export function useProviders(serverUrl: string): { providers: ProviderInfo[]; firstAvailable: ProviderId | "" } {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(new URL("/api/providers", serverUrl), { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as { providers: ProviderInfo[] };
        if (!cancelled) setProviders(body.providers);
      } catch {
        /* no provider detected; the caller shows that */
      }
    })();
    return () => { cancelled = true; };
  }, [serverUrl]);
  return { providers, firstAvailable: providers.find((entry) => entry.available)?.id ?? "" };
}
