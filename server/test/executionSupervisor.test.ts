import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProgramRecord, SuiteRecord, PromptRecord, ExecutionPolicy } from "@agent-console/shared";
import { PROVIDER_IDS } from "@agent-console/shared";
import { getAdapter, setAdapterOverride } from "../src/adapters/registry.ts";
import type { AgentAdapter } from "../src/adapters/types.ts";
import type { StartExecuteArgs } from "../src/runService.ts";
import { evidenceStore, executionStore, workspaces } from "../src/workspaces.ts";
import { reconcileExecution, adoptExecution, releaseRuntimeEffect, settleSupervisedRun, releaseSupervisedRun } from "../src/executionSupervisor.ts";
import { processIdentity } from "../src/executionProcess.ts";
import { pipelineScheduler, setPipelineStationStarter } from "../src/pipelineScheduler.ts";
import { recipeFingerprint,sourceFingerprint,environmentFingerprint } from "../src/sourceFingerprint.ts";
import { requestCommand } from "../src/commandTasks.ts";
import { runContexts } from "../src/runContext.ts";

const policy:ExecutionPolicy={maxAttempts:6,maxActiveMs:600000,maxTokens:6000,deadline:Date.now()+3600000,workerMs:100000,workerTokens:1000,unitAttempts:3,recoveryAttempts:2,maxReplans:2,maxProviderChanges:2};
function fixture(deferred=false,content="Repair the implementation and compile; final business checks belong to the verifier.",proseOnly=false) {
  const dir=mkdtempSync(join(tmpdir(),"supervisor-"));
  const workspace=workspaces.create({name:randomUUID(),workDirectory:dir,description:""});
  const program=workspaces.createChild("program",workspace.id,{name:"program",overview:""}) as ProgramRecord;
  const suite=workspaces.createChild("suite",program.id,{name:"suite",overview:""}) as SuiteRecord;
  const prompt=workspaces.createChild("prompt",suite.id,{title:"S1-02 replay",content}) as PromptRecord;
  const criterion=workspaces.saveDodCriterion({scope:"prompt",scopeId:prompt.id,patch:proseOnly?{kind:"PROSE",text:"Repair the implementation and author the handoff"}:{kind:"COMMAND",text:"Compile the repaired implementation",command:`node -e "process.exit(require('fs').existsSync('fixed.txt')?0:1)"`}}).criteria[0]!;
  const pipeline=workspaces.createPipeline({workspaceId:workspace.id,name:"pipeline",suiteIds:[suite.id]});
  workspaces.addNamedPipelineStep(pipeline.id,prompt.id,{provider:"codex"});
  let verifier:PromptRecord|null=null;
  let verifierCriterion:ReturnType<typeof workspaces.resolvedDefinitionOfDone>["criteria"][number]|null=null;
  if(deferred) {
    verifier=workspaces.createChild("prompt",suite.id,{title:"S1-06 final verification",content:"Run final business verification"}) as PromptRecord;
    verifierCriterion=workspaces.saveDodCriterion({scope:"prompt",scopeId:verifier.id,patch:{kind:"COMMAND",text:"Verify final business scenarios",command:`node -e "process.exit(require('fs').readFileSync('fixed.txt','utf8')==='repaired'?0:1)"`}}).criteria[0]!;
    workspaces.addNamedPipelineStep(pipeline.id,verifier.id,{provider:"codex"});
  }
  const criteria=deferred?[{id:"bindings",text:criterion.text,sourceStart:0,sourceEnd:prompt.content.length,phase:"implementation",verifierPromptId:prompt.id,dodCriterionId:criterion.id},{id:"business",text:verifierCriterion!.text,sourceStart:0,sourceEnd:prompt.content.length,phase:"verification",verifierPromptId:verifier!.id,dodCriterionId:verifierCriterion!.id}]:undefined;
  const status=adoptExecution(prompt.id,{policy,...(criteria?{criteria}:{})});executionStore.enable(status.contractId);
  const starts:string[]=[];
  const launches:StartExecuteArgs[]=[];
  setPipelineStationStarter(async args=>{
    launches.push(args);
    assert.ok(args.executionEffectId);
    const effect=executionStore.effect(args.executionEffectId);
    const credential=runContexts.create(effect.runId,workspace.id,args.promptId!);
    workspaces.beginAgentRun({runId:effect.runId,workspaceId:workspace.id,promptId:args.promptId!,provider:args.provider,model:args.model,tokenHash:credential.tokenHash,expiresAt:credential.expiresAt});
    workspaces.markAgentRunRunning(effect.runId);
    // A real OS process exercises registration and death confirmation. No
    // provider or live repository is involved in this fault fixture.
    const child=spawn(process.execPath,["-e","setTimeout(()=>{},20)"],{detached:true,stdio:"ignore"});
    executionStore.attachProcess(effect.id,processIdentity(child.pid!));
    await once(child,"close");
    starts.push(effect.runId);return {runId:effect.runId};
  });
  const review=(promptId:number)=>{
    for(const cr of workspaces.resolvedDefinitionOfDone(promptId).criteria.filter(c=>c.kind==="PROSE")) {
      workspaces.recordDodResult({promptId,criterionId:cr.id,source:"REVIEWER",result:"PASSED",evidence:"Fixture reviewer checked actual implementation and the assigned deferred owner",inputHash:sourceFingerprint(dir),environmentHash:environmentFingerprint(dir),recipeHash:recipeFingerprint(cr),stableInputs:true});
    }
  };
  const end=async()=>{
    const runId=starts.at(-1)!;
    workspaces.finishAgentRun(runId,"done","",{usage:{inputTokens:10,outputTokens:5,totalTokens:15,cachedInputTokens:0,reasoningOutputTokens:0},toolCalls:0,toolOutputBytes:0,stopReason:null});
    await pipelineScheduler.onExecuteEnded({runId,workspaceId:workspace.id,promptId:executionStore.byRun(runId)!.promptId,processState:"done"});
  };
  return {dir,workspace,suite,prompt,criterion,pipeline,verifier,verifierCriterion,contractId:status.contractId,starts,launches,end,review,cleanup:()=>{setPipelineStationStarter(null);workspaces.remove(workspace.id);rmSync(dir,{recursive:true,force:true});}};
}

