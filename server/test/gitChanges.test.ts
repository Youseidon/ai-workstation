import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertRunChangesCommitted, checkpointRun, prepareChangeCapture, releaseChangeCapture, runChangeDetail, runFileDiff } from "../src/gitChanges.ts";
import { runContexts } from "../src/runContext.ts";
import { workspaces } from "../src/workspaces.ts";

let sequence=0;
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),"agent-changes-"));
  const command=(...args:string[])=>execFileSync("git",args,{cwd:directory,encoding:"utf8"});
  command("init","-q");command("config","user.name","Fixture");command("config","user.email","fixture@example.test");
  writeFileSync(join(directory,"app.ts"),"export const value = 1;\n");command("add","app.ts");command("commit","-qm","Initial source");
  const workspace=workspaces.create({name:`git-changes-${process.pid}-${Date.now()}-${sequence++}`,description:"",workDirectory:directory});
  const runId=`run-git-${process.pid}-${Date.now()}-${sequence++}`;const credential=runContexts.create(runId,workspace.id,null);
  workspaces.beginCustomExecuteRun({runId,workspaceId:workspace.id,provider:"codex",model:null,tokenHash:credential.tokenHash,expiresAt:credential.expiresAt,displayText:"Change source"});
  const capture=prepareChangeCapture(directory,runId);workspaces.beginRunChangeSet({runId,workspaceId:workspace.id,...capture});
  return{directory,workspace,runId,command,cleanup(){workspaces.remove(workspace.id);rmSync(directory,{recursive:true,force:true});}};
}

test("a checkpoint commits and exposes a reviewable run range",()=>{
  const item=fixture();try{
    writeFileSync(join(item.directory,"app.ts"),"export const value = 2;\n");
    const summary=checkpointRun(item.runId,"Update exported value","codex",null);
    assert.equal(summary.state,"COMMITTED");assert.equal(summary.filesChanged,1);assert.equal(summary.commitCount,1);
    assert.doesNotThrow(()=>assertRunChangesCommitted(item.runId));
    const detail=runChangeDetail(item.runId);assert.equal(detail.commits[0]?.subject,"Update exported value");assert.equal(detail.files[0]?.path,"app.ts");
    const diff=runFileDiff(item.runId,"app.ts");assert.match(diff.patch,/value = 2/);assert.match(item.command("log","-1","--format=%b"),/Agent-Run:/);
  }finally{item.cleanup();}
});

test("dirty source cannot end without a checkpoint",()=>{
  const item=fixture();try{
    writeFileSync(join(item.directory,"app.ts"),"export const value = 3;\n");
    assert.throws(()=>assertRunChangesCommitted(item.runId),(error:unknown)=>(error as {code?:string}).code==="git_commit_required");
  }finally{item.cleanup();}
});

test("a finished capsule does not absorb later branch commits",()=>{
  const item=fixture();try{
    writeFileSync(join(item.directory,"app.ts"),"export const value = 4;\n");checkpointRun(item.runId,"Set value to four","codex",null);
    workspaces.finishAgentRun(item.runId,"done");releaseChangeCapture(item.runId);
    writeFileSync(join(item.directory,"later.ts"),"export const later = true;\n");item.command("add","later.ts");item.command("commit","-qm","Later human change");
    const detail=runChangeDetail(item.runId);assert.equal(detail.commitCount,1);assert.equal(detail.files.length,1);assert.equal(detail.files[0]?.path,"app.ts");
  }finally{item.cleanup();}
});

test("a writable run refuses an ambiguous dirty baseline",()=>{
  const directory=mkdtempSync(join(tmpdir(),"agent-dirty-"));try{
    execFileSync("git",["init","-q"],{cwd:directory});execFileSync("git",["config","user.name","Fixture"],{cwd:directory});execFileSync("git",["config","user.email","fixture@example.test"],{cwd:directory});
    writeFileSync(join(directory,"file.txt"),"one\n");execFileSync("git",["add","file.txt"],{cwd:directory});execFileSync("git",["commit","-qm","Initial"],{cwd:directory});writeFileSync(join(directory,"file.txt"),"dirty\n");
    assert.throws(()=>prepareChangeCapture(directory),(error:unknown)=>(error as {code?:string}).code==="git_worktree_dirty");
  }finally{rmSync(directory,{recursive:true,force:true});}
});
