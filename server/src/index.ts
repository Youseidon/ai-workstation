import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "@agent-console/shared";
import { isRunRole } from "@agent-console/shared";
import type { DbAccessPayload, NormalizedEvent } from "@agent-console/shared";
import { newId } from "./lib/ids.ts";
import { describeAcceptedWrite, describeRead, describeRejectedWrite, type DbOperation } from "./dbAccessLog.ts";
import { config } from "./config.ts";
import { collectAccountUsage, detectProviders } from "./adapters/registry.ts";
import { resetSettings, snapshot, updateSettings } from "./settings.ts";
import { createLogger } from "./lib/logger.ts";
import { acquireInstanceLock, InstanceLockedError, type InstanceLock } from "./lib/instanceLock.ts";
import { runRoleStartError } from "./runner.ts";
import { runDefinitionOfDoneCommands } from "./definitionOfDone.ts";
import { handleWorkspaceApi } from "./workspaceApi.ts";
import { DECOMPOSE_MAX_DEPTH, WorkspaceError, workspaces } from "./workspaces.ts";
import { runContexts } from "./runContext.ts";
import { removeAllAgentShims } from "./agentShim.ts";
import { budgetMarkdown, contextMarkdown, progressApiMarkdown } from "./agentContext.ts";
import { hashRunToken } from "./runContext.ts";
import { runHub } from "./runHub.ts";
import { ProviderUnavailableError, consultContextText, startConsult, startExecute, startVerifySuite } from "./runService.ts";
import { pipelineScheduler } from "./pipelineScheduler.ts";
import { scheduleRetentionSweep } from "./retention.ts";
import { settings } from "./settings.ts";

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


/**
 * Record one trip an agent made to this app's database.
 *
 * Emitted here, at the agent API's single route handler, rather than by each
 * adapter — so a raw curl, the CLI shim and a provider's own tool call all
 * produce the same line, and no adapter has to cooperate for the operator to
 * see it. The event rides the normal transcript channel, so it streams live and
 * is replayed to a tab that opens mid-run like anything else.
 *
 * Failures here are swallowed. Losing a log line is bad; failing an agent's
 * status post because the logging of it broke would be very much worse.
 */