test("a token-limited prose-only worker continues with fresh context without auditing unfinished work",async()=>{
  const f=fixture(false,"Implement the remaining protected operations and hand off to S1-06.",true);
  let providerProbes=0;
  try {
    for(const provider of PROVIDER_IDS) {
      const adapter=Object.create(getAdapter(provider)) as AgentAdapter;
      adapter.checkAvailability=async()=>{providerProbes++;return {available:false,reason:"Isolated regression fixture",version:null,binary:null};};
      setAdapterOverride(provider,adapter);
    }
    await pipelineScheduler.playNamed(f.pipeline.id,{provider:"codex"});
    const first=f.starts[0]!,beforeProbes=providerProbes;
    workspaces.finishAgentRun(first,"done","",{usage:{inputTokens:1000,outputTokens:5,totalTokens:1005,cachedInputTokens:0,reasoningOutputTokens:0},toolCalls:2,toolOutputBytes:100,stopReason:"budget_total_tokens:1000"});
    await pipelineScheduler.onExecuteEnded({runId:first,workspaceId:f.workspace.id,promptId:f.prompt.id,processState:"done"});
    assert.equal(providerProbes,beforeProbes,"unfinished work must not trigger provider detection for a completion audit");
    assert.equal(workspaces.completionAuditsForRun(first).length,0);
    assert.equal(f.starts.length,2);
    assert.equal(executionStore.status(f.contractId).attempts,2);
    assert.equal(f.launches[1]!.freshContext,true);
    assert.equal(f.launches[1]!.reuseSavedSession,false);
    assert.equal(executionStore.byRun(f.starts[1]!)!.payload.recovery,"fresh_context");
  } finally {for(const provider of PROVIDER_IDS)setAdapterOverride(provider,null);f.cleanup();}
});

