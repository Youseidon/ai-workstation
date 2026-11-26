import { currentLockMode } from "../../infrastructure/instanceLock.ts";
import { runHub } from "../runs/runHub.ts";
import type { ExecutionPlan, ExecutionPolicy, ContractCriterion, ProviderId } from "@hydra/shared";
import { ExecutionError, executionHash } from "../../repositories/executionStore.ts";
import type { ExecutionEffect } from "../../models/execution.ts";
import { executionStore, evidenceStore, WorkspaceError, workspaces } from "../../repositories/workspaces.ts";
import { repositoryResource, sourceFingerprint, environmentFingerprint } from "../../infrastructure/sourceFingerprint.ts";
import { awaitManagedCommands, hasActiveManagedCommands, isManagedCommandProcess, requestCommand, recipeFingerprint } from "./commandTasks.ts";
import { terminateTrackedProcess, writerLiveness } from "../../infrastructure/executionProcess.ts";
import { failureSignature, recoveryDecision } from "../../domain/pipeline/recoveryPolicy.ts";
import type { StartExecuteArgs } from "../../contracts/runRequests.ts";

const runtimeEffects=new Set<string>();
export function trackRuntimeEffect(id:string):void {runtimeEffects.add(id);}
export function releaseRuntimeEffect(id:string):void {runtimeEffects.delete(id);}

function assertIdle(promptId:number):void {
  const home=workspaces.promptHome(promptId);
  const active=workspaces.activePipelineForWorkspace(home.workspaceId);
  if(active?.currentRunId || (workspaces.promptOptions(home.workspaceId).find(p=>p.id===promptId)?.currentRun?.processActive ?? false)) throw new WorkspaceError(409,"execution_active","Drain the current worker to a checkpoint before adopting or changing engines");
}

export function adoptExecution(promptId:number,input:Record<string,unknown>) {
  assertIdle(promptId);
  const home=workspaces.promptHome(promptId), saved=workspaces.resolvePrompt(home.workspaceId,promptId);
  if(!input.policy || typeof input.policy!=="object") throw new WorkspaceError(422,"finite_policy_required","Supply a finite root policy before adopting an autonomous requirement");
  return workspaces.executionIntake(()=>{
  const dod=workspaces.resolvedDefinitionOfDone(promptId);
  const original=workspaces.ensureOriginalAcceptance(promptId,executionHash(saved.content));
  const criteria:ContractCriterion[]=Array.isArray(input.criteria) ? input.criteria as unknown as ContractCriterion[] : dod.criteria.filter(c=>c.required).map(c=>({id:`criterion-${c.id}`,text:c.text,sourceStart:Math.max(0,saved.content.indexOf(c.text)),sourceEnd:saved.content.includes(c.text)?saved.content.indexOf(c.text)+c.text.length:saved.content.length,phase:"implementation",verifierPromptId:promptId,dodCriterionId:c.id}));
  if(!criteria.some(c=>c.dodCriterionId===original.id)) criteria.push({id:`original-${original.id}`,text:original.text,sourceStart:0,sourceEnd:saved.content.length,phase:"implementation",verifierPromptId:promptId,dodCriterionId:original.id,kind:"PROSE"});
  for(const c of criteria) {
    const verifier=workspaces.resolvePrompt(home.workspaceId,c.verifierPromptId);
    const criterion=c.dodCriterionId===original.id && verifier.id===promptId ? original : workspaces.resolvedDefinitionOfDone(verifier.id).criteria.find(item=>item.id===c.dodCriterionId && item.required);
    if(!criterion || criterion.text!==c.text) throw new WorkspaceError(422,"manifest_mismatch","Criteria must preserve the existing required acceptance text and verifier owner");
    c.kind=criterion.kind;
  }
  if(dod.criteria.some(c=>c.required && !criteria.some(cr=>cr.dodCriterionId===c.id))) throw new WorkspaceError(422,"manifest_incomplete","Contract cannot omit a required criterion");
  const owners=[...new Set(criteria.map(c=>c.verifierPromptId))];
  const proposal:ExecutionPlan=input.plan as unknown as ExecutionPlan ?? {revision:1,rationale:"Initial plan from the saved requirement and its assigned verification owners",units:owners.map(owner=>({promptId:owner,criterionIds:criteria.filter(c=>c.verifierPromptId===owner).map(c=>c.id),targets:[workspaces.promptPreview(owner).title],dependencies:owner===promptId?[]:[promptId],phase:owner===promptId?"implementation":"verification",recipeIds:workspaces.dodCommandPlan(owner).criteria.map(c=>c.id),rationale:"Existing bounded work item with its server-owned checks"}))};
  validatePlanOwnership(promptId,proposal,criteria.filter(c=>c.phase==="verification").map(c=>c.verifierPromptId));
  return workspaces.adoptExecutionContract({promptId,originalPrompt:saved.content,authority:(input.authority ?? {}) as Record<string,unknown>,criteria,policy:input.policy as unknown as ExecutionPolicy,engine:"shadow",...(typeof input.budgetScope==="string"?{budgetScope:input.budgetScope}:{})},proposal);
  });
}

