import type { IncomingMessage, ServerResponse } from "node:http";
import { pipelineScheduler } from "./pipelineScheduler.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";
import { inspectPromptPack } from "./promptImport.ts";
import { activeRuns } from "./activeRuns.ts";
import { runHub } from "./runHub.ts";
import { INSTRUCTION_FILE_NAMES, isProviderId, normalizeAgentRequest, programDraftPreview, type AgentRequest, type OperationsPrompt, type OperationsSnapshot, type ProviderId } from "@agent-console/shared";
import { startConsult, startExecute, startInstructionAuthor, startProgramAuthor } from "./runService.ts";
import { scheduleCompletionAudit, type AuditBlock } from "./completionAudit.ts";
import { respondAndContinue, saveHumanResponse } from "./humanInput.ts";
import { assertNoLiveHandover, liveHandoverHolding } from "./teamHandoverHold.ts";
import { scheduleHandoff } from "./handoffCoordinator.ts";
import { taskControl, withLiveTokenState } from "./taskControl.ts";
import { TEAM_DISABLED_CODE, TEAM_DISABLED_MESSAGE, telegramRuntime } from "./integrations/telegram/runtime.ts";
import { isHarnessMode } from "./harnessGuard.ts";
import { settings } from "./settings.ts";

const MAX_BODY_BYTES = 128 * 1024;
/** A whole instruction file, as a proposal edit PATCHes it. Two 64k fields' worth with headroom for escaping. */
const MAX_PROPOSAL_BODY_BYTES = 512 * 1024;
/*
 * An operator editing a drafted program PATCHes the whole body back: every
 * suite, every work item, every page of instructions. That is legitimately
 * larger than any other request this API takes.
 */
const MAX_DRAFT_BODY_BYTES = 4 * 1024 * 1024;

/*
 * M-16. Attaches the live handover holding each prompt, and takes a held prompt
 * off the owner's attention list.
 *
 * Here rather than in `workspaces.operations()` because that builder is
 * synchronous and reading a control record is git I/O, and here rather than in
 * `operationalState` because the item genuinely is BLOCKED - being handed over
 * is a second fact about it, not a different status. The reconcile that moved
 * `operationalState` is what caused C3, so nothing in this task touches it.
 *
 * `liveHandoverHolding` is P-A5's, unchanged: it considers only the
 * **requester's** item link, reads the **local** bare control clone rather than
 * the network remote, and returns null without reading anything unless that link
 * already carries a `control_head`. A guard over every link would refuse the
 * receiver's own run, which is why the executor link must stay null here too.
 *
 * Sub-steps are walked as well as station roots: an item link is keyed by prompt
 * id and nothing stops a sub-step carrying one.
 *
 * `attentionCount` is decremented rather than left alone. It is built from the
 * same `attention` flags this clears (`allPrompts.filter(item=>item.attention)`),
 * so leaving it would make the board's "Needs you 1" chip disagree with the
 * empty list behind it - which is the same complaint M-16 exists to fix, moved
 * one element to the left.
 */
async function withHandoverHolds(snapshot: OperationsSnapshot): Promise<OperationsSnapshot> {
  /*
   * The roster's own names for the people the control record refers to by id.
   *
   * The record stores person ids because that is what a shared, machine-readable
   * record should store; a badge should not. Resolved here rather than in `web/`
   * because this is where the roster already is - the row list has no roster and
   * would have had to fetch one for a string - and read once per snapshot rather
   * than once per prompt.
   *
   * A name that is missing stays missing: an id is a poor label but a *wrong* name
   * is worse, so the surfaces fall back to the id rather than to a guess.
   */
  const labels = new Map<string, string>();
  for (const cached of workspaces.teamRosters()) {
    const record = cached.record as { members?: Array<{ personId?: unknown; personLabel?: unknown }> };
    for (const member of record.members ?? []) {
      if (typeof member.personId === "string" && typeof member.personLabel === "string" && member.personLabel !== "") {
        labels.set(member.personId, member.personLabel);
      }
    }
  }
  for (const suite of snapshot.suites) {
    let cleared = 0;
    const walk = async (prompts: OperationsPrompt[]): Promise<void> => {
      for (const entry of prompts) {
        const held = await liveHandoverHolding(entry.prompt.id);
        entry.heldByTeammate = held === null
          ? null
          : { ...held, executorLabel: held.executor === null ? null : labels.get(held.executor) ?? null };
        if (entry.heldByTeammate !== null && entry.attention) {
          entry.attention = false;
          cleared += 1;
        }
        await walk(entry.children);
      }
    };
    await walk(suite.prompts);
    suite.attentionCount -= cleared;
  }
  return snapshot;
}

const AUDIT_BLOCK_CODE: Record<AuditBlock, string> = {
  already_complete: "station_already_complete",
  not_auditable: "station_not_auditable",
  audit_running: "audit_in_progress",
  attempt_limit: "audit_limit_reached",
  provider_unavailable: "audit_provider_unavailable",
};
const AUDIT_BLOCK_MESSAGE: Record<AuditBlock, string> = {
  already_complete: "This station is already complete; there is nothing to audit",
  not_auditable: "Only a station blocked because its run ended without posting a status can be audited. A station that reported BLOCKED asked you a specific question, and no amount of reading the tree answers it",
  audit_running: "An audit of this run is already going; wait for its verdict",
  attempt_limit: "This run has already been audited automatically; read that verdict, or complete or retry the station yourself",
  provider_unavailable: "No read-only agent is available to audit — it cannot be Cursor, and it cannot be the agent whose own run is being judged",
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function body(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > maxBytes) { reject(new WorkspaceError(413, "body_too_large", "Request body is too large")); req.destroy(); }
    });
    req.on("end", () => {
      try {
        const parsed: unknown = raw.trim() === "" ? {} : JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new WorkspaceError(400, "invalid_json", "Body must be a JSON object");
        resolve(parsed as Record<string, unknown>);
      } catch (error) { reject(error instanceof WorkspaceError ? error : new WorkspaceError(400, "invalid_json", "Body is not valid JSON")); }
    });
    req.on("error", reject);
  });
}

function id(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new WorkspaceError(400, "invalid_id", "Resource id must be a positive integer");
  return parsed;
}

function failure(res: ServerResponse, error: unknown): void {
  if (error instanceof WorkspaceError) { json(res, error.status, { error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}), ...(error.details ?? {}) } }); return; }
  console.error("workspace API failed", error);
  json(res, 500, { error: { code: "internal_error", message: "Workspace operation failed" } });
}

