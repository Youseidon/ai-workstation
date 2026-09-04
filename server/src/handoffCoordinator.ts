import { HANDOFF_RECOMMENDATIONS, type HandoffBrief, type ProviderId } from "@agent-console/shared";
import { detectProviders, getAdapter } from "./adapters/registry.ts";
import { newId } from "./lib/ids.ts";
import { createLogger } from "./lib/logger.ts";
import { runHub } from "./runHub.ts";
import { settings } from "./settings.ts";
import { runContexts } from "./runContext.ts";
import { startRun } from "./runner.ts";
import { materialize } from "./workspaceInstructions.ts";
import { WorkspaceError, workspaces, type RunCostMetrics } from "./workspaces.ts";

const log=createLogger("handoff");
/** Operator-settable; see the "Pipeline policy" settings group. */
function maxGenerations():number{return settings.pipelinePolicy.maxHandoffGenerations;}

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

/**
 * Why a handoff could not be prepared. `reusable` is not a dead end: a brief
 * for this run already exists, and the operator continues from it instead of
 * paying a second read-only agent to write the same summary again.
 */
export type HandoffBlock="already_complete"|"handoff_running"|"reusable"|"attempt_limit"|"provider_unavailable";
export type ScheduleHandoffResult={started:true}|{started:false;block:HandoffBlock};

export async function scheduleHandoff(args:{workspaceId:number;promptId:number;sourceRunId:string;sourceProvider:ProviderId;sourceModel:string|null;processState:string;handoffProvider?:ProviderId;handoffModel?:string|null;successorProvider?:ProviderId;successorModel?:string|null;namedPipelineId?:number}):Promise<ScheduleHandoffResult>{
  const outcome=workspaces.promptOutcome(args.promptId);
  if(outcome.status==="DONE"||outcome.status==="SKIPPED")return{started:false,block:"already_complete"};
  const previous=workspaces.handoffsForPrompt(args.promptId);
  const priorForRun=previous.find(item=>item.sourceRunId===args.sourceRunId);
  if(priorForRun!==undefined&&priorForRun.state==="READY")return{started:false,block:"reusable"};
  if(priorForRun!==undefined&&priorForRun.state!=="FAILED")return{started:false,block:"handoff_running"};
  if(priorForRun===undefined&&previous.length>=maxGenerations())return{started:false,block:"attempt_limit"};
  const provider=await providerFor(args.handoffProvider??args.sourceProvider);if(provider===null){log.warn(`requested read-only provider unavailable prompt=${args.promptId}`);return{started:false,block:"provider_unavailable"};}
  const handoffModel=args.handoffModel??(provider===args.sourceProvider?args.sourceModel:null);
  const id=priorForRun?.id??newId("handoff");const record=priorForRun===undefined?workspaces.createHandoff({id,workspaceId:args.workspaceId,promptId:args.promptId,sourceRunId:args.sourceRunId,provider,model:handoffModel}):workspaces.updateHandoff(id,{state:"QUEUED",handoffRunId:null,recommendation:null,brief:null,briefMarkdown:"",error:null,completedAt:null});
  const runId=newId("run");const credential=runContexts.create(runId,args.workspaceId,args.promptId);
  workspaces.beginHandoffAgentRun({runId,workspaceId:args.workspaceId,promptId:args.promptId,provider,model:handoffModel,tokenHash:credential.tokenHash,expiresAt:credential.expiresAt});
  workspaces.updateHandoff(id,{state:"RUNNING",handoffRunId:runId});
  const dossier=workspaces.handoffDossier(args.workspaceId,args.promptId,args.sourceRunId);
  const prompt=`You are a read-only handoff agent. You cannot edit files or orchestration state. Convert the authoritative dossier below into a compact continuation brief so a developer agent can resume without reconstructing prior work. Distinguish a real external human dependency from incomplete implementation. Return one JSON object only with keys: originalObjective, terminationReason, completedWork, pendingWork, verificationPassed, verificationFailed, blockers (description, requiresHuman, requiredAction), importantFiles, decisionsAndAssumptions, recommendation (CONTINUE, WAIT_FOR_HUMAN, RETRY_LATER, or DO_NOT_CONTINUE), successorInstructions. Never recommend DONE.\n\nDOSSIER\n${dossier}`;
  let answer="";
  materialize(workspaces.get(args.workspaceId));
  const handle=startRun({runId,adapter:getAdapter(provider),prompt,cwd:workspaces.get(args.workspaceId).workDirectory,model:handoffModel,role:"handoff",permissionOverride:"handoff",onEvent:event=>{if(event.type==="assistant_text"&&event.payload.kind==="message")answer+=event.payload.text;if(event.type==="result"&&event.payload.text)answer=event.payload.text;workspaces.recordAgentEvent(runId,event);runHub.event(runId,event);},onEnd:(ended,state,metrics)=>{void finishHandoff(record.id,ended,state,answer,args,metrics).catch(error=>log.error("finish failed",error));}});
  workspaces.markAgentRunRunning(runId);
  const saved=workspaces.resolvePrompt(args.workspaceId,args.promptId);
  runHub.start({handle,workspace:{id:args.workspaceId,name:workspaces.get(args.workspaceId).name,workDirectory:workspaces.get(args.workspaceId).workDirectory},source:{type:"handoff",handoffId:id,promptId:args.promptId,promptKey:saved.externalKey,title:saved.title,sourceRunId:args.sourceRunId},role:"handoff",permissionMode:handle.permissionMode});
  void handle.done.catch(error=>log.error("run failed",error));return{started:true};
}

