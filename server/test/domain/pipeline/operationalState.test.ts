import assert from "node:assert/strict";
import test from "node:test";
import type { PromptOption, PromptStatus } from "@hydra/shared";
import { operationalState } from "../../../src/domain/pipeline/operationalState.ts";

function prompt(status:PromptStatus,overrides:Partial<PromptOption>={}):PromptOption{return{id:1,title:"Work",content:"Do work",suiteId:1,suiteName:"Suite",programId:1,programName:"Program",externalKey:"X-01",status,ready:status==="TODO",blockedBy:[],currentRun:null,recoverable:false,parentPromptId:null,childOrder:0,...overrides};}

test("operational state prioritises live ownership and recovery",()=>{
  assert.equal(operationalState(prompt("IN_PROGRESS",{currentRun:{id:"run",provider:"codex",model:null,role:"execute",state:"RUNNING",startedAt:"",endedAt:null,processActive:true}})),"WORKING");
  assert.equal(operationalState(prompt("IN_PROGRESS",{recoverable:true})),"RECOVERY_NEEDED");
  assert.equal(operationalState(prompt("BLOCKED",{recoverable:true})),"BLOCKED");
  assert.equal(operationalState(prompt("FAILED",{recoverable:true})),"FAILED");
  assert.equal(operationalState(prompt("UNREPORTED",{recoverable:true})),"UNREPORTED");
});

test("operational state separates intervention, dependency, and terminal states",()=>{
  assert.equal(operationalState(prompt("BLOCKED")),"BLOCKED");
  assert.equal(operationalState(prompt("TODO",{blockedBy:["X-00"]})),"WAITING_DEPENDENCY");
  assert.equal(operationalState(prompt("TODO",{ready:false})),"WAITING_DEPENDENCY");
  assert.equal(operationalState(prompt("TODO")),"READY");
  assert.equal(operationalState(prompt("DONE")),"DONE");
  assert.equal(operationalState(prompt("SKIPPED")),"SKIPPED");
  assert.equal(operationalState(prompt("IN_PROGRESS")),"IN_PROGRESS");
});

test("every stored status is shown as itself, never as an inferred failure",()=>{
  for(const status of ["TODO","IN_PROGRESS","DONE","BLOCKED","UNREPORTED","FAILED","NEEDS_REVIEW","SKIPPED"] as const){
    const shown=operationalState(prompt(status));
    if(status==="TODO"){assert.equal(shown,"READY");continue;}
    assert.equal(shown,status,`${status} was displayed as ${shown}`);
  }
});

test("FAILED is reached only by being stored, never by falling through",()=>{
  assert.equal(operationalState(prompt("UNREPORTED")),"UNREPORTED");
  assert.equal(operationalState(prompt("FAILED")),"FAILED");
  assert.equal(operationalState(prompt("NEEDS_REVIEW")),"NEEDS_REVIEW");
});
