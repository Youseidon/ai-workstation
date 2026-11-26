"use client";

import { userLocalStorage } from "@/lib/identityStorage";

import { useCallback, useSyncExternalStore } from "react";
import type { ProviderId, ProviderInfo } from "@hydra/shared";
import { isProviderId } from "@hydra/shared";
import { modelChoice } from "@/features/providers/lib/modelChoice";

export type ModelChoices = Partial<Record<ProviderId, string | null>>;

const STORAGE_KEY = "hydra.models";

const EMPTY: ModelChoices = {};

let cache: ModelChoices = EMPTY;
let cacheRaw: string | null = null;
const listeners = new Set<() => void>();

function parse(raw: string | null): ModelChoices {
  if (raw === null) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return EMPTY;
    const result: ModelChoices = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (!isProviderId(key)) continue;
      if (value === null) result[key] = null;
      else if (typeof value === "string" && value.trim() !== "")
        result[key] = value.trim();
    }
    return result;
  } catch {
    return EMPTY;
  }
}

function readRaw(): string | null {
  try {
    return userLocalStorage.getItem(STORAGE_KEY);
  } catch {
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

function getServerSnapshot(): ModelChoices {
  return EMPTY;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function write(next: ModelChoices): void {
  try {
    userLocalStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    cacheRaw = null;
    cache = next;
  }
  for (const listener of listeners) listener();
}

export interface ModelSelection {
  resolve(provider: ProviderId): string | null;
  isPinned(provider: ProviderId): boolean;
  isAuto(provider: ProviderId): boolean;
  configured(provider: ProviderId): string | null | undefined;
  select(provider: ProviderId, model: string | null): void;
  clear(provider: ProviderId): void;
}

export function useModelSelection(providers: ProviderInfo[]): ModelSelection {
  const choices = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const resolve = useCallback(
    (provider: ProviderId): string | null => {
      const info = providers.find((entry) => entry.id === provider);
      if (info === undefined) return choices[provider] ?? null;
      const choice = modelChoice(info, choices[provider]);
      return choice.active ? (choice.configured ?? null) : info.model;
    },
    [choices, providers],
  );

  const isPinned = useCallback(
    (provider: ProviderId) => {
      const info = providers.find((entry) => entry.id === provider);
      return info === undefined
        ? provider in choices
        : modelChoice(info, choices[provider]).active;
    },
    [choices, providers],
  );

  const isAuto = useCallback(
    (provider: ProviderId) =>
      providers.find((entry) => entry.id === provider)?.modelSelectionMode ===
      "auto",
    [providers],
  );

  const select = useCallback(
    (provider: ProviderId, model: string | null) => {
      if (
        providers.find((entry) => entry.id === provider)?.modelSelectionMode ===
        "auto"
      )
        return;
      write({ ...choices, [provider]: model });
    },
    [choices, providers],
  );

  const clear = useCallback(
    (provider: ProviderId) => {
      const next = { ...choices };
      delete next[provider];
      write(next);
    },
    [choices],
  );

  const configured = useCallback(
    (provider: ProviderId) => choices[provider],
    [choices],
  );

  return { resolve, isPinned, isAuto, configured, select, clear };
}