test("Run preserves exhaustion and an explicit allocation resumes with cumulative usage and a fresh handoff",async()=>{
  const f=fixture();
  try {
    await pipelineScheduler.playNamed(f.pipeline.id,{provider:"codex"});
    for(let i=0;i<5;i++) await f.end();
    const before=executionStore.status(f.contractId);
    const remedies=executionStore.remedies(f.contractId,f.prompt.id);
    assert.equal(before.exception?.code,"budget_exhausted");
    assert.equal(before.attempts,5);
    assert.equal(before.tokens,75);
    const refused=await pipelineScheduler.playNamed(f.pipeline.id,{});
    assert.equal(refused.state,"WAITING_HUMAN");
    assert.equal(refused.waitReason,"execution:budget_exhausted");
    assert.equal(f.starts.length,5);
    assert.deepEqual(executionStore.status(f.contractId).policy,before.policy);
    executionStore.amendBudget(f.contractId,{...before.policy,maxAttempts:12,maxActiveMs:1200000,maxTokens:12000,unitAttempts:6,recoveryAttempts:4},"Approved remaining implementation after reviewing the checkpoint");
    await pipelineScheduler.onBudgetAmended(f.prompt.id);
    assert.equal(f.starts.length,6);
    assert.equal(workspaces.latestNamedPipelineRun(f.pipeline.id)!.state,"PLAYING");
    const after=executionStore.status(f.contractId);
    assert.equal(after.attempts,6);
    assert.equal(after.tokens,before.tokens+policy.workerTokens);
    assert.equal(after.exception,null);
    assert.deepEqual(executionStore.remedies(f.contractId,f.prompt.id),remedies);
    assert.equal(f.launches.at(-1)!.freshContext,true);
    assert.equal(f.launches.at(-1)!.reuseSavedSession,false);
  } finally {f.cleanup();}
});

test("a refused DONE records review intent without treating progress prose as completion",async()=>{
  const f=fixture();
  try {
    await pipelineScheduler.playNamed(f.pipeline.id,{provider:"codex"});
    const runId=f.starts[0]!;
    workspaces.addAgentRemark(runId,{requestId:randomUUID(),kind:"PROGRESS",content:"The implementation is done, but checks remain"});
    assert.equal(workspaces.runHasCompletionRemark(f.prompt.id,runId),false);
    workspaces.updateAgentStatus(runId,{requestId:randomUUID(),expectedStatus:"IN_PROGRESS",status:"DONE",reason:"Request independent review",verificationSummary:"Implementation claim awaits trusted proof"});
    assert.equal(workspaces.runHasCompletionRemark(f.prompt.id,runId),true);
    assert.equal(workspaces.runHasCompletionRemark(f.prompt.id,"another-run"),false);
  } finally {f.cleanup();}
});

test("ordinary failures use reserved recovery and reach verified delivery without another Play",async()=>{
  const f=fixture();
  try {
    await pipelineScheduler.playNamed(f.pipeline.id,{provider:"codex"});
    for(let i=0;i<3;i++) await f.end();
    assert.equal(f.starts.length,4);
    const effect=executionStore.byRun(f.starts.at(-1)!)!;
    assert.equal(effect.payload.recovery,"diagnose");
    writeFileSync(join(f.dir,"fixed.txt"),"repaired");
    await requestCommand(f.prompt.id,f.criterion.id,effect.runId);
    f.review(f.prompt.id);
    assert.equal(workspaces.definitionOfDoneEvaluation(f.prompt.id).satisfied,true);
    workspaces.updateAgentStatus(effect.runId,{requestId:randomUUID(),expectedStatus:"IN_PROGRESS",status:"DONE",reason:"Fixed and compiled",verificationSummary:"Managed compiler passed"});
    await f.end();
    assert.equal(executionStore.status(f.contractId).phase,"delivered");
    assert.deepEqual(executionStore.accepted(f.contractId),[f.prompt.id]);
    assert.equal(workspaces.latestNamedPipelineRun(f.pipeline.id)!.state,"COMPLETE");
    assert.equal(f.starts.length,4);
    assert.equal(executionStore.status(f.contractId).attempts,4);
  } finally {f.cleanup();}
});

