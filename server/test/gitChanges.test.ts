import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertRunChangesCommitted, checkpointRun, prepareChangeCapture, refreshChangeCapture, releaseChangeCapture, runChangeDetail, runFileDiff } from "../src/gitChanges.ts";
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
    assert.deepEqual(workspaces.runChangeSets(item.workspace.id),[]);
    writeFileSync(join(item.directory,"app.ts"),"export const value = 2;\n");
    const summary=checkpointRun(item.runId,"Update exported value","codex",null);
    assert.equal(summary.state,"COMMITTED");assert.equal(summary.filesChanged,1);assert.equal(summary.commitCount,1);
    assert.equal(summary.promptTitle,"Change source");
    assert.deepEqual(workspaces.runChangeSets(item.workspace.id).map(change=>change.runId),[item.runId]);
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

/*
 * The lock-out this guards against: a run's provider ran out of allowance
 * mid-work, its wrap-up died the same way, and the edits it left made every
 * later start — fallback provider, Resume, Retry — fail as a dirty baseline.
 */
test("work an interrupted run left uncommitted is checkpointed under its name",()=>{
  const item=fixture();try{
    writeFileSync(join(item.directory,"app.ts"),"export const value = 5;\n");writeFileSync(join(item.directory,"new.ts"),"export const added = true;\n");
    assert.equal(refreshChangeCapture(item.runId).state,"NEEDS_COMMIT");
    workspaces.finishAgentRun(item.runId,"error");releaseChangeCapture(item.runId);
    const next=`${item.runId}-next`;
    const capture=prepareChangeCapture(item.directory,next);releaseChangeCapture(next);
    assert.equal(item.command("status","--porcelain").trim(),"");
    assert.equal(capture.baseCommit,item.command("rev-parse","HEAD").trim());
    assert.match(item.command("log","-1","--format=%s%n%b"),new RegExp(`interrupted run[\\s\\S]*Agent-Run: ${item.runId}[\\s\\S]*Agent-Checkpoint: orchestrator`));
    const left=workspaces.runChangeSet(item.runId)!;
    assert.equal(left.state,"COMMITTED");assert.equal(left.filesChanged,2);assert.equal(left.commitCount,1);
  }finally{item.cleanup();}
});

test("a run the process died under leaves work the next start can take over",()=>{
  const item=fixture();try{
    // Checkpointed once, then killed with more edits on disk: the capsule was
    // never reconciled, so it is still PENDING and HEAD has moved past its base.
    writeFileSync(join(item.directory,"app.ts"),"export const value = 6;\n");item.command("commit","-qam","Agent checkpoint");
    writeFileSync(join(item.directory,"app.ts"),"export const value = 7;\n");
    workspaces.finishAgentRun(item.runId,"interrupted");releaseChangeCapture(item.runId);
    assert.doesNotThrow(()=>prepareChangeCapture(item.directory));
    const left=workspaces.runChangeSet(item.runId)!;
    assert.equal(left.state,"COMMITTED");assert.equal(left.commitCount,2);
  }finally{item.cleanup();}
});

test("changes nobody's run accounts for are still refused",()=>{
  const item=fixture();try{
    // The run ended clean, so what is in the tree afterwards is not its work.
    assert.equal(refreshChangeCapture(item.runId).state,"UNCHANGED");
    workspaces.finishAgentRun(item.runId,"done");releaseChangeCapture(item.runId);
    writeFileSync(join(item.directory,"app.ts"),"export const value = 8;\n");
    assert.throws(()=>prepareChangeCapture(item.directory),(error:unknown)=>(error as {code?:string}).code==="git_worktree_dirty");
    assert.match(item.command("log","-1","--format=%s"),/Initial source/);
  }finally{item.cleanup();}
});

test("leftover work is not taken over once someone has committed on top of it",()=>{
  const item=fixture();try{
    writeFileSync(join(item.directory,"app.ts"),"export const value = 9;\n");
    assert.equal(refreshChangeCapture(item.runId).state,"NEEDS_COMMIT");
    workspaces.finishAgentRun(item.runId,"error");releaseChangeCapture(item.runId);
    item.command("commit","-qam","Human commit");writeFileSync(join(item.directory,"app.ts"),"export const value = 10;\n");
    assert.throws(()=>prepareChangeCapture(item.directory),(error:unknown)=>(error as {code?:string}).code==="git_worktree_dirty");
  }finally{item.cleanup();}
});

test("a live writer's uncommitted work is never taken over",()=>{
  const item=fixture();try{
    writeFileSync(join(item.directory,"app.ts"),"export const value = 11;\n");
    assert.throws(()=>prepareChangeCapture(item.directory,`${item.runId}-other`),(error:unknown)=>(error as {code?:string}).code==="git_repository_busy");
    // Even with the in-memory claim gone, a run still marked active keeps its tree.
    releaseChangeCapture(item.runId);
    assert.throws(()=>prepareChangeCapture(item.directory),(error:unknown)=>(error as {code?:string}).code==="git_worktree_dirty");
    assert.match(item.command("log","-1","--format=%s"),/Initial source/);
  }finally{releaseChangeCapture(item.runId);item.cleanup();}
});
