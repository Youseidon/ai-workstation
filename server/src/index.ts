import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "@agent-console/shared";
import { isProviderId } from "@agent-console/shared";
import { config } from "./config.ts";
import { settings } from "./settings.ts";
import { detectProviders, getAdapter } from "./adapters/registry.ts";
import { resetSettings, snapshot, updateSettings } from "./settings.ts";
import { createLogger } from "./lib/logger.ts";
import { startRun, type RunHandle } from "./runner.ts";
import { handleWorkspaceApi } from "./workspaceApi.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

const log = createLogger("server");

/* -------------------------------------------------------------------------- */
/* HTTP: detection + health                                                    */
/* -------------------------------------------------------------------------- */

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

const MAX_BODY_BYTES = 64 * 1024;

/** A model id is a short slug; anything longer is a malformed or hostile frame. */
const MAX_MODEL_LENGTH = 200;

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (raw.trim() === "") {
        resolvePromise({});
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error("body must be a JSON object"));
          return;
        }
        resolvePromise(parsed as Record<string, unknown>);
      } catch {
        reject(new Error("body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Settings changes alter what the providers are and where they run, so every
 * open tab is told to re-read both.
 */
async function broadcastSettingsChange(): Promise<void> {
  const providers = await detectProviders(true);
  const message: ServerMessage = {
    kind: "settings_updated",
    workdir: settings.workdir,
    providers,
  };
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

const httpServer = createServer((req, res) => {
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname.startsWith("/api/workspaces") || /^\/api\/(programs|suites|prompts)\//.test(url.pathname)) {
    void handleWorkspaceApi(req, res, url);
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, workdir: settings.workdir, workdirExists: settings.workdirExists });
    return;
  }

  if (url.pathname === "/api/providers") {
    const force = url.searchParams.get("refresh") === "1";
    detectProviders(force)
      .then((providers) => sendJson(res, 200, { workdir: settings.workdir, providers }))
      .catch((error: unknown) => {
        log.error("provider detection failed", error);
        sendJson(res, 500, { error: "provider detection failed" });
      });
    return;
  }

  if (url.pathname === "/api/settings") {
    if (req.method === "GET") {
      sendJson(res, 200, snapshot());
      return;
    }
    if (req.method === "PUT" || req.method === "POST") {
      readJsonBody(req)
        .then(async (body) => {
          // Accept both `{ "codex.model": "..." }` and `{ patch: { ... } }`.
          const patch = (body.patch ?? body) as Record<string, never>;
          const result = updateSettings(patch);
          if (!result.ok) {
            sendJson(res, 400, { errors: result.errors, snapshot: result.snapshot });
            return;
          }
          if (result.changed.length > 0) await broadcastSettingsChange();
          sendJson(res, 200, { changed: result.changed, snapshot: result.snapshot });
        })
        .catch((error: unknown) => {
          sendJson(res, 400, { errors: [error instanceof Error ? error.message : String(error)] });
        });
      return;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  if (url.pathname === "/api/settings/reset" && req.method === "POST") {
    readJsonBody(req)
      .then(async (body) => {
        const keys = Array.isArray(body.keys)
          ? body.keys.filter((key): key is string => typeof key === "string")
          : undefined;
        const result = resetSettings(keys);
        if (!result.ok) {
          sendJson(res, 400, { errors: result.errors, snapshot: result.snapshot });
          return;
        }
        if (result.changed.length > 0) await broadcastSettingsChange();
        sendJson(res, 200, { changed: result.changed, snapshot: result.snapshot });
      })
      .catch((error: unknown) => {
        sendJson(res, 400, { errors: [error instanceof Error ? error.message : String(error)] });
      });
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

/* -------------------------------------------------------------------------- */
/* WebSocket: one connection per browser tab, one run at a time                */
/* -------------------------------------------------------------------------- */

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !config.allowedOrigins.includes(origin)) {
    log.warn(`rejected websocket upgrade from origin ${origin}`);
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

let connectionCounter = 0;

wss.on("connection", (ws: WebSocket) => {
  const connectionId = ++connectionCounter;
  const connLog = createLogger(`ws#${connectionId}`);
  connLog.info("connected");

  let activeRun: RunHandle | null = null;

  const send = (message: ServerMessage): void => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(message));
  };

  const sendError = (message: string, detail: string | null = null): void => {
    send({
      kind: "event",
      event: {
        id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        runId: activeRun?.runId ?? "none",
        provider: activeRun?.provider ?? "claude",
        model: activeRun?.model ?? null,
        timestamp: new Date().toISOString(),
        type: "error",
        payload: { message, fatal: false, detail },
      },
    });
  };

  void detectProviders().then((providers) => {
    send({ kind: "hello", workdir: settings.workdir, providers });
  });

  const handleRun = async (
    workspaceId: number,
    prompt: string | undefined,
    promptId: number | undefined,
    providerId: string,
    model: string | null,
  ): Promise<void> => {
    if (activeRun !== null) {
      sendError("A run is already in progress on this connection.");
      return;
    }
    if (!isProviderId(providerId)) {
      sendError(`Unknown provider "${providerId}".`);
      return;
    }
    const providers = await detectProviders(true);
    const info = providers.find((provider) => provider.id === providerId);
    if (info === undefined || !info.available) {
      sendError(
        `Provider "${providerId}" is not available.`,
        info?.reason ?? "detection failed",
      );
      send({ kind: "providers", providers });
      return;
    }
    let workspace;
    let resolvedPrompt: string;
    let savedPrompt: { id: number; title: string } | null = null;
    try {
      workspace = workspaces.get(workspaceId);
      if (!workspace.workDirectoryExists) throw new WorkspaceError(422, "invalid_directory", `Workspace directory does not exist: ${workspace.workDirectory}`);
      if (promptId !== undefined) {
        const record = workspaces.resolvePrompt(workspaceId, promptId);
        resolvedPrompt = record.content;
        savedPrompt = { id: record.id, title: record.title };
      } else {
        resolvedPrompt = prompt?.trim() ?? "";
        if (resolvedPrompt === "") throw new WorkspaceError(422, "validation_error", "Prompt is empty");
      }
    } catch (error) {
      sendError(error instanceof Error ? error.message : "Unable to resolve workspace");
      return;
    }

    const handle = startRun({
      adapter: getAdapter(providerId),
      prompt: resolvedPrompt,
      cwd: workspace.workDirectory,
      model,
      onEvent: (event) => send({ kind: "event", event }),
      onEnd: (runId, state) => {
        activeRun = null;
        send({ kind: "run_ended", runId, state });
      },
    });
    activeRun = handle;
    send({
      kind: "run_started",
      runId: handle.runId,
      provider: providerId,
      model: handle.model,
      prompt: resolvedPrompt,
      workspace: { id: workspace.id, name: workspace.name, workDirectory: workspace.workDirectory },
      savedPrompt,
    });
    void handle.done.catch((error: unknown) => connLog.error("run failed", error));
  };

  ws.on("message", (raw) => {
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      sendError("Malformed message from client.");
      return;
    }

    switch (parsed.kind) {
      case "run": {
        if (!Number.isSafeInteger(parsed.workspaceId) || parsed.workspaceId <= 0) {
          sendError("A valid workspace is required.");
          return;
        }
        const hasPrompt = typeof parsed.prompt === "string" && parsed.prompt.trim() !== "";
        const hasPromptId = Number.isSafeInteger(parsed.promptId) && (parsed.promptId ?? 0) > 0;
        if (hasPrompt === hasPromptId) { sendError("Supply exactly one of prompt or promptId."); return; }
        // An absent/blank model means "fall back to the configured one"; a
        // non-string is a malformed frame rather than a silent default.
        if (parsed.model !== undefined && parsed.model !== null && typeof parsed.model !== "string") {
          sendError("Model must be a string.");
          return;
        }
        const model = typeof parsed.model === "string" ? parsed.model.trim() : "";
        if (model.length > MAX_MODEL_LENGTH) {
          sendError(`Model id is too long (max ${MAX_MODEL_LENGTH} characters).`);
          return;
        }
        void handleRun(parsed.workspaceId, hasPrompt ? parsed.prompt : undefined, hasPromptId ? parsed.promptId : undefined, parsed.provider, model === "" ? null : model);
        return;
      }
      case "interrupt": {
        if (activeRun === null) return;
        if (parsed.runId && parsed.runId !== activeRun.runId) return;
        void activeRun.interrupt();
        return;
      }
      case "refresh_providers": {
        void detectProviders(true).then((providers) => send({ kind: "providers", providers }));
        return;
      }
      case "ping":
        send({ kind: "pong" });
        return;
      default:
        sendError("Unsupported message kind.");
    }
  });

  ws.on("close", () => {
    connLog.info("disconnected");
    if (activeRun !== null) {
      connLog.info("interrupting run because the client disconnected");
      void activeRun.interrupt();
      activeRun = null;
    }
  });

  ws.on("error", (error) => connLog.warn("socket error", error));
});

/* -------------------------------------------------------------------------- */

// A port clash is an ordinary situation for a local dev tool; say so plainly
// instead of letting an unhandled 'error' event throw a raw stack trace.
httpServer.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    log.error(
      `port ${config.port} is already in use on ${config.host} — another copy of the ` +
        `console is probably running. Stop it, or set PORT in .env to something else.`,
    );
    process.exit(1);
  }
  log.error("http server error", error);
  process.exit(1);
});

httpServer.listen(config.port, config.host, () => {
  log.info(`http  http://${config.host}:${config.port}`);
  log.info(`ws    ws://${config.host}:${config.port}/ws`);
  log.info(`workdir ${settings.workdir}${settings.workdirExists ? "" : "  (MISSING)"}`);
  void detectProviders(true).then((providers) => {
    for (const provider of providers) {
      const status = provider.available
        ? `available${provider.version ? ` (${provider.version})` : ""}`
        : `unavailable — ${provider.reason ?? "unknown"}`;
      log.info(`provider ${provider.id.padEnd(7)} ${status}`);
    }
  });
});

const shutdown = () => {
  log.info("shutting down");
  wss.clients.forEach((client) => client.close());
  httpServer.close(() => { workspaces.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 2000).unref();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
