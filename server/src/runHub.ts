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
} from "@agent-console/shared";
import type { RunHandle } from "./runner.ts";
import { createLogger } from "./lib/logger.ts";

const log = createLogger("runhub");

/**
 * How much of a run's transcript is kept for replay. A long run can emit tens
 * of thousands of events; this bounds memory while still covering far more than
 * a reader will scroll back through. Overflow is reported as `truncated` rather
 * than silently hidden.
 */
const MAX_REPLAY_EVENTS = 2000;

export interface LiveRun {
  handle: RunHandle;
  runId: string;
  provider: ProviderId;
  model: string | null;
  workspace: Pick<WorkspaceRecord, "id" | "name" | "workDirectory">;
  source: RunSource;
  role: RunRole;
  permissionMode: string | null;
  state: RunState;
  startedAt: string;
  elapsedMs: number;
  usage: TokenUsage | null;
  detail: string | null;
  events: NormalizedEvent[];
  truncated: boolean;
}

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

/**
 * Owns every run in flight, and fans their events out to all connected clients.
 *
 * Runs used to live in the WebSocket connection closure that started them,
 * which meant their events reached exactly one socket: opening a second tab, or
 * navigating to another page in the app, produced a fresh socket that received
 * nothing and reported "idle" while the agent was still working. The run is a
 * property of the server, so it is owned here and every subscriber sees it.
 */
export const runHub = {
  /** Registers a client. Returns an unsubscribe function. */
  subscribe(subscriber: Subscriber): () => void {
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  },

  broadcast(message: ServerMessage): void {
    for (const subscriber of subscribers) {
      // One bad socket must not stop the others from being told.
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

  /** Every live run, newest last, with replay buffers. */
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

  /**
   * The run currently holding a workspace's working directory, if any.
   *
   * A workspace is one working directory, and two agents editing the same tree
   * at once corrupt each other's work. An author run counts: it is told to read
   * rather than write, but it starts with the same permissions an execute run
   * does (it has to be able to reach `agent-step`, and a read-only sandbox
   * blocks that outright on Codex), so treating it as a reader would be trusting
   * an instruction where a lock belongs.
   */
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

  /** Registers a started run and announces it to every client. */
  start(input: {
    handle: RunHandle;
    workspace: Pick<WorkspaceRecord, "id" | "name" | "workDirectory">;
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
      role: run.role,
    });
    this.operationsChanged();
  },

  /** Buffers an event, folds it into the run's live state, and fans it out. */
  event(runId: string, event: NormalizedEvent): void {
    const run = runs.get(runId);
    if (run !== undefined) {
      run.events.push(event);
      if (run.events.length > MAX_REPLAY_EVENTS) {
        run.events.splice(0, run.events.length - MAX_REPLAY_EVENTS);
        run.truncated = true;
      }
      // Status carries the server-side clock and cumulative usage, so a client
      // that joins late gets real numbers rather than starting from zero.
      if (event.type === "status") {
        run.state = event.payload.state;
        run.elapsedMs = event.payload.elapsedMs;
        run.usage = event.payload.usage ?? run.usage;
        run.detail = event.payload.detail ?? run.detail;
      }
    }
    this.broadcast({ kind: "event", event });
  },

  /** Removes a finished run and announces its terminal state. */
  end(runId: string, state: Extract<RunState, "done" | "interrupted" | "error">): void {
    runs.delete(runId);
    this.broadcast({ kind: "run_ended", runId, state });
    this.operationsChanged();
  },

  /** Interrupts a run from anywhere — any tab, or the REST endpoint. */
  async stop(runId: string): Promise<boolean> {
    const run = runs.get(runId);
    if (run === undefined) return false;
    await run.handle.interrupt();
    await run.handle.done;
    return true;
  },

  /**
   * True once shutdown has begun, so callers that would start new work — the
   * pipeline scheduler advancing to the next station — can stand down instead
   * of spawning an agent into a process that is on its way out.
   */
  isClosing(): boolean {
    return closing;
  },

  /**
   * Interrupts every live run and waits for each to record its terminal state.
   *
   * Agents are children of this server, not of the shell that started it, so
   * nothing else signals them: left alone they outlive the server, keep writing
   * to a database no live process owns, and surface on the next boot as runs
   * that were abandoned mid-flight.
   */
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

  /** Stops a provider that has already posted DONE/BLOCKED, without recording a false interruption. */
  async complete(runId: string): Promise<boolean> {
    const run = runs.get(runId);
    if (run === undefined) return false;
    if (run.handle.complete) await run.handle.complete();
    else await run.handle.interrupt();
    await run.handle.done;
    return true;
  },
};