test("dirty edits invalidate a managed pass, command identity deduplicates, deadline is fixed",async()=>{
  const f=fixture();
  try {
    await pipelineScheduler.playNamed(f.pipeline.id,{provider:"codex"});
    writeFileSync(join(f.dir,"fixed.txt"),"one");
    const [first,duplicate]=await Promise.all([requestCommand(f.prompt.id,f.criterion.id,f.starts[0]),requestCommand(f.prompt.id,f.criterion.id,f.starts[0])]);
    assert.equal(first,duplicate);
    assert.equal(await requestCommand(f.prompt.id,f.criterion.id,f.starts[0]),first);
    writeFileSync(join(f.dir,"fixed.txt"),"two");
    assert.equal(workspaces.definitionOfDoneEvaluation(f.prompt.id).satisfied,false);
    const fresh=await requestCommand(f.prompt.id,f.criterion.id,f.starts[0]);
    assert.notEqual(fresh,first);
  } finally {f.cleanup();}
});

test("implementation advances to its deferred verifier without claiming delivery",async()=>{
  const f=fixture(true);
  try {
    await pipelineScheduler.playNamed(f.pipeline.id,{provider:"codex"});
    writeFileSync(join(f.dir,"fixed.txt"),"repaired");
    await requestCommand(f.prompt.id,f.criterion.id,f.starts[0]);
    f.review(f.prompt.id);
    workspaces.updateAgentStatus(f.starts[0]!,{requestId:randomUUID(),expectedStatus:"IN_PROGRESS",status:"DONE",reason:"Bindings compiled",verificationSummary:"Compile passed; business verification belongs to S1-06"});
    await f.end();
    assert.equal(executionStore.status(f.contractId).phase,"verification");
    assert.deepEqual(executionStore.status(f.contractId).pendingObligations,["business"]);
    assert.equal(evidenceStore.latestFor(f.verifier!.id).length,0);
    const finalRun=f.starts.at(-1)!;
    assert.equal(executionStore.byRun(finalRun)!.promptId,f.verifier!.id);
    await requestCommand(f.verifier!.id,f.verifierCriterion!.id,finalRun);
    workspaces.updateAgentStatus(finalRun,{requestId:randomUUID(),expectedStatus:"IN_PROGRESS",status:"DONE",reason:"Business scenarios verified",verificationSummary:"Fresh managed verification passed"});
    await f.end();
    assert.equal(executionStore.status(f.contractId).phase,"delivered");
    assert.equal(workspaces.latestNamedPipelineRun(f.pipeline.id)!.state,"COMPLETE");
  } finally {f.cleanup();}
});

