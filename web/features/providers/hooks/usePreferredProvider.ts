"use client";

import { userLocalStorage } from "@/lib/identityStorage";

import { useCallback, useSyncExternalStore } from "react";
import type { ProviderId, ProviderInfo } from "@hydra/shared";
import { isProviderId } from "@hydra/shared";

const STORAGE_KEY = "hydra.preferred-provider";

let cache: ProviderId | null = null;
let cacheRaw: string | null | undefined = undefined;
const listeners = new Set<() => void>();

function readRaw(): string | null {
  try {
    return userLocalStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function parse(raw: string | null): ProviderId | null {
  if (raw === null || !isProviderId(raw)) return null;
  return raw;
}

function getSnapshot(): ProviderId | null {
  const raw = readRaw();
  if (raw !== cacheRaw) {
    cacheRaw = raw;
    cache = parse(raw);
  }
  return cache;
}

function getServerSnapshot(): ProviderId | null {
  return null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function write(next: ProviderId): void {
  try {
    userLocalStorage.setItem(STORAGE_KEY, next);
  } catch {
    cacheRaw = next;
    cache = next;
  }
  for (const listener of listeners) listener();
}

export function usePreferredProvider(providers: ProviderInfo[]): {
  preferred: ProviderId | null;
  selected: ProviderId;
  setPreferred(provider: ProviderId): void;
} {
  const preferred = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const selected = (() => {
    const picked = providers.find((provider) => provider.id === preferred);
    if (picked?.available === true) return picked.id;
    return providers.find((provider) => provider.available)?.id ?? preferred ?? "claude";
  })();

  const setPreferred = useCallback((provider: ProviderId) => write(provider), []);

  return { preferred, selected, setPreferred };
}
