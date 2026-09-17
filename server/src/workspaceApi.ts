import type { IncomingMessage, ServerResponse } from "node:http";
import { pipelineScheduler } from "./pipelineScheduler.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";
import { inspectPromptPack } from "./promptImport.ts";
import { activeRuns } from "./activeRuns.ts";
import { runHub } from "./runHub.ts";
import { isProviderId, programDraftPreview } from "@agent-console/shared";
import { startConsult, startProgramAuthor } from "./runService.ts";
import { scheduleCompletionAudit, type AuditBlock } from "./completionAudit.ts";

const MAX_BODY_BYTES = 128 * 1024;
/*
 * An operator editing a drafted program PATCHes the whole body back: every
 * suite, every work item, every page of instructions. That is legitimately
 * larger than any other request this API takes.
 */
const MAX_DRAFT_BODY_BYTES = 4 * 1024 * 1024;

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
    || pathname.startsWith("/api/workspaces")
    || pathname.startsWith("/api/program-drafts")
    || /^\/api\/(programs|suites|prompts|runs|verifications|pipelines)\//.test(pathname);
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
      else {const value=url.searchParams.get("workspace");const workspaceId=value===null?undefined:id(value);json(res,200,workspaces.operations(workspaceId));}
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
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/human-response$/);
    if(match&&method==="POST"){
      const promptId=id(match[1]!);
      const remark=workspaces.respondToBlockedPrompt(promptId,await body(req));
      await pipelineScheduler.onPromptResponded(promptId);
      json(res,201,{remark});return true;
    }
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/recover$/);
    if(match&&method==="POST"){const promptId=id(match[1]!);const runId=workspaces.recoveryRunId(promptId);await activeRuns.stop(runId);workspaces.recoverPrompt(promptId,runId);json(res,200,{recovered:true});return true;}
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