test("one final verifier atomically closes multiple requirements under one cumulative budget",async()=>{
  const f=fixture(true);
  try {
    const second=workspaces.createChild("prompt",f.suite.id,{title:"Second implementation",content:"Implement the second part; final business checks belong to S1-06."}) as PromptRecord;
    workspaces.addNamedPipelineStep(f.pipeline.id,second.id,{provider:"codex"});
    workspaces.reorderNamedPipelineSteps(f.pipeline.id,f.suite.id,[f.prompt.id,second.id,f.verifier!.id]);
    const secondStatus=adoptExecution(second.id,{policy,budgetScope:executionStore.contract(f.contractId).budgetScope,criteria:[{id:"shared-business",text:f.verifierCriterion!.text,sourceStart:0,sourceEnd:second.content.length,phase:"verification",verifierPromptId:f.verifier!.id,dodCriterionId:f.verifierCriterion!.id}]});
    assert.equal(executionStore.sharedConsumers(f.verifier!.id).length,0,"shadow intake cannot change active verification gates");
    executionStore.enable(secondStatus.contractId);
    assert.equal(executionStore.sharedConsumers(f.verifier!.id).length,1);
    await pipelineScheduler.playNamed(f.pipeline.id,{provider:"codex"});
    writeFileSync(join(f.dir,"fixed.txt"),"repaired");
    await requestCommand(f.prompt.id,f.criterion.id,f.starts[0]);
    f.review(f.prompt.id);
    workspaces.updateAgentStatus(f.starts[0]!,{requestId:randomUUID(),expectedStatus:"IN_PROGRESS",status:"DONE",reason:"Implemented first part",verificationSummary:"Fresh phase evidence"});
    await f.end();
    assert.equal(executionStore.byRun(f.starts.at(-1)!)!.promptId,second.id);
    assert.match(f.launches.find(launch=>launch.promptId===second.id)!.recoveryBrief!,/First perform bounded intake planning/);
    writeFileSync(join(f.dir,"second.txt"),"implemented");
    f.review(second.id);
    workspaces.updateAgentStatus(f.starts.at(-1)!,{requestId:randomUUID(),expectedStatus:"IN_PROGRESS",status:"DONE",reason:"Implemented second part",verificationSummary:"Fresh phase evidence"});
    await f.end();
    assert.equal(executionStore.status(f.contractId).phase,"verification");
    assert.equal(executionStore.status(secondStatus.contractId).phase,"verification");
    const finalRun=f.starts.at(-1)!;
    assert.equal(executionStore.byRun(finalRun)!.promptId,f.verifier!.id);
    await requestCommand(f.verifier!.id,f.verifierCriterion!.id,finalRun);
    workspaces.updateAgentStatus(finalRun,{requestId:randomUUID(),expectedStatus:"IN_PROGRESS",status:"DONE",reason:"Final scenarios verified",verificationSummary:"Fresh shared verifier evidence"});
    await f.end();
    assert.equal(executionStore.status(f.contractId).phase,"delivered");
    assert.equal(executionStore.status(secondStatus.contractId).phase,"delivered");
    assert.equal(executionStore.status(f.contractId).attempts,3);
    assert.equal(executionStore.status(secondStatus.contractId).attempts,3);
    assert.equal(f.starts.length,3);
    assert.equal(workspaces.latestNamedPipelineRun(f.pipeline.id)!.state,"COMPLETE");
  } finally {f.cleanup();}
});

test("a crash after result persistence accepts the unit on reconciliation and never reruns it",async()=>{
  const f=fixture();
  try {
    await pipelineScheduler.playNamed(f.pipeline.id,{provider:"codex"});
    writeFileSync(join(f.dir,"fixed.txt"),"repaired");
    const runId=f.starts[0]!;
    await requestCommand(f.prompt.id,f.criterion.id,runId);
    f.review(f.prompt.id);
    workspaces.updateAgentStatus(runId,{requestId:randomUUID(),expectedStatus:"IN_PROGRESS",status:"DONE",reason:"Implemented",verificationSummary:"Fresh managed check"});
    workspaces.finishAgentRun(runId,"done");
    // Crash here: no onExecuteEnded callback or accepted-unit write yet.
    releaseRuntimeEffect(executionStore.byRun(runId)!.id); // process-local registration is lost on restart
    workspaces.recoverAbandonedRuns();
    await reconcileExecution();
    assert.deepEqual(executionStore.accepted(f.contractId),[f.prompt.id]);
    await pipelineScheduler.playNamed(f.pipeline.id,{});
    assert.equal(f.starts.length,1);
    assert.equal(workspaces.latestNamedPipelineRun(f.pipeline.id)!.state,"COMPLETE");
  } finally {f.cleanup();}
});