export function validatePlanOwnership(rootPromptId:number,proposal:ExecutionPlan,verifierIds:readonly number[]=[]):void {
  const rootHome=workspaces.promptHome(rootPromptId);
  if(!proposal.units.some(unit=>unit.promptId===rootPromptId && unit.coverage!=="contribution")) throw new WorkspaceError(422,"integration_owner_required","Keep the original requirement as final integration owner");
  for(const unit of proposal.units) {
    const home=workspaces.promptHome(unit.promptId);
    if(home.workspaceId!==rootHome.workspaceId) throw new WorkspaceError(422,"plan_scope_mismatch","Work units must belong to the requirement's workspace");
    const c=executionStore.forPrompt(rootPromptId);
    const isVerifier=verifierIds.includes(unit.promptId) || c?.criteria.some(cr=>cr.verifierPromptId===unit.promptId && cr.phase==="verification");
    if(unit.promptId!==rootPromptId && !isVerifier) {
      let parent:number|null=workspaces.parentPromptId(unit.promptId),owned=false;
      while(parent!==null) { if(parent===rootPromptId) {owned=true;break;} parent=workspaces.parentPromptId(parent); }
      if(!owned) throw new WorkspaceError(422,"plan_scope_mismatch","Implementation units must reuse descendants of the saved requirement");
    }
    const recipes=workspaces.dodCommandPlan(unit.promptId).criteria;
    if(unit.recipeIds.some(id=>!recipes.some(recipe=>recipe.id===id))) throw new WorkspaceError(422,"recipe_unknown","Plan references an unowned command recipe");
  }
}

export function unitHandoff(promptId:number,reason:string):string {
  const c=executionStore.forPrompt(promptId)!;
  const plan=executionStore.plan(c.id),status=executionStore.status(c.id),unit=plan.units.find(u=>u.promptId===promptId);
  const checks=workspaces.definitionOfDoneEvaluation(promptId).criteria;
  let checkpoint:unknown=null;
  try {const capture=workspaces.runChangeSet(workspaces.latestExecuteRunId(promptId));if(capture)checkpoint={headCommit:capture.headCommit,baseCommit:capture.baseCommit,state:capture.state};} catch {  }
  const remedies=executionStore.remedies(c.id,promptId);
  return JSON.stringify({contractId:c.id,contractVersion:c.version,originalPromptHash:c.promptHash,planRevision:plan.revision,phase:unit?.phase,generation:status.generation,acceptedUnits:status.acceptedUnits,assignedCriterionIds:unit?.criterionIds,remainingTargets:unit?.targets.slice(0,100),pendingVerification:status.pendingObligations,checkpoint,checks:checks.slice(0,20).map(check=>({criterionId:check.criterionId,result:check.result,evidence:check.evidence.slice(0,800),output:check.output.slice(-800)})),omittedChecks:Math.max(0,checks.length-20),evidenceIds:evidenceStore.latestFor(promptId).slice(-20),remedies:remedies.slice(-6).map(remedy=>({...remedy,evidence:remedy.evidence.slice(0,1500)})),reason:reason.slice(0,3000),nextAction:reason.slice(0,3000)},null,2);
}

function assertManifest(id:string):void {
  const c=executionStore.contract(id);
  for(const criterion of c.criteria) {
    const current=workspaces.definitionCriterion(criterion.dodCriterionId);
    if(!current || !current.required || current.text!==criterion.text || (criterion.kind && current.kind!==criterion.kind)) throw new ExecutionError("contract_changed","Required acceptance changed; record an operator requirement amendment before dispatch or delivery");
  }
}

