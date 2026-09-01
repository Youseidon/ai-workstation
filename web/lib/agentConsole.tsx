"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import type {
  ClientMessage,
  ProviderId,
  ProviderInfo,
  RunRole,
  RunSnapshot,
  RunSource,
  RunState,
  ServerMessage,
  TokenUsage,
  WorkspaceRecord,
} from "@agent-console/shared";
import { mergeUsage } from "@agent-console/shared";
import { appendPrompt, applyEvent, type LogItem } from "./log";
import { SERVER_URL } from "./serverUrl";

export type ConnectionState = "connecting" | "open" | "disconnected";

export interface RunStatus {
  runId: string;
  provider: ProviderId;
  /** The model this run resolved to on the server, not the current selection. */
  model: string | null;
  role: RunRole;
  permissionMode: string | null;
  state: RunState;
  elapsedMs: number;
  usage: TokenUsage | null;
  detail: string | null;
  workspace: Pick<WorkspaceRecord, "id" | "name" | "workDirectory">;
  source: RunSource;
  startedAt: string;
}

interface ConsoleState {
  connection: ConnectionState;
  providers: ProviderInfo[];
  items: LogItem[];
  /** Every run in flight, oldest first. Empty when nothing is running. */
  runs: RunStatus[];
  /** Kept after a run ends so the status bar can show the final numbers. */
  lastRun: RunStatus | null;
  /** Last consult that ended, so the briefing pane can stay open. */
  lastConsult: RunStatus | null;
  /** Every consult runId seen this session — writer LogPanel excludes these. */
  consultIds: string[];
  /** Advances whenever durable operations/prompt data should be re-read. */
  operationsRevision: number;
}

type Action =
  | { type: "connection"; value: ConnectionState }
  | { type: "providers"; providers: ProviderInfo[] }
  | { type: "server"; message: ServerMessage }
  | { type: "clear" };

const initialState: ConsoleState = {
  connection: "connecting",
  providers: [],
  items: [],
  runs: [],
  lastRun: null,
  lastConsult: null,
  consultIds: [],
  operationsRevision: 0,
};

function rememberConsultId(ids: string[], runId: string): string[] {
  return ids.includes(runId) ? ids : [...ids, runId];
}

/** The transcript line that stands in for a run's instruction. */
function sourceText(source: RunSource): string {
  switch (source.type) {
    case "custom":
      return source.displayText;
    case "clarification":
      return `Clarifying ${source.promptKey ?? source.title}: ${source.question}`;
    case "verification":
      return source.promptKey === null
        ? `Verifying suite ${source.suiteKey === null ? source.suiteName : `${source.suiteKey} — ${source.suiteName}`}`
        : `Verifying ${source.promptKey} in ${source.suiteKey === null ? source.suiteName : `${source.suiteKey} — ${source.suiteName}`}`;
    case "saved":
      return `Selected saved prompt: ${source.promptKey === null ? "" : `${source.promptKey} — `}${source.title}\n${source.programName} / ${source.suiteName}`;
    case "consult":
      return `Consulting: ${source.question}`;
    case "handoff":
      return `Preparing handoff for ${source.promptKey ?? source.title}`;
  }
}

function toRunStatus(snapshot: RunSnapshot): RunStatus {
  return {
    runId: snapshot.runId,
    provider: snapshot.provider,
    model: snapshot.model,
    role: snapshot.role ?? "execute",
    permissionMode: snapshot.permissionMode ?? null,
    state: snapshot.state,
    elapsedMs: snapshot.elapsedMs,
    usage: snapshot.usage,
    detail: snapshot.detail,
    workspace: snapshot.workspace,
    source: snapshot.source,
    startedAt: snapshot.startedAt,
  };
}