test("periodic reconciliation leaves active finalization and live worker claims unaccepted",async()=>{
  const f=fixture();
  try {
    await pipelineScheduler.playNamed(f.pipeline.id,{provider:"codex"});
    writeFileSync(join(f.dir,"fixed.txt"),"repaired");
    const runId=f.starts[0]!;
    await requestCommand(f.prompt.id,f.criterion.id,runId);
    f.review(f.prompt.id);
    workspaces.updateAgentStatus(runId,{requestId:randomUUID(),expectedStatus:"IN_PROGRESS",status:"DONE",reason:"Implemented",verificationSummary:"Fresh evidence"});
    await reconcileExecution();
    assert.deepEqual(executionStore.accepted(f.contractId),[]);
    workspaces.finishAgentRun(runId,"done");
    assert.ok(await settleSupervisedRun(runId,true));
    await reconcileExecution();
    assert.deepEqual(executionStore.accepted(f.contractId),[]);
    assert.ok(executionStore.pending().some(effect=>effect.runId===runId));
    // A restart discards the active callback registration, leaving durable
    // settlement and ownership to complete acceptance before lease release.
    releaseRuntimeEffect(executionStore.byRun(runId)!.id);
    await reconcileExecution();
    assert.deepEqual(executionStore.accepted(f.contractId),[f.prompt.id]);
    assert.equal(executionStore.pending().length,0);
  } finally {for(const runId of f.starts)releaseSupervisedRun(runId);f.cleanup();}
});

test("compiler success cannot close the original requirement without its semantic review",async()=>{
  const f=fixture();
  try {
    await pipelineScheduler.playNamed(f.pipeline.id,{provider:"codex"});
    writeFileSync(join(f.dir,"fixed.txt"),"repaired");
    await requestCommand(f.prompt.id,f.criterion.id,f.starts[0]);
    const result=workspaces.updateAgentStatus(f.starts[0]!,{requestId:randomUUID(),expectedStatus:"IN_PROGRESS",status:"DONE",reason:"Compiler passed",verificationSummary:"Exit zero"}) as {status:string};
    assert.equal(result.status,"NEEDS_REVIEW");
    assert.equal(executionStore.status(f.contractId).phase,"implementation");
    assert.deepEqual(executionStore.accepted(f.contractId),[]);
  } finally {f.cleanup();}
});

test("operator pause and stop survive abandoned-run recovery",async()=>{
  const f=fixture();
  try {
    await pipelineScheduler.playNamed(f.pipeline.id,{provider:"codex"});
    await pipelineScheduler.pauseNamed(f.pipeline.id);
    workspaces.recoverAbandonedRuns();
    assert.equal(workspaces.latestPipeline(f.suite.id)!.state,"PAUSED");
    assert.equal(workspaces.latestNamedPipelineRun(f.pipeline.id)!.state,"PAUSED");
    assert.equal(executionStore.contract(f.contractId).desired,"PAUSED");
    await pipelineScheduler.stopNamed(f.pipeline.id);
    workspaces.recoverAbandonedRuns();
    assert.equal(workspaces.latestNamedPipelineRun(f.pipeline.id)!.state,"STOPPED");
    assert.equal(executionStore.contract(f.contractId).desired,"STOPPED");
    assert.equal(f.starts.length,1);
  } finally {f.cleanup();}
});

test("a reused check request returns its persisted failure without launching again",async()=>{
  const f=fixture();
  try {
    await pipelineScheduler.playNamed(f.pipeline.id,{provider:"codex"});
    const requestId=randomUUID(),runId=f.starts[0]!;
    const first=await requestCommand(f.prompt.id,f.criterion.id,runId,requestId);
    writeFileSync(join(f.dir,"fixed.txt"),"repaired");
    assert.equal(await requestCommand(f.prompt.id,f.criterion.id,runId,requestId),first);
    assert.equal(evidenceStore.evidence([first])[0]!.result,"FAILED");
    assert.notEqual(await requestCommand(f.prompt.id,f.criterion.id,runId,randomUUID()),first);
  } finally {f.cleanup();}
});

test("review history proves distinct failed and successful check requests without exposing request keys",async()=>{
  const f=fixture();
  try {
    await pipelineScheduler.playNamed(f.pipeline.id,{provider:"codex"});
    const first=await requestCommand(f.prompt.id,f.criterion.id,f.starts[0],"private-first-request");
    writeFileSync(join(f.dir,"fixed.txt"),"repaired");
    const second=await requestCommand(f.prompt.id,f.criterion.id,f.starts[0],"private-second-request");
    const history=evidenceStore.runnerHistory(f.prompt.id);
    assert.deepEqual(history.map(row=>[row.id,row.result]),[[first,"FAILED"],[second,"PASSED"]]);
    assert.ok(history.every(row=>row.taskId&&row.requestKeyHash));
    assert.notEqual(history[0]!.requestKeyHash,history[1]!.requestKeyHash);
    assert.doesNotMatch(JSON.stringify(history),/private-(first|second)-request/);
  } finally {f.cleanup();}
});


