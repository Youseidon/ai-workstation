import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createExecutionStore,executionSchema,type ProcessIdentity } from "../src/executionStore.ts";
import { writerLiveness } from "../src/executionProcess.ts";

for(const mode of ["before-dispatch","after-claim","registered-spawn","unregistered-spawn"]) {
  test(`crash window ${mode} never permits a second writer`,async()=>{
    const dir=mkdtempSync(join(tmpdir(),"execution-crash-")),path=join(dir,"state.sqlite");
    let identity:ProcessIdentity|null=null;
    const db=new Database(path);
    try {
      db.exec("CREATE TABLE prompt(id INTEGER PRIMARY KEY,status TEXT);INSERT INTO prompt VALUES(1,'TODO');CREATE TABLE dod_criterion(id INTEGER PRIMARY KEY,kind TEXT);CREATE TABLE dod_result(id INTEGER PRIMARY KEY,prompt_id INTEGER,criterion_id INTEGER,result TEXT);");
      db.exec(executionSchema);
      const store=createExecutionStore(db,()=>1000);
      store.adopt({id:"root",promptId:1,originalPrompt:"requirement",authority:{},criteria:[{id:"a",text:"requirement",sourceStart:0,sourceEnd:11,phase:"implementation",verifierPromptId:1,dodCriterionId:1}],policy:{maxAttempts:6,maxActiveMs:6000,maxTokens:600,deadline:100000,workerMs:1000,workerTokens:100,unitAttempts:3,recoveryAttempts:2,maxReplans:2,maxProviderChanges:2},engine:"supervised"});
      store.activatePlan("root",{revision:1,rationale:"fixture",units:[{promptId:1,criterionIds:["a"],targets:["source"],dependencies:[],phase:"implementation",recipeIds:[],rationale:"bounded"}]});
      store.setDesired("root","RUNNING");
      const output=execFileSync(process.execPath,["--import","tsx",new URL("./fixtures/execution-crash.mjs",import.meta.url).pathname,path,mode],{encoding:"utf8"});
      if(output.trim()) identity=JSON.parse(output.trim()).identity;
      const restored=createExecutionStore(db,()=>2000),pending=restored.pending()[0]!;
      assert.ok(pending);
      assert.equal(restored.status("root").attempts,1);
      assert.throws(()=>restored.reserve({contractId:"root",promptId:1,requestId:"second",expectedGeneration:restored.contract("root").generation,revision:1,resource:"repo",payload:{provider:"codex"}}),/writer/);
      if(mode==="before-dispatch") {
        assert.equal(pending.state,"PENDING");
        assert.ok(restored.claim(pending.id));
        assert.equal(restored.claim(pending.id),null);
      } else if(identity) {
        assert.equal(await writerLiveness(identity),"alive");
        restored.quarantine(pending.id,"Writer survived its parent");
        process.kill(-identity.pid,"SIGKILL");
        for(let attempt=0;attempt<20 && await writerLiveness(identity)!=="dead";attempt++) await new Promise(resolve=>setTimeout(resolve,10));
        assert.equal(await writerLiveness(identity),"dead");
        restored.settle(pending.id,{generation:pending.generation,actualMs:null,actualTokens:null,result:{interrupted:true},writerDead:true});
        assert.equal(restored.pending().length,0);
      } else {
        assert.equal(pending.state,"CLAIMED");
        restored.quarantine(pending.id,"Unacknowledged dispatch must be reconciled before replacement");
      }
    } finally {
      if(identity) {try {process.kill(-identity.pid,"SIGKILL");} catch { /* gone */ }}
      db.close();rmSync(dir,{recursive:true,force:true});
    }
  });
}