function reducer(state: ConsoleState, action: Action): ConsoleState {
  switch (action.type) {
    case "connection":
      // A dropped socket must not leave the UI asserting a run is live — but it
      // is not evidence the run stopped, either. The next `hello` is what
      // settles which runs still exist.
      if (action.value === "disconnected" && state.runs.length > 0) {
        const lastExecute = [...state.runs].reverse().find((run) => run.role === "execute");
        const lastConsultLive = [...state.runs].reverse().find((run) => run.role === "consult");
        return {
          ...state,
          connection: action.value,
          runs: [],
          lastRun: lastExecute ?? state.lastRun,
          lastConsult: lastConsultLive ?? state.lastConsult,
        };
      }
      return { ...state, connection: action.value };

    case "providers":
      return {
        ...state,
        providers: action.providers,
      };

    case "clear":
      // Only drops transcript lines from runs that have finished; clearing the
      // log must not erase the run you are currently watching.
      return {
        ...state,
        items: state.items.filter((item) => state.runs.some((run) => run.runId === item.runId)),
      };

    case "server": {
      const message = action.message;
      switch (message.kind) {
        case "hello": {
          // Rebuild the transcript of everything still running, and keep lines
          // from runs that have already finished. Doing it this way makes
          // `hello` idempotent, so a reconnect mid-run repairs the log rather
          // than duplicating it.
          const liveIds = new Set(message.activeRuns.map((run) => run.runId));
          const finished = state.items.filter((item) => !liveIds.has(item.runId));
          let replayed: LogItem[] = [];
          for (const snapshot of message.activeRuns) {
            replayed = appendPrompt(replayed, {
              runId: snapshot.runId,
              provider: snapshot.provider,
              model: snapshot.model,
              text: sourceText(snapshot.source),
              timestamp: snapshot.startedAt,
            });
            for (const event of snapshot.events) replayed = applyEvent(replayed, event);
          }
          return {
            ...state,
            providers: message.providers,
            items: [...finished, ...replayed],
            runs: message.activeRuns.map(toRunStatus),
            consultIds: message.activeRuns.reduce(
              (ids, snapshot) =>
                (snapshot.role ?? "execute") === "consult" ? rememberConsultId(ids, snapshot.runId) : ids,
              state.consultIds,
            ),
          };
        }

        case "providers":
          return { ...state, providers: message.providers };

        case "settings_updated":
          // Another tab (or this one) changed provider settings: re-detected
          // providers without a reload.
          return { ...state, providers: message.providers };

        case "operations_changed":
          return { ...state, operationsRevision: state.operationsRevision + 1 };

        case "run_started": {
          // `hello` may already have replayed this run; keep one entry.
          if (state.runs.some((run) => run.runId === message.runId)) return state;
          const role = message.role ?? "execute";
          return {
            ...state,
            items: appendPrompt(state.items, {
              runId: message.runId,
              provider: message.provider,
              model: message.model,
              text: sourceText(message.source),
            }),
            runs: [
              ...state.runs,
              {
                runId: message.runId,
                provider: message.provider,
                model: message.model,
                role,
                permissionMode: null,
                state: "starting",
                elapsedMs: 0,
                usage: null,
                detail: null,
                workspace: message.workspace,
                source: message.source,
                startedAt: new Date().toISOString(),
              },
            ],
            consultIds: role === "consult" ? rememberConsultId(state.consultIds, message.runId) : state.consultIds,
          };
        }

        case "event": {
          const event = message.event;
          const items = applyEvent(state.items, event);
          if (event.type !== "status") return { ...state, items };
          const index = state.runs.findIndex((run) => run.runId === event.runId);
          if (index === -1) return { ...state, items };
          const runs = [...state.runs];
          const current = runs[index]!;
          runs[index] = {
            ...current,
            state: event.payload.state,
            elapsedMs: event.payload.elapsedMs,
            usage: mergeUsage(current.usage, event.payload.usage),
            detail: event.payload.detail ?? current.detail,
          };
          return { ...state, items, runs };
        }

        case "run_ended": {
          const ended = state.runs.find((run) => run.runId === message.runId);
          if (ended === undefined) return state;
          const remaining = state.runs.filter((run) => run.runId !== message.runId);
          const closed = { ...ended, state: message.state, detail: null };
          if (ended.role === "consult") {
            return { ...state, runs: remaining, lastConsult: closed };
          }
          return { ...state, runs: remaining, lastRun: closed };
        }

        case "pong":
          return state;
      }
    }
  }
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5000;

interface AgentConsoleApi extends ConsoleState {
  /**
   * The execute writer for single-run UI. Prefer execute so a consult cannot
   * hide a writer; TopBar falls back for consult-only.
   */
  run: RunStatus | null;
  /** Transcript lines belonging to one run. */
  itemsFor(runId: string): LogItem[];
  startRun(
    workspaceId: number,
    provider: ProviderId,
    source: { prompt: string } | { promptId: number },
    model: string | null,
  ): boolean;
  startConsult(
    workspaceId: number,
    provider: ProviderId,
    source: { prompt: string } | { promptId: number } | { prompt: string; promptId: number },
    model: string | null,
  ): boolean;
  askClarification(
    workspaceId: number,
    provider: ProviderId,
    promptId: number,
    question: string,
    model: string | null,
  ): boolean;
  /** Starts a server-side agent verification of a suite, or one work item inside it. */
  verifySuite(suiteId: number, provider: ProviderId, model: string | null, promptId?: number | null): boolean;
  /** Stops a run by id, or the primary run when called with no argument. */
  interrupt(runId?: string): boolean;
  clearLog(): void;
  refreshProviders(): Promise<void>;
}

const AgentConsoleContext = createContext<AgentConsoleApi | null>(null);

/**
 * Holds the single WebSocket for the whole app.
 *
 * This lives in the root layout, which the App Router preserves across
 * navigation, so moving between Console, Operations and Workspaces no longer
 * tears down the socket and throws away the transcript. Previously each page
 * called this hook itself: every navigation opened a new connection that
 * started with an empty log and reported "idle" while an agent was mid-run.
 */
export function AgentConsoleProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const socketRef = useRef<WebSocket | null>(null);

  const wsUrl = useMemo(() => {
    const url = new URL("/ws", SERVER_URL);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }, []);

  // Populate the switcher even if the socket never comes up.
  const refreshProviders = useCallback(async () => {
    try {
      const response = await fetch(new URL("/api/providers?refresh=1", SERVER_URL), {
        cache: "no-store",
      });
      if (!response.ok) return;
      const body = (await response.json()) as { providers: ProviderInfo[] };
      dispatch({ type: "providers", providers: body.providers });
    } catch {
      // The socket's `hello` is the other path to this data.
    }
  }, []);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (disposed) return;
      dispatch({ type: "connection", value: "connecting" });
      const socket = new WebSocket(wsUrl);
      socketRef.current = socket;

      socket.onopen = () => {
        attempt = 0;
        dispatch({ type: "connection", value: "open" });
      };

      socket.onmessage = (raw) => {
        try {
          dispatch({ type: "server", message: JSON.parse(String(raw.data)) as ServerMessage });
        } catch {
          // Ignore frames we cannot parse rather than tearing down the socket.
        }
      };

      socket.onerror = () => socket.close();

      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        dispatch({ type: "connection", value: "disconnected" });
        if (disposed) return;
        attempt += 1;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  }, [wsUrl]);

  const send = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const value = useMemo<AgentConsoleApi>(() => {
    const run = state.runs.find((entry) => entry.role === "execute") ?? state.runs[0] ?? null;
    return {
      ...state,
      run,
      itemsFor: (runId) => state.items.filter((item) => item.runId === runId),
      startRun: (workspaceId, provider, source, model) =>
        send({ kind: "run", workspaceId, provider, ...source, model, role: "execute" }),
      startConsult: (workspaceId, provider, source, model) =>
        send({ kind: "run", workspaceId, provider, ...source, model, role: "consult" }),
      askClarification: (workspaceId, provider, promptId, question, model) =>
        send({ kind: "run", mode: "clarify", workspaceId, provider, promptId, question, model, role: "execute" }),
      verifySuite: (suiteId, provider, model, promptId) =>
        send({ kind: "verify_suite", suiteId, provider, model, promptId: promptId ?? null }),
      interrupt: (runId) => {
        const target = runId ?? run?.runId;
        if (target === undefined) return false;
        return send({ kind: "interrupt", runId: target });
      },
      clearLog: () => dispatch({ type: "clear" }),
      refreshProviders,
    };
  }, [refreshProviders, send, state]);

  return <AgentConsoleContext.Provider value={value}>{children}</AgentConsoleContext.Provider>;
}

export function useAgentConsole(): AgentConsoleApi {
  const context = useContext(AgentConsoleContext);
  if (context === null) throw new Error("useAgentConsole must be used inside <AgentConsoleProvider>");
  return context;
}