test("remaining plans derive named deferred obligations without dropping original scope or usage",async()=>{
  const f=fixture(false,"Repair the bindings. Business scenarios are verified at S1-06.");
  try {
    const verifier=workspaces.createChild("prompt",f.suite.id,{title:"S1-06",content:"Verify business scenarios"}) as PromptRecord;
    const finalCheck=workspaces.saveDodCriterion({scope:"prompt",scopeId:verifier.id,patch:{kind:"COMMAND",text:"Verify final scenarios",command:"node --version"}}).criteria[0]!;
    workspaces.addNamedPipelineStep(f.pipeline.id,verifier.id,{provider:"codex"});
    await pipelineScheduler.playNamed(f.pipeline.id,{provider:"codex"});
    const contract=executionStore.contract(f.contractId),before=executionStore.plan(f.contractId),text="Business scenarios are verified at S1-06.";
    const sourceStart=contract.originalPrompt.indexOf(text),sourceCriterionId=contract.criteria.find(c=>c.kind==="PROSE")!.id;
    const plan={...before,revision:2,additionalCriteria:[{id:"deferred-business",text,sourceStart,sourceEnd:sourceStart+text.length,verifierPromptId:verifier.id,sourceCriterionId}],units:[...before.units,{promptId:verifier.id,criterionIds:["deferred-business"],targets:["business scenarios"],phase:"verification" as const,dependencies:[f.prompt.id],recipeIds:[],rationale:"Original requirement names the final owner"}]};
    workspaces.proposeExecutionPlan(f.starts[0]!,{requestId:randomUUID(),plan});
    await f.end();
    const activated=executionStore.plan(f.contractId),manifest=executionStore.contract(f.contractId).criteria;
    assert.equal(activated.revision,2);
    assert.ok(manifest.some(c=>c.id==="deferred-business" && c.verifierPromptId===verifier.id));
    assert.ok(activated.units.find(unit=>unit.promptId===verifier.id)!.recipeIds.includes(finalCheck.id));
    for(const criterion of contract.criteria)assert.ok(manifest.some(c=>c.id===criterion.id && c.text===criterion.text));
    assert.equal(executionStore.status(f.contractId).attempts,2);
    assert.equal(executionStore.status(f.contractId).tokens,1015); // first actual + second reservation
  } finally {f.cleanup();}
});

test("native saved sessions require matching unit, provider, model, instructions and permissions",async()=>{
  const f=fixture();
  try {
    await pipelineScheduler.playNamed(f.pipeline.id,{provider:"codex"});
    const runId=f.starts[0]!,run=workspaces.runSummary(runId);
    workspaces.recordExecutionManifest(runId,"instructions-v1","permissions-v1");
    workspaces.finishAgentRun(runId,"done","",{usage:null,toolCalls:0,toolOutputBytes:0,stopReason:null,sessionId:"native-session"});
    assert.equal(workspaces.savedSession(f.prompt.id,run.provider,run.model,"instructions-v1","permissions-v1"),"native-session");
    assert.equal(workspaces.savedSession(f.prompt.id,run.provider,run.model,"instructions-v2","permissions-v1"),null);
    assert.equal(workspaces.savedSession(f.prompt.id,run.provider,run.model,"instructions-v1","permissions-v2"),null);
    assert.equal(workspaces.savedSession(f.prompt.id,"grok",run.model,"instructions-v1","permissions-v1"),null);
    assert.equal(workspaces.savedSession(f.prompt.id,run.provider,"another-model","instructions-v1","permissions-v1"),null);
  } finally {f.cleanup();}
});
