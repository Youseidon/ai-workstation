import type { IncomingMessage, ServerResponse } from "node:http";
import { pipelineScheduler } from "./pipelineScheduler.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";
import { inspectPromptPack } from "./promptImport.ts";
import { activeRuns } from "./activeRuns.ts";
import { runHub } from "./runHub.ts";
import { isProviderId, promptNeedsHandoff } from "@agent-console/shared";
import { resumeReadyHandoff, scheduleHandoff, type HandoffBlock } from "./handoffCoordinator.ts";
import { scheduleCompletionAudit, type AuditBlock } from "./completionAudit.ts";

const MAX_BODY_BYTES = 128 * 1024;

// One message per reason: "something is in the way" left operators guessing
// which of three unrelated conditions they had hit, and what to do about it.
const HANDOFF_BLOCK_CODE: Record<HandoffBlock, string> = {
  already_complete: "station_already_complete",
  handoff_running: "handoff_in_progress",
  reusable: "handoff_reusable",
  attempt_limit: "handoff_limit_reached",
  provider_unavailable: "handoff_provider_unavailable",
};
const HANDOFF_BLOCK_MESSAGE: Record<HandoffBlock, string> = {
  already_complete: "This station is already complete; resume the pipeline to start the next ready station",
  handoff_running: "A handoff agent is already preparing a brief for this run; wait for it to finish",
  reusable: "A handoff brief for this run is ready; continue with it instead of preparing another",
  attempt_limit: "This station reached the handoff attempt limit; raise it in Pipeline policy or retry the station directly",
  provider_unavailable: "The selected handoff provider is unavailable; choose another read-only agent",
};

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

function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > MAX_BODY_BYTES) { reject(new WorkspaceError(413, "body_too_large", "Request body is too large")); req.destroy(); }
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
  if (error instanceof WorkspaceError) { json(res, error.status, { error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) } }); return; }
  console.error("workspace API failed", error);
  json(res, 500, { error: { code: "internal_error", message: "Workspace operation failed" } });
}

