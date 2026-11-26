import type { ProcessIdentity } from "../../contracts/execution.ts";
import { randomUUID } from "node:crypto";
import { workspaces, executionStore, evidenceStore } from "../../repositories/workspaces.ts";
import { executionHash, ExecutionError } from "../../repositories/executionStore.ts";
import { repositoryResource, recipeFingerprint, sourceFingerprint, environmentFingerprint } from "../../infrastructure/sourceFingerprint.ts";
import { terminateTrackedProcess, writerLiveness } from "../../infrastructure/executionProcess.ts";
import { commandPassed, describeOutcome, runDodCommand } from "../verification/dodCommands.ts";
import { settings } from "../../config/settings.ts";

const inFlight = new Map<string,Promise<number>>();
let hostTail:Promise<unknown>=Promise.resolve();
const byRun=new Map<string,Set<Promise<number>>>();
const activeProcesses=new Set<number>();
const activeCommandIds=new Set<string>();
let commandsClosing=false;
export const hasActiveManagedCommands=(runId:string):boolean=>(byRun.get(runId)?.size ?? 0)>0;
export const isManagedCommandProcess=(pid:number|undefined):boolean=>pid!==undefined && activeProcesses.has(pid);
export async function awaitManagedCommands(runId:string):Promise<void> {
  while(hasActiveManagedCommands(runId)) await Promise.allSettled([...(byRun.get(runId) ?? [])]);
}
export async function cancelManagedCommands(runId:string):Promise<void> {
  for(const command of evidenceStore.active().filter(task=>task.runId===runId)) {
    if(command.process) await terminateTrackedProcess(command.process);
  }
}
export async function stopAllManagedCommands():Promise<void> {
  commandsClosing=true;
  await Promise.allSettled(evidenceStore.active().filter(task=>activeCommandIds.has(task.id)&&task.process).map(task=>terminateTrackedProcess(task.process!)));
  await Promise.allSettled([...inFlight.values()]);
}
export { recipeFingerprint } from "../../infrastructure/sourceFingerprint.ts";

