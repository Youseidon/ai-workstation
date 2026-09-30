import { spawnSync } from "node:child_process";
import type { ProviderId, RunChangeDetail, RunChangedFile, RunCommit, RunFileDiff } from "@agent-console/shared";
import { WorkspaceError, workspaces } from "./workspaces.ts";

const GIT_TIMEOUT_MS = 15_000;
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;

interface GitResult { stdout:string; stderr:string }

function git(cwd:string,args:string[],allowFailure=false):GitResult {
  const result=spawnSync("git",args,{cwd,encoding:"utf8",timeout:GIT_TIMEOUT_MS,maxBuffer:MAX_GIT_OUTPUT});
  const stdout=result.stdout??"";const stderr=result.stderr??"";
  if(result.error!==undefined||result.status!==0){
    if(allowFailure)return{stdout,stderr};
    const detail=(stderr||result.error?.message||`git exited ${result.status}`).trim().slice(0,4000);
    throw new WorkspaceError(409,"git_operation_failed","Git could not complete the agent checkpoint.",undefined,{detail});
  }
  return{stdout,stderr};
}

export interface PreparedChangeCapture { repositoryRoot:string; branch:string|null; baseCommit:string }
const repositoryWriters=new Map<string,string>();

/** Establishes the unambiguous boundary that makes per-run commits truthful. */
export function prepareChangeCapture(cwd:string,runId?:string):PreparedChangeCapture {
  const root=git(cwd,["rev-parse","--show-toplevel"],true);
  if(root.stdout.trim()==="")throw new WorkspaceError(409,"git_repository_required","Writable agent runs require a Git repository.",undefined,{detail:"Initialize Git and create an initial commit before starting a writer. Read-only consults are still available."});
  const repositoryRoot=root.stdout.trim();
  const owner=repositoryWriters.get(repositoryRoot);
  if(runId!==undefined&&owner!==undefined&&owner!==runId)throw new WorkspaceError(409,"git_repository_busy","Another agent is already writing in this Git repository.");
  const head=git(repositoryRoot,["rev-parse","--verify","HEAD"],true).stdout.trim();
  if(head==="")throw new WorkspaceError(409,"git_initial_commit_required","Create the repository's initial commit before starting a writable agent run.");
  const status=git(repositoryRoot,["status","--porcelain=v1","--untracked-files=all"]).stdout.trim();
  if(status!=="")throw new WorkspaceError(409,"git_worktree_dirty","Commit or stash the existing working-tree changes before starting an agent.",undefined,{detail:status.slice(0,8000)});
  const branch=git(repositoryRoot,["symbolic-ref","--quiet","--short","HEAD"],true).stdout.trim()||null;
  if(runId!==undefined)repositoryWriters.set(repositoryRoot,runId);
  return{repositoryRoot,branch,baseCommit:head};
}

export function releaseChangeCapture(runId:string):void {
  for(const [root,owner] of repositoryWriters)if(owner===runId)repositoryWriters.delete(root);
}

function currentHead(root:string):string {
  const value=git(root,["rev-parse","--verify","HEAD"]).stdout.trim();
  if(value==="")throw new WorkspaceError(409,"git_history_missing","The repository no longer has a HEAD commit.");
  return value;
}

function ensureDescendant(root:string,base:string,head:string):void {
  const result=spawnSync("git",["merge-base","--is-ancestor",base,head],{cwd:root,encoding:"utf8",timeout:GIT_TIMEOUT_MS});
  if(result.status!==0)throw new WorkspaceError(409,"git_history_rewritten","The repository no longer descends from this run's starting commit. Restore the branch or resolve the history before finishing the run.");
}

function rangeStats(root:string,base:string,head:string):{filesChanged:number;additions:number;deletions:number;commitCount:number} {
  if(base===head)return{filesChanged:0,additions:0,deletions:0,commitCount:0};
  let filesChanged=0,additions=0,deletions=0;
  for(const line of git(root,["diff","--numstat",`${base}..${head}`,"--"]).stdout.split("\n")){
    if(line==="")continue;const [added,removed]=line.split("\t");filesChanged+=1;
    if(added!=="-")additions+=Number(added)||0;if(removed!=="-")deletions+=Number(removed)||0;
  }
  const commitCount=Number(git(root,["rev-list","--count",`${base}..${head}`]).stdout.trim())||0;
  return{filesChanged,additions,deletions,commitCount};
}

/** Reconciles the durable capsule with the repository as it exists now. */
export function refreshChangeCapture(runId:string) {
  const capture=workspaces.runChangeSet(runId);
  if(capture===null)throw new WorkspaceError(404,"change_set_not_found","This run has no Git change capture record.");
  const head=currentHead(capture.repositoryRoot);ensureDescendant(capture.repositoryRoot,capture.baseCommit,head);
  const dirty=git(capture.repositoryRoot,["status","--porcelain=v1","--untracked-files=all"]).stdout.trim();
  const stats=rangeStats(capture.repositoryRoot,capture.baseCommit,head);
  const state=dirty!==""?"NEEDS_COMMIT":head===capture.baseCommit?"UNCHANGED":"COMMITTED";
  const message=dirty!==""?dirty.slice(0,8000):state==="COMMITTED"?git(capture.repositoryRoot,["log","-1","--format=%s",head]).stdout.trim()||null:null;
  return workspaces.updateRunChangeSet(runId,{headCommit:head,state, ...stats,message});
}

