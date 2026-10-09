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
  AgentSession,
  AgentInputAnswer,
  AgentInputRequestPayload,
  ClientMessage,
  NormalizedEvent,
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

export interface PendingLaunch {
  requestId: string;
  tabId: string;
  role: RunRole;
}

export interface PendingAgentInput extends AgentInputRequestPayload {
  runId: string;
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
  /** Last completed consult per workspace, so another tab finishing cannot erase this tab's briefing. */
  lastConsults: Record<number, RunStatus>;
  /** Every consult runId seen this session — writer LogPanel excludes these. */
  consultIds: string[];
  /** Stable run ownership used to keep workspace transcripts isolated after a run ends. */
  runWorkspaceIds: Record<string, number>;
  /** Browser-local work tab that launched or adopted each run. */
  runTabIds: Record<string, string>;
  /** Provider session announced by each run, retained across reconnect replay. */
  runSessionIds: Record<string, string>;
  /** Provider-native conversations retained independently in each work tab. */
  tabSessions: Record<string, Partial<Record<ProviderId, { sessionId: string; workspaceId: number }>>>;
  /** Last completed research run in each browser-local work tab. */
  lastConsultsByTab: Record<string, RunStatus>;
  /** Requests accepted by the socket that have not produced a run yet. */
  pendingLaunches: PendingLaunch[];
  /** Launch failures keyed by the browser-local tab that submitted them. */
  launchFailuresByTab: Record<string, string>;
  /** Unanswered decision decks, keyed by run id. */
  inputRequests: Record<string, PendingAgentInput>;
  /** Advances whenever durable operations/prompt data should be re-read. */
  operationsRevision: number;
}

type Action =
  | { type: "connection"; value: ConnectionState }
  | { type: "providers"; providers: ProviderInfo[] }
  | { type: "server"; message: ServerMessage; tabId?: string; requestId?: string }
  | { type: "launch_queued"; launch: PendingLaunch }
  | { type: "launch_send_failed"; requestId: string }
  | { type: "dismiss_launch_failure"; tabId: string }
  | { type: "claim_workspace"; workspaceId: number; tabId: string }
  | { type: "restore_thread"; tabId: string; sessions: AgentSession[] }
  | { type: "clear"; workspaceId?: number; tabId?: string };

const initialState: ConsoleState = {
  connection: "connecting",
  providers: [],
  items: [],
  runs: [],
  lastRun: null,
  lastConsult: null,
  lastConsults: {},
  consultIds: [],
  runWorkspaceIds: {},
  runTabIds: {},
  runSessionIds: {},
  tabSessions: {},
  lastConsultsByTab: {},
  pendingLaunches: [],
  launchFailuresByTab: {},
  inputRequests: {},
  operationsRevision: 0,
};

function rememberConsultId(ids: string[], runId: string): string[] {
  return ids.includes(runId) ? ids : [...ids, runId];
}

function sessionAnnouncedBy(events: NormalizedEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "status" && typeof event.payload.sessionId === "string" && event.payload.sessionId !== "") {
      return event.payload.sessionId;
    }
  }
  return undefined;
}

