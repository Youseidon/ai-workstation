import type { AgentSession, PromptOption, PromptRemark, ServerMessage } from "@agent-console/shared";
import { serverUrl, webUrl } from "../env/orchestrator.ts";

/*
 * Durable-state driver (docs/e2e-harness-plan.md 3, principle 2): the typed
 * REST API a user's browser also uses, plus the same WebSocket `run` message
 * the UI sends. "Exactly one" invariants are asserted from here, never from
 * the UI.
 */

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`API ${status}: ${body.slice(0, 300)}`);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${serverUrl}${path}`, {
    method,
    headers: { Origin: webUrl, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new ApiError(response.status, text);
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

export interface PromptHistory {
  events: Array<{ id: number; runId: string | null; previousStatus: string | null; newStatus: string; reason: string; verificationSummary: string; actorType: string }>;
  remarks: PromptRemark[];
  runs: Array<{ id: string; provider: string; role: string; state: string }>;
}

export interface SavedTask {
  workspaceId: number;
  promptId: number;
  workDirectory: string;
}

export const state = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),

  async updateSettings(values: Record<string, unknown>): Promise<void> {
    await request("PUT", "/api/settings", values);
  },

  /** A workspace with one program, one suite and one saved task. */
  async createSavedTask(args: { workDirectory: string; title: string; content: string; name?: string }): Promise<SavedTask> {
    const { workspace } = await request<{ workspace: { id: number } }>("POST", "/api/workspaces", { name: args.name ?? `ws-${Date.now()}`, description: "", workDirectory: args.workDirectory });
    const { program } = await request<{ program: { id: number } }>("POST", `/api/workspaces/${workspace.id}/programs`, { name: "Program", overview: "" });
    const { suite } = await request<{ suite: { id: number } }>("POST", `/api/programs/${program.id}/suites`, { name: "Suite", overview: "" });
    const { prompt } = await request<{ prompt: { id: number } }>("POST", `/api/suites/${suite.id}/prompts`, { title: args.title, content: args.content });
    return { workspaceId: workspace.id, promptId: prompt.id, workDirectory: args.workDirectory };
  },

  async prompt(task: SavedTask): Promise<PromptOption> {
    const { prompts } = await request<{ prompts: PromptOption[] }>("GET", `/api/workspaces/${task.workspaceId}/prompts`);
    const found = prompts.find((prompt) => prompt.id === task.promptId);
    if (!found) throw new Error(`prompt ${task.promptId} not found`);
    return found;
  },

  history: (task: SavedTask) => request<PromptHistory>("GET", `/api/prompts/${task.promptId}/history`),

  async sessionsFor(task: SavedTask): Promise<AgentSession[]> {
    const response = await request<{ sessions: AgentSession[] } | AgentSession[]>("GET", "/api/sessions");
    const sessions = Array.isArray(response) ? response : response.sessions;
    return sessions.filter((session) => session.promptId === task.promptId);
  },

  /** Starts a saved-task run exactly as the UI does, over the WebSocket. Resolves once the server accepted or refused it. */
  startSavedTask(task: SavedTask, provider: string): Promise<{ runId: string } | { error: string }> {
    return websocketCommand({ kind: "run", provider, workspaceId: task.workspaceId, promptId: task.promptId, model: null }, (message) => {
      if (message.kind === "run_started") {
        const source = message.source as { promptId?: number };
        return source.promptId === task.promptId ? { runId: message.runId } : undefined;
      }
      if (message.kind === "event" && message.event.type === "error") return { error: message.event.payload.message };
      return undefined;
    }).then((result) => result ?? { error: "no reply" });
  },

  interrupt(runId: string): Promise<void> {
    return websocketCommand({ kind: "interrupt", runId }, () => undefined, 1500).then(() => undefined);
  },
};

function websocketCommand<T>(message: unknown, match: (message: ServerMessage) => T | undefined, settleAfterMs?: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${serverUrl.replace(/^http/, "ws")}/ws`);
    const timer = setTimeout(() => {
      socket.close();
      if (settleAfterMs !== undefined) resolve(undefined);
      else reject(new Error("no WebSocket reply within 15s"));
    }, settleAfterMs ?? 15_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify(message)));
    socket.addEventListener("message", (event) => {
      const parsed = JSON.parse(String(event.data)) as ServerMessage;
      const result = match(parsed);
      if (result !== undefined) {
        clearTimeout(timer);
        socket.close();
        resolve(result);
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("WebSocket error"));
    });
  });
}

/** Polls an observable condition; never a fixed sleep. */
export async function eventually<T>(description: string, probe: () => Promise<T | undefined | null | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined && value !== null && value !== false) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${description}${last instanceof Error ? ` (last error: ${last.message})` : ""}`);
}
