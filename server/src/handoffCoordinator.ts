import { HANDOFF_RECOMMENDATIONS, type HandoffBrief, type HandoffRecord, type ProviderId } from "@agent-console/shared";
import { detectProviders, getAdapter } from "./adapters/registry.ts";
import { newId } from "./lib/ids.ts";
import { createLogger } from "./lib/logger.ts";
import { runHub } from "./runHub.ts";
import { runContexts } from "./runContext.ts";
import { startRun } from "./runner.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

const log=createLogger("handoff");
const MAX_GENERATIONS=3;

type HandoffArgs={workspaceId:number;promptId:number;sourceRunId:string;sourceProvider:ProviderId;sourceModel:string|null;processState:string;handoffProvider?:ProviderId;handoffModel?:string|null;successorProvider?:ProviderId;successorModel?:string|null;namedPipelineId?:number};
export type HandoffScheduleResult=
  | {started:true;handoffId:string;runId:string|null;reusedReady:boolean}
  | {started:false;code:string;message:string;detail?:string;handoffId?:string};

function list(value:unknown):string[]{return Array.isArray(value)?value.filter((item):item is string=>typeof item==="string").slice(0,30):[];}
function parseBrief(text:string,originalObjective:string,terminationReason:string):HandoffBrief {
  const fenced=text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate=fenced??text.slice(text.indexOf("{"),text.lastIndexOf("}")+1);
  const raw=JSON.parse(candidate) as Record<string,unknown>;
  const recommendation:HandoffBrief["recommendation"]=typeof raw.recommendation==="string"&&HANDOFF_RECOMMENDATIONS.includes(raw.recommendation as never)?raw.recommendation as HandoffBrief["recommendation"]:"WAIT_FOR_HUMAN";
  const blockers=Array.isArray(raw.blockers)?raw.blockers.filter(item=>item&&typeof item==="object").map(item=>{const row=item as Record<string,unknown>;return{description:String(row.description??""),requiresHuman:row.requiresHuman===true,requiredAction:typeof row.requiredAction==="string"?row.requiredAction:null};}).slice(0,20):[];
  return{version:1,originalObjective:typeof raw.originalObjective==="string"?raw.originalObjective:originalObjective,terminationReason:typeof raw.terminationReason==="string"?raw.terminationReason:terminationReason,completedWork:list(raw.completedWork),pendingWork:list(raw.pendingWork),verificationPassed:list(raw.verificationPassed),verificationFailed:list(raw.verificationFailed),blockers,importantFiles:list(raw.importantFiles),decisionsAndAssumptions:list(raw.decisionsAndAssumptions),recommendation,successorInstructions:typeof raw.successorInstructions==="string"?raw.successorInstructions:"Continue from the existing working tree. Verify current state before changing files."};
}

function markdown(brief:HandoffBrief):string {
  const bullets=(items:string[])=>items.length?items.map(item=>`- ${item}`).join("\n"):"- None recorded.";
  return `# Handoff brief\n\n## Original objective\n\n${brief.originalObjective}\n\n## Why the previous run stopped\n\n${brief.terminationReason}\n\n## Completed work\n\n${bullets(brief.completedWork)}\n\n## Pending work\n\n${bullets(brief.pendingWork)}\n\n## Verification passed\n\n${bullets(brief.verificationPassed)}\n\n## Verification failed or missing\n\n${bullets(brief.verificationFailed)}\n\n## Important files\n\n${bullets(brief.importantFiles)}\n\n## Successor instructions\n\n${brief.successorInstructions}`;
}

async function providerFor(requested:ProviderId):Promise<ProviderId|null>{
  const providers=await detectProviders();
  const eligible=providers.filter(item=>item.available&&item.id!=="cursor");
  return eligible.some(item=>item.id===requested)?requested:null;
}

function canReuseReadyHandoff(handoff:HandoffRecord,sourceRunId:string):boolean{
  return handoff.state==="READY"&&handoff.recommendation==="CONTINUE"&&handoff.briefMarkdown.trim()!==""&&(handoff.sourceRunId===sourceRunId||handoff.successorRunId===sourceRunId);
}

