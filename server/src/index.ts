import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "@agent-console/shared";
import { isProviderId } from "@agent-console/shared";
import { config } from "./config.ts";
import { settings } from "./settings.ts";
import { detectProviders, getAdapter } from "./adapters/registry.ts";
import { resetSettings, snapshot, updateSettings } from "./settings.ts";
import { createLogger } from "./lib/logger.ts";
import { startRun } from "./runner.ts";
import { handleWorkspaceApi } from "./workspaceApi.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";
import { runContexts } from "./runContext.ts";
import { contextMarkdown } from "./agentContext.ts";
import { hashRunToken } from "./runContext.ts";
import { newId } from "./lib/ids.ts";
import { runHub } from "./runHub.ts";

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

  const agentMatch=url.pathname.match(/^\/api\/agent\/runs\/([^/]+)\/(context|state|remarks|status)$/);
  if(agentMatch){
    const runId=agentMatch[1]!;const operation=agentMatch[2]!;const authorization=req.headers.authorization??"";const token=authorization.startsWith("Bearer ")?authorization.slice(7):"";
    try{
      const memory=runContexts.authenticate(runId,token);if(!memory)throw new WorkspaceError(401,"invalid_run_token","Run credential is invalid or expired");
      const persisted=workspaces.authorizeAgentRun(runId,hashRunToken(token));if(memory.workspaceId!==persisted.workspaceId||memory.promptId!==persisted.promptId)throw new WorkspaceError(403,"run_scope_mismatch","Run credential scope does not match");
      res.setHeader("Cache-Control","no-store");
      if(operation==="context"&&req.method==="GET"){
        const context=workspaces.agentContext(memory.workspaceId,memory.promptId);
        if(req.headers.accept?.includes("application/json"))sendJson(res,200,context);else{const api=`## Progress API\n\nThis run is already marked IN_PROGRESS. Use only these endpoints for orchestration records; never open or modify SQLite directly.\n\nPost a remark with:\n\n\`\`\`bash\ncurl -fsS -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' http://127.0.0.1:${config.port}/api/agent/runs/${runId}/remarks -d '{"requestId":"unique-remark-id","kind":"PROGRESS","content":"What changed or was discovered"}'\n\`\`\`\n\nAllowed remark kinds: PROGRESS, FINDING, DECISION_NEEDED, BLOCKER, VERIFICATION, COMPLETION.\n\nBefore finishing, post exactly one terminal prompt status. For success:\n\n\`\`\`bash\ncurl -fsS -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' http://127.0.0.1:${config.port}/api/agent/runs/${runId}/status -d '{"requestId":"unique-status-id","expectedStatus":"IN_PROGRESS","status":"DONE","reason":"Completed","verificationSummary":"Commands run and observable results"}'\n\`\`\`\n\nBLOCKED is only valid for a concrete external dependency that requires human action after safe in-scope alternatives have been exhausted. Remaining implementation work is not a blocker. For BLOCKED, provide observed evidence in reason and put the exact action only the human can take in verificationSummary:\n\n\`\`\`bash\ncurl -fsS -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' http://127.0.0.1:${config.port}/api/agent/runs/${runId}/status -d '{"requestId":"unique-status-id","expectedStatus":"IN_PROGRESS","status":"BLOCKED","reason":"Observed evidence showing why execution cannot continue","verificationSummary":"Exact action only the human can take"}'\n\`\`\`\n\nEvery requestId must be unique for this run.\n\n`;res.writeHead(200,{"Content-Type":"text/markdown; charset=utf-8"});res.end(`${contextMarkdown(context)}\n\n${api}`);}return;
      }
      if(operation==="state"&&req.method==="GET"){sendJson(res,200,workspaces.promptHistory(memory.promptId));return;}
      if((operation==="remarks"||operation==="status")&&req.method==="POST"){
        void readJsonBody(req).then(body=>{
          const result=operation==="remarks"?workspaces.addAgentRemark(runId,body):workspaces.updateAgentStatus(runId,body);
          sendJson(res,200,result);
          runHub.operationsChanged();
        }).catch(error=>sendJson(res,error instanceof WorkspaceError?error.status:400,{error:{code:error instanceof WorkspaceError?error.code:"invalid_request",message:error instanceof Error?error.message:String(error)}}));return;
      }
      sendJson(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
    }catch(error){sendJson(res,error instanceof WorkspaceError?error.status:500,{error:{code:error instanceof WorkspaceError?error.code:"internal_error",message:error instanceof Error?error.message:"Agent API failed"}});}
    return;
  }

  if (url.pathname === "/api/sessions" || url.pathname === "/api/operations" || url.pathname.startsWith("/api/workspaces") || /^\/api\/(programs|suites|prompts|runs|verifications)\//.test(url.pathname)) {
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
      workdir: settings.workdir,
      providers,
      // Whatever is already running, with its transcript, so a page that opens
      // mid-run repaints it instead of showing an empty log.
      activeRuns: runHub.snapshots(),
    });
  });

  const handleRun = async (
    workspaceId: number,
    prompt: string | undefined,
    promptId: number | undefined,
    providerId: string,
    model: string | null,
    mode: "execute"|"clarify" = "execute",
    question?: string,
  ): Promise<void> => {
    const busy = runHub.activeForWorkspace(workspaceId);
    if (busy !== undefined) {
      // One workspace is one working directory. Two agents editing the same
      // tree at once corrupt each other; the old per-connection guard happily
      // allowed it as soon as you opened a second tab.
      sendError(
        `A run is already in progress in this workspace (${busy.provider}${busy.model === null ? "" : ` · ${busy.model}`}).`,
        "Stop the running agent before starting another in the same working directory.",
      );
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
    let savedPrompt: ReturnType<typeof workspaces.resolvePrompt> | null = null;
    let customDisplay = "";
    let clarificationId:number|null=null;
    // Scoped to this run, not the connection: runs outlive the socket now.
    let activeContextRunId: string | null = null;
    const plannedRunId=newId("run");
    try {
      workspace = workspaces.get(workspaceId);
      if (!workspace.workDirectoryExists) throw new WorkspaceError(422, "invalid_directory", `Workspace directory does not exist: ${workspace.workDirectory}`);
      if (promptId !== undefined) {
        const record = workspaces.resolvePrompt(workspaceId, promptId);
        savedPrompt = record;
        if(mode==="clarify"){
          if(record.status!=="BLOCKED")throw new WorkspaceError(409,"prompt_not_blocked","Clarification is only available while a prompt is blocked");
          if(typeof question!=="string"||question.trim()==="")throw new WorkspaceError(422,"validation_error","A clarification question is required");
          clarificationId=workspaces.beginClarification(promptId,question,providerId,model);
          resolvedPrompt=`${contextMarkdown(workspaces.agentContext(workspaceId,promptId),"clarify")}\n\n## Human question\n\n${question.trim()}`;
        }else{
        if (!record.ready) throw new WorkspaceError(409, "dependencies_incomplete", `Prompt is waiting on: ${record.blockedBy.join(", ")}`);
        const credential=runContexts.create(plannedRunId,workspaceId,promptId);
        try{workspaces.beginAgentRun({runId:plannedRunId,workspaceId,promptId,provider:providerId,model,tokenHash:credential.tokenHash,expiresAt:credential.expiresAt});}catch(error){runContexts.revoke(plannedRunId);throw error;}
        activeContextRunId=plannedRunId;
        const contextUrl=`http://127.0.0.1:${config.port}/api/agent/runs/${plannedRunId}/context`;
        resolvedPrompt=`Execute saved work item ${record.externalKey??record.title}. Before doing anything else, retrieve its authoritative context with:\n\ncurl -fsS -H 'Authorization: Bearer ${credential.token}' ${contextUrl}\n\nThe database endpoint is the source of truth. Do not search for a Markdown prompt file and never modify SQLite directly. Follow the complete context returned by the endpoint, post remarks through its Progress API, and post a final DONE or BLOCKED status before finishing.`;
        }
      } else {
        resolvedPrompt = prompt?.trim() ?? "";
        customDisplay = resolvedPrompt;
        if (resolvedPrompt === "") throw new WorkspaceError(422, "validation_error", "Prompt is empty");
        if (workspace.description.trim() !== "") resolvedPrompt = `${workspace.description.trim()}\n\n---\n\n# Work item\n\n${resolvedPrompt}`;
      }
    } catch (error) {
      sendError(error instanceof Error ? error.message : "Unable to resolve workspace");
      return;
    }

    let clarificationAnswer="";
    let executionAnswer="";
    const handle = startRun({
      runId:plannedRunId,
      adapter: getAdapter(providerId),
      prompt: resolvedPrompt,
      cwd: workspace.workDirectory,
      model,
      onEvent: (event) => {if(event.type==="assistant_text"&&event.payload.kind==="message"){if(clarificationId!==null)clarificationAnswer+=event.payload.text;else if(activeContextRunId!==null)executionAnswer+=event.payload.text;}if(event.type==="result"&&event.payload.text){if(clarificationId!==null)clarificationAnswer=event.payload.text;else if(activeContextRunId!==null)executionAnswer=event.payload.text;}if(activeContextRunId!==null)workspaces.recordAgentEvent(activeContextRunId,event);runHub.event(plannedRunId,event);},
      onEnd: (runId, state) => {
        if(activeContextRunId!==null){workspaces.finishAgentRun(activeContextRunId,state,executionAnswer);runContexts.complete(activeContextRunId);activeContextRunId=null;}
        if(clarificationId!==null)workspaces.finishClarification(clarificationId,state==="done"?"DONE":state==="interrupted"?"INTERRUPTED":"ERROR",clarificationAnswer);
        // Deregisters and tells every client, not just the one that started it.
        runHub.end(runId, state);
      },
    });
    // Marked RUNNING before the announcement, so a client that reacts to
    // run_started by refetching never reads a stale STARTING row.
    if(savedPrompt!==null&&mode==="execute")workspaces.markAgentRunRunning(handle.runId);
    runHub.start({
      handle,
      workspace: { id: workspace.id, name: workspace.name, workDirectory: workspace.workDirectory },
      source:savedPrompt===null?{type:"custom",displayText:customDisplay}:mode==="clarify"?{type:"clarification",promptId:savedPrompt.id,promptKey:savedPrompt.externalKey,title:savedPrompt.title,question:question!.trim()}:{type:"saved",promptId:savedPrompt.id,promptKey:savedPrompt.externalKey,title:savedPrompt.title,programName:savedPrompt.programName,suiteName:savedPrompt.suiteName},
    });
    void handle.done.catch((error: unknown) => connLog.error("run failed", error));
  };

  /**
   * Runs an agent verification of a whole suite.
   *
   * The dossier is built here rather than in the browser, and the run is
   * recorded before it starts, so its events persist and its report survives
   * the page that launched it. The old path fired the dossier as an anonymous
   * custom prompt: nothing about it was ever written down.
   */
  const handleVerifySuite = async (suiteId: number, providerId: string, model: string | null): Promise<void> => {
    if (!isProviderId(providerId)) { sendError(`Unknown provider "${providerId}".`); return; }
    const providers = await detectProviders(true);
    const info = providers.find((provider) => provider.id === providerId);
    if (info === undefined || !info.available) {
      sendError(`Provider "${providerId}" is not available.`, info?.reason ?? "detection failed");
      send({ kind: "providers", providers });
      return;
    }

    let suite; let context; let workspace; let verificationId: number;
    const plannedRunId = newId("run");
    try {
      suite = workspaces.suiteHeader(suiteId);
      workspace = workspaces.get(suite.workspaceId);
      if (!workspace.workDirectoryExists) throw new WorkspaceError(422, "invalid_directory", `Workspace directory does not exist: ${workspace.workDirectory}`);
      const busy = runHub.activeForWorkspace(workspace.id);
      if (busy !== undefined) throw new WorkspaceError(409, "workspace_busy", `A run is already in progress in this workspace (${busy.provider}). Stop it before verifying.`);
      context = workspaces.suiteVerificationContext(suiteId);
      verificationId = workspaces.beginSuiteVerification({ runId: plannedRunId, suiteId, provider: providerId, model, stats: context.stats });
    } catch (error) {
      sendError(error instanceof Error ? error.message : "Unable to start verification");
      return;
    }

    // The agent's closing message is the report; keep the last full one.
    let report = "";
    const handle = startRun({
      runId: plannedRunId,
      adapter: getAdapter(providerId),
      prompt: context.prompt,
      cwd: workspace.workDirectory,
      model,
      onEvent: (event) => {
        if (event.type === "assistant_text" && event.payload.kind === "message") report += event.payload.text;
        if (event.type === "result" && event.payload.text) report = event.payload.text;
        workspaces.recordVerificationEvent(verificationId, event);
        runHub.event(plannedRunId, event);
      },
      onEnd: (runId, state) => {
        workspaces.finishSuiteVerification(verificationId, state, report);
        runHub.end(runId, state);
      },
    });
    runHub.start({
      handle,
      workspace: { id: workspace.id, name: workspace.name, workDirectory: workspace.workDirectory },
      source: { type: "verification", verificationId, suiteId, suiteKey: suite.key, suiteName: suite.name },
    });
    void handle.done.catch((error: unknown) => connLog.error("verification failed", error));
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
        const mode=parsed.mode??"execute";
        if(mode!=="execute"&&mode!=="clarify"){sendError("Unknown run mode.");return;}
        if(mode==="clarify"&&(!hasPromptId||typeof parsed.question!=="string"||parsed.question.trim()==="")){sendError("Clarification requires a saved prompt and a question.");return;}
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
        void handleRun(parsed.workspaceId, hasPrompt ? parsed.prompt : undefined, hasPromptId ? parsed.promptId : undefined, parsed.provider, model === "" ? null : model,mode,parsed.question);
        return;
      }
      case "verify_suite": {
        if (!Number.isSafeInteger(parsed.suiteId) || parsed.suiteId <= 0) { sendError("A valid suite is required."); return; }
        if (parsed.model !== undefined && parsed.model !== null && typeof parsed.model !== "string") { sendError("Model must be a string."); return; }
        const verifyModel = typeof parsed.model === "string" ? parsed.model.trim() : "";
        if (verifyModel.length > MAX_MODEL_LENGTH) { sendError(`Model id is too long (max ${MAX_MODEL_LENGTH} characters).`); return; }
        void handleVerifySuite(parsed.suiteId, parsed.provider, verifyModel === "" ? null : verifyModel);
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
