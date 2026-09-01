import type { IncomingMessage, ServerResponse } from "node:http";
import { pipelineScheduler } from "./pipelineScheduler.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";
import { inspectPromptPack } from "./promptImport.ts";
import { activeRuns } from "./activeRuns.ts";
import { runHub } from "./runHub.ts";

const MAX_BODY_BYTES = 128 * 1024;

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
    let match = url.pathname.match(/^\/api\/workspaces\/(\d+)(?:\/(tree|prompts|programs))?$/);
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
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/history$/);
    if(match&&method==="GET"){json(res,200,workspaces.promptHistory(id(match[1]!)));return true;}
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/activity$/);
    if(match&&method==="GET"){json(res,200,workspaces.promptActivity(id(match[1]!)));return true;}
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/human-response$/);
    if(match&&method==="POST"){json(res,201,{remark:workspaces.respondToBlockedPrompt(id(match[1]!),await body(req))});return true;}
    match=url.pathname.match(/^\/api\/prompts\/(\d+)\/recover$/);
    if(match&&method==="POST"){const promptId=id(match[1]!);const runId=workspaces.recoveryRunId(promptId);await activeRuns.stop(runId);workspaces.recoverPrompt(promptId,runId);json(res,200,{recovered:true});return true;}
    json(res, 404, { error: { code: "not_found", message: "Route not found" } }); return true;
  } catch (error) { failure(res, error); return true; }
}