export function assertRunChangesCommitted(runId:string):void {
  const captureId=workspaces.runChangeSet(runId)===null?(workspaces.wrapupSourceRunId(runId)??runId):runId;
  const capture=workspaces.runChangeSet(captureId);
  if(capture===null)return; // legacy and deliberately read-only runs
  const refreshed=refreshChangeCapture(captureId);
  if(refreshed.state==="NEEDS_COMMIT")throw new WorkspaceError(409,"git_commit_required","Checkpoint the working-tree changes before ending this run.",undefined,{detail:refreshed.message});
}

export function checkpointRun(runId:string,message:unknown,provider:ProviderId,model:string|null) {
  if(typeof message!=="string"||message.trim()===""||message.includes("\n")||message.trim().length>72){
    throw new WorkspaceError(422,"checkpoint_message_invalid","Use one meaningful commit subject of 72 characters or fewer.");
  }
  const captureId=workspaces.runChangeSet(runId)===null?(workspaces.wrapupSourceRunId(runId)??runId):runId;
  const capture=workspaces.runChangeSet(captureId);
  if(capture===null)throw new WorkspaceError(409,"change_set_not_found","This run was not opened as a writable Git run.");
  const before=currentHead(capture.repositoryRoot);ensureDescendant(capture.repositoryRoot,capture.baseCommit,before);
  const dirty=git(capture.repositoryRoot,["status","--porcelain=v1","--untracked-files=all"]).stdout.trim();
  if(dirty==="")return refreshChangeCapture(captureId);
  git(capture.repositoryRoot,["add","-A"]);
  const providerLabel=provider[0]!.toUpperCase()+provider.slice(1);
  const body=[`Agent-Run: ${captureId}`,...(captureId===runId?[]:[`Agent-Finalizer-Run: ${runId}`]),`Agent-Provider: ${provider}`,...(model===null?[]:[`Agent-Model: ${model}`])].join("\n");
  git(capture.repositoryRoot,[
    "-c",`user.name=${providerLabel} via Agent Console`,
    "-c","user.email=agent@agent-console.local",
    "commit","-m",message.trim(),"-m",body,
  ]);
  return refreshChangeCapture(captureId);
}

function commits(root:string,base:string,head:string):RunCommit[] {
  if(base===head)return[];
  const out=git(root,["log","--reverse","--format=%H%x1f%s%x1f%an%x1f%aI%x1e",`${base}..${head}`]).stdout;
  return out.split("\x1e").map(row=>row.trim()).filter(Boolean).map(row=>{
    const [sha,subject,author,authoredAt]=row.split("\x1f");return{sha:sha!,subject:subject!,author:author!,authoredAt:authoredAt!};
  });
}

function statusName(code:string):RunChangedFile["status"] {
  if(code.startsWith("A"))return"added";if(code.startsWith("M"))return"modified";if(code.startsWith("D"))return"deleted";
  if(code.startsWith("R"))return"renamed";if(code.startsWith("C"))return"copied";if(code.startsWith("T"))return"type-changed";return"unknown";
}

function changedFiles(root:string,base:string,head:string):RunChangedFile[] {
  if(base===head)return[];
  const numbers=new Map<string,{additions:number|null;deletions:number|null;binary:boolean}>();
  for(const line of git(root,["diff","--numstat",`${base}..${head}`,"--"]).stdout.split("\n")){
    if(line==="")continue;const [a,d,...parts]=line.split("\t");const path=parts.join("\t");
    numbers.set(path,{additions:a==="-"?null:Number(a),deletions:d==="-"?null:Number(d),binary:a==="-"||d==="-"});
  }
  return git(root,["diff","--name-status","--find-renames",`${base}..${head}`,"--"]).stdout.split("\n").filter(Boolean).map(line=>{
    const [code,first,second]=line.split("\t");const renamed=code!.startsWith("R")||code!.startsWith("C");const path=renamed?second!:first!;
    const count=numbers.get(path)??numbers.get(renamed?`${first} => ${second}`:path);
    return{path,previousPath:renamed?first!:null,status:statusName(code!),additions:count?.additions??null,deletions:count?.deletions??null,binary:count?.binary??false};
  });
}

export function runChangeDetail(runId:string):RunChangeDetail {
  const stored=workspaces.runChangeSet(runId);
  if(stored===null)throw new WorkspaceError(404,"change_set_not_found","This run has no Git change capture record.");
  const summary=workspaces.agentRunActive(runId)?refreshChangeCapture(runId):stored;const head=summary.headCommit??summary.baseCommit;
  return{...summary,commits:commits(summary.repositoryRoot,summary.baseCommit,head),files:changedFiles(summary.repositoryRoot,summary.baseCommit,head)};
}

export function runFileDiff(runId:string,path:string):RunFileDiff {
  const detail=runChangeDetail(runId);const file=detail.files.find(entry=>entry.path===path);
  if(file===undefined)throw new WorkspaceError(404,"changed_file_not_found","That file is not part of this run's committed changes.");
  const head=detail.headCommit??detail.baseCommit;
  const raw=git(detail.repositoryRoot,["diff","--no-ext-diff","--unified=4",`${detail.baseCommit}..${head}`,"--",file.previousPath??file.path,file.path]).stdout;
  const truncated=Buffer.byteLength(raw)>MAX_PATCH_BYTES;
  return{runId,path:file.path,previousPath:file.previousPath,patch:truncated?raw.slice(0,MAX_PATCH_BYTES)+"\n… diff truncated by Agent Console\n":raw,truncated};
}
