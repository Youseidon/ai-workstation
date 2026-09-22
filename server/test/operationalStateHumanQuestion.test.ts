import assert from "node:assert/strict";
import test from "node:test";
import type { PromptOption, PromptStatus } from "@agent-console/shared";
import { operationalState } from "../src/operationalState.ts";

/*
 * The AWAITING_RESPONSE overlay, which is Team's. An outstanding question is a
 * fact about right now, so it is never stored — it lasts exactly as long as the
 * question does. The rest of the vocabulary is covered by operationalState.test.ts.
 */

function prompt(status:PromptStatus,overrides:Partial<PromptOption>={}):PromptOption{return{id:1,title:"Work",content:"Do work",suiteId:1,suiteName:"Suite",programId:1,programName:"Program",externalKey:"X-01",status,ready:status==="TODO",blockedBy:[],currentRun:null,recoverable:false,recovery:{kind:"none",message:null},...overrides} as PromptOption;}

test("an unanswered question puts a live item in AWAITING_RESPONSE", () => {
  assert.equal(operationalState(prompt("TODO"), true), "AWAITING_RESPONSE");
  assert.equal(operationalState(prompt("IN_PROGRESS"), true), "AWAITING_RESPONSE");
  assert.equal(operationalState(prompt("BLOCKED"), true), "AWAITING_RESPONSE");
});

test("a question never overrides a terminal state", () => {
  assert.equal(operationalState(prompt("DONE"), true), "DONE");
  assert.equal(operationalState(prompt("SKIPPED"), true), "SKIPPED");
});

test("without a question the stored status stands", () => {
  assert.equal(operationalState(prompt("BLOCKED")), "BLOCKED");
  assert.equal(operationalState(prompt("DONE")), "DONE");
});

test("a running process still outranks an outstanding question", () => {
  const running = prompt("IN_PROGRESS",{currentRun:{id:"run",provider:"codex",model:null,role:"execute",state:"RUNNING",startedAt:"",endedAt:null,processActive:true}} as Partial<PromptOption>);
  assert.equal(operationalState(running, true), "WORKING");
});