export async function reserveSupervisedStart(args:StartExecuteArgs,reason="Execute the current bounded work unit",chooseProvider?:(from:string)=>Promise<{provider:ProviderId;model:string|null}|null>):Promise<{effect:ExecutionEffect;args:StartExecuteArgs}|null> {
  const promptId=args.promptId;
  if(promptId===undefined) return null;
  const c=executionStore.forPrompt(promptId);
  if(!c || c.engine!=="supervised") return null;
  if(process.env.HYDRA_SUPERVISOR_HOLD==="1") throw new ExecutionError("engine_held","Supervised dispatch is held; its ledger and ownership remain intact");
  assertManifest(c.id);
  const effectivePromptHash=(executionStore.events(c.id).filter(e=>e.kind==="recipe_substituted" && e.sequence>(executionStore.events(c.id).filter(event=>event.kind==="requirement_amended").at(-1)?.sequence ?? 0)).at(-1)?.payload as {effectivePromptHash?:string}|undefined)?.effectivePromptHash ?? c.promptHash;
  if(executionHash(workspaces.promptPreview(c.promptId).content)!==effectivePromptHash) throw new ExecutionError("contract_changed","Original requirement changed; adopt a new reviewed contract version before spending more");
  const outstanding=executionStore.pending().find(e=>e.contractId===c.id && e.promptId===promptId && e.state==="PENDING" && e.payload.kind!=="audit" && e.payload.kind!=="command");
  if(outstanding) return {effect:outstanding,args:{...args,executionEffectId:outstanding.id,reuseSavedSession:true,recoveryBrief:unitHandoff(promptId,"Recover durable dispatch intent")}};
  const status=executionStore.status(c.id);
  const prior=executionStore.events(c.id).filter(e=>e.kind==="dispatch_reserved").at(-1);
  const newAllocation=status.exception?.code==="budget_exhausted" && executionStore.events(c.id).some(e=>e.kind==="budget_amended" && e.sequence>(prior?.sequence ?? 0));
  const requestId=`${args.pipelineRunId ?? c.id}:${promptId}:${prior?.sequence ?? "initial"}`;
  const remedies=executionStore.remedies(c.id,promptId);
  const unitAttempts=executionStore.unitUsage(c.id,promptId);
  let previousFailure="";
  try {previousFailure=workspaces.runFailureFacts(workspaces.latestExecuteRunId(promptId)).errorText;} catch {  }
  const facts=workspaces.promptOutcome(promptId).result || previousFailure || reason;
  const signature=failureSignature(facts);
  const ordinaryFraction=c.policy.recoveryAttempts>0?0.8:1;
  const reserveNeeded=status.attempts-unitAttempts.recovery>=c.policy.maxAttempts-c.policy.recoveryAttempts || status.activeMs+c.policy.workerMs>Math.floor(c.policy.maxActiveMs*ordinaryFraction) || status.tokens+c.policy.workerTokens>Math.floor(c.policy.maxTokens*ordinaryFraction);
  const decision=recoveryDecision({facts,attempts:reserveNeeded?Math.max(unitAttempts.workers,c.policy.unitAttempts):unitAttempts.workers,unitAttempts:c.policy.unitAttempts,tried:remedies.filter(r=>r.signature===signature).map(r=>r.remedy),remainingRecovery:c.policy.recoveryAttempts-unitAttempts.recovery,providerChanges:remedies.filter(r=>r.remedy==="change_provider").length,maxProviderChanges:c.policy.maxProviderChanges,canReplan:executionStore.replanUsage(c.id)<c.policy.maxReplans && workspaces.decomposeDepth(promptId)<2});
  if(decision.action==="exhausted" || decision.action==="external_input") {
    executionStore.decision(c.id,decision.action==="exhausted"?"execution_exception":"external_action_required",{...decision,promptId:promptId,handoff:unitHandoff(promptId,decision.reason),remaining:status});
    throw new ExecutionError(decision.action==="exhausted"?"budget_exhausted":"external_input_required",decision.reason);
  }
  const recovery=reserveNeeded||unitAttempts.workers>=c.policy.unitAttempts;
  if(decision.action==="change_provider") {
    if(!chooseProvider)throw new ExecutionError("recovery_exhausted","No provider change is authorized for this pipeline");
    const target=await chooseProvider(args.provider);
    if(!target)throw new ExecutionError("provider_unavailable","The permitted recovery providers are unavailable; waiting inside the delivery deadline");
    args={...args,...target};
  }
  const resource=repositoryResource(workspaces.get(args.workspaceId).workDirectory);
  const effect=executionStore.reserveWithRemedy({contractId:c.id,promptId:promptId,requestId,expectedGeneration:c.generation,revision:c.revision,resource,payload:{provider:args.provider,model:args.model,pipelineRunId:args.pipelineRunId ?? null,recovery:decision.action},recovery},recovery||decision.action==="fresh_context"?{signature:decision.signature,action:decision.action,evidence:facts}:undefined);
  return {effect,args:{...args,executionEffectId:effect.id,reuseSavedSession:!newAllocation&&!recovery&&decision.action!=="fresh_context",freshContext:newAllocation||recovery||decision.action==="fresh_context",recoveryBrief:unitHandoff(promptId,`${unitAttempts.workers===0?"First perform bounded intake planning: validate criterion coverage and targets. If the unit cannot fit a worker allowance, use decompose with original criterionIds and concrete targets; preserve all original obligations. For a coherent unit, proceed in this session. ":""}${decision.reason}. ${decision.action==="replan"?"Propose a coverage-preserving decomposition before further implementation.":decision.action==="diagnose"?"Diagnose from the recorded checks, state a concrete hypothesis, then repair using a different approach.":reason}`)}};
}

