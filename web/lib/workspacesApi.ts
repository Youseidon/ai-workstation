import type { AgentRequest, AgentSession, ApiErrorBody, DefinitionOfDone, DodEvaluation, HumanInputRequest, InstructionProposalRecord, OperationsSnapshot, PipelineDashboard, PipelineFlowchartView, PipelineRecord, PipelineRun, PipelineRunDetail, ProgramDraftBody, ProgramDraftPreview, ProgramDraftRecord, PromptActivity, PromptOption, PromptPipelineRule, PromptRemark, PromptStatusEvent, ProviderId, StartUnknownClassification, StatusDefinition, SuitePipelineRun, SuiteVerificationContext, SuiteVerificationDetail, SuiteVerificationRecord, TaskControlCapability, TeamHandoverSummary, TeamItemAccessSummary, TelegramLiveStatus, TelegramPairingState, UsageReport, WorkspaceRecord, WorkspaceTree } from "@agent-console/shared";

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

export interface HandoverItemStatus {
  itemId: string;
  state: string;
  epoch: number;
  requester: string;
  executor: string | null;
  branch: string;
  hold: { held: boolean; reason: string };
}

/** What the requester confirms before anything is pushed (TM-T0-7). */
export interface HandoverPreview {
  itemId: string;
  provider: string;
  model: string | null;
  branch: string;
  files: Array<{ path: string; status: string; bytes: number; shapes: string[] }>;
  excluded: string[];
  flagged: Array<{ path: string; shapes: string[] }>;
  totalBytes: number;
  large: boolean;
  requiredConfirmations: string[];
  risk: string;
  mitigation: string;
}

export interface HandoverOffer {
  itemId: string;
  branch: string;
  snapshotCommit: string;
  provider: string;
  model: string | null;
  receiver: null;
  epoch: number;
  startDeadline: string;
}

export interface HandoverReview {
  applyOffered: boolean;
  evidenceMissing: boolean;
  reason: string;
  refusedBecause: string[];
  result: { resultId: string; label: "full" | "partial"; resultCommit: string };
}
/** What applying a revision draft did to its program. */
export interface ProgramRevisionApplied { added:number; updated:number; removed:number; moved:number; newPromptIds:number[]; pipelineSteps:number }