function replayInputRequests(base: Record<string, PendingAgentInput>, events: NormalizedEvent[]): Record<string, PendingAgentInput> {
  const next = { ...base };
  for (const event of events) {
    if (event.type === "input_request") next[event.runId] = { runId: event.runId, ...event.payload };
    if (event.type === "input_response") delete next[event.runId];
  }
  return next;
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
    case "audit":
      return `Auditing whether ${source.promptKey ?? source.title} was actually finished`;
    case "wrapup":
      return `Wrapping up ${source.promptKey ?? source.title}: the run before this one was stopped by its budget (${source.stopReason}) and is recording what it verified and what remains`;
    case "author":
      return source.revision === true
        ? `Proposing changes to ${source.programName ?? "a program"} (draft ${source.draftId}): ${source.goal}`
        : `Drafting a program (draft ${source.draftId}): ${source.goal}`;
    case "instructions":
      return `Proposing changes to ${source.file} (proposal ${source.proposalId}): ${source.goal}`;
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
    case "launch_queued": {
      const launchFailuresByTab = { ...state.launchFailuresByTab };
      delete launchFailuresByTab[action.launch.tabId];
      return {
        ...state,
        pendingLaunches: [...state.pendingLaunches, action.launch],
        launchFailuresByTab,
      };
    }

    case "launch_send_failed": {
      const launch = state.pendingLaunches.find((item) => item.requestId === action.requestId);
      if (launch === undefined) return state;
      return {
        ...state,
        pendingLaunches: state.pendingLaunches.filter((item) => item.requestId !== action.requestId),
        launchFailuresByTab: {
          ...state.launchFailuresByTab,
          [launch.tabId]: "The agent connection closed before the run could be sent.",
        },
      };
    }

    case "dismiss_launch_failure": {
      if (state.launchFailuresByTab[action.tabId] === undefined) return state;
      const launchFailuresByTab = { ...state.launchFailuresByTab };
      delete launchFailuresByTab[action.tabId];
      return { ...state, launchFailuresByTab };
    }

    case "connection":
      // A dropped socket must not leave the UI asserting a run is live — but it
      // is not evidence the run stopped, either. The next `hello` is what
      // settles which runs still exist.
      if (action.value === "disconnected" && state.runs.length > 0) {
        const lastExecute = [...state.runs].reverse().find((run) => run.role === "execute");
        const lastConsultLive = [...state.runs].reverse().find((run) => run.role === "consult");
        const lastConsults = state.runs.reduce<Record<number, RunStatus>>(
          (byWorkspace, run) => run.role === "consult"
            ? { ...byWorkspace, [run.workspace.id]: run }
            : byWorkspace,
          state.lastConsults,
        );
        const lastConsultsByTab = state.runs.reduce<Record<string, RunStatus>>(
          (byTab, run) => {
            const tabId = state.runTabIds[run.runId];
            return run.role === "consult" && tabId !== undefined
              ? { ...byTab, [tabId]: run }
              : byTab;
          },
          state.lastConsultsByTab,
        );
        return {
          ...state,
          connection: action.value,
          runs: [],
          lastRun: lastExecute ?? state.lastRun,
          lastConsult: lastConsultLive ?? state.lastConsult,
          lastConsults,
          lastConsultsByTab,
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
      const lastConsultsByTab = { ...state.lastConsultsByTab };
      if (action.tabId !== undefined) delete lastConsultsByTab[action.tabId];
      return {
        ...state,
        lastConsultsByTab,
        items: state.items.filter((item) => {
          if (state.runs.some((run) => run.runId === item.runId)) return true;
          if (action.tabId !== undefined) return state.runTabIds[item.runId] !== action.tabId;
          return action.workspaceId !== undefined && state.runWorkspaceIds[item.runId] !== action.workspaceId;
        }),
      };

    case "claim_workspace": {
      const runTabIds = { ...state.runTabIds };
      const tabSessions = { ...state.tabSessions };
      for (const [runId, workspaceId] of Object.entries(state.runWorkspaceIds)) {
        if (workspaceId === action.workspaceId && runTabIds[runId] === undefined) {
          runTabIds[runId] = action.tabId;
        }
        if (workspaceId === action.workspaceId && runTabIds[runId] === action.tabId) {
          const run = state.runs.find((candidate) => candidate.runId === runId);
          const sessionId = state.runSessionIds[runId];
          if (run?.role === "execute" && run.source.type === "custom" && sessionId !== undefined) {
            tabSessions[action.tabId] = {
              ...tabSessions[action.tabId],
              [run.provider]: { sessionId, workspaceId: action.workspaceId },
            };
          }
        }
      }
      const previousConsult = state.lastConsults[action.workspaceId];
      const ownsPreviousConsult = previousConsult !== undefined
        && runTabIds[previousConsult.runId] === action.tabId;
      return {
        ...state,
        runTabIds,
        tabSessions,
        lastConsultsByTab: !ownsPreviousConsult
          ? state.lastConsultsByTab
          : { ...state.lastConsultsByTab, [action.tabId]: previousConsult },
      };
    }

    case "restore_thread": {
      const ordered = [...action.sessions].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
      if (ordered.length === 0) return state;
      const restoredIds = new Set(ordered.map((session) => session.id));
      const liveIds = new Set(state.runs.map((run) => run.runId));
      let restored = state.items.filter((item) => !restoredIds.has(item.runId) || liveIds.has(item.runId));
      const runWorkspaceIds = { ...state.runWorkspaceIds };
      const runTabIds = { ...state.runTabIds };
      const runSessionIds = { ...state.runSessionIds };
      const providerSessions = { ...state.tabSessions[action.tabId] };
      for (const session of ordered) {
        runWorkspaceIds[session.id] = session.workspaceId;
        runTabIds[session.id] = action.tabId;
        if (session.providerSessionId !== null) {
          runSessionIds[session.id] = session.providerSessionId;
          providerSessions[session.provider as ProviderId] = {
            sessionId: session.providerSessionId,
            workspaceId: session.workspaceId,
          };
        }
        if (liveIds.has(session.id)) continue;
        if (session.displayText !== null && session.displayText !== "") {
          restored = appendPrompt(restored, {
            runId: session.id,
            provider: session.provider as ProviderId,
            model: session.model,
            text: session.displayText,
            timestamp: session.startedAt,
          });
        }
        for (const event of session.events) restored = applyEvent(restored, event);
      }
      return {
        ...state,
        items: restored,
        runWorkspaceIds,
        runTabIds,
        runSessionIds,
        tabSessions: { ...state.tabSessions, [action.tabId]: providerSessions },
      };
    }

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
          // A hello is authoritative for live runs. Requests whose process
          // vanished while the socket was down cannot still be answered.
          let inputRequests = Object.fromEntries(Object.entries(state.inputRequests).filter(([runId]) => liveIds.has(runId)));
          for (const snapshot of message.activeRuns) inputRequests = replayInputRequests(inputRequests, snapshot.events);
          return {
            ...state,
            providers: message.providers,
            items: [...finished, ...replayed],
            runs: message.activeRuns.map(toRunStatus),
            runWorkspaceIds: message.activeRuns.reduce<Record<string, number>>(
              (owners, snapshot) => ({ ...owners, [snapshot.runId]: snapshot.workspace.id }),
              state.runWorkspaceIds,
            ),
            runTabIds: message.activeRuns.reduce<Record<string, string>>(
              (owners, snapshot) => snapshot.source.type === "custom" && snapshot.source.threadId !== undefined
                ? { ...owners, [snapshot.runId]: snapshot.source.threadId }
                : owners,
              state.runTabIds,
            ),
            runSessionIds: message.activeRuns.reduce<Record<string, string>>(
              (sessions, snapshot) => {
                const sessionId = sessionAnnouncedBy(snapshot.events);
                return sessionId === undefined ? sessions : { ...sessions, [snapshot.runId]: sessionId };
              },
              state.runSessionIds,
            ),
            consultIds: message.activeRuns.reduce(
              (ids, snapshot) =>
                (snapshot.role ?? "execute") === "consult" ? rememberConsultId(ids, snapshot.runId) : ids,
              state.consultIds,
            ),
            inputRequests,
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
          const role = message.role ?? "execute";
          const ownerTabId = action.tabId
            ?? (message.source.type === "custom" ? message.source.threadId : undefined);
          const pendingLaunches = action.requestId === undefined
            ? state.pendingLaunches
            : state.pendingLaunches.filter((launch) => launch.requestId !== action.requestId);
          const launchFailuresByTab = { ...state.launchFailuresByTab };
          if (action.tabId !== undefined) delete launchFailuresByTab[action.tabId];
          // `hello` may already have replayed this run; still settle its pending request.
          if (state.runs.some((run) => run.runId === message.runId)) {
            return { ...state, pendingLaunches, launchFailuresByTab };
          }
          return {
            ...state,
            pendingLaunches,
            launchFailuresByTab,
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
            runWorkspaceIds: {
              ...state.runWorkspaceIds,
              [message.runId]: message.workspace.id,
            },
            runTabIds: ownerTabId === undefined
              ? state.runTabIds
              : { ...state.runTabIds, [message.runId]: ownerTabId },
          };
        }

        case "run_rejected": {
          const launch = state.pendingLaunches.find((item) => item.requestId === message.clientRequestId);
          if (launch === undefined) return state;
          return {
            ...state,
            pendingLaunches: state.pendingLaunches.filter((item) => item.requestId !== message.clientRequestId),
            launchFailuresByTab: {
              ...state.launchFailuresByTab,
              [launch.tabId]: message.detail === null ? message.message : `${message.message} ${message.detail}`,
            },
          };
        }

        case "event": {
          const event = message.event;
          const items = applyEvent(state.items, event);
          if (event.type === "input_request") {
            return { ...state, items, inputRequests: { ...state.inputRequests, [event.runId]: { runId: event.runId, ...event.payload } } };
          }
          if (event.type === "input_response") {
            const inputRequests = { ...state.inputRequests };
            delete inputRequests[event.runId];
            return { ...state, items, inputRequests };
          }
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
          const tabId = state.runTabIds[event.runId];
          const announcedSession = event.payload.sessionId;
          const shouldRememberSession =
            current.role === "execute"
            && current.source.type === "custom"
            && tabId !== undefined
            && typeof announcedSession === "string"
            && announcedSession !== "";
          return {
            ...state,
            items,
            runs,
            runSessionIds: typeof announcedSession === "string" && announcedSession !== ""
              ? { ...state.runSessionIds, [event.runId]: announcedSession }
              : state.runSessionIds,
            tabSessions: !shouldRememberSession
              ? state.tabSessions
              : {
                  ...state.tabSessions,
                  [tabId]: {
                    ...state.tabSessions[tabId],
                    [current.provider]: { sessionId: announcedSession, workspaceId: current.workspace.id },
                  },
                },
          };
        }

        case "run_ended": {
          const ended = state.runs.find((run) => run.runId === message.runId);
          if (ended === undefined) return state;
          const remaining = state.runs.filter((run) => run.runId !== message.runId);
          const inputRequests = { ...state.inputRequests };
          delete inputRequests[message.runId];
          const closed = { ...ended, state: message.state, detail: null };
          if (ended.role === "consult") {
            const tabId = state.runTabIds[ended.runId];
            return {
              ...state,
              inputRequests,
              runs: remaining,
              lastConsult: closed,
              lastConsults: { ...state.lastConsults, [closed.workspace.id]: closed },
              lastConsultsByTab: tabId === undefined
                ? state.lastConsultsByTab
                : { ...state.lastConsultsByTab, [tabId]: closed },
            };
          }
          return { ...state, runs: remaining, lastRun: closed, inputRequests };
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
  /** Transcript lines belonging to one workspace, including completed runs. */
  itemsForWorkspace(workspaceId: number): LogItem[];
  /** Transcript lines launched from one browser-local work tab. */
  itemsForTab(tabId: string): LogItem[];
  startRun(
    workspaceId: number,
    provider: ProviderId,
    source: { prompt: string } | { promptId: number },
    model: string | null,
    tabId?: string,
  ): boolean;
  startConsult(
    workspaceId: number,
    provider: ProviderId,
    source: { prompt: string } | { promptId: number } | { prompt: string; promptId: number },
    model: string | null,
    tabId?: string,
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
  answerInput(runId: string, requestId: string, answers: Record<string, AgentInputAnswer>): boolean;
  clearLog(): void;
  clearWorkspaceLog(workspaceId: number): void;
  clearTabLog(tabId: string): void;
  /** Rebuild a persisted custom conversation in its original Chat tab. */
  restoreThread(tabId: string, sessions: AgentSession[]): void;
  claimWorkspaceRuns(tabId: string, workspaceId: number): void;
  dismissLaunchFailure(tabId: string): void;
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
  const pendingTabsRef = useRef<Array<{
    workspaceId: number;
    provider: ProviderId;
    role: RunRole;
    tabId: string;
    requestId: string;
  }>>([]);

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
          const message = JSON.parse(String(raw.data)) as ServerMessage;
          let tabId: string | undefined;
          let requestId: string | undefined;
          if (message.kind === "run_started") {
            const index = pendingTabsRef.current.findIndex((pending) =>
              pending.workspaceId === message.workspace.id
              && pending.provider === message.provider
              && pending.role === (message.role ?? "execute"));
            if (index !== -1) {
              const pending = pendingTabsRef.current[index]!;
              tabId = pending.tabId;
              requestId = pending.requestId;
              pendingTabsRef.current.splice(index, 1);
            }
          } else if (message.kind === "run_rejected") {
            const index = pendingTabsRef.current.findIndex((pending) => pending.requestId === message.clientRequestId);
            if (index !== -1) pendingTabsRef.current.splice(index, 1);
          }
          dispatch({ type: "server", message, tabId, requestId });
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
    const startOwnedRun = (message: Extract<ClientMessage, { kind: "run" }>, tabId?: string) => {
      const requestId = `launch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      if (tabId !== undefined) {
        const launch = { requestId, tabId, role: message.role ?? "execute" };
        dispatch({ type: "launch_queued", launch });
        pendingTabsRef.current.push({
          workspaceId: message.workspaceId,
          provider: message.provider,
          role: message.role ?? "execute",
          tabId,
          requestId,
        });
      }
      const started = send({ ...message, clientRequestId: requestId });
      if (!started && tabId !== undefined) {
        const index = pendingTabsRef.current.findIndex((pending) => pending.requestId === requestId);
        if (index !== -1) pendingTabsRef.current.splice(index, 1);
        dispatch({ type: "launch_send_failed", requestId });
      }
      return started;
    };
    return {
      ...state,
      run,
      itemsFor: (runId) => state.items.filter((item) => item.runId === runId),
      itemsForWorkspace: (workspaceId) =>
        state.items.filter((item) => state.runWorkspaceIds[item.runId] === workspaceId),
      itemsForTab: (tabId) => state.items.filter((item) => state.runTabIds[item.runId] === tabId),
      startRun: (workspaceId, provider, source, model, tabId) =>
        startOwnedRun({
          kind: "run",
          workspaceId,
          provider,
          ...source,
          model,
          role: "execute",
          ...(tabId !== undefined
            && "prompt" in source
            && state.tabSessions[tabId]?.[provider]?.workspaceId === workspaceId
            ? { resumeSessionId: state.tabSessions[tabId]![provider]!.sessionId }
            : {}),
          ...(tabId !== undefined && "prompt" in source ? { threadId: tabId } : {}),
        }, tabId),
      startConsult: (workspaceId, provider, source, model, tabId) =>
        startOwnedRun({ kind: "run", workspaceId, provider, ...source, model, role: "consult" }, tabId),
      askClarification: (workspaceId, provider, promptId, question, model) =>
        send({ kind: "run", mode: "clarify", workspaceId, provider, promptId, question, model, role: "execute" }),
      verifySuite: (suiteId, provider, model, promptId) =>
        send({ kind: "verify_suite", suiteId, provider, model, promptId: promptId ?? null }),
      interrupt: (runId) => {
        const target = runId ?? run?.runId;
        if (target === undefined) return false;
        return send({ kind: "interrupt", runId: target });
      },
      answerInput: (runId, requestId, answers) => send({ kind: "input_response", runId, requestId, answers }),
      clearLog: () => dispatch({ type: "clear" }),
      clearWorkspaceLog: (workspaceId) => dispatch({ type: "clear", workspaceId }),
      clearTabLog: (tabId) => dispatch({ type: "clear", tabId }),
      restoreThread: (tabId, sessions) => dispatch({ type: "restore_thread", tabId, sessions }),
      claimWorkspaceRuns: (tabId, workspaceId) => dispatch({ type: "claim_workspace", tabId, workspaceId }),
      dismissLaunchFailure: (tabId) => dispatch({ type: "dismiss_launch_failure", tabId }),
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