/**
 * Continue from a brief that already exists. Two shapes reach here: the brief
 * launched a successor and that successor failed, and the brief never launched
 * one at all — its recommendation was not CONTINUE, so the station parked for a
 * human. The recommendation is advice to the automatic path, not a veto on the
 * operator, so an explicit resume overrides it either way.
 */
export async function resumeReadyHandoff(args:{handoffId:string;promptId:number;failedSuccessorRunId:string;successorProvider:ProviderId;successorModel:string|null;namedPipelineId?:number}):Promise<string>{
  const record=workspaces.handoffById(args.handoffId);
  const unused=record!==null&&record.successorRunId===null;
  if(record===null||record.promptId!==args.promptId||record.state!=="READY"||(!unused&&(record.recommendation!=="CONTINUE"||record.successorRunId!==args.failedSuccessorRunId)))throw new WorkspaceError(409,"handoff_not_reusable","The saved handoff is not available for this run");
  // A brief that never reached a successor was never written onto the prompt,
  // so the retry path alone would start the successor with no continuation.
  if(unused)workspaces.preparePromptForSuccessor(args.promptId,record.id,record.briefMarkdown);
  else workspaces.preparePromptForHandoffRetry(args.promptId,record.id);
  let runId:string;
  if(args.namedPipelineId!==undefined){
    const {pipelineScheduler}=await import("./pipelineScheduler.ts");const named=await pipelineScheduler.playNamed(args.namedPipelineId,{provider:args.successorProvider,model:args.successorModel,preferPlayTarget:true});const suite=named.currentSuiteRunId===null?null:workspaces.pipelineById(named.currentSuiteRunId);runId=suite?.currentRunId??"";
  }else{
    const {startExecute}=await import("./runService.ts");runId=(await startExecute({workspaceId:record.workspaceId,promptId:args.promptId,provider:args.successorProvider,model:args.successorModel})).runId;
  }
  if(runId==="")throw new WorkspaceError(409,"successor_not_started","The successor run did not start");
  workspaces.updateHandoff(record.id,{successorRunId:runId});runHub.operationsChanged();return runId;
}

async function finishHandoff(id:string,runId:string,state:"done"|"interrupted"|"error",answer:string,args:{workspaceId:number;promptId:number;sourceRunId:string;sourceProvider:ProviderId;sourceModel:string|null;processState:string;successorProvider?:ProviderId;successorModel?:string|null;namedPipelineId?:number},metrics?:RunCostMetrics):Promise<void>{
  workspaces.finishAgentRun(runId,state,"",metrics);runContexts.complete(runId);runHub.end(runId,state);
  if(state!=="done"){workspaces.updateHandoff(id,{state:"FAILED",error:`Handoff agent ended ${state}`,completedAt:new Date().toISOString()});const {pipelineScheduler}=await import("./pipelineScheduler.ts");await pipelineScheduler.onExecuteEnded({runId:args.sourceRunId,workspaceId:args.workspaceId,promptId:args.promptId,processState:args.processState as never});runHub.operationsChanged();return;}
  try{
    const context=workspaces.agentContext(args.workspaceId,args.promptId);const brief=parseBrief(answer,context.prompt.content,`Agent process ended ${args.processState}`);const rendered=markdown(brief);
    workspaces.updateHandoff(id,{state:"READY",recommendation:brief.recommendation,brief,briefMarkdown:rendered,completedAt:new Date().toISOString()});
    if(brief.recommendation==="CONTINUE"){
      workspaces.preparePromptForSuccessor(args.promptId,id,rendered);
      const successorProvider=args.successorProvider??args.sourceProvider;const successorModel=args.successorModel??args.sourceModel;
      if(args.namedPipelineId!==undefined){
        const {pipelineScheduler}=await import("./pipelineScheduler.ts");const named=await pipelineScheduler.playNamed(args.namedPipelineId,{provider:successorProvider,model:successorModel,preferPlayTarget:true});const suite=named.currentSuiteRunId===null?null:workspaces.pipelineById(named.currentSuiteRunId);workspaces.updateHandoff(id,{successorRunId:suite?.currentRunId??null});
      }else{
        const {startExecute}=await import("./runService.ts");const result=await startExecute({workspaceId:args.workspaceId,promptId:args.promptId,provider:successorProvider,model:successorModel});workspaces.updateHandoff(id,{successorRunId:result.runId});
      }
    }else{
      const {pipelineScheduler}=await import("./pipelineScheduler.ts");
      await pipelineScheduler.onExecuteEnded({runId:args.sourceRunId,workspaceId:args.workspaceId,promptId:args.promptId,processState:args.processState as never});
    }
  }catch(error){workspaces.updateHandoff(id,{state:"FAILED",error:error instanceof Error?error.message:String(error),completedAt:new Date().toISOString()});}
  runHub.operationsChanged();
}