export async function handleWorkspaceApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== "/api/sessions" && url.pathname !== "/api/operations" && url.pathname !== "/api/report" && url.pathname !== "/api/pipelines" && !url.pathname.startsWith("/api/workspaces") && !/^\/api\/(programs|suites|prompts|runs|verifications|pipelines)\//.test(url.pathname)) return false;
  const mutates = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
  if (mutates) {
    res.once("finish", () => {
      if (res.statusCode >= 200 && res.statusCode < 300) runHub.operationsChanged();
    });
  }
  try {
    const method = req.method ?? "GET";
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
    const suitePipelineMatch=url.pathname.match(/^\/api\/suites\/(\d+)\/pipeline$/);
    if(suitePipelineMatch){
      const suiteId=id(suitePipelineMatch[1]!);
      if(method==="GET")json(res,200,workspaces.pipeline(suiteId));
      else if(method==="PATCH"){workspaces.updateSuitePipelineDefaults(suiteId,await body(req));json(res,200,workspaces.pipeline(suiteId));}
      else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      return true;
    }
    const suitePipelineStepsMatch=url.pathname.match(/^\/api\/suites\/(\d+)\/pipeline\/steps$/);
    if(suitePipelineStepsMatch){
      const suiteId=id(suitePipelineStepsMatch[1]!);
      if(method==="POST"){
        const input=await body(req);
        const promptId=typeof input.promptId==="number"?input.promptId:0;
        const home=workspaces.promptHome(promptId);
        if(home.suiteId!==suiteId)throw new WorkspaceError(422,"validation_error","Prompt is not in this suite");
        json(res,200,{rule:workspaces.addPipelineStep(promptId,input),pipeline:workspaces.pipeline(suiteId)});
      } else if(method==="PUT"){
        const input=await body(req);
        const promptIds=Array.isArray(input.promptIds)?input.promptIds.filter((value):value is number=>typeof value==="number"):[];
        json(res,200,{steps:workspaces.reorderPipelineSteps(suiteId,promptIds),pipeline:workspaces.pipeline(suiteId)});
      } else json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      return true;
    }
    const pipelineStepMatch=url.pathname.match(/^\/api\/prompts\/(\d+)\/pipeline-step$/);
    if(pipelineStepMatch){
      if(method!=="DELETE")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else {
        const promptId=id(pipelineStepMatch[1]!);
        workspaces.removePipelineStep(promptId);
        json(res,200,{pipeline:workspaces.pipeline(workspaces.promptHome(promptId).suiteId)});
      }
      return true;
    }
    const suitePlayMatch=url.pathname.match(/^\/api\/suites\/(\d+)\/play$/);
    if(suitePlayMatch){
      if(method!=="POST")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else json(res,200,{pipeline:await pipelineScheduler.play(id(suitePlayMatch[1]!),await body(req))});
      return true;
    }
    const suitePauseMatch=url.pathname.match(/^\/api\/suites\/(\d+)\/pause$/);
    if(suitePauseMatch){
      if(method!=="POST")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else json(res,200,{pipeline:await pipelineScheduler.pause(id(suitePauseMatch[1]!))});
      return true;
    }
    const suiteStopMatch=url.pathname.match(/^\/api\/suites\/(\d+)\/stop$/);
    if(suiteStopMatch){
      if(method!=="POST")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else json(res,200,{pipeline:await pipelineScheduler.stop(id(suiteStopMatch[1]!))});
      return true;
    }
    const pipelineRuleMatch=url.pathname.match(/^\/api\/prompts\/(\d+)\/pipeline-rule$/);
    if(pipelineRuleMatch){
      if(method!=="PATCH")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else json(res,200,{rule:workspaces.upsertPipelineRule(id(pipelineRuleMatch[1]!),await body(req))});
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
    const completeMatch=url.pathname.match(/^\/api\/prompts\/(\d+)\/complete$/);
    if(completeMatch){
      if(method!=="POST")json(res,405,{error:{code:"method_not_allowed",message:"Method not allowed"}});
      else {
        const promptId=id(completeMatch[1]!);
        const input=await body(req);
        workspaces.completePrompt(promptId,"USER",{reason:input.reason,verificationSummary:input.verificationSummary});
        await pipelineScheduler.onPromptCompleted(promptId);
        json(res,200,{completed:true});
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
    if(match&&method==="POST"){json(res,201,{remark:workspaces.respondToBlockedPrompt(id(match[1]!),await body(req))});return true;}
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/recover$/);
    if(match&&method==="POST"){const promptId=id(match[1]!);const runId=workspaces.recoveryRunId(promptId);await activeRuns.stop(runId);workspaces.recoverPrompt(promptId,runId);json(res,200,{recovered:true});return true;}
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/retry-launch$/);
    if(match&&method==="POST"){
      const promptId=id(match[1]!);const input=await body(req);const provider=input.provider;
      if(!isProviderId(provider))throw new WorkspaceError(422,"validation_error","Choose a valid successor provider");
      const pipelineId=typeof input.pipelineId==="number"&&Number.isSafeInteger(input.pipelineId)&&input.pipelineId>0?input.pipelineId:null;
      if(pipelineId===null)throw new WorkspaceError(422,"validation_error","pipelineId is required");
      const runId=workspaces.latestExecuteRunId(promptId);
      if(!workspaces.canDirectRetry(promptId))throw new WorkspaceError(409,"handoff_required","This run produced work; prepare a handoff before continuing");
      workspaces.recoverPrompt(promptId,runId);
      const {pipelineScheduler}=await import("./pipelineScheduler.ts");
      const run=await pipelineScheduler.playNamed(pipelineId,{provider,model:typeof input.model==="string"?input.model:null,preferPlayTarget:true});
      json(res,202,{started:true,run});return true;
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
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/handoff$/);
    if(match&&method==="POST"){
      const promptId=id(match[1]!);const input=await body(req);const handoffProvider=input.handoffProvider;const successorProvider=input.successorProvider;
      const outcome=workspaces.promptOutcome(promptId);
      if(!promptNeedsHandoff(outcome.status))throw new WorkspaceError(409,"station_already_complete","This station is already complete; resume the pipeline to start the next ready station");
      if(!isProviderId(successorProvider))throw new WorkspaceError(422,"validation_error","Choose a valid successor provider");
      const sourceRunId=workspaces.latestExecuteRunId(promptId);const source=workspaces.runSummary(sourceRunId);
      const namedPipelineId=typeof input.pipelineId==="number"&&Number.isSafeInteger(input.pipelineId)&&input.pipelineId>0?input.pipelineId:undefined;
      if(typeof input.reuseHandoffId==="string"&&input.reuseHandoffId!==""){
        const runId=await resumeReadyHandoff({handoffId:input.reuseHandoffId,promptId,failedSuccessorRunId:sourceRunId,successorProvider,successorModel:typeof input.successorModel==="string"?input.successorModel:null,namedPipelineId});json(res,202,{started:true,reused:true,runId});return true;
      }
      if(!isProviderId(handoffProvider))throw new WorkspaceError(422,"validation_error","Choose a valid handoff provider");
      if(handoffProvider==="cursor")throw new WorkspaceError(422,"handoff_not_supported","Cursor cannot guarantee a read-only handoff");
      const result=await scheduleHandoff({workspaceId:source.workspaceId,promptId,sourceRunId,sourceProvider:source.provider,sourceModel:source.model,processState:source.state.toLowerCase(),handoffProvider,handoffModel:typeof input.handoffModel==="string"?input.handoffModel:null,successorProvider,successorModel:typeof input.successorModel==="string"?input.successorModel:null,namedPipelineId});
      if(!result.started)throw new WorkspaceError(409,HANDOFF_BLOCK_CODE[result.block],HANDOFF_BLOCK_MESSAGE[result.block]);
      json(res,202,{started:true});return true;
    }
    json(res, 404, { error: { code: "not_found", message: "Route not found" } }); return true;
  } catch (error) { failure(res, error); return true; }
}
