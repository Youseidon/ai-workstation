import type { LiveRun } from "../../models/runs.ts";
import type {
  NormalizedEvent,
  ProviderId,
  RunRole,
  RunSnapshot,
  RunSource,
  RunState,
  ServerMessage,
  TokenUsage,
  WorkspaceRecord,
} from "@hydra/shared";
import type { RunHandle } from "../../contracts/runs.ts";
import { createLogger } from "../../utils/logger.ts";
import { cancelAgentInput } from "../agents/agentInput.ts";

const log = createLogger("runhub");

const MAX_REPLAY_EVENTS = 2000;

type Subscriber = (message: ServerMessage) => void;

const subscribers = new Set<Subscriber>();
const runs = new Map<string, LiveRun>();
let closing = false;

function snapshot(run: LiveRun): RunSnapshot {
  return {
    runId: run.runId,
    provider: run.provider,
    model: run.model,
    workspace: run.workspace,
    source: run.source,
    clientRequestId: run.clientRequestId,
    role: run.role,
    state: run.state,
    startedAt: run.startedAt,
    elapsedMs: run.elapsedMs,
    usage: run.usage,
    detail: run.detail,
    events: run.events,
    truncated: run.truncated,
    permissionMode: run.permissionMode,
  };
}

const endHooks: Array<(runId: string) => void> = [];

export const runHub = {
  subscribe(subscriber: Subscriber): () => void {
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  },

  broadcast(message: ServerMessage): void {
    for (const subscriber of subscribers) {
      try {
        subscriber(message);
      } catch (error) {
        log.warn("subscriber failed", error);
      }
    }
  },

  operationsChanged(): void {
    this.broadcast({ kind: "operations_changed" });
  },

  snapshots(): RunSnapshot[] {
    return [...runs.values()]
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map(snapshot);
  },

  has(runId: string): boolean {
    return runs.has(runId);
  },

  get(runId: string): LiveRun | undefined {
    return runs.get(runId);
  },

  activeForWorkspace(workspaceId: number): LiveRun | undefined {
    for (const run of runs.values()) {
      if (run.workspace.id === workspaceId && (run.role === "execute" || run.role === "author")) return run;
    }
    return undefined;
  },

  activeExecuteForWorkspace(workspaceId: number): LiveRun | undefined {
    for (const run of runs.values()) {
      if (run.workspace.id === workspaceId && run.role === "execute") return run;
    }
    return undefined;
  },

  consultsForWorkspace(workspaceId: number): LiveRun[] {
    return [...runs.values()].filter(
      (run) => run.workspace.id === workspaceId && run.role === "consult",
    );
  },

  start(input: {
    handle: RunHandle;
    workspace: Pick<WorkspaceRecord, "id" | "name" | "workDirectory">;
    clientRequestId?: string;
    source: RunSource;
    role?: RunRole;
    permissionMode?: string | null;
  }): void {
    const run: LiveRun = {
      handle: input.handle,
      runId: input.handle.runId,
      provider: input.handle.provider,
      model: input.handle.model,
      workspace: input.workspace,
      source: input.source,
      clientRequestId: input.clientRequestId,
      role: input.role ?? input.handle.role ?? "execute",
      permissionMode: input.permissionMode !== undefined ? input.permissionMode : (input.handle.permissionMode ?? null),
      state: "starting",
      startedAt: new Date().toISOString(),
      elapsedMs: 0,
      usage: null,
      detail: null,
      events: [],
      truncated: false,
    };
    runs.set(run.runId, run);
    this.broadcast({
      kind: "run_started",
      runId: run.runId,
      provider: run.provider,
      model: run.model,
      workspace: run.workspace,
      source: run.source,
      clientRequestId: run.clientRequestId,
      role: run.role,
    });
    this.operationsChanged();
  },

  event(runId: string, event: NormalizedEvent): void {
    const run = runs.get(runId);
    if (run !== undefined) {
      run.events.push(event);
      if (run.events.length > MAX_REPLAY_EVENTS) {
        run.events.splice(0, run.events.length - MAX_REPLAY_EVENTS);
        run.truncated = true;
      }
      if (event.type === "status") {
        run.state = event.payload.state;
        run.elapsedMs = event.payload.elapsedMs;
        run.usage = event.payload.usage ?? run.usage;
        run.detail = event.payload.detail ?? run.detail;
      }
    }
    this.broadcast({ kind: "event", event });
  },

  onBeforeEnd(hook: (runId: string) => void): void {
    endHooks.push(hook);
  },

  end(runId: string, state: Extract<RunState, "done" | "interrupted" | "error">): void {
    cancelAgentInput(runId);
    for (const hook of endHooks) {
      try { hook(runId); } catch (error) { log.warn(`end hook failed for run ${runId}`, error); }
    }
    runs.delete(runId);
    this.broadcast({ kind: "run_ended", runId, state });
    this.operationsChanged();
  },

  async stop(runId: string): Promise<boolean> {
    const run = runs.get(runId);
    if (run === undefined) return false;
    await run.handle.interrupt();
    await run.handle.done;
    return true;
  },

  isClosing(): boolean {
    return closing;
  },

  async stopAll(): Promise<void> {
    closing = true;
    const live = [...runs.keys()];
    if (live.length === 0) return;
    log.info(`stopping ${live.length} live run${live.length === 1 ? "" : "s"}`);
    const results = await Promise.allSettled(live.map((runId) => this.stop(runId)));
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") log.warn(`run ${live[index]} did not stop cleanly`, result.reason);
    }
  },

  async complete(runId: string): Promise<boolean> {
    const run = runs.get(runId);
    if (run === undefined) return false;
    if (run.handle.complete) await run.handle.complete();
    else await run.handle.interrupt();
    await run.handle.done;
    return true;
  },
};