async function startSuccessorFromHandoff(handoff:HandoffRecord,args:HandoffArgs):Promise<HandoffScheduleResult>{
  let successorProvider = args.successorProvider ?? args.sourceProvider;
  let successorModel = args.successorModel !== undefined
    ? args.successorModel
    : successorProvider === args.sourceProvider ? args.sourceModel : null;
  let pipelineOverride = false;
  if (args.namedPipelineId !== undefined) {
    const pipeline = workspaces.getPipeline(args.namedPipelineId);
    const home = workspaces.promptHome(args.promptId);
    if (pipeline.workspaceId !== args.workspaceId || !pipeline.stages.some(stage => stage.suiteId === home.suiteId) || !workspaces.pipelineRule(args.promptId).enabled) {
      throw new WorkspaceError(422, "invalid_pipeline", "The work item must be an enabled step in the selected pipeline.");
    }
    if (pipeline.executionProvider !== null) {
      successorProvider = pipeline.executionProvider;
      successorModel = pipeline.executionModel;
      pipelineOverride = true;
    }
  }
  workspaces.preparePromptForSuccessor(args.promptId,handoff.id,handoff.briefMarkdown);
  if(args.namedPipelineId!==undefined){
    // Station assignments outrank pipeline defaults. Save the explicit choice
    // on this station so the successor and subsequent retries use it.
    if (!pipelineOverride) workspaces.upsertPipelineRule(args.promptId, { provider: successorProvider, model: successorModel });
    const {pipelineScheduler}=await import("./pipelineScheduler.ts");const named=await pipelineScheduler.playNamed(args.namedPipelineId,{provider:successorProvider,model:successorModel});const suite=named.currentSuiteRunId===null?null:workspaces.pipelineById(named.currentSuiteRunId);workspaces.updateHandoff(handoff.id,{successorRunId:suite?.currentRunId??null});
    return{started:true,handoffId:handoff.id,runId:suite?.currentRunId??null,reusedReady:true};
  }
  const {startExecute}=await import("./runService.ts");const result=await startExecute({workspaceId:args.workspaceId,promptId:args.promptId,provider:successorProvider,model:successorModel});workspaces.updateHandoff(handoff.id,{successorRunId:result.runId});
  return{started:true,handoffId:handoff.id,runId:result.runId,reusedReady:true};
}