function recordDbAccess(runId:string,payload:DbAccessPayload):void{
  try{
    const live=runHub.get(runId);
    const event:NormalizedEvent={
      id:newId("evt"),
      runId,
      provider:live?.provider??"claude",
      model:live?.model??null,
      timestamp:new Date().toISOString(),
      type:"db_access",
      payload,
    };
    workspaces.recordAgentEvent(runId,event);
    runHub.event(runId,event);
  }catch(error){
    log.warn(`could not record database access for run=${runId}`,error);
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
      const startedAt=Date.now();
      if(operation==="context"&&req.method==="GET"){
        if(persisted.role==="consult"){
          const markdown=consultContextText(memory.workspaceId,persisted.promptId,memory.question);
          if(req.headers.accept?.includes("application/json"))sendJson(res,200,{purpose:"consult",markdown});
          else{res.writeHead(200,{"Content-Type":"text/markdown; charset=utf-8"});res.end(markdown);}
          return;
        }
        if(memory.promptId===null)throw new WorkspaceError(409,"run_not_active","Run is not attached to a work item");
        const full=url.searchParams.get("full")==="1";
        const context=workspaces.agentContext(memory.workspaceId,memory.promptId,{full});
        const depth=workspaces.decomposeDepth(memory.promptId);
        const budget=runHub.get(runId)?.handle.budget()??null;
        if(req.headers.accept?.includes("application/json"))sendJson(res,200,{...context,budget,full});
        else{
          const api=progressApiMarkdown({runId,token,port:config.port,canDecompose:depth<DECOMPOSE_MAX_DEPTH});
          res.writeHead(200,{"Content-Type":"text/markdown; charset=utf-8"});
          res.end(`${contextMarkdown(context,"execute",{depth,maxDepth:DECOMPOSE_MAX_DEPTH,full})}\n\n${api}${budgetMarkdown(budget)}`);
        }
        recordDbAccess(runId,describeRead({operation:"context",summary:`read work item ${context.prompt.externalKey??context.prompt.title}`,durationMs:Date.now()-startedAt}));
        return;
      }
      if(operation==="state"&&req.method==="GET"){
        if(memory.promptId===null){sendJson(res,200,{events:[],remarks:[],runs:[]});return;}
        const history=workspaces.promptHistory(memory.promptId);
        sendJson(res,200,history);
        recordDbAccess(runId,describeRead({operation:"state",summary:`read ${(history.events as unknown[]).length} status events and ${(history.remarks as unknown[]).length} remarks`,durationMs:Date.now()-startedAt}));
        return;
      }
      if((operation==="remarks"||operation==="status"||operation==="decompose")&&req.method==="POST"){
        void readJsonBody(req).then(async body=>{
          const requestId=typeof (body as Record<string,unknown>).requestId==="string"?(body as Record<string,unknown>).requestId as string:null;
          const before=memory.promptId===null?null:workspaces.promptOutcome(memory.promptId).status;
          // An agent claiming DONE is the moment the definition-of-done commands
          // are worth running: the gate that reads their results is a synchronous
          // database read, so the evidence has to exist before it looks. Awaited
          // here rather than inside the write because a test suite must not be
          // run with a SQLite transaction held open.
          // A CONTINUE post is not a claim of completion, so the definition of
          // done has nothing to check: running a test suite for a run that just
          // said "here is what still remains" would charge the item for the
          // evidence it is explicitly not offering.
          if(operation==="status"&&(body as Record<string,unknown>).status==="DONE"&&memory.promptId!==null){
            await runDefinitionOfDoneCommands(memory.promptId,runId);
            // Under `block`, a failing criterion is not a status change — it is
            // a refusal the agent can still act on. Writing NEEDS_REVIEW here
            // would end the run and park the rail; handing the compiler output
            // back while the provider session is live is the cheaper fix.
            const failures=workspaces.agentDoneVerificationFailures(memory.promptId);
            if(failures!==null){
              workspaces.recordVerificationFailureRemark(memory.promptId,runId,failures);
              const message="Fix this and post `done` again. If it cannot be fixed in this run, post `continue` with what remains.";
              sendJson(res,409,{error:{code:"verification_failed",message,failures}});
              recordDbAccess(runId,describeRejectedWrite({
                operation:"status",httpStatus:409,errorCode:"verification_failed",
                message,requestId,durationMs:Date.now()-startedAt,
              }));
              return;
            }
          }
          const result=operation==="remarks"?workspaces.addAgentRemark(runId,body):operation==="status"?workspaces.updateAgentStatus(runId,body):workspaces.decomposePrompt(runId,body);
          // The agent cannot see the runner's counters. Riding the reply it is
          // already making is the one channel that reaches every provider, so a
          // run learns to bank its work before the budget stops it.
          const live=runHub.get(runId)?.handle.budget()??null;
          sendJson(res,200,live===null?result:{...result as Record<string,unknown>,budget:live});
          const after=memory.promptId===null?null:workspaces.promptOutcome(memory.promptId).status;
          // An idempotent replay changed nothing; saying "IN_PROGRESS → DONE"
          // twice would have the operator hunting a transition that only ever
          // happened once.
          recordDbAccess(runId,describeAcceptedWrite({
            operation:operation as DbOperation,
            before,after,requestId,
            remarkKind:typeof (body as Record<string,unknown>).kind==="string"?(body as Record<string,unknown>).kind as string:null,
            durationMs:Date.now()-startedAt,
          }));
          runHub.operationsChanged();
          // A status post or a decompose is the agent's authoritative signal
          // that this run is done with the work item — DONE and BLOCKED because
          // the item is settled, CONTINUE because the agent has handed over to
          // the run that resumes it. End the provider after the HTTP response is
          // flushed so a CLI that waits after its final tool call cannot leave
          // DONE shown as WORKING.
          if(operation==="status"||operation==="decompose")void runHub.complete(runId);
        }).catch(error=>{
          const status=error instanceof WorkspaceError?error.status:400;
          const code=error instanceof WorkspaceError?error.code:"invalid_request";
          sendJson(res,status,{error:{code,message:error instanceof Error?error.message:String(error),...(error instanceof WorkspaceError&&error.fields?{fields:error.fields}:{}),...(error instanceof WorkspaceError&&error.details?error.details:{})}});
          // A refusal is the most important line in this log. Without it, an
          // agent whose status post was rejected — a stale expectedStatus, a
          // missing verification summary — looks exactly like one that never
          // tried, and the operator blames the wrong side.
          recordDbAccess(runId,describeRejectedWrite({
            operation:operation as DbOperation,httpStatus:status,errorCode:code,
            message:error instanceof Error?error.message:String(error),
            requestId:null,durationMs:Date.now()-startedAt,
          }));
        });return;
      }
      sendJson(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
    }catch(error){sendJson(res,error instanceof WorkspaceError?error.status:500,{error:{code:error instanceof WorkspaceError?error.code:"internal_error",message:error instanceof Error?error.message:"Agent API failed"}});}
    return;
  }

  if (url.pathname === "/api/sessions" || url.pathname === "/api/operations" || url.pathname === "/api/report" || url.pathname === "/api/pipelines" || url.pathname === "/api/statuses" || url.pathname === "/api/triggers" || url.pathname.startsWith("/api/statuses/") || url.pathname.startsWith("/api/triggers/") || url.pathname.startsWith("/api/definition-of-done/") || url.pathname.startsWith("/api/workspaces") || /^\/api\/(programs|suites|prompts|runs|verifications|pipelines)\//.test(url.pathname)) {
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
      .then(async (providers) => {
        const { coolingFor } = await import("./providerHealth.ts");
        sendJson(res, 200, {
          providers: providers.map((provider) => ({
            ...provider,
            cooling: coolingFor(provider.id),
          })),
        });
      })
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
        error.holder?.mode === "serve"
          ? `a live console (pid ${error.heldByPid}) is running against ${workspaces.databasePath} — ` +
              `develop with \`npm run dev:sandbox\`, which copies the database and uses another port.`
          : `another console (pid ${error.heldByPid}) is already using ${workspaces.databasePath} — ` +
              `two servers on one database corrupt each other's runs. Stop it, or point ` +
              `AGENT_CONSOLE_DB at a different file.`,
      );
      process.exit(1);
    }
    throw error;
  }
  // The database must not sit inside a directory an agent is given write access
  // to. Refused rather than warned about: a warning at boot is a line nobody
  // reads, and the whole point of routing agents through the API is that a
  // status change without a recorded cause becomes impossible rather than
  // merely discouraged.
  try {
    workspaces.assertDatabaseOutOfReach();
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // Safe only here: this process now demonstrably owns the database, so runs
  // still marked in flight really did die with the last one.
  workspaces.recoverAbandonedRuns();

  log.info(`http  http://${config.host}:${config.port}`);
  log.info(`ws    ws://${config.host}:${config.port}/ws`);
  log.info(`workspaces ${workspaces.list().length}`);
  // Transcript events accumulate forever without this. First pass is delayed
  // so boot (and auto-resume) are not competing with a multi-second DELETE.
  scheduleRetentionSweep();
  void detectProviders(true).then((providers) => {
    for (const provider of providers) {
      const status = provider.available
        ? `available${provider.version ? ` (${provider.version})` : ""}`
        : `unavailable — ${provider.reason ?? "unknown"}`;
      log.info(`provider ${provider.id.padEnd(7)} ${status}`);
    }
    scheduleAutoResume();
  }, (error: unknown) => {
    // Detection failing is not a reason to leave a pipeline stranded; the
    // adapters report their own unavailability when a run actually starts.
    log.warn("provider detection failed at boot", error);
    scheduleAutoResume();
  });
});

/**
 * The delay is not a guess about how long anything takes; it is a courtesy.
 * `recoverAbandonedRuns` has already run, so the state is consistent from the
 * first millisecond. The wait lets provider detection settle and a browser tab
 * reconnect, so the operator sees the resume happen rather than finding a run
 * already in progress with no visible cause.
 */
const AUTO_RESUME_DELAY_MS = 10_000;

let autoResumeScheduled = false;

function scheduleAutoResume(): void {
  if (autoResumeScheduled) return;
  autoResumeScheduled = true;
  if (settings.pipelinePolicy.onRestart !== "autoResume") return;
  setTimeout(() => {
    if (shuttingDown) return;
    void pipelineScheduler.resumeInterrupted().catch((error: unknown) => {
      log.error("auto-resume failed", error);
    });
  }, AUTO_RESUME_DELAY_MS).unref();
}

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
  // Every run credential this process wrote to tmp goes with it.
  removeAllAgentShims();
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
