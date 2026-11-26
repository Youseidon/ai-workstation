"use client";

import { userLocalStorage } from "@/lib/identityStorage";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSearchParams } from "next/navigation";
import type { WorkspaceRecord } from "@hydra/shared";
import { SERVER_URL } from "@/api/serverUrl";
import { workspaceApi } from "@/api/workspacesApi";

export const WORKSPACE_STORAGE_KEY = "hydra.workspace";

export type WorkspaceStatus = "loading" | "ready" | "empty" | "error";

type WorkspaceContextValue = {
  workspaces: WorkspaceRecord[];
  workspaceId: number | null;
  workspace: WorkspaceRecord | null;
  status: WorkspaceStatus;
  error: string | null;
  setWorkspaceId: (id: number) => void;
  refresh: () => Promise<void>;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function readStoredId(): number | null {
  try {
    const raw = userLocalStorage.getItem(WORKSPACE_STORAGE_KEY);
    const id = Number(raw);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function readUrlId(): number | null {
  try {
    const id = Number(new URLSearchParams(window.location.search).get("workspace"));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function persistId(id: number | null) {
  try {
    if (id === null) userLocalStorage.removeItem(WORKSPACE_STORAGE_KEY);
    else userLocalStorage.setItem(WORKSPACE_STORAGE_KEY, String(id));
  } catch {
  }
}

function syncUrlWorkspace(id: number | null) {
  try {
    const url = new URL(window.location.href);
    if (id === null) url.searchParams.delete("workspace");
    else url.searchParams.set("workspace", String(id));
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
  }
}

function pickId(list: WorkspaceRecord[], preferred: number | null): number | null {
  if (preferred !== null && list.some((item) => item.id === preferred)) return preferred;
  return list[0]?.id ?? null;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [workspaceId, setWorkspaceIdState] = useState<number | null>(null);
  const [status, setStatus] = useState<WorkspaceStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const bootstrapped = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const list = await workspaceApi.list(SERVER_URL);
      setWorkspaces(list);
      setError(null);
      setWorkspaceIdState((current) => {
        const urlId = typeof window !== "undefined" ? readUrlId() : null;
        const stored = typeof window !== "undefined" ? readStoredId() : null;
        const preferred = urlId ?? (bootstrapped.current ? current : stored) ?? current;
        const next = pickId(list, preferred);
        if (next !== null) persistId(next);
        return next;
      });
      setStatus(list.length === 0 ? "empty" : "ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Workspaces could not be loaded.");
      setStatus("error");
    } finally {
      bootstrapped.current = true;
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async list fetch on mount
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onUrlChange = () => {
      const urlId = readUrlId();
      if (urlId === null) return;
      setWorkspaceIdState((current) => {
        if (current === urlId) return current;
        if (!workspaces.some((item) => item.id === urlId)) return current;
        persistId(urlId);
        return urlId;
      });
    };
    window.addEventListener("popstate", onUrlChange);
    return () => window.removeEventListener("popstate", onUrlChange);
  }, [workspaces]);

  const setWorkspaceId = useCallback(
    (id: number) => {
      if (!workspaces.some((item) => item.id === id) && workspaces.length > 0) return;
      setWorkspaceIdState(id);
      persistId(id);
      syncUrlWorkspace(id);
    },
    [workspaces],
  );

  const workspace = useMemo(
    () => workspaces.find((item) => item.id === workspaceId) ?? null,
    [workspaces, workspaceId],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspaces,
      workspaceId,
      workspace,
      status,
      error,
      setWorkspaceId,
      refresh,
    }),
    [workspaces, workspaceId, workspace, status, error, setWorkspaceId, refresh],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (value === null) {
    throw new Error("useWorkspace must be used within WorkspaceProvider");
  }
  return value;
}

export function WorkspaceUrlSync() {
  const params = useSearchParams();
  const { workspaces, workspaceId, setWorkspaceId } = useWorkspace();
  const raw = params.get("workspace");
  const urlId = raw !== null ? Number(raw) : null;
  const applied = useRef<number | null>(null);

  useEffect(() => {
    if (urlId === null || !Number.isSafeInteger(urlId) || urlId <= 0) return;
    if (applied.current === urlId) return;
    if (!workspaces.some((item) => item.id === urlId)) return;
    applied.current = urlId;
    if (workspaceId !== urlId) setWorkspaceId(urlId);
  }, [urlId, workspaceId, workspaces, setWorkspaceId]);

  return null;
}