/**
 * Whether this path belongs to the workspace API.
 *
 * Exported because `index.ts` has to decide the same thing before it delegates,
 * and this list used to be written out in both places. It drifted the moment a
 * route was added: `/api/program-drafts` was routed here and rejected there, so
 * the endpoint returned the outer 404 and looked unimplemented. One copy.
 */
export function isWorkspaceApiPath(pathname: string): boolean {
  return pathname === "/api/sessions"
    || pathname.startsWith("/api/sessions/")
    || pathname === "/api/operations"
    || pathname === "/api/report"
    || pathname === "/api/pipelines"
    || pathname === "/api/statuses"
    || pathname === "/api/triggers"
    || pathname.startsWith("/api/statuses/")
    || pathname.startsWith("/api/triggers/")
    || pathname.startsWith("/api/definition-of-done/")
    || pathname.startsWith("/api/task-control/")
    || pathname.startsWith("/api/workspaces")
    || pathname.startsWith("/api/program-drafts")
    || pathname.startsWith("/api/instruction-proposals")
    || /^\/api\/(programs|suites|prompts|runs|verifications|pipelines)\//.test(pathname);
}

export type AgentRequestResult =
  | { kind: "consult"; runId: string }
  | { kind: "program-draft"; draft: ReturnType<typeof workspaces.programDraft>; preview: ReturnType<typeof programDraftPreview>; runId: string | null }
  | { kind: "instruction-proposal"; proposal: ReturnType<typeof workspaces.instructionProposal>; runId: string | null };

/**
 * "Regarding suite S2 — Endpoints", for a request narrowed inside a program, so
 * "this" in the operator's text means what they had selected. Also checks that
 * every id belongs where the request says it does.
 */
function programFocus(workspaceId:number,target:{programId:number;suiteId?:number|null;promptId?:number|null}):string|null {
  const program=workspaces.tree(workspaceId).programs.find(entry=>entry.id===target.programId);
  if(program===undefined)throw new WorkspaceError(404,"not_found","Program not found in this workspace");
  const label=(key:string|null,name:string)=>key===null?name:`${key} — ${name}`;
  if(target.promptId!=null){
    for(const suite of program.suites){
      const prompt=suite.prompts.find(entry=>entry.id===target.promptId);
      if(prompt!==undefined)return `work item ${label(prompt.externalKey,prompt.title)}`;
    }
    throw new WorkspaceError(404,"not_found","Work item not found in this program");
  }
  if(target.suiteId!=null){
    const suite=program.suites.find(entry=>entry.id===target.suiteId);
    if(suite===undefined)throw new WorkspaceError(404,"not_found","Suite not found in this program");
    return `suite ${label(suite.externalKey,suite.name)}`;
  }
  return null;
}

async function routeAgentRequest(workspaceId:number,request:AgentRequest):Promise<AgentRequestResult> {
  workspaces.get(workspaceId);
  const {target,mode,text,model=null}=request;
  const provider=():ProviderId=>{
    if(!isProviderId(request.provider))throw new WorkspaceError(422,"validation_error","Choose an agent",{provider:"Unknown provider"});
    return request.provider;
  };
  switch(target.kind){
    case "workspace":
      return {kind:"consult",...await startConsult({workspaceId,provider:provider(),model,question:text})};
    case "instructions":{
      const file=INSTRUCTION_FILE_NAMES[target.field];
      if(mode==="ask"){
        const question=`About ${file}, this workspace's agent instruction file (./${file} in the working directory):\n\n${text}`;
        return {kind:"consult",...await startConsult({workspaceId,provider:provider(),model,question})};
      }
      if(mode==="edit")return {kind:"instruction-proposal",proposal:workspaces.createInstructionProposal({workspaceId,field:target.field,goal:text}),runId:null};
      return {kind:"instruction-proposal",...await startInstructionAuthor({workspaceId,field:target.field,goal:text,provider:provider(),model})};
    }
    case "program":{
      const focus=programFocus(workspaceId,target);
      const framed=focus===null?text:`Regarding ${focus}:\n\n${text}`;
      if(mode==="ask")return {kind:"consult",...await startConsult({workspaceId,programId:target.programId,provider:provider(),model,question:framed})};
      if(mode==="edit"){
        const draft=workspaces.createProgramRevision({workspaceId,programId:target.programId,goal:framed});
        return {kind:"program-draft",draft,preview:programDraftPreview(draft.body),runId:null};
      }
      const started=await startProgramAuthor({workspaceId,programId:target.programId,goal:framed,provider:provider(),model});
      return {kind:"program-draft",draft:started.draft,preview:programDraftPreview(started.draft.body),runId:started.runId};
    }
    case "new-program":{
      if(mode==="edit"){
        const draft=workspaces.createProgramDraft({workspaceId,goal:text});
        return {kind:"program-draft",draft,preview:programDraftPreview(draft.body),runId:null};
      }
      const started=await startProgramAuthor({workspaceId,goal:text,provider:provider(),model});
      return {kind:"program-draft",draft:started.draft,preview:programDraftPreview(started.draft.body),runId:started.runId};
    }
  }
}

