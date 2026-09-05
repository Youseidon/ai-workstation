import assert from "node:assert/strict";
import test from "node:test";
import type { PromptOption, PromptStatus } from "@agent-console/shared";
import { operationalState } from "./operationalState.ts";

function prompt(status:PromptStatus,overrides:Partial<PromptOption>={}):PromptOption{return{id:1,title:"Work",content:"Do work",suiteId:1,suiteName:"Suite",programId:1,programName:"Program",externalKey:"X-01",status,ready:status==="TODO",blockedBy:[],currentRun:null,recoverable:false,...overrides};}

test("operational state prioritises live ownership and recovery",()=>{
  assert.equal(operationalState(prompt("IN_PROGRESS",{currentRun:{id:"run",provider:"codex",model:null,role:"execute",state:"RUNNING",startedAt:"",endedAt:null,processActive:true}})),"WORKING");
  assert.equal(operationalState(prompt("BLOCKED",{recoverable:true})),"RECOVERY_NEEDED");
});

test("operational state separates intervention, dependency, and terminal states",()=>{
  assert.equal(operationalState(prompt("BLOCKED")),"AWAITING_RESPONSE");
  assert.equal(operationalState(prompt("TODO",{blockedBy:["X-00"]})),"WAITING_DEPENDENCY");
  assert.equal(operationalState(prompt("TODO")),"READY");
  assert.equal(operationalState(prompt("DONE")),"COMPLETE");
  assert.equal(operationalState(prompt("SKIPPED")),"SKIPPED");
  assert.equal(operationalState(prompt("IN_PROGRESS")),"FAILED");
});

 test("unresolved handoff questions keep TODO tasks in attention without overriding terminal states", () => {
  assert.equal(operationalState(prompt("TODO"), true), "AWAITING_RESPONSE");
  assert.equal(operationalState(prompt("DONE"), true), "COMPLETE");
  assert.equal(operationalState(prompt("SKIPPED"), true), "SKIPPED");
});
