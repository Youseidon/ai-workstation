"use client";

import { useState } from "react";
import type {
  ProviderId,
  ProviderInstallResult,
  ProviderSetupInfo,
} from "@hydra/shared";
import { apiFetch } from "@/api/http";
import { SERVER_URL } from "@/api/serverUrl";

export interface ProviderSetupSession {
  info: ProviderSetupInfo | null;
  state: "loading" | "ready" | "installing" | "connect" | "error";
  error: string | null;
}

async function setupRequest<T>(
  id: ProviderId,
  operation: "setup" | "install",
): Promise<T> {
  const response = await apiFetch(
    new URL(`/api/providers/${id}/${operation}`, SERVER_URL),
    { method: operation === "install" ? "POST" : "GET", cache: "no-store" },
  );
  const body = (await response.json()) as T & {
    error?: string | { message?: string };
  };
  if (!response.ok)
    throw new Error(
      typeof body.error === "string"
        ? body.error
        : (body.error?.message ?? `Provider setup failed (${response.status})`),
    );
  return body;
}

export function useProviderSetup(onInstalled: () => Promise<void>) {
  const [sessions, setSessions] = useState<
    Partial<Record<ProviderId, ProviderSetupSession>>
  >({});
  const change = (id: ProviderId, update: Partial<ProviderSetupSession>) =>
    setSessions((current) => ({
      ...current,
      [id]: {
        info: null,
        state: "loading",
        error: null,
        ...current[id],
        ...update,
      },
    }));
  const load = async (id: ProviderId) => {
    if (sessions[id]?.state === "installing") return;
    change(id, { state: "loading", error: null });
    try {
      const info = await setupRequest<ProviderSetupInfo>(id, "setup");
      change(id, { info, state: info.installed ? "connect" : "ready" });
    } catch (cause) {
      change(id, {
        state: "error",
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };
  const install = async (id: ProviderId) => {
    change(id, { state: "installing", error: null });
    try {
      const result = await setupRequest<ProviderInstallResult>(id, "install");
      if (!result.installed)
        throw new Error("The provider could not be installed.");
      await onInstalled();
      const info = await setupRequest<ProviderSetupInfo>(id, "setup");
      change(id, { info, state: "connect" });
    } catch (cause) {
      change(id, {
        state: "error",
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };
  return { sessions, load, install };
}
