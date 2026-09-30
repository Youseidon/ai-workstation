"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { RunChangeDetail, RunChangeSummary, RunFileDiff } from "@agent-console/shared";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import { SERVER_URL } from "@/lib/serverUrl";
import { useWorkspace } from "@/lib/workspaceContext";
import { workspaceApi } from "@/lib/workspacesApi";

function shortSha(value:string|null):string { return value?.slice(0,8)??"—"; }
function totals(change:Pick<RunChangeSummary,"filesChanged"|"additions"|"deletions">):string {
  return `${change.filesChanged} ${change.filesChanged===1?"file":"files"} · +${change.additions} −${change.deletions}`;
}

export function ChangesIndex() {
  const {workspaceId}=useWorkspace();const [items,setItems]=useState<RunChangeSummary[]|null>(null);const [error,setError]=useState<string|null>(null);
  useEffect(()=>{if(workspaceId===null){setItems([]);return;}let cancelled=false;void workspaceApi.changes(SERVER_URL,workspaceId).then(value=>{if(!cancelled){setItems(value);setError(null);}}).catch((reason:unknown)=>{if(!cancelled)setError(reason instanceof Error?reason.message:"Changes could not be loaded.");});return()=>{cancelled=true;};},[workspaceId]);
  if(workspaceId===null)return <Empty text="Choose a workspace to browse agent changes."/>;
  if(error!==null)return <Empty text={error}/>;
  if(items===null)return <div className="space-y-3 p-5"><Skeleton className="h-24 w-full"/><Skeleton className="h-24 w-full"/></div>;
  if(items.length===0)return <Empty text="No agent change capsules have been captured in this workspace yet."/>;
  return <div className="mx-auto w-full max-w-5xl space-y-3 p-5">
    <div className="mb-5"><h1 className="text-2xl text-fg">Agent changes</h1><p className="mt-1 text-sm text-fg-muted">Every committed checkpoint, tied back to the run that produced it.</p></div>
    {items.map(item=><Link key={item.runId} href={`/changes/${encodeURIComponent(item.runId)}`} className="block rounded-panel border border-line bg-surface-1 p-4 transition-colors hover:border-line-strong hover:bg-surface-2">
      <div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><div className="font-mono text-xs text-fg-dim">{item.runId}</div><div className="mt-1 text-sm text-fg">{item.message??(item.state==="UNCHANGED"?"No source changes":"Change capture in progress")}</div><div className="mt-2 text-xs text-fg-muted">{item.branch??"detached HEAD"} · {shortSha(item.baseCommit)} → {shortSha(item.headCommit)}</div></div><div className="flex items-center gap-2"><Badge tone={item.state==="COMMITTED"?"success":item.state==="NEEDS_COMMIT"?"warning":"neutral"}>{item.state.toLowerCase().replaceAll("_"," ")}</Badge><span className="numeric text-xs text-fg-muted">{totals(item)}</span></div></div>
    </Link>)}
  </div>;
}

