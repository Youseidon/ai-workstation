import assert from "node:assert/strict";
import test from "node:test";
import { validateExecutionPlan,validateExecutionPolicy,type ContractCriterion,type ExecutionPlan } from "../../src/models/executionPlan.ts";
const criteria:ContractCriterion[]=[{id:"a",text:"Original obligation A",sourceStart:0,sourceEnd:10,phase:"implementation",verifierPromptId:1,dodCriterionId:1},{id:"b",text:"Original obligation B",sourceStart:11,sourceEnd:20,phase:"verification",verifierPromptId:2,dodCriterionId:2}];
const plan:ExecutionPlan={revision:1,rationale:"intake",units:[{promptId:1,criterionIds:["a"],targets:["bindings"],dependencies:[],phase:"implementation",recipeIds:[1],rationale:"compile-only implementation"},{promptId:2,criterionIds:["b"],targets:["business scenarios"],dependencies:[1],phase:"verification",recipeIds:[2],rationale:"deferred verifier"}]};
test("planner cannot drop scope, invent criteria, create cycles or reverse verification order",()=>{
  validateExecutionPlan(criteria,plan);
  assert.throws(()=>validateExecutionPlan(criteria,{...plan,units:plan.units.slice(0,1)}),/drops/);
  assert.throws(()=>validateExecutionPlan(criteria,{...plan,units:[{...plan.units[0]!,criterionIds:["unknown"]},plan.units[1]!]}),/Unknown criterion/);
  assert.throws(()=>validateExecutionPlan(criteria,{...plan,units:[{...plan.units[0]!,dependencies:[2]},plan.units[1]!]}),/cycle|deferred/);
  assert.throws(()=>validateExecutionPlan(criteria,{...plan,units:[{...plan.units[0]!,phase:"verification"},plan.units[1]!]}),/phase/);
  assert.throws(()=>validateExecutionPlan(criteria,{...plan,revision:2,units:[{...plan.units[0]!,targets:["weaker scope"]},plan.units[1]!]},plan,[1]),/accepted/);
  validateExecutionPlan(criteria,{...plan,revision:2},plan,[1]);
});
test("root policies require finite limits and an absolute unexpired deadline",()=>{
  const policy={maxAttempts:6,maxActiveMs:6000,maxTokens:600,deadline:10000,workerMs:1000,workerTokens:100,unitAttempts:3,recoveryAttempts:2,maxReplans:2,maxProviderChanges:2};
  validateExecutionPolicy(policy,1000);
  for(const [key,value] of [["maxAttempts",Infinity],["maxTokens",0],["workerMs",7000],["deadline",500],["recoveryAttempts",6]] as const) assert.throws(()=>validateExecutionPolicy({...policy,[key]:value},1000));
});