export async function handleWorkspaceApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!isWorkspaceApiPath(url.pathname)) return false;
  const mutates = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
  if (mutates) {
    res.once("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) runHub.operationsChanged();
    });
  }
  try {
    const method = req.method ?? "GET";
    if ((url.pathname === "/api/task-control/team" || url.pathname.startsWith("/api/task-control/team/")) && !settings.team.enabled) {
      throw new WorkspaceError(403, TEAM_DISABLED_CODE, TEAM_DISABLED_MESSAGE);
    }
    // The status catalog: what each state is called, what it means, and what
    // entering it sets in motion. Locked fields are refused with the reason
    // rather than silently dropped — see workspaces.updateStatusDefinition.
    if(url.pathname==="/api/statuses"){
      if(method==="GET")json(res,200,{statuses:workspaces.statusCatalog(),triggers:workspaces.triggerSentences()});
      else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      return true;
    }
    {
      const match=url.pathname.match(/^\/api\/statuses\/([A-Z_]+)$/);
      if(match){
        const statusId=match[1]!;
        if(method==="PATCH")json(res,200,{status:workspaces.updateStatusDefinition(statusId,await body(req))});
        else if(method==="DELETE")json(res,200,{status:workspaces.resetStatusDefinition(statusId)});
        else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
        return true;
      }
    }
    {
      const match=url.pathname.match(/^\/api\/triggers\/([a-z_]+)$/);
      if(match){
        if(method==="PATCH"){const input=await body(req);json(res,200,{triggers:workspaces.updateTriggerSentence(match[1]!,input.sentence)});}
        else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
        return true;
      }
    }
    if(url.pathname==="/api/operations"){
      if(method!=="GET")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else {const value=url.searchParams.get("workspace");const workspaceId=value===null?undefined:id(value);json(res,200,await withHandoverHolds(workspaces.operations(workspaceId)));}
      return true;
    }
    if(url.pathname==="/api/task-control/capability"){
      if(method!=="GET")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else json(res,200,{capability:withLiveTokenState(taskControl.capability(),telegramRuntime.status().tokenConfigured)});
      return true;
    }
    // Live Telegram setup (L1). Local-only like every route here; responses carry
    // bot identity and enrolment state, never the token.
    if(url.pathname==="/api/task-control/telegram"){
      if(method!=="GET")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else json(res,200,{status:telegramRuntime.status()});
      return true;
    }
    if(url.pathname==="/api/task-control/telegram/credential"){
      if(method!=="PUT")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else{const input=await body(req,4096);json(res,200,{status:await telegramRuntime.configureToken(input.token)});}
      return true;
    }
    if(url.pathname==="/api/task-control/telegram/pairing"){
      if(method==="POST")json(res,201,{pairing:telegramRuntime.startPairing()});
      else if(method==="DELETE"){telegramRuntime.cancelPairing();res.writeHead(204);res.end();}
      else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      return true;
    }
    if(url.pathname==="/api/task-control/telegram/pairing/confirm"){
      if(method!=="POST")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else{const input=await body(req);json(res,200,{actor:telegramRuntime.confirmPairing(input.code),status:telegramRuntime.status()});}
      return true;
    }
    if (url.pathname === "/api/task-control/team") {
      if (method !== "GET") json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      else json(res, 200, { team: telegramRuntime.teamStatus() });
      return true;
    }
    if (url.pathname === "/api/task-control/team/refresh") {
      if (method !== "POST") json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      else json(res, 200, { team: await telegramRuntime.refreshTeam() });
      return true;
    }
    if (url.pathname === "/api/task-control/team/create") {
      if (method === "GET") json(res, 200, { team: telegramRuntime.teamCreateStatus() });
      else if (method === "POST") { const input = await body(req); json(res, 201, { team: telegramRuntime.startTeamCreate(input.remoteUrl) }); }
      else if (method === "DELETE") { telegramRuntime.cancelTeamCreate(); res.writeHead(204); res.end(); }
      else json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      return true;
    }
    if (url.pathname === "/api/task-control/team/create/confirm") {
      if (method !== "POST") json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      else json(res, 201, { team: await telegramRuntime.confirmTeamCreate() });
      return true;
    }
    // B1: the join code is returned once and nothing persists it, so the owner of
    // an existing roster mints a fresh one here rather than being stranded.
    if (url.pathname === "/api/task-control/team/join-code") {
      if (method !== "POST") json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      else json(res, 201, { team: await telegramRuntime.reissueTeamJoinCode() });
      return true;
    }
    if (url.pathname === "/api/task-control/team/join") {
      if (method !== "POST") json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      else { const input = await body(req); json(res, 201, { team: telegramRuntime.startTeamJoin(input.code) }); }
      return true;
    }
    if (url.pathname === "/api/task-control/team/join/confirm") {
      if (method !== "POST") json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      else json(res, 201, { team: await telegramRuntime.confirmTeamJoin() });
      return true;
    }
    if (url.pathname === "/api/task-control/team/items") {
      if (method === "GET") json(res, 200, { item: telegramRuntime.teamItemForPrompt(Number(url.searchParams.get("promptId"))) });
      else if (method === "POST") { const input = await body(req); json(res, 201, { item: telegramRuntime.openTeamItem(input.promptId) }); }
      else json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      return true;
    }
    if (url.pathname === "/api/task-control/team/handovers") {
      if (method === "GET") json(res, 200, { handovers: await telegramRuntime.teamHandovers() });
      else json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      return true;
    }
    const handoverActionMatch = url.pathname.match(/^\/api\/task-control\/team\/handovers\/([^/]+)\/(accept|decline|withdraw|return)$/);
    if (handoverActionMatch) {
      if (method !== "POST") json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      else json(res, 200, { result: await telegramRuntime.teamHandoverAction(decodeURIComponent(handoverActionMatch[1]!), handoverActionMatch[2]!) });
      return true;
    }
    const teamItemAccessMatch = url.pathname.match(/^\/api\/task-control\/team\/items\/([^/]+)\/access(?:\/([^/]+))?$/);
    if (teamItemAccessMatch) {
      const itemId = decodeURIComponent(teamItemAccessMatch[1]!);
      const personId = teamItemAccessMatch[2] === undefined ? null : decodeURIComponent(teamItemAccessMatch[2]);
      if (method === "GET" && personId === null) json(res, 200, { access: telegramRuntime.teamItemAccess(itemId) });
      else if (method === "PUT" && personId !== null) json(res, 200, { access: telegramRuntime.setTeamItemAccess(itemId, personId, await body(req)) });
      else json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      return true;
    }
    const teamItemCloseMatch = url.pathname.match(/^\/api\/task-control\/team\/items\/([^/]+)\/close$/);
    if (teamItemCloseMatch) {
      if (method !== "POST") json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      else json(res, 200, { result: await telegramRuntime.closeTeamItem(decodeURIComponent(teamItemCloseMatch[1]!)) });
      return true;
    }
    // Handover, the requester's side (C1). Team-off is already refused above with
    // `team_disabled`; each route below refuses handover-off with
    // `handover_disabled`, so a caller is told which capability stopped it. Both
    // settings are false by default and neither is changed from here.
    const handoverMatch = url.pathname.match(/^\/api\/task-control\/team\/handover\/([^/]+)\/(begin|preview|publish|review|apply|request-changes)$/);
    if (handoverMatch) {
      const itemId = decodeURIComponent(handoverMatch[1]!);
      const step = handoverMatch[2]!;
      const wants = step === "preview" || step === "review" ? "GET" : "POST";
      if (method !== wants) { json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } }); return true; }
      if (step === "begin") json(res, 201, { handover: await telegramRuntime.beginHandover(itemId) });
      else if (step === "preview") {
        json(res, 200, { preview: await telegramRuntime.handoverPreview(itemId, { provider: url.searchParams.get("provider"), model: url.searchParams.get("model") }) });
      } else if (step === "publish") json(res, 201, { offer: await telegramRuntime.publishHandover(itemId, await body(req)) });
      else if (step === "review") json(res, 200, { review: await telegramRuntime.handoverReview(itemId) });
      else if (step === "apply") json(res, 200, { apply: await telegramRuntime.applyHandover(itemId, await body(req)) });
      else json(res, 201, { changes: await telegramRuntime.requestHandoverChanges(itemId, await body(req)) });
      return true;
    }
    const teamItemReopenMatch = isHarnessMode() ? url.pathname.match(/^\/api\/task-control\/team\/harness\/items\/([^/]+)\/reopen$/) : null;
    if (teamItemReopenMatch) {
      if (method !== "POST") json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      else { telegramRuntime.harnessReopenTeamItem(decodeURIComponent(teamItemReopenMatch[1]!)); json(res, 200, { reopened: true }); }
      return true;
    }
    const teamItemCompleteMatch = isHarnessMode() ? url.pathname.match(/^\/api\/task-control\/team\/harness\/items\/([^/]+)\/complete$/) : null;
    if (teamItemCompleteMatch) {
      if (method !== "POST") json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      else { telegramRuntime.harnessCompleteTeamItem(decodeURIComponent(teamItemCompleteMatch[1]!)); json(res, 200, { completed: true }); }
      return true;
    }
    // Harness seam (docs/e2e-scenarios/l3-f1-f2.md question 1): until a product path issues edits
    // (slice B), end-to-end scenarios queue a send and edits of it through the real outbox. These
    // routes do not exist outside AGENT_CONSOLE_HARNESS=1.
    if(isHarnessMode()&&url.pathname==="/api/task-control/telegram/harness/outbox"){
      if(method!=="POST")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else{const input=await body(req);json(res,201,{outboxId:telegramRuntime.harnessQueueText(input.chatId,input.text)});}
      return true;
    }
    const harnessEditMatch=isHarnessMode()?url.pathname.match(/^\/api\/task-control\/telegram\/harness\/outbox\/(\d+)\/edit$/):null;
    if(harnessEditMatch){
      if(method!=="POST")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else{const input=await body(req);json(res,201,{outboxId:telegramRuntime.harnessQueueEdit(id(harnessEditMatch[1]!),input.payload)});}
      return true;
    }
    const telegramActorMatch=url.pathname.match(/^\/api\/task-control\/telegram\/actors\/([^/]+)$/);
    if(telegramActorMatch){
      if(method!=="DELETE")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else{telegramRuntime.removeActor(decodeURIComponent(telegramActorMatch[1]!));res.writeHead(204);res.end();}
      return true;
    }
    // The record audit. A POST records a new one; GET reads the latest without
    // creating another, so polling a suite cannot spam its history.
    const verificationMatch=url.pathname.match(/^\/api\/suites\/(\d+)\/verification$/);
    if(verificationMatch){
      const suiteId=id(verificationMatch[1]!);
      if(method==="POST")json(res,201,{verification:workspaces.recordSuiteAudit(suiteId)});
      else if(method==="GET"){const latest=workspaces.suiteVerifications(suiteId,1)[0];json(res,200,{verification:latest??null});}
      else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      return true;
    }
    const verificationsMatch=url.pathname.match(/^\/api\/suites\/(\d+)\/verifications$/);
    if(verificationsMatch){
      if(method!=="GET")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else json(res,200,{verifications:workspaces.suiteVerifications(id(verificationsMatch[1]!))});
      return true;
    }
    const verificationDetailMatch=url.pathname.match(/^\/api\/verifications\/(\d+)$/);
    if(verificationDetailMatch){
      if(method!=="GET")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else json(res,200,{verification:workspaces.suiteVerificationDetail(id(verificationDetailMatch[1]!))});
      return true;
    }
    const verificationContextMatch=url.pathname.match(/^\/api\/suites\/(\d+)\/verification-context$/);
    if(verificationContextMatch){if(method!=="GET")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});else json(res,200,workspaces.suiteVerificationContext(id(verificationContextMatch[1]!)));return true;}
    if(url.pathname==="/api/pipelines"){
      if(method==="GET"){
        const value=url.searchParams.get("workspace");
        const workspaceId=value===null?undefined:id(value);
        if(url.searchParams.get("dashboard")==="1"&&workspaceId!==undefined){
          json(res,200,workspaces.pipelineDashboard(workspaceId));
          return true;
        }
        json(res,200,{pipelines:workspaces.listPipelines(workspaceId)});
      } else if(method==="POST") json(res,201,{pipeline:workspaces.createPipeline(await body(req))});
      else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      return true;
    }
    const namedPipelineMatch=url.pathname.match(/^\/api\/pipelines\/(\d+)$/);
    if(namedPipelineMatch){
      const pipelineId=id(namedPipelineMatch[1]!);
      if(method==="GET") json(res,200,{pipeline:workspaces.getPipeline(pipelineId)});
      else if(method==="PATCH") json(res,200,{pipeline:workspaces.updatePipeline(pipelineId,await body(req))});
      else if(method==="DELETE"){workspaces.deletePipeline(pipelineId);res.writeHead(204);res.end();}
      else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      return true;
    }
    const namedPipelineRunsMatch=url.pathname.match(/^\/api\/pipelines\/(\d+)\/runs$/);
    if(namedPipelineRunsMatch){
      if(method!=="GET") json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else json(res,200,{runs:workspaces.listPipelineRuns(id(namedPipelineRunsMatch[1]!))});
      return true;
    }
    const namedPipelinePlayMatch=url.pathname.match(/^\/api\/pipelines\/(\d+)\/play$/);
    if(namedPipelinePlayMatch){
      if(method!=="POST") json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else json(res,200,{run:await pipelineScheduler.playNamed(id(namedPipelinePlayMatch[1]!),await body(req))});
      return true;
    }
    const namedPipelinePauseMatch=url.pathname.match(/^\/api\/pipelines\/(\d+)\/pause$/);
    if(namedPipelinePauseMatch){
      if(method!=="POST") json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else json(res,200,{run:await pipelineScheduler.pauseNamed(id(namedPipelinePauseMatch[1]!))});
      return true;
    }
    const namedPipelineStopMatch=url.pathname.match(/^\/api\/pipelines\/(\d+)\/stop$/);
    if(namedPipelineStopMatch){
      if(method!=="POST") json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else json(res,200,{run:await pipelineScheduler.stopNamed(id(namedPipelineStopMatch[1]!))});
      return true;
    }
    const namedPipelineFlowchartMatch=url.pathname.match(/^\/api\/pipelines\/(\d+)\/flowchart$/);
    if(namedPipelineFlowchartMatch){
      const pipelineId=id(namedPipelineFlowchartMatch[1]!);
      const suiteIdValue=url.searchParams.get("suiteId");
      if(suiteIdValue===null) throw new WorkspaceError(400,"validation_error","suiteId is required");
      const suiteId=id(suiteIdValue);
      const incompleteOnly=url.searchParams.get("incompleteOnly")==="1";
      if(method==="GET") json(res,200,workspaces.namedPipelineFlowchart(pipelineId,suiteId,{incompleteOnly}));
      else if(method==="PATCH"){workspaces.updateSuitePipelineDefaults(suiteId,await body(req));json(res,200,workspaces.namedPipelineFlowchart(pipelineId,suiteId,{incompleteOnly}));}
      else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      return true;
    }
    const namedPipelineFlowchartStepsMatch=url.pathname.match(/^\/api\/pipelines\/(\d+)\/flowchart\/steps$/);
    if(namedPipelineFlowchartStepsMatch){
      const pipelineId=id(namedPipelineFlowchartStepsMatch[1]!);
      const suiteIdValue=url.searchParams.get("suiteId");
      if(suiteIdValue===null) throw new WorkspaceError(400,"validation_error","suiteId is required");
      const suiteId=id(suiteIdValue);
      const incompleteOnly=url.searchParams.get("incompleteOnly")==="1";
      if(method==="POST"){
        const input=await body(req);
        const promptId=typeof input.promptId==="number"?input.promptId:0;
        const home=workspaces.promptHome(promptId);
        if(home.suiteId!==suiteId) throw new WorkspaceError(422,"validation_error","Prompt is not in this suite");
        json(res,200,{rule:workspaces.addNamedPipelineStep(pipelineId,promptId,input),flowchart:workspaces.namedPipelineFlowchart(pipelineId,suiteId,{incompleteOnly})});
      } else if(method==="PUT"){
        const input=await body(req);
        const promptIds=Array.isArray(input.promptIds)?input.promptIds.filter((value):value is number=>typeof value==="number"):[];
        json(res,200,{steps:workspaces.reorderNamedPipelineSteps(pipelineId,suiteId,promptIds),flowchart:workspaces.namedPipelineFlowchart(pipelineId,suiteId,{incompleteOnly})});
      } else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      return true;
    }
    const namedPipelineStepMatch=url.pathname.match(/^\/api\/pipelines\/(\d+)\/flowchart\/steps\/(\d+)$/);
    if(namedPipelineStepMatch){
      const pipelineId=id(namedPipelineStepMatch[1]!);
      const promptId=id(namedPipelineStepMatch[2]!);
      const incompleteOnly=url.searchParams.get("incompleteOnly")==="1";
      if(method==="DELETE"){
        // Only the delete reply rebuilds the stage flowchart, so only it needs
        // the suite; a rule patch is addressed by prompt id alone.
        const suiteIdValue=url.searchParams.get("suiteId");
        if(suiteIdValue===null) throw new WorkspaceError(400,"validation_error","suiteId is required");
        const suiteId=id(suiteIdValue);
        workspaces.removeNamedPipelineStep(pipelineId,promptId);
        json(res,200,{flowchart:workspaces.namedPipelineFlowchart(pipelineId,suiteId,{incompleteOnly})});
      } else if(method==="PATCH"){
        json(res,200,{rule:workspaces.upsertNamedPipelineRule(pipelineId,promptId,await body(req))});
      } else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      return true;
    }
    const skipMatch=url.pathname.match(/^\/api\/prompts\/(\d+)\/skip$/);
    if(skipMatch){
      if(method!=="POST")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else {
        const promptId=id(skipMatch[1]!);
        const input=await body(req);
        const reason=typeof input.reason==="string"&&input.reason.trim()!==""?input.reason.trim():"Operator skipped this station.";
        workspaces.skipPrompt(promptId,"USER",reason);
        await pipelineScheduler.onPromptSkipped(promptId);
        json(res,200,{skipped:true});
      }
      return true;
    }
    // What a work item is judged against, and how each criterion currently
    // stands. `?run=1` runs the command criteria first, which is the operator's
    // "check it now" — the same execution the closing gate depends on, so what
    // they see here is exactly what a close would be decided on.
    const dodPromptMatch=url.pathname.match(/^\/api\/prompts\/(\d+)\/definition-of-done$/);
    if(dodPromptMatch){
      const promptId=id(dodPromptMatch[1]!);
      if(method==="GET"){
        json(res,200,{definitionOfDone:workspaces.resolvedDefinitionOfDone(promptId),evaluation:workspaces.definitionOfDoneEvaluation(promptId)});
      } else if(method==="POST"){
        const { runDefinitionOfDoneCommands }=await import("./definitionOfDone.ts");
        await runDefinitionOfDoneCommands(promptId,null);
        json(res,200,{definitionOfDone:workspaces.resolvedDefinitionOfDone(promptId),evaluation:workspaces.definitionOfDoneEvaluation(promptId)});
        runHub.operationsChanged();
      } else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      return true;
    }
    // The definition of done at one scope, on its own — what an editor for that
    // scope shows and writes. Separate from the resolved view above because
    // "this suite says nothing and inherits" has to be editable as itself.
    {
      const match=url.pathname.match(/^\/api\/definition-of-done\/([a-z]+)\/(\d+)$/);
      if(match){
        const scope=match[1]!;const scopeId=id(match[2]!);
        if(method==="GET")json(res,200,{definitionOfDone:workspaces.definitionOfDone(scope,scopeId)});
        else if(method==="PATCH"){
          const input=await body(req);
          const enforcement=input.enforcement===null?null:typeof input.enforcement==="string"?input.enforcement:undefined;
          if(enforcement===undefined)throw new WorkspaceError(422,"validation_error","Some changes were refused",{enforcement:"Must be block, warn, off, or null to inherit"});
          json(res,200,{definitionOfDone:workspaces.setDodEnforcement(scope,scopeId,enforcement)});
        }
        else if(method==="POST")json(res,200,{definitionOfDone:workspaces.saveDodCriterion({scope,scopeId,patch:await body(req)})});
        else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
        return true;
      }
    }
    {
      const match=url.pathname.match(/^\/api\/definition-of-done\/([a-z]+)\/(\d+)\/criteria\/(\d+)$/);
      if(match){
        const scope=match[1]!;const scopeId=id(match[2]!);const criterionId=id(match[3]!);
        if(method==="PATCH")json(res,200,{definitionOfDone:workspaces.saveDodCriterion({scope,scopeId,criterionId,patch:await body(req)})});
        else if(method==="DELETE")json(res,200,{definitionOfDone:workspaces.removeDodCriterion(scope,scopeId,criterionId)});
        else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
        return true;
      }
    }
    const completeMatch=url.pathname.match(/^\/api\/prompts\/(\d+)\/complete$/);
    if(completeMatch){
      if(method!=="POST")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else {
        const promptId=id(completeMatch[1]!);
        // M-17: this needs no run at all - it writes DONE directly - so it could
        // complete work a teammate was still doing.
        await assertNoLiveHandover(promptId,"Marking this work item complete");
        const input=await body(req);
        const written=workspaces.completePrompt(promptId,"USER",{reason:input.reason,verificationSummary:input.verificationSummary});
        await pipelineScheduler.onPromptCompleted(promptId);
        // `status` rather than a bare `completed:true`: an operator override is
        // always honoured, but saying so is not the same as saying nothing was
        // outstanding, and the caller shows what was closed over.
        json(res,200,{completed:written==="DONE",status:written});
      }
      return true;
    }
    let runMatch=url.pathname.match(/^\/api\/runs\/([^/]+)\/interrupt$/);
    if(runMatch){if(method!=="POST")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});else if(!await activeRuns.stop(runMatch[1]!))throw new WorkspaceError(409,"run_not_active","The agent process is no longer active");else json(res,200,{interrupted:true});return true;}
    if(url.pathname==="/api/sessions"){
      if(method==="GET")json(res,200,{sessions:workspaces.sessions()});
      else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      return true;
    }
    {
      const sessionMatch=url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if(sessionMatch){
        if(method!=="GET"){json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});return true;}
        const session=workspaces.sessionById(sessionMatch[1]!);
        if(session===null)throw new WorkspaceError(404,"not_found","Session not found");
        json(res,200,{session});
        return true;
      }
    }
    if(url.pathname==="/api/report"){
      if(method==="GET"){
        const workspaceParam=url.searchParams.get("workspace");
        const workspaceId=workspaceParam===null||workspaceParam===""?undefined:id(workspaceParam);
        json(res,200,{report:workspaces.usageReport(workspaceId)});
      }else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      return true;
    }
    if(url.pathname==="/api/prompts/human-input"){
      if(method==="GET")json(res,200,{requests:workspaces.humanInputRequests()});
      else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      return true;
    }
    if (url.pathname === "/api/workspaces") {
      if (method === "GET") json(res, 200, { workspaces: workspaces.list() });
      else if (method === "POST") json(res, 201, { workspace: workspaces.create(await body(req)) });
      else json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      return true;
    }
    /*
     * Agent-authored programs.
     *
     * A draft is the whole point of these routes: an agent may fill one in, and
     * only the operator turns one into a program. So the writes here are split
     * accordingly — POST starts an agent, PATCH is the operator's own edit, and
     * `apply` is the single place a draft becomes rows in `program`, `suite` and
     * `prompt`.
     */
    const draftsMatch=url.pathname.match(/^\/api\/workspaces\/(\d+)\/program-drafts$/);
    if(draftsMatch){
      const workspaceId=id(draftsMatch[1]!);
      if(method==="GET"){
        json(res,200,{drafts:workspaces.programDrafts(workspaceId).map(draft=>({draft,preview:programDraftPreview(draft.body)}))});
      } else if(method==="POST"){
        const input=await body(req);
        const goal=typeof input.goal==="string"?input.goal:"";
        // No provider means "open an empty draft and let me write it myself".
        if(input.provider===undefined){
          const draft=workspaces.createProgramDraft({workspaceId,goal});
          json(res,201,{draft,preview:programDraftPreview(draft.body),runId:null});
          return true;
        }
        if(!isProviderId(input.provider))throw new WorkspaceError(422,"validation_error","Choose a provider to draft with",{provider:"Unknown provider"});
        const started=await startProgramAuthor({
          workspaceId,goal,provider:input.provider,
          model:typeof input.model==="string"?input.model:null,
        });
        json(res,201,{draft:started.draft,preview:programDraftPreview(started.draft.body),runId:started.runId});
      } else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      return true;
    }
    /*
     * Talking to an agent about a program that already exists.
     *
     * `ask` is a consult: read-only, no writer lock, the answer is its
     * transcript. `revisions` opens a revision draft — a copy of the program an
     * agent edits — and, like a new-program draft, changes nothing until the
     * operator applies it.
     */
    const programAgentMatch=url.pathname.match(/^\/api\/programs\/(\d+)\/(ask|revisions)$/);
    if(programAgentMatch){
      if(method!=="POST"){json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});return true;}
      const programId=id(programAgentMatch[1]!);
      const workspaceId=workspaces.programBrief(programId).workspace.id;
      const input=await body(req);
      const model=typeof input.model==="string"&&input.model!==""?input.model:null;
      if(programAgentMatch[2]==="ask"){
        if(!isProviderId(input.provider))throw new WorkspaceError(422,"validation_error","Choose an agent to ask",{provider:"Unknown provider"});
        const question=typeof input.question==="string"?input.question.trim():"";
        if(question==="")throw new WorkspaceError(422,"validation_error","Ask a question about the program",{question:"Required"});
        const started=await startConsult({workspaceId,programId,provider:input.provider,model,question});
        json(res,202,{runId:started.runId});
        return true;
      }
      const goal=typeof input.goal==="string"?input.goal:"";
      if(input.provider===undefined){
        const draft=workspaces.createProgramRevision({workspaceId,programId,goal});
        json(res,201,{draft,preview:programDraftPreview(draft.body),runId:null});
        return true;
      }
      if(!isProviderId(input.provider))throw new WorkspaceError(422,"validation_error","Choose an agent to make the changes",{provider:"Unknown provider"});
      const started=await startProgramAuthor({workspaceId,programId,goal,provider:input.provider,model});
      json(res,201,{draft:started.draft,preview:programDraftPreview(started.draft.body),runId:started.runId});
      return true;
    }
    /*
     * The request bar: one door for asking an agent anything about a workspace.
     *
     * Every request is a target and a mode (see `shared/src/agentRequest.ts`),
     * and this only routes it to the run or proposal that already exists for
     * that pair. Nothing here changes the workspace: `ask` is a read-only
     * consult, and the other modes open a proposal the operator applies.
     */
    const agentRequestMatch=url.pathname.match(/^\/api\/workspaces\/(\d+)\/agent-requests$/);
    if(agentRequestMatch){
      if(method!=="POST"){json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});return true;}
      const workspaceId=id(agentRequestMatch[1]!);
      const parsed=normalizeAgentRequest(await body(req));
      if(!parsed.ok)throw new WorkspaceError(422,"validation_error","That request cannot be sent",parsed.errors);
      const result=await routeAgentRequest(workspaceId,parsed.value);
      json(res,result.kind==="consult"?202:201,result);
      return true;
    }
    const proposalsMatch=url.pathname.match(/^\/api\/workspaces\/(\d+)\/instruction-proposals$/);
    if(proposalsMatch){
      if(method==="GET")json(res,200,{proposals:workspaces.instructionProposals(id(proposalsMatch[1]!))});
      else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      return true;
    }
    const proposalMatch=url.pathname.match(/^\/api\/instruction-proposals\/(\d+)(?:\/(apply|discard|revise))?$/);
    if(proposalMatch){
      const proposalId=id(proposalMatch[1]!);
      const action=proposalMatch[2];
      if(action===undefined&&method==="GET")json(res,200,{proposal:workspaces.instructionProposal(proposalId)});
      else if(action===undefined&&method==="PATCH")json(res,200,{proposal:workspaces.saveInstructionProposal(proposalId,await body(req,MAX_PROPOSAL_BODY_BYTES))});
      else if(action===undefined&&method==="DELETE"){workspaces.removeInstructionProposal(proposalId);res.writeHead(204);res.end();}
      else if(action==="apply"&&method==="POST"){
        const input=await body(req);
        json(res,200,workspaces.applyInstructionProposal(proposalId,{force:input.force===true}));
      }
      else if(action==="discard"&&method==="POST")json(res,200,{proposal:workspaces.discardInstructionProposal(proposalId)});
      else if(action==="revise"&&method==="POST"){
        const input=await body(req);
        if(!isProviderId(input.provider))throw new WorkspaceError(422,"validation_error","Choose an agent to rework it with",{provider:"Unknown provider"});
        const proposal=workspaces.instructionProposal(proposalId);
        const started=await startInstructionAuthor({
          workspaceId:proposal.workspaceId,proposalId,provider:input.provider,
          model:typeof input.model==="string"&&input.model!==""?input.model:null,
          ...(typeof input.feedback==="string"?{feedback:input.feedback}:{}),
        });
        json(res,202,started);
      }
      else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      return true;
    }
    const draftMatch=url.pathname.match(/^\/api\/program-drafts\/(\d+)$/);
    if(draftMatch){
      const draftId=id(draftMatch[1]!);
      if(method==="GET"){
        const draft=workspaces.programDraft(draftId);
        json(res,200,{draft,preview:programDraftPreview(draft.body)});
      } else if(method==="PATCH"){
        const draft=workspaces.saveProgramDraft(draftId,await body(req,MAX_DRAFT_BODY_BYTES));
        json(res,200,{draft,preview:programDraftPreview(draft.body)});
      } else if(method==="DELETE"){
        workspaces.removeProgramDraft(draftId);res.writeHead(204);res.end();
      } else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      return true;
    }
    const draftApplyMatch=url.pathname.match(/^\/api\/program-drafts\/(\d+)\/apply$/);
    if(draftApplyMatch){
      if(method!=="POST")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else {
        const input=await body(req);
        const applied=workspaces.applyProgramDraft(id(draftApplyMatch[1]!),{withPipeline:input.withPipeline===true});
        json(res,201,{
          draft:applied.draft,
          programId:applied.programId,
          prompts:applied.prompts,
          pipelineId:applied.pipelineId,
          pipelineError:applied.pipelineError,
          revision:applied.revision,
          workspace:workspaces.tree(applied.draft.workspaceId),
        });
      }
      return true;
    }
    const draftDiscardMatch=url.pathname.match(/^\/api\/program-drafts\/(\d+)\/discard$/);
    if(draftDiscardMatch){
      if(method!=="POST")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else {
        const draft=workspaces.discardProgramDraft(id(draftDiscardMatch[1]!));
        json(res,200,{draft,preview:programDraftPreview(draft.body)});
      }
      return true;
    }
    const draftReviseMatch=url.pathname.match(/^\/api\/program-drafts\/(\d+)\/revise$/);
    if(draftReviseMatch){
      if(method!=="POST")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else {
        const draftId=id(draftReviseMatch[1]!);
        const input=await body(req);
        if(!isProviderId(input.provider))throw new WorkspaceError(422,"validation_error","Choose a provider to revise with",{provider:"Unknown provider"});
        const draft=workspaces.programDraft(draftId);
        const started=await startProgramAuthor({
          workspaceId:draft.workspaceId,draftId,provider:input.provider,
          model:typeof input.model==="string"?input.model:null,
          ...(typeof input.feedback==="string"?{feedback:input.feedback}:{}),
        });
        json(res,202,{draft:started.draft,preview:programDraftPreview(started.draft.body),runId:started.runId});
      }
      return true;
    }
    let importMatch=url.pathname.match(/^\/api\/workspaces\/(\d+)\/imports\/(inspect|apply)$/);
    if(importMatch){
      if(method!=="POST") json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else { const workspaceId=id(importMatch[1]!); workspaces.get(workspaceId); const input=await body(req); const inspected=inspectPromptPack(input.rootPath,input.programKey); if(importMatch[2]==="inspect") json(res,200,{preview:inspected.preview}); else json(res,201,{preview:inspected.preview,workspace:workspaces.importProgram(workspaceId,inspected.pack)}); }
      return true;
    }
    let match = url.pathname.match(/^\/api\/workspaces\/(\d+)\/revisions$/);
    if (match && method === "GET") {
      const field = url.searchParams.get("field");
      json(res, 200, { revisions: workspaces.workspaceRevisions(id(match[1]!), field ?? undefined) });
      return true;
    }
    match = url.pathname.match(/^\/api\/workspaces\/(\d+)\/revisions\/(\d+)\/restore$/);
    if (match && method === "POST") {
      json(res, 200, { workspace: workspaces.restoreWorkspaceRevision(id(match[1]!), id(match[2]!)) });
      return true;
    }
    match = url.pathname.match(/^\/api\/workspaces\/(\d+)(?:\/(tree|prompts|programs))?$/);
    if (match) {
      const workspaceId = id(match[1]!); const child = match[2];
      if (!child && method === "GET") json(res, 200, { workspace: workspaces.get(workspaceId) });
      else if (!child && method === "PATCH") json(res, 200, { workspace: workspaces.update(workspaceId, await body(req)) });
      else if (!child && method === "DELETE") { workspaces.remove(workspaceId); res.writeHead(204); res.end(); }
      else if (child === "tree" && method === "GET") json(res, 200, { workspace: workspaces.tree(workspaceId) });
      else if (child === "prompts" && method === "GET") json(res, 200, { prompts: workspaces.promptOptions(workspaceId) });
      else if (child === "programs" && method === "GET") json(res, 200, { programs: workspaces.tree(workspaceId).programs });
      else if (child === "programs" && method === "POST") json(res, 201, { program: workspaces.createChild("program", workspaceId, await body(req)) });
      else json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      return true;
    }
    match = url.pathname.match(/^\/api\/(programs|suites)\/(\d+)\/(suites|prompts)$/);
    if (match && method === "POST") {
      const parent = match[1]!; const child = match[3]!;
      if ((parent === "programs" && child !== "suites") || (parent === "suites" && child !== "prompts")) throw new WorkspaceError(404, "not_found", "Route not found");
      const kind = child === "suites" ? "suite" : "prompt";
      json(res, 201, { [kind]: workspaces.createChild(kind, id(match[2]!), await body(req)) }); return true;
    }
    match = url.pathname.match(/^\/api\/(programs|suites|prompts)\/(\d+)$/);
    if (match) {
      const kind = match[1]!.slice(0, -1) as "program" | "suite" | "prompt"; const resourceId = id(match[2]!);
      if (method === "PATCH") json(res, 200, { [kind]: workspaces.updateChild(kind, resourceId, await body(req)) });
      else if (method === "DELETE") { workspaces.removeChild(kind, resourceId); res.writeHead(204); res.end(); }
      else json(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
      return true;
    }
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/revisions$/);
    if(match&&method==="GET"){json(res,200,{revisions:workspaces.promptRevisions(id(match[1]!))});return true;}
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/revisions\/(\d+)\/restore$/);
    if(match&&method==="POST"){json(res,200,{prompt:workspaces.restorePromptRevision(id(match[1]!),id(match[2]!))});return true;}
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/history$/);
    if(match&&method==="GET"){json(res,200,workspaces.promptHistory(id(match[1]!)));return true;}
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/activity$/);
    if(match&&method==="GET"){json(res,200,workspaces.promptActivity(id(match[1]!)));return true;}
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/clarify$/);
    if(match&&method==="POST"){
      const promptId=id(match[1]!);const input=await body(req);
      if(!isProviderId(input.provider))throw new WorkspaceError(422,"provider_required","Choose an agent for clarification.");
      if(typeof input.question!=="string"||!input.question.trim())throw new WorkspaceError(422,"validation_error","A clarification question is required.");
      const home=workspaces.promptHome(promptId);
      json(res,201,await startExecute({workspaceId:home.workspaceId,promptId,provider:input.provider,model:typeof input.model==="string"?input.model:null,mode:"clarify",question:input.question}));return true;
    }
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/respond-and-continue$/);
    if(match&&method==="POST"){json(res,200,await respondAndContinue(id(match[1]!),await body(req)));return true;}
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/save-human-response$/);
    if(match&&method==="POST"){json(res,201,await saveHumanResponse(id(match[1]!),await body(req)));return true;}
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/human-response$/);
    if(match&&method==="POST"){
      const promptId=id(match[1]!);
      // M-17: answering starts a local run through the scheduler below, so a
      // teammate holding this item would have had a second run started against
      // the work they were doing.
      await assertNoLiveHandover(promptId,"Answering this work item");
      const remark=workspaces.respondToBlockedPrompt(promptId,await body(req));
      await pipelineScheduler.onPromptResponded(promptId);
      json(res,201,{remark});return true;
    }
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/recover$/);
    if(match&&method==="POST"){const promptId=id(match[1]!);await assertNoLiveHandover(promptId,"Recovering this work item");const runId=workspaces.recoveryRunId(promptId);await activeRuns.stop(runId);workspaces.recoverPrompt(promptId,runId);json(res,200,{recovered:true});return true;}
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/classify-start-unknown$/);
    if(match&&method==="POST"){json(res,200,workspaces.classifyStartUnknown(id(match[1]!),await body(req)));return true;}
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/handoff$/);
    if(match&&method==="POST"){
      const promptId=id(match[1]!);const input=await body(req);const handoffProvider=input.handoffProvider;const successorProvider=input.successorProvider;
      if(!isProviderId(handoffProvider)||!isProviderId(successorProvider))throw new WorkspaceError(422,"validation_error","Choose valid handoff and successor providers");
      if(handoffProvider==="cursor")throw new WorkspaceError(422,"handoff_not_supported","Cursor cannot guarantee a read-only handoff");
      const sourceRunId=workspaces.latestExecuteRunId(promptId);const source=workspaces.runSummary(sourceRunId);
      const namedPipelineId=typeof input.pipelineId==="number"&&Number.isSafeInteger(input.pipelineId)&&input.pipelineId>0?input.pipelineId:undefined;
      const result=await scheduleHandoff({workspaceId:source.workspaceId,promptId,sourceRunId,sourceProvider:source.provider,sourceModel:source.model,processState:source.state.toLowerCase(),handoffProvider,handoffModel:typeof input.handoffModel==="string"?input.handoffModel:null,successorProvider,successorModel:typeof input.successorModel==="string"?input.successorModel:null,namedPipelineId});
      if(!result.started)throw new WorkspaceError(409,result.code,result.message,result.detail===undefined?undefined:{detail:result.detail});
      json(res,202,result);return true;
    }
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/audit$/);
    if(match&&method==="POST"){
      const promptId=id(match[1]!);const input=await body(req);
      const sourceRunId=workspaces.latestExecuteRunId(promptId);const source=workspaces.runSummary(sourceRunId);
      const auditProvider=input.provider;
      if(auditProvider!==undefined&&!isProviderId(auditProvider))throw new WorkspaceError(422,"validation_error","Choose a valid read-only provider");
      if(auditProvider==="cursor")throw new WorkspaceError(422,"audit_not_supported","Cursor cannot be held read-only, so it cannot audit");
      const result=await scheduleCompletionAudit({
        workspaceId:source.workspaceId,promptId,sourceRunId,sourceProvider:source.provider,automatic:false,
        ...(auditProvider===undefined?{}:{auditProvider}),
        ...(typeof input.model==="string"?{auditModel:input.model}:{}),
      });
      if(!result.started)throw new WorkspaceError(409,AUDIT_BLOCK_CODE[result.block],AUDIT_BLOCK_MESSAGE[result.block]);
      json(res,202,{started:true,auditId:result.auditId});return true;
    }
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/audits$/);
    if(match&&method==="GET"){json(res,200,{audits:workspaces.completionAuditsForPrompt(id(match[1]!))});return true;}
    json(res, 404, { error: { code: "not_found", message: "Route not found" } }); return true;
  } catch (error) { failure(res, error); return true; }
}
