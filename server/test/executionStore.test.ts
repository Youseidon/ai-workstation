import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createExecutionStore, executionSchema } from "../src/executionStore.ts";
import type { ContractCriterion, ExecutionPolicy } from "@agent-console/shared";

function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE prompt(id INTEGER PRIMARY KEY); INSERT INTO prompt VALUES(1),(2),(3),(4);
    CREATE TABLE dod_criterion(id INTEGER PRIMARY KEY); INSERT INTO dod_criterion VALUES(1),(2);
    CREATE TABLE dod_result(id INTEGER PRIMARY KEY,prompt_id INTEGER,criterion_id INTEGER,result TEXT);
  `);
  db.exec(executionSchema);
  let now = 1000;
  const store = createExecutionStore(db, () => now);
  const policy: ExecutionPolicy = {maxAttempts:6,maxActiveMs:6000,maxTokens:600,deadline:100000,workerMs:1000,workerTokens:100,unitAttempts:3,recoveryAttempts:2,maxReplans:2,maxProviderChanges:2};
  const criteria: ContractCriterion[] = [{id:"a",text:"requirement",sourceStart:0,sourceEnd:11,phase:"implementation",verifierPromptId:1,dodCriterionId:1}];
  const contract = store.adopt({id:"root",promptId:1,originalPrompt:"requirement",authority:{},criteria,policy,engine:"supervised"});
  store.activatePlan(contract.id,{revision:1,units:[{promptId:1,criterionIds:["a"],targets:["requirement"],dependencies:[],phase:"implementation",recipeIds:[1],rationale:"bounded"}],rationale:"initial"});
  store.setDesired(contract.id,"RUNNING");
  const reserve = (requestId:string,recovery=false) => store.reserve({contractId:"root",promptId:1,requestId,expectedGeneration:store.contract("root").generation,revision:1,resource:"repo",payload:{provider:"codex"},recovery});
  return {db,store,reserve,policy,setNow:(value:number)=>{now=value;}};
}

test("dispatch intent, reservation and ownership survive lost dispatch and store recreation", () => {
  const f = fixture();
  try {
    const effect = f.reserve("first");
    const restored = createExecutionStore(f.db,()=>1000);
    assert.equal(restored.pending()[0]!.id,effect.id);
    assert.equal(restored.status("root").attempts,1);
    assert.equal(restored.status("root").reservedTokens,100);
    assert.throws(()=>f.reserve("duplicate"),/writer/);
    assert.ok(restored.claim(effect.id));
    assert.equal(restored.claim(effect.id),null);
  } finally { f.db.close(); }
});

test("replayed request reserves once, changed arguments conflict, and expiry never steals a lease", () => {
  const f=fixture();
  try {
    const args={contractId:"root",promptId:1,requestId:"x",expectedGeneration:f.store.contract("root").generation,revision:1,resource:"repo",payload:{}};
    const effect=f.store.reserve(args);
    assert.equal(f.store.reserve(args).id,effect.id);
    assert.throws(()=>f.store.reserve({...args,payload:{changed:true}}),/reused/);
    f.setNow(10000);
    assert.throws(()=>f.reserve("other"),/writer/);
    assert.equal(f.store.status("root").attempts,1);
  } finally { f.db.close(); }
});

test("uncertain spawn quarantines; stale results cannot release another writer", () => {
  const f=fixture();
  try {
    const e=f.reserve("one"); f.store.claim(e.id);
    f.store.attachProcess(e.id,{pid:123,startTicks:"x",bootId:"b",unitName:null,containment:"process-group"});
    assert.equal(f.store.settle(e.id,{generation:e.generation,actualMs:10,actualTokens:2,result:{},writerDead:false}),false);
    assert.equal(f.store.effect(e.id).state,"QUARANTINED");
    assert.throws(()=>f.reserve("two"),/writer/);
    assert.throws(()=>f.store.settle(e.id,{generation:e.generation-1,actualMs:10,actualTokens:2,result:{},writerDead:true}),/Late/);
    f.store.settle(e.id,{generation:e.generation,actualMs:10,actualTokens:2,result:{},writerDead:true});
    assert.ok(f.reserve("two"));
  } finally { f.db.close(); }
});

test("settlement fences credentials and retains ownership until evidence finalization", () => {
  const f=fixture();
  try {
    const e=f.reserve("first");f.store.claim(e.id);
    f.store.settle(e.id,{generation:e.generation,actualMs:10,actualTokens:2,result:{},writerDead:true,holdLease:true});
    assert.throws(()=>f.store.assertAttempt(e.runId),/fenced/);
    assert.throws(()=>f.reserve("next"),/writer/);
    assert.equal(createExecutionStore(f.db,()=>1000).pending()[0]!.id,e.id);
    f.store.releaseSettledLease(e.id);
    assert.equal(f.store.pending().length,0);
    assert.ok(f.reserve("next"));
    // An old finalizer cannot release the successor's lease.
    f.store.releaseSettledLease(e.id);
    assert.throws(()=>f.reserve("third"),/writer/);
  } finally {f.db.close();}
});

test("local limit spends reserved recovery then stops at cumulative root ceiling", () => {
  const f=fixture();
  try {
    for(let i=0;i<5;i++) {
      if(i===3) assert.throws(()=>f.reserve("worker-over"),/Local worker/);
      const e=f.reserve(`attempt-${i}`,i>=3); f.store.claim(e.id);
      f.store.settle(e.id,{generation:e.generation,actualMs:null,actualTokens:null,result:{},writerDead:true});
    }
    assert.equal(f.store.status("root").attempts,5);
    assert.equal(f.store.status("root").tokens,500);
    assert.throws(()=>f.reserve("over",true),/Recovery reserve exhausted/);
    assert.equal(f.store.remedy("root",1,"failure","fresh_context","facts"),true);
    assert.equal(f.store.remedy("root",1,"failure","fresh_context","facts"),false);
  } finally { f.db.close(); }
});

test("pause and stop remain durable and block dispatch, accepted scope stays closed after replan", () => {
  const f=fixture();
  try {
    f.store.setDesired("root","PAUSED");
    assert.throws(()=>f.reserve("paused"),/not running/);
    assert.equal(createExecutionStore(f.db).contract("root").desired,"PAUSED");
    f.db.prepare("UPDATE work_unit_meta SET accepted_at=1000 WHERE prompt_id=1").run();
    const previous=f.store.plan("root");
    assert.throws(()=>f.store.activatePlan("root",{...previous,revision:2,units:[{...previous.units[0]!,targets:["weaker"]}]}),/accepted/);
    f.store.activatePlan("root",{...previous,revision:2});
    assert.deepEqual(f.store.accepted("root"),[1]);
    f.store.setDesired("root","STOPPED");
    assert.equal(createExecutionStore(f.db).contract("root").desired,"STOPPED");
  } finally { f.db.close(); }
});

test("a failed accounting write retains reservations, writer ownership and current generation",()=>{
  const f=fixture();
  try {
    const e=f.reserve("telemetry");f.store.claim(e.id);
    f.db.exec("CREATE TRIGGER fail_usage BEFORE UPDATE ON budget_ledger BEGIN SELECT RAISE(ABORT,'telemetry unavailable'); END;");
    assert.throws(()=>f.store.settle(e.id,{generation:e.generation,actualMs:10,actualTokens:5,result:{},writerDead:true}),/telemetry unavailable/);
    assert.equal(f.store.effect(e.id).state,"CLAIMED");
    assert.equal(f.store.status("root").reservedTokens,100);
    assert.throws(()=>f.reserve("free-work"),/writer/);
    f.db.exec("DROP TRIGGER fail_usage");
    f.store.settle(e.id,{generation:e.generation,actualMs:null,actualTokens:null,result:{},writerDead:true});
    assert.equal(f.store.status("root").tokens,100);
  } finally {f.db.close();}
});

test("explicit budget amendments retain actual usage and a recorded reason",()=>{
  const f=fixture();
  try {
    const e=f.reserve("spent");f.store.claim(e.id);
    f.store.settle(e.id,{generation:e.generation,actualMs:200,actualTokens:50,result:{},writerDead:true});
    assert.throws(()=>f.store.amendBudget("root",{...f.policy,maxAttempts:8},""),/reason/);
    f.store.amendBudget("root",{...f.policy,maxAttempts:8,maxActiveMs:8000,maxTokens:800},"Approved additional integration allowance");
    assert.equal(f.store.status("root").attempts,1);
    assert.equal(f.store.status("root").tokens,50);
    assert.equal(f.store.status("root").policy.maxAttempts,8);
    assert.equal(f.store.events("root").at(-1)!.kind,"budget_amended");
  } finally {f.db.close();}
});

test("independent reviewers spend root allowance without consuming worker provider changes",()=>{
  const f=fixture();
  try {
    f.store.amendBudget("root",{...f.policy,maxProviderChanges:0},"Keep the worker provider fixed; independent review remains required");
    const end=(e:ReturnType<typeof f.reserve>)=>{f.store.claim(e.id);f.store.settle(e.id,{generation:e.generation,actualMs:10,actualTokens:1,result:{},writerDead:true});};
    end(f.reserve("worker"));
    const audit=f.store.reserve({contractId:"root",promptId:1,requestId:"audit",expectedGeneration:f.store.contract("root").generation,revision:1,resource:"repo",actor:"reviewer",payload:{kind:"audit",provider:"claude"}});
    end(audit);
    end(f.reserve("same-worker-provider"));
    assert.equal(f.store.status("root").attempts,3);
    assert.throws(()=>f.store.reserve({contractId:"root",promptId:1,requestId:"changed-worker-provider",expectedGeneration:f.store.contract("root").generation,revision:1,resource:"repo",payload:{provider:"grok"}}),/provider-change allowance/);
  } finally {f.db.close();}
});

test("recovery already consumed does not reserve the same attempt slots twice",()=>{
  const f=fixture();
  try {
    const end=(e:ReturnType<typeof f.reserve>)=>{f.store.claim(e.id);f.store.settle(e.id,{generation:e.generation,actualMs:10,actualTokens:1,result:{},writerDead:true});};
    end(f.reserve("early-recovery-1",true));
    end(f.reserve("early-recovery-2",true));
    for(let i=0;i<4;i++)end(f.store.reserve({contractId:"root",promptId:1,requestId:`ordinary-review-${i}`,expectedGeneration:f.store.contract("root").generation,revision:1,resource:"repo",actor:"reviewer",payload:{kind:"audit",provider:"claude"}}));
    assert.equal(f.store.status("root").attempts,6);
    assert.throws(()=>f.reserve("beyond-root",true),/root envelope/);
  } finally {f.db.close();}
});
