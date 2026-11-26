import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {mkdtempSync,rmSync,copyFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";

test("v43 upgrade preserves legacy history and an isolated backup restores and upgrades again",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"execution-migration-")),path=join(dir,"console.sqlite");
  const run=(mode:string,dbPath=path)=>{
    const output=execFileSync(process.execPath,["--import","tsx",new URL("../fixtures/execution-migration.mjs",import.meta.url).pathname,mode,dir],{env:{...process.env,HYDRA_DB:dbPath,SETTINGS_FILE:join(dir,"settings.json")},encoding:"utf8"});
    return JSON.parse(output.trim().split("\n").at(-1)!) as {version:number;integrity:string;foreignKeys:unknown[]};
  };
  const tables=["workspace","program","suite","prompt","agent_run","agent_run_event","prompt_status_event","prompt_remark","agent_command"];
  const counts=(db:Database.Database)=>Object.fromEntries(tables.map(table=>[table,(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as {n:number}).n]));
  try {
    run("seed");
    const db=new Database(path);
    const before=counts(db);
    // Construct a v43 fixture from this disposable DB only. This is not a
    // production rollback path, and no live database is opened by this test.
    db.pragma("foreign_keys = OFF");
    db.transaction(()=>{
      for(const table of ["shared_verification","command_task","execution_wakeup","budget_ledger","recovery_case","execution_lease","dispatch_outbox","execution_event","work_unit_meta","execution_plan","delivery_contract_version","delivery_contract"])db.exec(`DROP TABLE ${table}`);
      for(const [table,columns] of [["agent_run",["instruction_hash","permission_key","process_started"]],["agent_command",["request_hash"]],["dod_criterion",["supervisor_only"]],["dod_result",["input_hash","recipe_hash","environment_hash","stable_inputs"]]] as const)for(const column of columns)db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      db.exec("ALTER TABLE prompt DROP COLUMN station_policy_json");
      db.prepare("DELETE FROM schema_migration WHERE version>=44").run();
    })();
    assert.equal((db.prepare("SELECT MAX(version) n FROM schema_migration").get() as {n:number}).n,43);
    const backup=join(dir,"before-v44.sqlite");await db.backup(backup);db.close();
    assert.deepEqual(run("verify"),{version:45,integrity:"ok",foreignKeys:[]});
    let upgraded=new Database(path);assert.deepEqual(counts(upgraded),before);upgraded.close();
    const restored=join(dir,"restored.sqlite");copyFileSync(backup,restored);
    upgraded=new Database(restored);assert.equal((upgraded.prepare("SELECT MAX(version) n FROM schema_migration").get() as {n:number}).n,43);assert.deepEqual(counts(upgraded),before);upgraded.close();
    assert.deepEqual(run("verify",restored),{version:45,integrity:"ok",foreignKeys:[]});
    assert.deepEqual(run("verify",restored),{version:45,integrity:"ok",foreignKeys:[]});
  } finally {rmSync(dir,{recursive:true,force:true});}
});
