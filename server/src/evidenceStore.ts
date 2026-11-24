import type Database from "better-sqlite3";
import type { ProcessIdentity } from "./executionStore.ts";
import { executionHash, ExecutionError } from "./executionStore.ts";

export function createEvidenceStore(db:Database.Database) {
  return {
    requestResult(runId:string,requestId:string,promptId:number,criterionId:number):number|null {
      const row=db.prepare("SELECT operation,request_hash,response FROM agent_command WHERE run_id=? AND request_id=?").get(runId,requestId) as {operation:string;request_hash:string|null;response:string}|undefined;
      if(!row)return null;
      if(row.operation!=="managed-check" || row.request_hash!==executionHash({runId,promptId,criterionId}))throw new ExecutionError("idempotency_conflict","Request ID reused for a different operation");
      return (JSON.parse(row.response) as {evidenceId:number}).evidenceId;
    },
    recordRequestResult(runId:string,requestId:string,promptId:number,criterionId:number,evidenceId:number):void {
      db.prepare("INSERT OR IGNORE INTO agent_command(run_id,request_id,operation,response,request_hash,created_at) VALUES(?,?,'managed-check',?,?,?)").run(runId,requestId,JSON.stringify({evidenceId}),executionHash({runId,promptId,criterionId}),new Date().toISOString());
    },
    request(key:string):{id:string;requestHash:string;state:string;evidenceId:number|null}|null {
      return db.prepare("SELECT id,request_hash requestHash,state,evidence_id evidenceId FROM command_task WHERE request_key=?").get(key) as {id:string;requestHash:string;state:string;evidenceId:number|null}|undefined ?? null;
    },
    reusable(promptId:number,criterionId:number,inputHash:string,recipeHash:string,environmentHash:string):number|null {
      const row=db.prepare("SELECT id,result,source,input_hash,recipe_hash,environment_hash,stable_inputs FROM dod_result WHERE prompt_id=? AND criterion_id=? ORDER BY id DESC LIMIT 1").get(promptId,criterionId) as {id:number;result:string;source:string;input_hash:string|null;recipe_hash:string|null;environment_hash:string|null;stable_inputs:number}|undefined;
      return row?.result==="PASSED" && row.source==="RUNNER" && row.stable_inputs===1 && row.input_hash===inputHash && row.recipe_hash===recipeHash && row.environment_hash===environmentHash ? row.id : null;
    },
    admit(args:{id:string;contractId:string|null;promptId:number;runId:string|null;criterionId:number;recipeHash:string;inputHash:string;environmentHash:string;timeoutMs:number;requestKey?:string;requestHash?:string}):void {
      db.transaction(()=>{
        const held=db.prepare("SELECT effect_id FROM execution_lease WHERE resource='host:heavy-command'").get() as {effect_id:string|null}|undefined;
        if(held?.effect_id) throw new ExecutionError("command_pool_busy","A heavy command already owns the host pool");
        const now=Date.now();
        db.prepare("INSERT INTO command_task(id,contract_id,prompt_id,run_id,criterion_id,recipe_hash,input_hash,environment_hash,state,started_at,deadline,request_key,request_hash) VALUES(?,?,?,?,?,?,?,?,'STARTING',?,?,?,?)")
          .run(args.id,args.contractId,args.promptId,args.runId,args.criterionId,args.recipeHash,args.inputHash,args.environmentHash,now,now+args.timeoutMs,args.requestKey ?? null,args.requestHash ?? null);
        db.prepare("INSERT INTO execution_lease(resource,effect_id,fencing_token,expires_at) VALUES('host:heavy-command',?,1,?) ON CONFLICT(resource) DO UPDATE SET effect_id=excluded.effect_id,fencing_token=execution_lease.fencing_token+1,expires_at=excluded.expires_at,process_json=NULL").run(args.id,now+args.timeoutMs);
      })();
    },
    process(id:string,identity:ProcessIdentity):void {
      db.transaction(()=>{
        if(!db.prepare("SELECT 1 FROM command_task WHERE id=? AND state='STARTING'").get(id)) throw new ExecutionError("stale_command","Command is no longer starting");
        db.prepare("UPDATE command_task SET state='RUNNING',process_json=? WHERE id=?").run(JSON.stringify(identity),id);
        db.prepare("UPDATE execution_lease SET process_json=? WHERE effect_id=?").run(JSON.stringify(identity),id);
      })();
    },
    observation(id:string,observation:unknown):void {
      const row=db.prepare("SELECT observations_json FROM command_task WHERE id=?").get(id) as {observations_json:string}|undefined;
      if(!row) return;
      const observations=JSON.parse(row.observations_json) as unknown[];
      db.prepare("UPDATE command_task SET observations_json=? WHERE id=?").run(JSON.stringify([...observations.slice(-99),observation]),id);
    },
    finish(id:string,result:unknown,evidenceId:number|null,dead:boolean):void {
      db.transaction(()=>{
        if(!dead && db.prepare("SELECT 1 FROM command_task WHERE id=? AND state='QUARANTINED'").get(id)) return;
        db.prepare("UPDATE command_task SET state=?,ended_at=?,result_json=?,evidence_id=? WHERE id=?").run(dead?"SETTLED":"QUARANTINED",dead?Date.now():null,JSON.stringify(result),evidenceId,id);
        if(dead) db.prepare("UPDATE execution_lease SET effect_id=NULL,process_json=NULL WHERE effect_id=?").run(id);
      })();
    },
    runEnd(runId:string):number|null {
      const row=db.prepare("SELECT MAX(COALESCE(ended_at,deadline)) ended FROM command_task WHERE run_id=?").get(runId) as {ended:number|null};return row.ended;
    },
    active():Array<{id:string;process:ProcessIdentity|null;runId:string|null;deadline:number}> {
      return (db.prepare("SELECT id,process_json,run_id,deadline FROM command_task WHERE state IN ('STARTING','RUNNING','QUARANTINED')").all() as Array<{id:string;process_json:string|null;run_id:string|null;deadline:number}>).map(r=>({id:r.id,process:r.process_json?JSON.parse(r.process_json):null,runId:r.run_id,deadline:r.deadline}));
    },
    evidence(ids:number[]):Array<Record<string,unknown>> { return ids.map(id=>db.prepare("SELECT * FROM dod_result WHERE id=?").get(id) as Record<string,unknown>).filter(Boolean); },
    runnerHistory(promptId:number):Array<Record<string,unknown>> {
      const rows=db.prepare("SELECT r.id,r.criterion_id criterionId,r.result,r.evidence,r.exit_code exitCode,r.input_hash inputHash,r.recipe_hash recipeHash,r.environment_hash environmentHash,r.stable_inputs stableInputs,r.created_at createdAt,t.id taskId,t.request_key requestKey FROM dod_result r LEFT JOIN command_task t ON t.evidence_id=r.id WHERE r.prompt_id=? AND r.source='RUNNER' ORDER BY r.id DESC LIMIT 100").all(promptId) as Array<Record<string,unknown>>;
      return rows.reverse().map(({requestKey,...row})=>({...row,requestKeyHash:typeof requestKey==="string"?executionHash(requestKey):null}));
    },
    latestFor(promptId:number):number[] { return (db.prepare("SELECT MAX(id) id FROM dod_result WHERE prompt_id=? GROUP BY criterion_id").all(promptId) as {id:number}[]).map(row=>row.id); },
  };
}