export async function settleSupervisedRun(runId:string,holdLease=false):Promise<boolean> {
  const e=executionStore.byRun(runId); if(!e) return true;
  if(e.state==="SETTLED") return true;
  await awaitManagedCommands(runId);
  releaseRuntimeEffect(e.id);
  for(const command of evidenceStore.active().filter(task=>task.runId===runId)) {
    if(await writerLiveness(command.process)!=="dead") {executionStore.quarantine(e.id,"Owned command descendants are not confirmed dead");return false;}
    evidenceStore.finish(command.id,{interrupted:"worker_ended"},null,true);
  }
  const metrics=workspaces.executionRunMetrics(runId);
  const liveness=e.process===null && metrics.processStarted===false ? "dead" : await writerLiveness(e.process,e.runId);
  if(liveness!=="dead") {executionStore.quarantine(e.id,`Writer ${liveness} after run end`);return false;}
  const settled=executionStore.settle(e.id,{generation:e.generation,actualMs:metrics.actualMs===null?null:Math.max(metrics.actualMs,(evidenceStore.runEnd(runId) ?? e.createdAt)-e.createdAt),actualTokens:metrics.actualTokens,result:{outcome:workspaces.promptOutcome(e.promptId),stopReason:metrics.stopReason},writerDead:true,holdLease});
  if(holdLease && settled)trackRuntimeEffect(e.id);
  return settled;
}

export function releaseSupervisedRun(runId:string):void {
  const effect=executionStore.byRun(runId);
  if(effect?.state==="SETTLED") {executionStore.releaseSettledLease(effect.id);releaseRuntimeEffect(effect.id);}
}

export function acceptSupervisedUnit(promptId:number):boolean {
  const c=executionStore.forPrompt(promptId);if(!c || c.engine!=="supervised")return true;
  try {
    assertManifest(c.id);
    for(const consumer of executionStore.sharedConsumers(promptId))assertManifest(consumer.contract.id);
    const home=workspaces.promptHome(promptId),dir=workspaces.get(home.workspaceId).workDirectory;
    const definition=workspaces.resolvedDefinitionOfDone(promptId);
    const current={inputHash:sourceFingerprint(dir),environmentHash:environmentFingerprint(dir),recipes:Object.fromEntries(definition.criteria.map(cr=>[String(cr.id),recipeFingerprint(cr)]))};
    for(const criterion of workspaces.definitionOfDoneEvaluation(promptId).criteria.filter(cr=>cr.kind==="CHILDREN_CLOSED" && cr.result==="PASSED")) {
      workspaces.recordDodResult({promptId,criterionId:criterion.criterionId,source:"RUNNER",result:"PASSED",evidence:criterion.evidence,inputHash:current.inputHash,environmentHash:current.environmentHash,recipeHash:recipeFingerprint(definition.criteria.find(cr=>cr.id===criterion.criterionId)!),stableInputs:true});
    }
    workspaces.acceptExecutionUnits(promptId,evidenceStore.latestFor(promptId),current);return true;
  } catch(error) {executionStore.decision(c.id,"completion_refused",{promptId,reason:String(error)});return false;}
}

