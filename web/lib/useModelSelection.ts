"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { ProviderId, ProviderInfo } from "@agent-console/shared";
import { isProviderId } from "@agent-console/shared";

/**
 * Which model each provider should run with. A key that is *present* with the
 * value `null` means "explicitly use the provider's own default" (send no `-m`);
 * a key that is *absent* means the user has not chosen yet, so the model
 * configured in settings is used instead. That distinction is why this is a
 * Partial map rather than a plain Record with nulls.
 */
export type ModelChoices = Partial<Record<ProviderId, string | null>>;

const STORAGE_KEY = "agent-console.models";

/*
 * localStorage is an external store, so it is read through
 * useSyncExternalStore rather than an effect: React then handles the
 * server-renders-empty / client-renders-stored difference itself, and a change
 * made in another tab propagates here through the `storage` event.
 */

const EMPTY: ModelChoices = {};

/** getSnapshot must be referentially stable, so the parsed value is memoized. */
let cache: ModelChoices = EMPTY;
let cacheRaw: string | null = null;
const listeners = new Set<() => void>();

function parse(raw: string | null): ModelChoices {
  if (raw === null) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return EMPTY;
    const result: ModelChoices = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isProviderId(key)) continue;
      if (value === null) result[key] = null;
      else if (typeof value === "string" && value.trim() !== "") result[key] = value.trim();
    }
    return result;
  } catch {
    // A corrupt value is not a reason to take the console down over a UI
    // preference; fall back to "nothing pinned".
    return EMPTY;
  }
}

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private mode or storage disabled by policy.
    return null;
  }
}

function getSnapshot(): ModelChoices {
  const raw = readRaw();
  if (raw !== cacheRaw) {
    cacheRaw = raw;
    cache = parse(raw);
  }
  return cache;
}

/** Nothing is pinned during SSR — the same value every render, as required. */
function getServerSnapshot(): ModelChoices {
  return EMPTY;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab writing the key should move this tab's switcher too.
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function write(next: ModelChoices): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Not being able to remember the choice is not a reason to reject it, so
    // seed the cache directly and carry on for this session.
    cacheRaw = null;
    cache = next;
  }
  for (const listener of listeners) listener();
}

export interface ModelSelection {
  /** The model to run `provider` with, after the settings fallback. */
  resolve(provider: ProviderId): string | null;
  /** True when the user has picked a model rather than inheriting settings. */
  isPinned(provider: ProviderId): boolean;
  /** Pin a model (`null` pins "provider default"). */
  select(provider: ProviderId, model: string | null): void;
  /** Drop the pin so the provider follows its settings value again. */
  clear(provider: ProviderId): void;
}

/**
 * Model choices live here rather than in the settings file: switching models
 * mid-session is a per-run decision, and writing it back to settings would
 * silently rewrite the configured default for every other tab.
 */
export function useModelSelection(providers: ProviderInfo[]): ModelSelection {
  const choices = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const resolve = useCallback(
    (provider: ProviderId): string | null => {
      if (provider in choices) return choices[provider] ?? null;
      return providers.find((info) => info.id === provider)?.model ?? null;
    },
    [choices, providers],
  );

  const isPinned = useCallback((provider: ProviderId) => provider in choices, [choices]);

  const select = useCallback(
    (provider: ProviderId, model: string | null) => write({ ...choices, [provider]: model }),
    [choices],
  );

  const clear = useCallback(
    (provider: ProviderId) => {
      const next = { ...choices };
      delete next[provider];
      write(next);
    },
    [choices],
  );

  return { resolve, isPinned, select, clear };
}
