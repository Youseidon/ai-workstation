import assert from "node:assert/strict";
import test from "node:test";
import {failureSignature,recoveryDecision} from "../../../src/domain/pipeline/recoveryPolicy.ts";
const initial={facts:"compiler ownership check failed",attempts:3,unitAttempts:3,tried:[] as string[],remainingRecovery:2,providerChanges:0,maxProviderChanges:2,canReplan:true};
test("recovery changes strategies while authority remains and stops rather than repeating",()=>{
  assert.equal(recoveryDecision({...initial,attempts:1}).action,"continue");
  assert.equal(recoveryDecision(initial).action,"diagnose");
  assert.equal(recoveryDecision({...initial,tried:["diagnose"]}).action,"replan");
  assert.equal(recoveryDecision({...initial,tried:["diagnose","replan"]}).action,"change_provider");
  assert.equal(recoveryDecision({...initial,tried:["diagnose","replan","change_provider"]}).action,"exhausted");
  assert.equal(recoveryDecision({...initial,remainingRecovery:0}).action,"exhausted");
  assert.equal(recoveryDecision({...initial,facts:"login required"}).action,"external_input");
  assert.equal(recoveryDecision({...initial,attempts:1,facts:"native session not found"}).action,"fresh_context");
  assert.notEqual(recoveryDecision({...initial,attempts:1,facts:"native session not found",tried:["fresh_context"]}).action,"fresh_context");
});
test("failure identity survives fresh run IDs and timestamps",()=>{
  assert.equal(failureSignature("run_abc failed at 2026-11-20T06:00:00Z in 100ms"),failureSignature("run_xyz failed at 2026-11-20T07:00:00Z in 200ms"));
});

test("token-limited native sessions get one fresh handoff inside the ordinary allowance",()=>{
  const failed={...initial,attempts:1,facts:"Run budget exhausted (budget_total_tokens:250000)"};
  assert.equal(recoveryDecision(failed).action,"fresh_context");
  assert.equal(recoveryDecision({...failed,facts:"budget_input_tokens:250000"}).action,"fresh_context");
  assert.equal(recoveryDecision({...failed,tried:["fresh_context"]}).action,"continue");
  assert.equal(recoveryDecision({...failed,attempts:3,remainingRecovery:0}).action,"exhausted");
});