export async function scheduleHandoff(args:HandoffArgs):Promise<HandoffScheduleResult>{
  const outcome=workspaces.promptOutcome(args.promptId);
  if(outcome.status==="DONE"||outcome.status==="SKIPPED")return{started:false,code:"already_terminal",message:"This work item is already complete or skipped."};
  const previous=workspaces.handoffsForPrompt(args.promptId);
  const active=previous.find(item=>item.state==="QUEUED"||item.state==="RUNNING");
  if(active!==undefined)return{started:false,code:"handoff_active",message:`A handoff is already ${active.state.toLowerCase()} for this work item.`,handoffId:active.id};
  const priorForRun=previous.find(item=>item.sourceRunId===args.sourceRunId);
  if(priorForRun!==undefined&&priorForRun.state!=="FAILED"){
    if(canReuseReadyHandoff(priorForRun,args.sourceRunId))return startSuccessorFromHandoff(priorForRun,args);
    return{started:false,code:"handoff_exists",message:`A ${priorForRun.state.toLowerCase()} handoff already exists for this run.`,handoffId:priorForRun.id};
  }
  const reusable=previous.find(item=>canReuseReadyHandoff(item,args.sourceRunId));
  if(reusable!==undefined)return startSuccessorFromHandoff(reusable,args);
  if(priorForRun===undefined&&previous.length>=MAX_GENERATIONS)return{started:false,code:"handoff_attempt_limit",message:`This work item already has ${MAX_GENERATIONS} handoff attempts. Review an existing handoff or reset the item before creating another.`};
  const requestedProvider=args.handoffProvider??args.sourceProvider;
  const provider=await providerFor(requestedProvider);if(provider===null){log.warn(`requested read-only provider unavailable prompt=${args.promptId}`);return{started:false,code:"handoff_provider_unavailable",message:`${requestedProvider} is not available for a read-only handoff.`};}
  const handoffModel=args.handoffModel??(provider===args.sourceProvider?args.sourceModel:null);
  const id=priorForRun?.id??newId("handoff");const record=priorForRun===undefined?workspaces.createHandoff({id,workspaceId:args.workspaceId,promptId:args.promptId,sourceRunId:args.sourceRunId,provider,model:handoffModel}):workspaces.updateHandoff(id,{state:"QUEUED",handoffRunId:null,recommendation:null,brief:null,briefMarkdown:"",error:null,completedAt:null});
  const runId=newId("run");const credential=runContexts.create(runId,args.workspaceId,args.promptId);
  workspaces.beginHandoffAgentRun({runId,workspaceId:args.workspaceId,promptId:args.promptId,provider,model:handoffModel,tokenHash:credential.tokenHash,expiresAt:credential.expiresAt});
  workspaces.updateHandoff(id,{state:"RUNNING",handoffRunId:runId});
  const dossier=workspaces.handoffDossier(args.workspaceId,args.promptId,args.sourceRunId);
  const prompt=`You are a read-only handoff agent. You cannot edit files or orchestration state. Convert the authoritative dossier below into a compact continuation brief so a developer agent can resume without reconstructing prior work. Distinguish a real external human dependency from incomplete implementation. Return one JSON object only with keys: originalObjective, terminationReason, completedWork, pendingWork, verificationPassed, verificationFailed, blockers (description, requiresHuman, requiredAction), importantFiles, decisionsAndAssumptions, recommendation (CONTINUE, WAIT_FOR_HUMAN, RETRY_LATER, or DO_NOT_CONTINUE), successorInstructions. Never recommend DONE.\n\nDOSSIER\n${dossier}`;
  let answer="";
  const handle=startRun({runId,adapter:getAdapter(provider),prompt,cwd:workspaces.get(args.workspaceId).workDirectory,model:handoffModel,role:"handoff",permissionOverride:"handoff",onEvent:event=>{if(event.type==="assistant_text"&&event.payload.kind==="message")answer+=event.payload.text;if(event.type==="result"&&event.payload.text)answer=event.payload.text;workspaces.recordAgentEvent(runId,event);runHub.event(runId,event);},onEnd:(ended,state)=>{void finishHandoff(record.id,ended,state,answer,args).catch(error=>log.error("finish failed",error));}});
  workspaces.markAgentRunRunning(runId);
  const saved=workspaces.resolvePrompt(args.workspaceId,args.promptId);
  runHub.start({handle,workspace:{id:args.workspaceId,name:workspaces.get(args.workspaceId).name,workDirectory:workspaces.get(args.workspaceId).workDirectory},source:{type:"handoff",handoffId:id,promptId:args.promptId,promptKey:saved.externalKey,title:saved.title,sourceRunId:args.sourceRunId},role:"handoff",permissionMode:handle.permissionMode});
  void handle.done.catch(error=>log.error("run failed",error));return{started:true,handoffId:id,runId,reusedReady:false};
}

async function finishHandoff(id:string,runId:string,state:"done"|"interrupted"|"error",answer:string,args:{workspaceId:number;promptId:number;sourceRunId:string;sourceProvider:ProviderId;sourceModel:string|null;processState:string;successorProvider?:ProviderId;successorModel?:string|null;namedPipelineId?:number}):Promise<void>{
  workspaces.finishAgentRun(runId,state);runContexts.complete(runId);runHub.end(runId,state);
  if(state!=="done"){workspaces.updateHandoff(id,{state:"FAILED",error:`Handoff agent ended ${state}`,completedAt:new Date().toISOString()});const {pipelineScheduler}=await import("./pipelineScheduler.ts");await pipelineScheduler.onExecuteEnded({runId:args.sourceRunId,workspaceId:args.workspaceId,promptId:args.promptId,processState:args.processState as never});runHub.operationsChanged();return;}
  try{
    const context=workspaces.agentContext(args.workspaceId,args.promptId);const brief=parseBrief(answer,context.prompt.content,`Agent process ended ${args.processState}`);const rendered=markdown(brief);
    workspaces.updateHandoff(id,{state:"READY",recommendation:brief.recommendation,brief,briefMarkdown:rendered,completedAt:new Date().toISOString()});
    if(brief.recommendation==="CONTINUE"){
      await startSuccessorFromHandoff(workspaces.handoffById(id)!,args);
    }else{
      const {pipelineScheduler}=await import("./pipelineScheduler.ts");
      await pipelineScheduler.onExecuteEnded({runId:args.sourceRunId,workspaceId:args.workspaceId,promptId:args.promptId,processState:args.processState as never});
    }
  }catch(error){workspaces.updateHandoff(id,{state:"FAILED",error:error instanceof Error?error.message:String(error),completedAt:new Date().toISOString()});}
  runHub.operationsChanged();
}
