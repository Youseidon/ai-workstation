import type {
  ProgramDraftBody, ProgramDraftRecord, ProgramDraftPreview,
  StatusDefinition, DefinitionOfDone, DodEvaluation, AgentSession, ApiErrorBody, HumanInputRequest, OperationsSnapshot, PipelineDashboard, PipelineFlowchartView, PipelineRecord, PipelineRun, PipelineRunDetail, PromptActivity, PromptOption, PromptPipelineRule, PromptRemark, PromptStatusEvent, ProviderId, SuiteVerificationContext, SuiteVerificationDetail, SuiteVerificationRecord, UsageReport, WorkspaceRecord, WorkspaceTree } from "@agent-console/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    public fields?: Record<string, string>,
    public code?: string,
    public status?: number,
  ) { super(message); }
}

async function request<T>(serverUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, serverUrl), { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  if (!response.ok) {
    let data: ApiErrorBody | null = null;
    try { data = await response.json() as ApiErrorBody; } catch { /* use status text */ }
    throw new ApiError(data?.error.message ?? response.statusText, data?.error.fields, data?.error.code, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const json = (value: unknown): RequestInit => ({ body: JSON.stringify(value) });

/** What applying a revision draft did to its program. */
export interface ProgramRevisionApplied { added:number; updated:number; removed:number; moved:number; newPromptIds:number[]; pipelineSteps:number }

export const workspaceApi = {
  async sessions(serverUrl:string){return (await request<{sessions:AgentSession[]}>(serverUrl,"/api/sessions")).sessions;},
  async session(serverUrl:string,runId:string){return (await request<{session:AgentSession}>(serverUrl,`/api/sessions/${encodeURIComponent(runId)}`)).session;},
  async report(serverUrl:string,workspaceId?:number){return (await request<{report:UsageReport}>(serverUrl,`/api/report${workspaceId===undefined?"":`?workspace=${workspaceId}`}`)).report;},
  /** The status catalog and the trigger sentences, for the rules screen. */
  statuses(serverUrl:string){return request<{statuses:StatusDefinition[];triggers:Record<string,string>}>(serverUrl,"/api/statuses");},
  patchStatus(serverUrl:string,id:string,value:unknown){return request<{status:StatusDefinition}>(serverUrl,`/api/statuses/${id}`,{method:"PATCH",...json(value)}).then(r=>r.status);},
  resetStatus(serverUrl:string,id:string){return request<{status:StatusDefinition}>(serverUrl,`/api/statuses/${id}`,{method:"DELETE"}).then(r=>r.status);},
  /** What a work item is judged against, and how each criterion stands. */
  definitionOfDone(serverUrl:string,promptId:number){return request<{definitionOfDone:DefinitionOfDone;evaluation:DodEvaluation}>(serverUrl,`/api/prompts/${promptId}/definition-of-done`);},
  /** Runs the command criteria now. The same execution a close is decided on. */
  runDefinitionOfDone(serverUrl:string,promptId:number){return request<{definitionOfDone:DefinitionOfDone;evaluation:DodEvaluation}>(serverUrl,`/api/prompts/${promptId}/definition-of-done`,{method:"POST",body:"{}"});},
  scopeDefinitionOfDone(serverUrl:string,scope:string,scopeId:number){return request<{definitionOfDone:DefinitionOfDone}>(serverUrl,`/api/definition-of-done/${scope}/${scopeId}`).then(r=>r.definitionOfDone);},
  setDodEnforcement(serverUrl:string,scope:string,scopeId:number,enforcement:string|null){return request<{definitionOfDone:DefinitionOfDone}>(serverUrl,`/api/definition-of-done/${scope}/${scopeId}`,{method:"PATCH",...json({enforcement})}).then(r=>r.definitionOfDone);},
  addDodCriterion(serverUrl:string,scope:string,scopeId:number,patch:Record<string,unknown>){return request<{definitionOfDone:DefinitionOfDone}>(serverUrl,`/api/definition-of-done/${scope}/${scopeId}`,{method:"POST",...json(patch)}).then(r=>r.definitionOfDone);},
  patchDodCriterion(serverUrl:string,scope:string,scopeId:number,criterionId:number,patch:Record<string,unknown>){return request<{definitionOfDone:DefinitionOfDone}>(serverUrl,`/api/definition-of-done/${scope}/${scopeId}/criteria/${criterionId}`,{method:"PATCH",...json(patch)}).then(r=>r.definitionOfDone);},
  removeDodCriterion(serverUrl:string,scope:string,scopeId:number,criterionId:number){return request<{definitionOfDone:DefinitionOfDone}>(serverUrl,`/api/definition-of-done/${scope}/${scopeId}/criteria/${criterionId}`,{method:"DELETE"}).then(r=>r.definitionOfDone);},
  patchTrigger(serverUrl:string,id:string,sentence:string|null){return request<{triggers:Record<string,string>}>(serverUrl,`/api/triggers/${id}`,{method:"PATCH",...json({sentence})}).then(r=>r.triggers);},
  operations(serverUrl:string,workspaceId?:number){return request<OperationsSnapshot>(serverUrl,`/api/operations${workspaceId===undefined?"":`?workspace=${workspaceId}`}`);},
  /** Records a fresh audit of what the orchestration records already claim. */
  auditSuite(serverUrl:string,suiteId:number){return request<{verification:SuiteVerificationRecord}>(serverUrl,`/api/suites/${suiteId}/verification`,{method:"POST",body:"{}"}).then(r=>r.verification);},
  verifications(serverUrl:string,suiteId:number){return request<{verifications:SuiteVerificationRecord[]}>(serverUrl,`/api/suites/${suiteId}/verifications`).then(r=>r.verifications);},
  verification(serverUrl:string,id:number){return request<{verification:SuiteVerificationDetail}>(serverUrl,`/api/verifications/${id}`).then(r=>r.verification);},
  verificationContext(serverUrl:string,suiteId:number){return request<SuiteVerificationContext>(serverUrl,`/api/suites/${suiteId}/verification-context`);},
  activity(serverUrl:string,promptId:number){return request<PromptActivity>(serverUrl,`/api/prompts/${promptId}/activity`);},
  interruptRun(serverUrl:string,runId:string){return request<{interrupted:boolean}>(serverUrl,`/api/runs/${encodeURIComponent(runId)}/interrupt`,{method:"POST",...json({})});},
  async list(serverUrl: string) { return (await request<{ workspaces: WorkspaceRecord[] }>(serverUrl, "/api/workspaces")).workspaces; },
  async tree(serverUrl: string, id: number) { return (await request<{ workspace: WorkspaceTree }>(serverUrl, `/api/workspaces/${id}/tree`)).workspace; },
  async prompts(serverUrl: string, id: number) { return (await request<{ prompts: PromptOption[] }>(serverUrl, `/api/workspaces/${id}/prompts`)).prompts; },
  create(serverUrl: string, value: unknown) { return request(serverUrl, "/api/workspaces", { method: "POST", ...json(value) }); },
  update(serverUrl: string, id: number, value: unknown) { return request(serverUrl, `/api/workspaces/${id}`, { method: "PATCH", ...json(value) }); },
  remove(serverUrl: string, id: number) { return request<void>(serverUrl, `/api/workspaces/${id}`, { method: "DELETE" }); },
  createChild(serverUrl: string, parent: "workspaces"|"programs"|"suites", id: number, child: "programs"|"suites"|"prompts", value: unknown) { return request(serverUrl, `/api/${parent}/${id}/${child}`, { method: "POST", ...json(value) }); },
  updateChild(serverUrl: string, kind: "programs"|"suites"|"prompts", id: number, value: unknown) { return request(serverUrl, `/api/${kind}/${id}`, { method: "PATCH", ...json(value) }); },
  removeChild(serverUrl: string, kind: "programs"|"suites"|"prompts", id: number) { return request<void>(serverUrl, `/api/${kind}/${id}`, { method: "DELETE" }); },
  /* Agent-authored programs: the draft is written by an agent (or by hand) and
     only `applyProgramDraft` turns one into a program. */
  programDrafts(serverUrl:string,workspaceId:number){return request<{drafts:Array<{draft:ProgramDraftRecord;preview:ProgramDraftPreview}>}>(serverUrl,`/api/workspaces/${workspaceId}/program-drafts`).then(r=>r.drafts);},
  programDraft(serverUrl:string,id:number){return request<{draft:ProgramDraftRecord;preview:ProgramDraftPreview}>(serverUrl,`/api/program-drafts/${id}`);},
  /** With a provider, starts an author run; without one, opens an empty draft. */
  startProgramDraft(serverUrl:string,workspaceId:number,value:{goal:string;provider?:ProviderId;model?:string|null}){return request<{draft:ProgramDraftRecord;preview:ProgramDraftPreview;runId:string|null}>(serverUrl,`/api/workspaces/${workspaceId}/program-drafts`,{method:"POST",...json(value)});},
  saveProgramDraft(serverUrl:string,id:number,body:ProgramDraftBody){return request<{draft:ProgramDraftRecord;preview:ProgramDraftPreview}>(serverUrl,`/api/program-drafts/${id}`,{method:"PATCH",...json(body)});},
  applyProgramDraft(serverUrl:string,id:number,value:{withPipeline?:boolean}={}){return request<{draft:ProgramDraftRecord;programId:number;prompts:number;pipelineId:number|null;pipelineError:string|null;revision:ProgramRevisionApplied|null;workspace:WorkspaceTree}>(serverUrl,`/api/program-drafts/${id}/apply`,{method:"POST",...json(value)});},
  discardProgramDraft(serverUrl:string,id:number){return request<{draft:ProgramDraftRecord}>(serverUrl,`/api/program-drafts/${id}/discard`,{method:"POST",body:"{}"}).then(r=>r.draft);},
  removeProgramDraft(serverUrl:string,id:number){return request<void>(serverUrl,`/api/program-drafts/${id}`,{method:"DELETE"});},
  reviseProgramDraft(serverUrl:string,id:number,value:{provider:ProviderId;model?:string|null;feedback?:string}){return request<{draft:ProgramDraftRecord;preview:ProgramDraftPreview;runId:string}>(serverUrl,`/api/program-drafts/${id}/revise`,{method:"POST",...json(value)});},
  /* An existing program: ask about it (a read-only consult whose answer is its
     transcript), or open a revision draft of it, with or without an agent. */
  askAboutProgram(serverUrl:string,programId:number,value:{question:string;provider:ProviderId;model?:string|null}){return request<{runId:string}>(serverUrl,`/api/programs/${programId}/ask`,{method:"POST",...json(value)});},
  startProgramRevision(serverUrl:string,programId:number,value:{goal:string;provider?:ProviderId;model?:string|null}){return request<{draft:ProgramDraftRecord;preview:ProgramDraftPreview;runId:string|null}>(serverUrl,`/api/programs/${programId}/revisions`,{method:"POST",...json(value)});},
  history(serverUrl:string,id:number){return request<{events:PromptStatusEvent[];remarks:PromptRemark[];runs:unknown[]}>(serverUrl,`/api/prompts/${id}/history`);},
  humanInput(serverUrl:string){return request<{requests:HumanInputRequest[]}>(serverUrl,"/api/prompts/human-input");},
  respond(serverUrl:string,id:number,content:string){return request<{remark:PromptRemark}>(serverUrl,`/api/prompts/${id}/human-response`,{method:"POST",...json({content})});},
  /** Operator override for work that is done but whose status write never landed. */
  completePrompt(serverUrl:string,id:number,verificationSummary:string,reason?:string){return request<{completed:boolean}>(serverUrl,`/api/prompts/${id}/complete`,{method:"POST",...json(reason===undefined?{verificationSummary}:{verificationSummary,reason})});},
  skipPrompt(serverUrl:string,id:number,reason?:string){return request<{skipped:boolean}>(serverUrl,`/api/prompts/${id}/skip`,{method:"POST",...json(reason===undefined?{}:{reason})});},
  recover(serverUrl:string,id:number){return request<{recovered:boolean}>(serverUrl,`/api/prompts/${id}/recover`,{method:"POST",...json({})});},
  startAudit(serverUrl:string,id:number,value:{provider?:ProviderId;model?:string|null}={}){return request<{started:boolean;auditId:string}>(serverUrl,`/api/prompts/${id}/audit`,{method:"POST",...json(value)});},
  updatePipelineDefaults(serverUrl:string,pipelineId:number,suiteId:number,value:{defaultProvider?:ProviderId|null;defaultModel?:string|null;defaultFallbackProviders?:ProviderId[]}){return request<PipelineFlowchartView>(serverUrl,`/api/pipelines/${pipelineId}/flowchart?suiteId=${suiteId}`,{method:"PATCH",...json(value)});},
  listPipelines(serverUrl:string,workspaceId?:number){return request<{pipelines:PipelineRecord[]}>(serverUrl,`/api/pipelines${workspaceId===undefined?"":`?workspace=${workspaceId}`}`).then(r=>r.pipelines);},
  pipelineDashboard(serverUrl:string,workspaceId:number){return request<PipelineDashboard>(serverUrl,`/api/pipelines?workspace=${workspaceId}&dashboard=1`);},
  pipelineFlowchart(serverUrl:string,pipelineId:number,suiteId:number,incompleteOnly=false){return request<PipelineFlowchartView>(serverUrl,`/api/pipelines/${pipelineId}/flowchart?suiteId=${suiteId}${incompleteOnly?"&incompleteOnly=1":""}`);},
  addPipelineFlowchartStep(serverUrl:string,pipelineId:number,suiteId:number,value:{promptId:number;provider?:ProviderId|null;model?:string|null},incompleteOnly=false){return request<{rule:PromptPipelineRule;flowchart:PipelineFlowchartView}>(serverUrl,`/api/pipelines/${pipelineId}/flowchart/steps?suiteId=${suiteId}${incompleteOnly?"&incompleteOnly=1":""}`,{method:"POST",...json(value)});},
  reorderPipelineFlowchartSteps(serverUrl:string,pipelineId:number,suiteId:number,promptIds:number[],incompleteOnly=false){return request<{steps:PromptPipelineRule[];flowchart:PipelineFlowchartView}>(serverUrl,`/api/pipelines/${pipelineId}/flowchart/steps?suiteId=${suiteId}${incompleteOnly?"&incompleteOnly=1":""}`,{method:"PUT",...json({promptIds})});},
  removePipelineFlowchartStep(serverUrl:string,pipelineId:number,suiteId:number,promptId:number,incompleteOnly=false){return request<{flowchart:PipelineFlowchartView}>(serverUrl,`/api/pipelines/${pipelineId}/flowchart/steps/${promptId}?suiteId=${suiteId}${incompleteOnly?"&incompleteOnly=1":""}`,{method:"DELETE"});},
  patchPipelineFlowchartRule(serverUrl:string,pipelineId:number,promptId:number,value:Partial<Omit<PromptPipelineRule,"promptId">>){return request<{rule:PromptPipelineRule}>(serverUrl,`/api/pipelines/${pipelineId}/flowchart/steps/${promptId}`,{method:"PATCH",...json(value)}).then(r=>r.rule);},
  getPipeline(serverUrl:string,id:number){return request<{pipeline:PipelineRecord}>(serverUrl,`/api/pipelines/${id}`).then(r=>r.pipeline);},
  createPipeline(serverUrl:string,value:{workspaceId:number;name:string;description?:string;suiteIds:number[]}){return request<{pipeline:PipelineRecord}>(serverUrl,"/api/pipelines",{method:"POST",...json(value)}).then(r=>r.pipeline);},
  updatePipeline(serverUrl:string,id:number,value:{name?:string;description?:string;suiteIds?:number[]}){return request<{pipeline:PipelineRecord}>(serverUrl,`/api/pipelines/${id}`,{method:"PATCH",...json(value)}).then(r=>r.pipeline);},
  removePipeline(serverUrl:string,id:number){return request<void>(serverUrl,`/api/pipelines/${id}`,{method:"DELETE"});},
  pipelineRuns(serverUrl:string,id:number){return request<{runs:PipelineRunDetail[]}>(serverUrl,`/api/pipelines/${id}/runs`).then(r=>r.runs);},
  playPipeline(serverUrl:string,id:number,value:{provider?:ProviderId|null;model?:string|null}={}){return request<{run:PipelineRun}>(serverUrl,`/api/pipelines/${id}/play`,{method:"POST",...json(value)}).then(r=>r.run);},
  pausePipeline(serverUrl:string,id:number){return request<{run:PipelineRun}>(serverUrl,`/api/pipelines/${id}/pause`,{method:"POST",...json({})}).then(r=>r.run);},
  stopPipeline(serverUrl:string,id:number){return request<{run:PipelineRun}>(serverUrl,`/api/pipelines/${id}/stop`,{method:"POST",...json({})}).then(r=>r.run);},
};