export async function reconcileExecution():Promise<void> {
  for(const e of executionStore.pending()) {
    if(runtimeEffects.has(e.id))continue;
    if(e.state==="SETTLED") {
      if(workspaces.promptOutcome(e.promptId).status==="DONE" && !executionStore.accepted(e.contractId).includes(e.promptId) && !acceptSupervisedUnit(e.promptId)) {
        workspaces.refuseSupervisedCompletion(e.promptId,"Fresh evidence is required after interrupted finalization");
        workspaces.requeueTechnicalWait(e.promptId,"Recover interrupted verification inside the original allowance");
      }
      executionStore.releaseSettledLease(e.id);continue;
    }
    if(e.state==="PENDING" || runtimeEffects.has(e.id) || runHub.has(e.runId) || hasActiveManagedCommands(e.runId) || isManagedCommandProcess(e.process?.pid)) continue;
    if(evidenceStore.active().some(command=>command.runId===e.runId)) {executionStore.quarantine(e.id,"Owned command is still awaiting reconciliation");continue;}
    let alive=await writerLiveness(e.process,e.runId);
    const contract=executionStore.contract(e.contractId);
    if(alive==="alive" && e.process && Date.now()>=Math.min(contract.policy.deadline,e.createdAt+contract.policy.workerMs)) {
      await terminateTrackedProcess(e.process);alive=await writerLiveness(e.process,e.runId);
    }
    if(alive==="dead") {
      const metrics=workspaces.executionRunMetrics(e.runId);
      executionStore.settle(e.id,{generation:e.generation,actualMs:metrics.actualMs,actualTokens:e.payload.kind==="command"?0:metrics.actualTokens,result:{interrupted:"server_restart"},writerDead:true,holdLease:true});
      if(workspaces.promptOutcome(e.promptId).status==="DONE" && !acceptSupervisedUnit(e.promptId)) {
        workspaces.refuseSupervisedCompletion(e.promptId,"Interrupted completion requires fresh evidence");workspaces.requeueTechnicalWait(e.promptId,"Recover interrupted verification inside the original allowance");
      }
      executionStore.releaseSettledLease(e.id);
    }
    else executionStore.quarantine(e.id,`Startup reconciliation: writer ${alive}`);
  }
}

export async function dispatchPendingExecution(start:(args:StartExecuteArgs)=>Promise<{runId:string}>):Promise<void> {
  if(currentLockMode()!=="serve" || runHub.isClosing() || process.env.HYDRA_SUPERVISOR_HOLD==="1") return;
  for(const pending of executionStore.pending().filter(e=>e.state==="PENDING")) {
    if(pending.payload.kind==="audit") {
      const source=workspaces.runSummary(pending.payload.sourceRunId as string);
      const {scheduleCompletionAudit}=await import("../verification/completionAudit.ts");
      await scheduleCompletionAudit({workspaceId:source.workspaceId,promptId:pending.promptId,sourceRunId:source.id,sourceProvider:source.provider,auditProvider:pending.payload.provider as ProviderId,auditModel:pending.payload.model as string|null});continue;
    }
    if(pending.payload.kind==="command") {await requestCommand(pending.promptId,pending.payload.criterionId as number);continue;}
    const effect=executionStore.claim(pending.id); if(!effect) continue;
    trackRuntimeEffect(effect.id);
    const c=executionStore.contract(effect.contractId),home=workspaces.promptHome(effect.promptId);
    const pipelineRunId=typeof effect.payload.pipelineRunId==="string"?effect.payload.pipelineRunId:undefined;
    const pipeline=pipelineRunId?workspaces.pipelineById(pipelineRunId):null;
    if(!pipeline || pipeline.state!=="PLAYING") {releaseRuntimeEffect(effect.id);executionStore.quarantine(effect.id,"Dispatch requires a running owning pipeline");continue;}
    try {
      const result=await start({workspaceId:home.workspaceId,promptId:effect.promptId,provider:effect.payload.provider as ProviderId,model:effect.payload.model as string|null,pipelineRunId,executionEffectId:effect.id,reuseSavedSession:true,recoveryBrief:unitHandoff(effect.promptId,"Recover durable dispatch intent")});
      workspaces.updatePipelineRun(pipeline.id,{currentPromptId:effect.promptId,currentRunId:result.runId});
    } catch(error) {releaseRuntimeEffect(effect.id);executionStore.quarantine(effect.id,error instanceof Error?error.message:String(error));}
  }
}