export function ChangeReview({runId}:{runId:string}) {
  const [detail,setDetail]=useState<RunChangeDetail|null>(null);const [error,setError]=useState<string|null>(null);const [selected,setSelected]=useState<string|null>(null);const [diff,setDiff]=useState<RunFileDiff|null>(null);const [diffError,setDiffError]=useState<string|null>(null);const [mode,setMode]=useState<"unified"|"split">("unified");
  useEffect(()=>{let cancelled=false;void workspaceApi.runChanges(SERVER_URL,runId).then(value=>{if(cancelled)return;setDetail(value);setSelected(value.files[0]?.path??null);}).catch((reason:unknown)=>{if(!cancelled)setError(reason instanceof Error?reason.message:"Changes could not be loaded.");});return()=>{cancelled=true;};},[runId]);
  useEffect(()=>{if(selected===null){setDiff(null);return;}let cancelled=false;setDiff(null);setDiffError(null);void workspaceApi.runFileDiff(SERVER_URL,runId,selected).then(value=>{if(!cancelled)setDiff(value);}).catch((reason:unknown)=>{if(!cancelled)setDiffError(reason instanceof Error?reason.message:"Diff could not be loaded.");});return()=>{cancelled=true;};},[runId,selected]);
  const selectedFile=detail?.files.find(file=>file.path===selected)??null;
  if(error!==null)return <Empty text={error}/>;if(detail===null)return <div className="p-5"><Skeleton className="h-[70vh] w-full"/></div>;
  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="border-b border-line bg-surface-1 px-5 py-4"><div className="flex flex-wrap items-start gap-4"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><Link href="/changes" className="text-xs text-fg-dim hover:text-fg">Changes</Link><span className="text-fg-dim">/</span><span className="font-mono text-xs text-fg-muted">{runId}</span></div><h1 className="mt-2 text-xl text-fg">{detail.message??(detail.state==="UNCHANGED"?"No source changes":"Agent change review")}</h1><div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-fg-muted"><Badge tone={detail.state==="COMMITTED"?"success":detail.state==="NEEDS_COMMIT"?"warning":"neutral"}>{detail.state.toLowerCase().replaceAll("_"," ")}</Badge><span>{detail.branch??"detached HEAD"}</span><code>{shortSha(detail.baseCommit)}</code><span>→</span><code>{shortSha(detail.headCommit)}</code><span>{totals(detail)}</span></div></div><div className="flex gap-1 rounded-md border border-line bg-surface-2 p-1"><button className={cn("rounded px-2 py-1 text-xs",mode==="unified"?"bg-surface-4 text-fg":"text-fg-dim")} onClick={()=>setMode("unified")}>Unified</button><button className={cn("rounded px-2 py-1 text-xs",mode==="split"?"bg-surface-4 text-fg":"text-fg-dim")} onClick={()=>setMode("split")}>Split</button></div></div></header>
    <div className="grid min-h-0 flex-1 grid-rows-[minmax(180px,35vh)_minmax(0,1fr)] lg:grid-cols-[320px_minmax(0,1fr)] lg:grid-rows-1"><aside className="min-h-0 overflow-y-auto border-b border-line bg-surface-1 p-3 lg:border-r lg:border-b-0"><div className="mb-2 px-2 text-[10px] uppercase tracking-wider text-fg-dim">Changed files</div>{detail.files.length===0?<p className="px-2 text-sm text-fg-dim">This run did not change tracked source.</p>:detail.files.map(file=><button key={file.path} onClick={()=>setSelected(file.path)} className={cn("mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs",selected===file.path?"bg-surface-3 text-fg":"text-fg-muted hover:bg-surface-2 hover:text-fg")}><span className="w-4 shrink-0 font-mono uppercase text-accent">{file.status[0]}</span><span className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</span><span className="numeric shrink-0 text-[10px]"><b className="text-success">+{file.additions??"–"}</b> <b className="text-danger">−{file.deletions??"–"}</b></span></button>)}</aside>
      <main className="min-h-0 overflow-auto bg-surface-0">{selectedFile===null?<Empty text="Select a changed file."/>:<><div className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface-1/95 px-4 py-2 backdrop-blur"><span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{selectedFile.path}</span>{selectedFile.previousPath!==null&&<span className="truncate text-[10px] text-fg-dim">from {selectedFile.previousPath}</span>}</div>{diffError!==null?<Empty text={diffError}/>:diff===null?<div className="p-4"><Skeleton className="h-80 w-full"/></div>:<DiffPatch patch={diff.patch} split={mode==="split"}/>}</>}</main>
    </div>
    {detail.commits.length>0&&<footer className="border-t border-line bg-surface-1 px-5 py-2 text-xs text-fg-muted"><span className="mr-3 text-[10px] uppercase tracking-wider text-fg-dim">Commits</span>{detail.commits.map(commit=><span key={commit.sha} className="mr-4"><code>{shortSha(commit.sha)}</code> {commit.subject}</span>)}</footer>}
  </div>;
}

function DiffPatch({patch,split}:{patch:string;split:boolean}) {
  const lines=useMemo(()=>patch.split("\n"),[patch]);
  if(split){const rows:Array<{left:string|null;right:string|null}>=[];for(const line of lines){if(line.startsWith("-")&&!line.startsWith("---"))rows.push({left:line,right:null});else if(line.startsWith("+")&&!line.startsWith("+++")){const last=rows.at(-1);if(last?.right===null)last.right=line;else rows.push({left:null,right:line});}else rows.push({left:line,right:line});}return <div className="grid min-w-[900px] grid-cols-2 font-mono text-[12px] leading-5">{rows.flatMap((row,index)=>[<DiffLine key={`l${index}`} line={row.left??""}/>,<DiffLine key={`r${index}`} line={row.right??""}/>])}</div>;}
  return <pre className="min-w-max p-3 font-mono text-[12px] leading-5">{lines.map((line,index)=><DiffLine key={index} line={line}/>)}</pre>;
}
function DiffLine({line}:{line:string}) {const tone=line.startsWith("+")&&!line.startsWith("+++")?"bg-success/10 text-success":line.startsWith("-")&&!line.startsWith("---")?"bg-danger/10 text-danger":line.startsWith("@@")?"bg-accent/10 text-accent":"text-fg-muted";return <span className={cn("block min-h-5 whitespace-pre px-2",tone)}>{line||" "}</span>;}
function Empty({text}:{text:string}) {return <div className="flex min-h-[40vh] items-center justify-center p-6 text-center text-sm text-fg-dim">{text}</div>;}
