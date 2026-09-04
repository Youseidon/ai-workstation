import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "@agent-console/shared";
import { isRunRole } from "@agent-console/shared";
import { config } from "./config.ts";
import { collectAccountUsage, detectProviders } from "./adapters/registry.ts";
import { resetSettings, snapshot, updateSettings } from "./settings.ts";
import { createLogger } from "./lib/logger.ts";
import { acquireInstanceLock, InstanceLockedError, type InstanceLock } from "./lib/instanceLock.ts";
import { runRoleStartError } from "./runner.ts";
import { handleWorkspaceApi } from "./workspaceApi.ts";
import { DECOMPOSE_MAX_DEPTH, WorkspaceError, workspaces } from "./workspaces.ts";
import { runContexts } from "./runContext.ts";
import { budgetMarkdown, contextMarkdown, progressApiMarkdown } from "./agentContext.ts";
import { hashRunToken } from "./runContext.ts";
import { runHub } from "./runHub.ts";
import { ProviderUnavailableError, consultContextText, startConsult, startExecute, startVerifySuite } from "./runService.ts";

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

  const agentMatch=url.pathname.match(/^\/api\/agent\/runs\/([^/]+)\/(context|state|remarks|status|decompose)$/);
  if(agentMatch){
    const runId=agentMatch[1]!;const operation=agentMatch[2]!;const authorization=req.headers.authorization??"";const token=authorization.startsWith("Bearer ")?authorization.slice(7):"";
    try{
      const memory=runContexts.authenticate(runId,token);if(!memory)throw new WorkspaceError(401,"invalid_run_token","Run credential is invalid or expired");
      const persisted=workspaces.authorizeAgentRun(runId,hashRunToken(token));if(memory.workspaceId!==persisted.workspaceId||memory.promptId!==persisted.promptId)throw new WorkspaceError(403,"run_scope_mismatch","Run credential scope does not match");
      res.setHeader("Cache-Control","no-store");
      if(persisted.role!=="execute"&&(operation==="remarks"||operation==="status"||operation==="decompose"))throw new WorkspaceError(403,"consult_read_only","Read-only runs cannot post remarks, status, or decompose.");
      if(operation==="context"&&req.method==="GET"){
        if(persisted.role==="consult"){
          const markdown=consultContextText(memory.workspaceId,persisted.promptId,memory.question);
          if(req.headers.accept?.includes("application/json"))sendJson(res,200,{purpose:"consult",markdown});
          else{res.writeHead(200,{"Content-Type":"text/markdown; charset=utf-8"});res.end(markdown);}
          return;
        }
        if(memory.promptId===null)throw new WorkspaceError(409,"run_not_active","Run is not attached to a work item");
        const context=workspaces.agentContext(memory.workspaceId,memory.promptId);
        const depth=workspaces.decomposeDepth(memory.promptId);
        const budget=runHub.get(runId)?.handle.budget()??null;
        if(req.headers.accept?.includes("application/json"))sendJson(res,200,{...context,budget});
        else{
          const api=progressApiMarkdown({runId,token,port:config.port,canDecompose:depth<DECOMPOSE_MAX_DEPTH});
          res.writeHead(200,{"Content-Type":"text/markdown; charset=utf-8"});
          res.end(`${contextMarkdown(context,"execute",{depth,maxDepth:DECOMPOSE_MAX_DEPTH})}\n\n${api}${budgetMarkdown(budget)}`);
        }
        return;
      }
      if(operation==="state"&&req.method==="GET"){
        if(memory.promptId===null){sendJson(res,200,{events:[],remarks:[],runs:[]});return;}
        sendJson(res,200,workspaces.promptHistory(memory.promptId));return;
      }
      if((operation==="remarks"||operation==="status"||operation==="decompose")&&req.method==="POST"){
        void readJsonBody(req).then(body=>{
          const result=operation==="remarks"?workspaces.addAgentRemark(runId,body):operation==="status"?workspaces.updateAgentStatus(runId,body):workspaces.decomposePrompt(runId,body);
          // The agent cannot see the runner's counters. Riding the reply it is
          // already making is the one channel that reaches every provider, so a
          // run learns to bank its work before the budget stops it.
          const live=runHub.get(runId)?.handle.budget()??null;
          sendJson(res,200,live===null?result:{...result as Record<string,unknown>,budget:live});
          runHub.operationsChanged();
          // A terminal status or a decompose is the agent's authoritative
          // signal that this run is done with the work item. End the provider
          // after the HTTP response is flushed so a CLI that waits after its
          // final tool call cannot leave DONE shown as WORKING.
          if(operation==="status"||operation==="decompose")void runHub.complete(runId);
        }).catch(error=>sendJson(res,error instanceof WorkspaceError?error.status:400,{error:{code:error instanceof WorkspaceError?error.code:"invalid_request",message:error instanceof Error?error.message:String(error)}}));return;
      }
      sendJson(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
    }catch(error){sendJson(res,error instanceof WorkspaceError?error.status:500,{error:{code:error instanceof WorkspaceError?error.code:"internal_error",message:error instanceof Error?error.message:"Agent API failed"}});}
    return;
  }

  if (url.pathname === "/api/sessions" || url.pathname === "/api/operations" || url.pathname === "/api/report" || url.pathname === "/api/pipelines" || url.pathname.startsWith("/api/workspaces") || /^\/api\/(programs|suites|prompts|runs|verifications|pipelines)\//.test(url.pathname)) {
    void handleWorkspaceApi(req, res, url);
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/providers") {
    const force = url.searchParams.get("refresh") === "1";
    detectProviders(force)
      .then((providers) => sendJson(res, 200, { providers }))
      .catch((error: unknown) => {
        log.error("provider detection failed", error);
        sendJson(res, 500, { error: "provider detection failed" });
      });
    return;
  }

  if (url.pathname === "/api/providers/usage") {
    const force = url.searchParams.get("refresh") === "1";
    collectAccountUsage(force)
      .then((usage) => sendJson(res, 200, { usage, fetchedAt: new Date().toISOString() }))
      .catch((error: unknown) => {
        log.error("provider usage fetch failed", error);
        sendJson(res, 500, { error: "provider usage fetch failed" });
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

  const send = (message: ServerMessage): void => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(message));
  };

  // Every client observes every run, including ones another tab started. This
  // is what makes navigating between pages — which tears down one socket and
  // opens another — keep showing a run that is still going.
  const unsubscribe = runHub.subscribe(send);

  const sendError = (message: string, detail: string | null = null): void => {
    send({
      kind: "event",
      event: {
        id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        runId: "none",
        provider: "claude",
        model: null,
        timestamp: new Date().toISOString(),
        type: "error",
        payload: { message, fatal: false, detail },
      },
    });
  };

  void detectProviders().then((providers) => {
    send({
      kind: "hello",
      providers,
      // Whatever is already running, with its transcript, so a page that opens
      // mid-run repaints it instead of showing an empty log.
      activeRuns: runHub.snapshots(),
    });
  });

  const mapStartError = (error: unknown, fallback: string): void => {
    sendError(
      error instanceof Error ? error.message : fallback,
      error instanceof WorkspaceError ? error.fields?.detail ?? null : null,
    );
    if (error instanceof ProviderUnavailableError) {
      send({ kind: "providers", providers: error.providers });
    }
  };

  const handleRun = async (
    workspaceId: number,
    prompt: string | undefined,
    promptId: number | undefined,
    providerId: string,
    model: string | null,
    mode: "execute"|"clarify" = "execute",
    question?: string,
  ): Promise<void> => {
    try {
      await startExecute({ workspaceId, prompt, promptId, provider: providerId, model, mode, question });
    } catch (error) {
      mapStartError(error, "Unable to resolve workspace");
    }
  };

  const handleConsult = async (
    workspaceId: number,
    prompt: string | undefined,
    promptId: number | undefined,
    providerId: string,
    model: string | null,
    question?: string,
  ): Promise<void> => {
    try {
      await startConsult({ workspaceId, prompt, promptId, provider: providerId, model, question });
    } catch (error) {
      mapStartError(error, "Unable to start consult");
    }
  };

  const handleVerifySuite = async (
    suiteId: number,
    providerId: string,
    model: string | null,
    promptId?: number | null,
  ): Promise<void> => {
    try {
      await startVerifySuite({ suiteId, provider: providerId, model, promptId });
    } catch (error) {
      mapStartError(error, "Unable to start verification");
    }
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
        if (parsed.role !== undefined && !isRunRole(parsed.role)) { sendError("Unknown run role."); return; }
        const role = parsed.role ?? "execute";
        if (role === "consult") {
          if (!hasPrompt && !hasPromptId) { sendError("Supply a prompt or promptId."); return; }
        } else if (hasPrompt === hasPromptId) {
          sendError("Supply exactly one of prompt or promptId.");
          return;
        }
        const mode=parsed.mode??"execute";
        if(mode!=="execute"&&mode!=="clarify"){sendError("Unknown run mode.");return;}
        if(mode==="clarify"&&(!hasPromptId||typeof parsed.question!=="string"||parsed.question.trim()==="")){sendError("Clarification requires a saved prompt and a question.");return;}
        const roleError = runRoleStartError(role, parsed.provider);
        if (roleError !== null) { sendError(roleError); return; }
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
        if (role === "consult") {
          void handleConsult(parsed.workspaceId, hasPrompt ? parsed.prompt : undefined, hasPromptId ? parsed.promptId : undefined, parsed.provider, model === "" ? null : model, parsed.question);
        } else {
          void handleRun(parsed.workspaceId, hasPrompt ? parsed.prompt : undefined, hasPromptId ? parsed.promptId : undefined, parsed.provider, model === "" ? null : model,mode,parsed.question);
        }
        return;
      }
      case "verify_suite": {
        if (!Number.isSafeInteger(parsed.suiteId) || parsed.suiteId <= 0) { sendError("A valid suite is required."); return; }
        if (parsed.model !== undefined && parsed.model !== null && typeof parsed.model !== "string") { sendError("Model must be a string."); return; }
        const verifyModel = typeof parsed.model === "string" ? parsed.model.trim() : "";
        if (verifyModel.length > MAX_MODEL_LENGTH) { sendError(`Model id is too long (max ${MAX_MODEL_LENGTH} characters).`); return; }
        const hasPromptId = parsed.promptId !== undefined && parsed.promptId !== null;
        if (hasPromptId && (!Number.isSafeInteger(parsed.promptId) || (parsed.promptId ?? 0) <= 0)) {
          sendError("A valid work item is required.");
          return;
        }
        void handleVerifySuite(
          parsed.suiteId,
          parsed.provider,
          verifyModel === "" ? null : verifyModel,
          hasPromptId ? parsed.promptId : null,
        );
        return;
      }
      case "interrupt": {
        // Any client may stop any run: the agent dock is on every page, and the
        // tab that started a run is often not the one watching it finish.
        if (typeof parsed.runId !== "string" || parsed.runId === "") return;
        void runHub.stop(parsed.runId);
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
    // Runs are owned by the hub, so closing a socket only stops the delivery of
    // events to it. Reconnecting replays whatever is still in flight.
    unsubscribe();
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

/**
 * Claimed once the port is bound, released on shutdown. Two servers sharing a
 * database is the failure this pair of guards exists to prevent: the port rules
 * out a second copy on the same port, the lock rules out one on a different
 * port, and only an owner may reconcile runs.
 */
let instanceLock: InstanceLock | null = null;

function releaseInstanceLock(): void {
  instanceLock?.release();
  instanceLock = null;
}

httpServer.listen(config.port, config.host, () => {
  try {
    instanceLock = acquireInstanceLock(`${workspaces.databasePath}.lock`);
  } catch (error) {
    if (error instanceof InstanceLockedError) {
      log.error(
        `another console (pid ${error.heldByPid}) is already using ${workspaces.databasePath} — ` +
          `two servers on one database corrupt each other's runs. Stop it, or point ` +
          `AGENT_CONSOLE_DB at a different file.`,
      );
      process.exit(1);
    }
    throw error;
  }
  // Safe only here: this process now demonstrably owns the database, so runs
  // still marked in flight really did die with the last one.
  workspaces.recoverAbandonedRuns();

  log.info(`http  http://${config.host}:${config.port}`);
  log.info(`ws    ws://${config.host}:${config.port}/ws`);
  log.info(`workspaces ${workspaces.list().length}`);
  void detectProviders(true).then((providers) => {
    for (const provider of providers) {
      const status = provider.available
        ? `available${provider.version ? ` (${provider.version})` : ""}`
        : `unavailable — ${provider.reason ?? "unknown"}`;
      log.info(`provider ${provider.id.padEnd(7)} ${status}`);
    }
  });
});

/**
 * Long enough for every provider to take its interrupt (the runner allows a run
 * two seconds to stop gracefully, then the spawn adapter another two before
 * SIGKILL), short enough that a stuck agent cannot hold the terminal.
 */
const SHUTDOWN_GRACE_MS = 10_000;

let shuttingDown = false;

const finish = () => {
  releaseInstanceLock();
  workspaces.close();
  process.exit(0);
};

const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down");
  wss.clients.forEach((client) => client.close());
  httpServer.close();
  // Runs are stopped before the database closes so each one records its own
  // terminal state. Without this the agents survive the server that owns them.
  void runHub.stopAll().then(finish, (error: unknown) => {
    log.error("failed to stop live runs", error);
    finish();
  });
  setTimeout(finish, SHUTDOWN_GRACE_MS).unref();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// A crash or an explicit exit still has to give up the claim, or the next boot
// finds a lock file whose owner is gone.
process.on("exit", releaseInstanceLock);