export const workspaceApi = {
  async sessions(serverUrl:string){return (await request<{sessions:AgentSession[]}>(serverUrl,"/api/sessions")).sessions;},
  async session(serverUrl:string,runId:string){return (await request<{session:AgentSession}>(serverUrl,`/api/sessions/${encodeURIComponent(runId)}`)).session;},
  async report(serverUrl:string,workspaceId?:number){return (await request<{report:UsageReport}>(serverUrl,`/api/report${workspaceId===undefined?"":`?workspace=${workspaceId}`}`)).report;},
  taskControlCapability(serverUrl:string){return request<{capability:TaskControlCapability}>(serverUrl,"/api/task-control/capability").then(r=>r.capability);},
  telegramStatus(serverUrl:string){return request<{status:TelegramLiveStatus}>(serverUrl,"/api/task-control/telegram").then(r=>r.status);},
  configureTelegram(serverUrl:string,token:string){return request<{status:TelegramLiveStatus}>(serverUrl,"/api/task-control/telegram/credential",{method:"PUT",...json({token})}).then(r=>r.status);},
  startTelegramPairing(serverUrl:string){return request<{pairing:TelegramPairingState}>(serverUrl,"/api/task-control/telegram/pairing",{method:"POST",...json({})}).then(r=>r.pairing);},
  cancelTelegramPairing(serverUrl:string){return request<void>(serverUrl,"/api/task-control/telegram/pairing",{method:"DELETE"});},
  confirmTelegramPairing(serverUrl:string,code:string){return request<{status:TelegramLiveStatus}>(serverUrl,"/api/task-control/telegram/pairing/confirm",{method:"POST",...json({code})}).then(r=>r.status);},
  removeTelegramActor(serverUrl:string,actorId:string){return request<void>(serverUrl,`/api/task-control/telegram/actors/${encodeURIComponent(actorId)}`,{method:"DELETE"});},
  teamStatus(serverUrl:string){return request<{team:{teamId:string;groupChatId:string;members:Array<{personId:string;telegramUserId:string;botId:string;botUsername:string;workstationId:string;workstationLabel:string;personLabel?:string}>;instruction:string|null;inviteLink:string|null;handoverEnabled:boolean}|null}>(serverUrl,"/api/task-control/team").then(r=>r.team);},
  refreshTeam(serverUrl:string){return request<{team:{teamId:string;groupChatId:string;members:Array<{personId:string;telegramUserId:string;botId:string;botUsername:string;workstationId:string;workstationLabel:string;personLabel?:string}>;instruction:string|null;inviteLink:string|null;handoverEnabled:boolean}|null}>(serverUrl,"/api/task-control/team/refresh",{method:"POST",...json({})}).then(r=>r.team);},
  teamCreateStatus(serverUrl:string){return request<{team:{code:string;expiresAt:string;observed:boolean}|null}>(serverUrl,"/api/task-control/team/create").then(r=>r.team);},
  startTeamCreate(serverUrl:string,remoteUrl:string){return request<{team:{code:string;expiresAt:string;observed:boolean}}>(serverUrl,"/api/task-control/team/create",{method:"POST",...json({remoteUrl})}).then(r=>r.team);},
  cancelTeamCreate(serverUrl:string){return request<void>(serverUrl,"/api/task-control/team/create",{method:"DELETE"});},
  confirmTeamCreate(serverUrl:string){return request<{team:{teamId:string;joinCode:string}}>(serverUrl,"/api/task-control/team/create/confirm",{method:"POST",...json({})}).then(r=>r.team);},
  /** B1: mints a fresh join code for the roster this workstation already holds, since creation returns its code once and nothing persists it. */
  reissueTeamJoinCode(serverUrl:string){return request<{team:{teamId:string;joinCode:string}}>(serverUrl,"/api/task-control/team/join-code",{method:"POST",...json({})}).then(r=>r.team);},
  startTeamJoin(serverUrl:string,code:string){return request<{team:{teamId:string;groupChatId:string}}>(serverUrl,"/api/task-control/team/join",{method:"POST",...json({code})}).then(r=>r.team);},
  confirmTeamJoin(serverUrl:string){return request<{team:{teamId:string;instruction:string}}>(serverUrl,"/api/task-control/team/join/confirm",{method:"POST",...json({})}).then(r=>r.team);},
  /** Opens a Team item thread on the owner's own work item (R-B). Refused with prompt_already_complete once the task is finished. */
  openTeamItem(serverUrl:string,promptId:number){return request<{item:{itemId:string}}>(serverUrl,"/api/task-control/team/items",{method:"POST",...json({promptId})}).then(r=>r.item);},
  teamItemForPrompt(serverUrl:string,promptId:number){return request<{item:{itemId:string}|null}>(serverUrl,`/api/task-control/team/items?promptId=${promptId}`).then(r=>r.item);},
  teamHandovers(serverUrl:string){return request<{handovers:TeamHandoverSummary[]}>(serverUrl,"/api/task-control/team/handovers").then(r=>r.handovers);},
  teamHandoverAction(serverUrl:string,itemId:string,action:"accept"|"decline"|"withdraw"|"return"){return request<{result:unknown}>(serverUrl,`/api/task-control/team/handovers/${encodeURIComponent(itemId)}/${action}`,{method:"POST",...json({})}).then(r=>r.result);},
  teamItemAccess(serverUrl:string,itemId:string){return request<{access:TeamItemAccessSummary}>(serverUrl,`/api/task-control/team/items/${encodeURIComponent(itemId)}/access`).then(r=>r.access);},
  setTeamItemAccess(serverUrl:string,itemId:string,personId:string,capabilities:Array<"context"|"answer"|"resume">){return request<{access:TeamItemAccessSummary}>(serverUrl,`/api/task-control/team/items/${encodeURIComponent(itemId)}/access/${encodeURIComponent(personId)}`,{method:"PUT",...json({capabilities})}).then(r=>r.access);},
  closeTeamItem(serverUrl:string,itemId:string){return request<{result:{closed:boolean;reason:string}}>(serverUrl,`/api/task-control/team/items/${encodeURIComponent(itemId)}/close`,{method:"POST",...json({})}).then(r=>r.result);},
  /**
   * Handover, the requester's six steps (C1). Every one of them answers 403
   * team_disabled or handover_disabled while the capability is off, which is
   * what the control renders rather than hiding the refusal.
   */
  beginHandover(serverUrl:string,itemId:string){return request<{handover:HandoverItemStatus}>(serverUrl,`/api/task-control/team/handover/${encodeURIComponent(itemId)}/begin`,{method:"POST",...json({})}).then(r=>r.handover);},
  handoverPreview(serverUrl:string,itemId:string,provider:ProviderId,model?:string|null){return request<{preview:HandoverPreview}>(serverUrl,`/api/task-control/team/handover/${encodeURIComponent(itemId)}/preview?provider=${encodeURIComponent(provider)}${model?`&model=${encodeURIComponent(model)}`:""}`).then(r=>r.preview);},
  publishHandover(serverUrl:string,itemId:string,input:{confirmations:string[];acknowledgedBytes:number}){return request<{offer:HandoverOffer}>(serverUrl,`/api/task-control/team/handover/${encodeURIComponent(itemId)}/publish`,{method:"POST",...json(input)}).then(r=>r.offer);},
  handoverReview(serverUrl:string,itemId:string){return request<{review:HandoverReview}>(serverUrl,`/api/task-control/team/handover/${encodeURIComponent(itemId)}/review`).then(r=>r.review);},
  applyHandover(serverUrl:string,itemId:string,acceptanceMet:boolean){return request<{apply:{kind:string}}>(serverUrl,`/api/task-control/team/handover/${encodeURIComponent(itemId)}/apply`,{method:"POST",...json({acceptanceMet})}).then(r=>r.apply);},
  requestHandoverChanges(serverUrl:string,itemId:string,requirements:string){return request<{changes:{epoch:number}}>(serverUrl,`/api/task-control/team/handover/${encodeURIComponent(itemId)}/request-changes`,{method:"POST",...json({requirements})}).then(r=>r.changes);},
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
  /* The request bar: one call for every target and mode. `ask` answers as a
     consult run; every other mode returns the proposal it opened. */
  agentRequest(serverUrl:string,workspaceId:number,value:AgentRequest){return request<
    | {kind:"consult";runId:string}
    | {kind:"program-draft";draft:ProgramDraftRecord;preview:ProgramDraftPreview;runId:string|null}
    | {kind:"instruction-proposal";proposal:InstructionProposalRecord;runId:string|null}
  >(serverUrl,`/api/workspaces/${workspaceId}/agent-requests`,{method:"POST",...json(value)});},
  instructionProposals(serverUrl:string,workspaceId:number){return request<{proposals:InstructionProposalRecord[]}>(serverUrl,`/api/workspaces/${workspaceId}/instruction-proposals`).then(r=>r.proposals);},
  saveInstructionProposal(serverUrl:string,id:number,content:string){return request<{proposal:InstructionProposalRecord}>(serverUrl,`/api/instruction-proposals/${id}`,{method:"PATCH",...json({content})}).then(r=>r.proposal);},
  applyInstructionProposal(serverUrl:string,id:number,value:{force?:boolean}={}){return request<{proposal:InstructionProposalRecord;workspace:WorkspaceRecord}>(serverUrl,`/api/instruction-proposals/${id}/apply`,{method:"POST",...json(value)});},
  discardInstructionProposal(serverUrl:string,id:number){return request<{proposal:InstructionProposalRecord}>(serverUrl,`/api/instruction-proposals/${id}/discard`,{method:"POST",body:"{}"}).then(r=>r.proposal);},
  removeInstructionProposal(serverUrl:string,id:number){return request<void>(serverUrl,`/api/instruction-proposals/${id}`,{method:"DELETE"});},
  reviseInstructionProposal(serverUrl:string,id:number,value:{provider:ProviderId;model?:string|null;feedback?:string}){return request<{proposal:InstructionProposalRecord;runId:string}>(serverUrl,`/api/instruction-proposals/${id}/revise`,{method:"POST",...json(value)});},
  askAboutProgram(serverUrl:string,programId:number,value:{question:string;provider:ProviderId;model?:string|null}){return request<{runId:string}>(serverUrl,`/api/programs/${programId}/ask`,{method:"POST",...json(value)});},
  startProgramRevision(serverUrl:string,programId:number,value:{goal:string;provider?:ProviderId;model?:string|null}){return request<{draft:ProgramDraftRecord;preview:ProgramDraftPreview;runId:string|null}>(serverUrl,`/api/programs/${programId}/revisions`,{method:"POST",...json(value)});},
  history(serverUrl:string,id:number){return request<{events:PromptStatusEvent[];remarks:PromptRemark[];runs:unknown[]}>(serverUrl,`/api/prompts/${id}/history`);},
  humanInput(serverUrl:string){return request<{requests:HumanInputRequest[]}>(serverUrl,"/api/prompts/human-input");},
  respond(serverUrl:string,id:number,content:string){return request<{remark:PromptRemark}>(serverUrl,`/api/prompts/${id}/human-response`,{method:"POST",...json({content})});},
  saveHumanResponse(serverUrl:string,id:number,value:{content:string;expectedRevision:string}){return request<{responseId:number;started:boolean;runId:string|null;revision:string}>(serverUrl,`/api/prompts/${id}/save-human-response`,{method:"POST",...json(value)});},
  respondAndContinue(serverUrl:string,id:number,value:{content?:string;responseId?:number;provider:ProviderId;model:string|null;expectedRevision?:string}){return request<{responseId:number;started:boolean;runId:string|null;revision:string;error?:string}>(serverUrl,`/api/prompts/${id}/respond-and-continue`,{method:"POST",...json(value)});},
  clarify(serverUrl:string,id:number,value:{question:string;provider:ProviderId;model:string|null}){return request<{runId:string}>(serverUrl,`/api/prompts/${id}/clarify`,{method:"POST",...json(value)});},
  classifyStartUnknown(serverUrl:string,id:number,value:{classification:StartUnknownClassification;expectedStartIntentId:string;confirmed:true}){return request<{classified:true;classification:StartUnknownClassification;startIntentId:string}>(serverUrl,`/api/prompts/${id}/classify-start-unknown`,{method:"POST",...json(value)});},
  startHandoff(serverUrl:string,id:number,value:{handoffProvider:ProviderId;handoffModel?:string|null;successorProvider:ProviderId;successorModel?:string|null;pipelineId?:number}){return request<{started:boolean;handoffId:string;runId:string|null;reusedReady:boolean}>(serverUrl,`/api/prompts/${id}/handoff`,{method:"POST",...json(value)});},
  playSuite(serverUrl:string,suiteId:number,value:{provider?:ProviderId|null;model?:string|null}={}){return request<{pipeline:SuitePipelineRun}>(serverUrl,`/api/suites/${suiteId}/play`,{method:"POST",...json(value)}).then(r=>r.pipeline);},
  pauseSuite(serverUrl:string,suiteId:number){return request<{pipeline:SuitePipelineRun}>(serverUrl,`/api/suites/${suiteId}/pause`,{method:"POST",...json({})}).then(r=>r.pipeline);},
  stopSuite(serverUrl:string,suiteId:number){return request<{pipeline:SuitePipelineRun}>(serverUrl,`/api/suites/${suiteId}/stop`,{method:"POST",...json({})}).then(r=>r.pipeline);},
  patchPipelineRule(serverUrl:string,promptId:number,value:Partial<Omit<PromptPipelineRule,"promptId">>){return request<{rule:PromptPipelineRule}>(serverUrl,`/api/prompts/${promptId}/pipeline-rule`,{method:"PATCH",...json(value)}).then(r=>r.rule);},
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
  updatePipeline(serverUrl:string,id:number,value:{name?:string;description?:string;suiteIds?:number[];executionProvider?:ProviderId|null;executionModel?:string|null}){return request<{pipeline:PipelineRecord}>(serverUrl,`/api/pipelines/${id}`,{method:"PATCH",...json(value)}).then(r=>r.pipeline);},
  removePipeline(serverUrl:string,id:number){return request<void>(serverUrl,`/api/pipelines/${id}`,{method:"DELETE"});},
  pipelineRuns(serverUrl:string,id:number){return request<{runs:PipelineRunDetail[]}>(serverUrl,`/api/pipelines/${id}/runs`).then(r=>r.runs);},
  playPipeline(serverUrl:string,id:number,value:{provider?:ProviderId|null;model?:string|null}={}){return request<{run:PipelineRun}>(serverUrl,`/api/pipelines/${id}/play`,{method:"POST",...json(value)}).then(r=>r.run);},
  pausePipeline(serverUrl:string,id:number){return request<{run:PipelineRun}>(serverUrl,`/api/pipelines/${id}/pause`,{method:"POST",...json({})}).then(r=>r.run);},
  stopPipeline(serverUrl:string,id:number){return request<{run:PipelineRun}>(serverUrl,`/api/pipelines/${id}/stop`,{method:"POST",...json({})}).then(r=>r.run);},
};