export async function requestCommand(promptId:number,criterionId:number,runId:string|null=null,requestId?:string):Promise<number> {
  if (runId && workspaces.stationPolicy(promptId).verification === "deferred")
    throw new ExecutionError("phase_forbidden", "Verification belongs to the designated Verify station; hand off pending commands instead.");
  if(runId && requestId) {
    const recorded=evidenceStore.requestResult(runId,requestId,promptId,criterionId);
    if(recorded!==null)return recorded;
  }
  const recordResult=(evidenceId:number):number=>{if(runId&&requestId)evidenceStore.recordRequestResult(runId,requestId,promptId,criterionId,evidenceId);return evidenceId;};
  const requestKey=requestId?`${runId ?? "operator"}:${requestId}`:undefined;
  const requestHash=executionHash({promptId,criterionId,runId});
  const prior=requestKey?evidenceStore.request(requestKey):null;
  if(prior) {
    if(prior.requestHash!==requestHash) throw new ExecutionError("idempotency_conflict","Request ID reused for a different command");
    if(prior.evidenceId!==null) return recordResult(prior.evidenceId);
    throw new ExecutionError(prior.state==="SETTLED"?"command_failed":"command_pending",`Command ${prior.id} is ${prior.state.toLowerCase()}; the same request never launches it twice`);
  }
  const plan=workspaces.dodCommandPlan(promptId), criterion=plan.criteria.find(c=>c.id===criterionId);
  if(!criterion || !criterion.command) throw new ExecutionError("recipe_unknown","Request a command criterion assigned to this work item");
  const contract=executionStore.forPrompt(promptId);
  if(contract?.engine==="supervised") {
    if(process.env.HYDRA_SUPERVISOR_HOLD==="1") throw new ExecutionError("engine_held","Supervised command dispatch is held");
    const unit=executionStore.plan(contract.id).units.find(u=>u.promptId===promptId);
    if(!unit?.recipeIds.includes(criterionId) && !executionStore.sharedConsumers(promptId).some(consumer=>consumer.unit.recipeIds.includes(criterionId))) throw new ExecutionError("phase_forbidden","This recipe is not assigned to the current work unit and phase");
    if(runId) executionStore.assertAttempt(runId);
  }
  const inputHash=sourceFingerprint(plan.workDirectory), recipeHash=recipeFingerprint(criterion), environmentHash=environmentFingerprint(plan.workDirectory);
  const key=executionHash({promptId,criterionId,inputHash,recipeHash,environmentHash});
  const pending=inFlight.get(key); if(pending) return recordResult(await pending);
  const reusable=evidenceStore.reusable(promptId,criterionId,inputHash,recipeHash,environmentHash);
  if(reusable!==null) {
    if(contract) executionStore.decision(contract.id,"verification_reused",{criterionId,evidenceId:reusable});
    return recordResult(reusable);
  }
  const execute=async():Promise<number>=>{
    if(commandsClosing)throw new ExecutionError("server_closing","Command dispatch stopped for shutdown");
    if(runId) executionStore.assertAttempt(runId);
    const before=sourceFingerprint(plan.workDirectory);
    let commandEffect:ReturnType<typeof executionStore.reserve>|null=null;
    if(contract?.engine==="supervised" && runId===null) {
      const current=executionStore.contract(contract.id);
      const existing=executionStore.pending().find(e=>e.contractId===contract.id && e.payload.kind==="command" && e.payload.criterionId===criterionId && e.state==="PENDING");
      commandEffect=existing ?? executionStore.reserve({contractId:contract.id,promptId,requestId:`command-${key}-${randomUUID()}`,expectedGeneration:current.generation,revision:current.revision,resource:repositoryResource(plan.workDirectory),payload:{kind:"command",criterionId,inputHash:before,recipeHash,environmentHash},actor:"verifier"});
      if(!executionStore.claim(commandEffect.id)) throw new ExecutionError("command_held","The command's dispatch is held");
    }
    const id=randomUUID();
    try {evidenceStore.admit({id,contractId:contract?.id ?? null,promptId,runId,criterionId,recipeHash,inputHash:before,environmentHash,timeoutMs:criterion.timeoutMs,requestKey,requestHash});}
    catch(error) {
      if(commandEffect) executionStore.settle(commandEffect.id,{generation:commandEffect.generation,actualMs:0,actualTokens:0,result:{admissionFailed:String(error)},writerDead:true});
      throw error;
    }
    let identity:ProcessIdentity|null=null;
    activeCommandIds.add(id);
    try {
      const outcome=await runDodCommand({command:criterion.command!,workDirectory:plan.workDirectory,cwd:criterion.cwd,timeoutMs:criterion.timeoutMs,taskId:id,limits:settings.resourceLimits,onObservation:observation=>evidenceStore.observation(id,observation),onSpawn:process=>{identity=process;activeProcesses.add(process.pid);evidenceStore.process(id,process);if(commandEffect)executionStore.attachProcess(commandEffect.id,process);}});
      const stable=before===sourceFingerprint(plan.workDirectory) && environmentHash===environmentFingerprint(plan.workDirectory);
      const dead=identity===null || await writerLiveness(identity)==="dead";
      const passed=stable && dead && commandPassed(outcome,criterion.expectExitCode);
      const evidenceId=workspaces.recordDodResult({promptId,criterionId,runId,source:"RUNNER",result:passed?"PASSED":"FAILED",evidence:!stable?"Inputs changed during verification; result discarded.":!dead?"Command descendants are not confirmed dead.":describeOutcome(outcome,criterion.expectExitCode),output:outcome.output,exitCode:outcome.exitCode,inputHash:before,recipeHash,environmentHash,stableInputs:stable&&dead});
      evidenceStore.finish(id,outcome,evidenceId,dead);
      if(commandEffect) executionStore.settle(commandEffect.id,{generation:commandEffect.generation,actualMs:outcome.durationMs,actualTokens:0,result:{commandId:id,evidenceId},writerDead:dead});
      return evidenceId;
    } catch(error) {
      const dead=identity===null || await writerLiveness(identity)==="dead";
      evidenceStore.finish(id,{error:error instanceof Error?error.message:String(error)},null,dead);
      if(commandEffect) executionStore.settle(commandEffect.id,{generation:commandEffect.generation,actualMs:null,actualTokens:0,result:{commandId:id,error:String(error)},writerDead:dead});
      throw error;
    } finally {activeCommandIds.delete(id);const registered=identity as ProcessIdentity|null;if(registered)activeProcesses.delete(registered.pid);}
  };
  const promise=hostTail.then(execute,execute);
  hostTail=promise.then(()=>undefined,()=>undefined);
  inFlight.set(key,promise);
  if(runId) {const owned=byRun.get(runId) ?? new Set<Promise<number>>();owned.add(promise);byRun.set(runId,owned);}
  try { return recordResult(await promise); } finally { inFlight.delete(key);if(runId){byRun.get(runId)?.delete(promise);if(byRun.get(runId)?.size===0)byRun.delete(runId);} }
}

export async function reconcileCommands():Promise<void> {
  for(const task of evidenceStore.active()) {
    if(activeCommandIds.has(task.id))continue;
    const liveness=await writerLiveness(task.process);
    if(liveness==="dead") evidenceStore.finish(task.id,{interrupted:"server_restart"},null,true);
    else evidenceStore.finish(task.id,{exception:"command_liveness_uncertain",liveness},null,false);
  }
}
