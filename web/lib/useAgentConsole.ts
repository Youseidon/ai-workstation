"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type {
  ClientMessage,
  ProviderId,
  ProviderInfo,
  RunState,
  ServerMessage,
  TokenUsage,
} from "@agent-console/shared";
import { appendPrompt, applyEvent, type LogItem } from "./log";

export type ConnectionState = "connecting" | "open" | "disconnected";

export interface RunStatus {
  runId: string;
  provider: ProviderId;
  /** The model this run resolved to on the server, not the current selection. */
  model: string | null;
  state: RunState;
  elapsedMs: number;
  usage: TokenUsage | null;
  detail: string | null;
}

interface ConsoleState {
  connection: ConnectionState;
  providers: ProviderInfo[];
  workdir: string | null;
  items: LogItem[];
  /** Non-null exactly while a run is in flight. */
  run: RunStatus | null;
  /** Kept after a run ends so the status bar can show the final numbers. */
  lastRun: RunStatus | null;
}

type Action =
  | { type: "connection"; value: ConnectionState }
  | { type: "providers"; providers: ProviderInfo[]; workdir?: string }
  | { type: "server"; message: ServerMessage }
  | { type: "clear" };

const initialState: ConsoleState = {
  connection: "connecting",
  providers: [],
  workdir: null,
  items: [],
  run: null,
  lastRun: null,
};

function reducer(state: ConsoleState, action: Action): ConsoleState {
  switch (action.type) {
    case "connection":
      // A dropped socket cannot leave the UI stuck in "running" forever.
      if (action.value === "disconnected" && state.run !== null) {
        return { ...state, connection: action.value, run: null, lastRun: state.run };
      }
      return { ...state, connection: action.value };

    case "providers":
      return {
        ...state,
        providers: action.providers,
        workdir: action.workdir ?? state.workdir,
      };

    case "clear":
      return { ...state, items: [] };

    case "server": {
      const message = action.message;
      switch (message.kind) {
        case "hello":
          return { ...state, providers: message.providers, workdir: message.workdir };
        case "providers":
          return { ...state, providers: message.providers };
        case "settings_updated":
          // Another tab (or this one) changed settings: adopt the new workdir
          // and re-detected providers without a reload.
          return { ...state, providers: message.providers, workdir: message.workdir };
        case "run_started":
          return {
            ...state,
            items: appendPrompt(state.items, {
              runId: message.runId,
              provider: message.provider,
              model: message.model,
              text: message.prompt,
            }),
            run: {
              runId: message.runId,
              provider: message.provider,
              model: message.model,
              state: "starting",
              elapsedMs: 0,
              usage: null,
              detail: null,
            },
          };
        case "event": {
          const event = message.event;
          const items = applyEvent(state.items, event);
          if (event.type !== "status") return { ...state, items };
          if (state.run === null || state.run.runId !== event.runId) return { ...state, items };
          return {
            ...state,
            items,
            run: {
              ...state.run,
              state: event.payload.state,
              elapsedMs: event.payload.elapsedMs,
              usage: event.payload.usage ?? state.run.usage,
              detail: event.payload.detail ?? state.run.detail,
            },
          };
        }
        case "run_ended": {
          if (state.run === null || state.run.runId !== message.runId) return state;
          return {
            ...state,
            run: null,
            lastRun: { ...state.run, state: message.state, detail: null },
          };
        }
        case "pong":
          return state;
      }
    }
  }
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5000;

export function useAgentConsole(serverUrl: string) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const socketRef = useRef<WebSocket | null>(null);

  const wsUrl = useMemo(() => {
    const url = new URL("/ws", serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }, [serverUrl]);

  // Populate the switcher even if the socket never comes up.
  const refreshProviders = useCallback(async () => {
    try {
      const response = await fetch(new URL("/api/providers?refresh=1", serverUrl), {
        cache: "no-store",
      });
      if (!response.ok) return;
      const body = (await response.json()) as { providers: ProviderInfo[]; workdir: string };
      dispatch({ type: "providers", providers: body.providers, workdir: body.workdir });
    } catch {
      // The socket's `hello` is the other path to this data.
    }
  }, [serverUrl]);

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

  const startRun = useCallback(
    (workspaceId: number, provider: ProviderId, source: { prompt: string } | { promptId: number }, model: string | null) =>
      send({ kind: "run", workspaceId, provider, ...source, model }),
    [send],
  );

  const interrupt = useCallback(() => {
    if (state.run === null) return false;
    return send({ kind: "interrupt", runId: state.run.runId });
  }, [send, state.run]);

  const clearLog = useCallback(() => dispatch({ type: "clear" }), []);

  return { ...state, startRun, interrupt, clearLog, refreshProviders };
}
