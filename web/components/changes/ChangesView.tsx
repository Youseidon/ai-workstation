"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { RunChangeDetail, RunChangeState, RunChangeSummary, RunFileDiff } from "@agent-console/shared";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import { SERVER_URL } from "@/lib/serverUrl";
import { useWorkspace } from "@/lib/workspaceContext";
import { workspaceApi } from "@/lib/workspacesApi";

function shortSha(value:string|null):string { return value?.slice(0,8)??"—"; }
function fileCount(count:number):string { return `${count} ${count===1?"file":"files"}`; }
function stateTone(state:RunChangeState):Tone { return state==="COMMITTED"?"success":state==="NEEDS_COMMIT"?"warning":"neutral"; }
function stateLabel(state:RunChangeState):string { return state.toLowerCase().replaceAll("_"," "); }
function activityHref(runId:string):string { return `/activity?run=${encodeURIComponent(runId)}`; }
function timeAgo(iso:string):string {
  const minutes=Math.floor((Date.now()-new Date(iso).getTime())/60000);
  if(minutes<1)return "just now";if(minutes<60)return `${minutes}m ago`;
  const hours=Math.floor(minutes/60);if(hours<24)return `${hours}h ago`;
  const days=Math.floor(hours/24);return days<7?`${days}d ago`:new Date(iso).toLocaleDateString();
}

const ACTION="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs text-fg-muted ring-1 ring-inset ring-line transition-colors hover:bg-surface-3 hover:text-fg hover:ring-line-strong";
const ACTION_PRIMARY="inline-flex h-7 items-center gap-1.5 rounded-md bg-accent/15 px-2.5 text-xs font-medium text-accent ring-1 ring-inset ring-accent/40 transition-colors hover:bg-accent/25 hover:ring-accent/60";

function BranchIcon() {
  return <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="4.5" cy="3.5" r="1.75"/><circle cx="4.5" cy="12.5" r="1.75"/><circle cx="11.5" cy="5.5" r="1.75"/><path d="M4.5 5.25v5.5M11.5 7.25c0 2.5-3 2.25-7 3.5"/></svg>;
}

/** The branch the run was on when capture began — where its commits landed. */
function BranchChip({branch,className}:{branch:string|null;className?:string}) {
  return <span title={branch===null?"The run committed on a detached HEAD, not a branch":`Commits were made to ${branch}`} className={cn("inline-flex min-w-0 max-w-full items-center gap-1 rounded-md bg-surface-3 px-1.5 py-0.5 font-mono text-[11px] ring-1 ring-inset ring-line",branch===null?"text-warning":"text-fg",className)}><BranchIcon/><span className="truncate">{branch??"detached HEAD"}</span></span>;
}

function DiffStat({change}:{change:Pick<RunChangeSummary,"filesChanged"|"additions"|"deletions">}) {
  return <span className="numeric whitespace-nowrap text-xs text-fg-muted">{fileCount(change.filesChanged)} <span className="text-success">+{change.additions}</span> <span className="text-danger">−{change.deletions}</span></span>;
}

export function ChangesIndex() {
  const {workspaceId}=useWorkspace();const [items,setItems]=useState<RunChangeSummary[]|null>(null);const [error,setError]=useState<string|null>(null);const [query,setQuery]=useState("");
  useEffect(()=>{if(workspaceId===null){setItems([]);return;}let cancelled=false;void workspaceApi.changes(SERVER_URL,workspaceId).then(value=>{if(!cancelled){setItems(value);setError(null);}}).catch((reason:unknown)=>{if(!cancelled)setError(reason instanceof Error?reason.message:"Changes could not be loaded.");});return()=>{cancelled=true;};},[workspaceId]);
  const visible=useMemo(()=>{
    const needle=query.trim().toLowerCase();if(items===null||needle==="")return items??[];
    return items.filter(item=>[item.promptTitle,item.message,item.branch,item.pipeline?.name,item.headCommit].some(value=>value?.toLowerCase().includes(needle)));
  },[items,query]);
  if(workspaceId===null)return <Empty text="Choose a workspace to browse agent changes."/>;
  if(error!==null)return <Empty text={error}/>;
  if(items===null)return <div className="space-y-3 p-5"><Skeleton className="h-24 w-full"/><Skeleton className="h-24 w-full"/></div>;
  if(items.length===0)return <Empty text="No agent source changes have been captured in this workspace yet."/>;
  return <div className="mx-auto w-full max-w-5xl p-5">
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-1"><h1 className="text-2xl text-fg">Agent changes</h1><p className="mt-1 text-sm text-fg-muted">Every committed checkpoint, tied back to the run that produced it.</p></div>
      <input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Filter by title, branch, pipeline…" aria-label="Filter changes" className="h-9 w-full rounded-md bg-surface-2 px-3 text-[13px] text-fg ring-1 ring-inset ring-line placeholder:text-fg-dim focus:outline-none focus:ring-accent/60 sm:w-72"/>
    </div>
    {visible.length===0?<p className="rounded-panel border border-dashed border-line p-8 text-center text-sm text-fg-dim">No changes match “{query.trim()}”.</p>:<ul className="space-y-2">
      {visible.map(item=>{
        const detailHref=`/changes/${encodeURIComponent(item.runId)}`;
        return <li key={item.runId} className="group relative rounded-panel border border-line bg-surface-1 p-4 transition-colors hover:border-line-strong hover:bg-surface-2 focus-within:border-accent/60">
          <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
            {/* The title link is stretched over the whole card; the actions below sit above it. */}
            <Link href={detailHref} className="min-w-0 flex-1 text-sm font-medium text-fg outline-none after:absolute after:inset-0 after:rounded-panel group-hover:text-accent">{item.promptTitle}</Link>
            <Badge tone={stateTone(item.state)}>{stateLabel(item.state)}</Badge>
            <time dateTime={item.updatedAt} title={new Date(item.updatedAt).toLocaleString()} className="whitespace-nowrap text-xs text-fg-dim">{timeAgo(item.updatedAt)}</time>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-fg-muted">{item.message??"Change capture in progress"}</p>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <BranchChip branch={item.branch}/>
            <span className="font-mono text-[11px] text-fg-dim">{shortSha(item.baseCommit)} → {shortSha(item.headCommit)}</span>
            <DiffStat change={item}/>
            {item.commitCount>0&&<span className="text-xs text-fg-dim">{item.commitCount} {item.commitCount===1?"commit":"commits"}</span>}
            <div className="relative z-10 ml-auto flex flex-wrap items-center gap-2">
              <Link href={activityHref(item.runId)} className={ACTION} title="Open the run that produced these changes">Activity</Link>
              {item.pipeline!==null&&<Link href={`/pipeline/${item.pipeline.id}`} className={cn(ACTION,"max-w-[14rem]")} title={`Open pipeline: ${item.pipeline.name}`}><span className="text-fg-dim">Pipeline</span><span className="truncate">{item.pipeline.name}</span></Link>}
              <Link href={detailHref} className={ACTION_PRIMARY}>View details<span aria-hidden>→</span></Link>
            </div>
          </div>
        </li>;
      })}
    </ul>}
  </div>;
}

export function ChangeReview({runId}:{runId:string}) {
  const [detail,setDetail]=useState<RunChangeDetail|null>(null);const [error,setError]=useState<string|null>(null);const [selected,setSelected]=useState<string|null>(null);const [diff,setDiff]=useState<RunFileDiff|null>(null);const [diffError,setDiffError]=useState<string|null>(null);const [mode,setMode]=useState<"unified"|"split">("unified");
  useEffect(()=>{let cancelled=false;void workspaceApi.runChanges(SERVER_URL,runId).then(value=>{if(cancelled)return;setDetail(value);setSelected(value.files[0]?.path??null);}).catch((reason:unknown)=>{if(!cancelled)setError(reason instanceof Error?reason.message:"Changes could not be loaded.");});return()=>{cancelled=true;};},[runId]);
  useEffect(()=>{if(selected===null){setDiff(null);return;}let cancelled=false;setDiff(null);setDiffError(null);void workspaceApi.runFileDiff(SERVER_URL,runId,selected).then(value=>{if(!cancelled)setDiff(value);}).catch((reason:unknown)=>{if(!cancelled)setDiffError(reason instanceof Error?reason.message:"Diff could not be loaded.");});return()=>{cancelled=true;};},[runId,selected]);
  const selectedFile=detail?.files.find(file=>file.path===selected)??null;
  if(error!==null)return <Empty text={error}/>;if(detail===null)return <div className="p-5"><Skeleton className="h-[70vh] w-full"/></div>;
  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="border-b border-line bg-surface-1 px-5 py-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 text-xs"><Link href="/changes" className="text-fg-dim hover:text-fg">Changes</Link><span className="text-fg-dim">/</span><span className="truncate text-fg-muted" title={runId}>{detail.promptTitle}</span></div>
          <h1 className="mt-2 text-xl text-fg">{detail.message??(detail.state==="UNCHANGED"?"No source changes":"Agent change review")}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-fg-muted">
            <Badge tone={stateTone(detail.state)}>{stateLabel(detail.state)}</Badge>
            <span className="inline-flex min-w-0 items-center gap-1.5"><span className="text-fg-dim">{detail.commitCount===1?"1 commit to":`${detail.commitCount} commits to`}</span><BranchChip branch={detail.branch} className="text-xs"/></span>
            <span className="font-mono text-[11px] text-fg-dim">{shortSha(detail.baseCommit)} → {shortSha(detail.headCommit)}</span>
            <DiffStat change={detail}/>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={activityHref(runId)} className={ACTION} title="Open the run that produced these changes">Activity</Link>
          {detail.pipeline!==null&&<Link href={`/pipeline/${detail.pipeline.id}`} className={cn(ACTION,"max-w-[14rem]")} title={`Open pipeline: ${detail.pipeline.name}`}><span className="text-fg-dim">Pipeline</span><span className="truncate">{detail.pipeline.name}</span></Link>}
          <div className="flex gap-1 rounded-md border border-line bg-surface-2 p-1"><button className={cn("rounded px-2 py-1 text-xs",mode==="unified"?"bg-surface-4 text-fg":"text-fg-dim")} onClick={()=>setMode("unified")}>Unified</button><button className={cn("rounded px-2 py-1 text-xs",mode==="split"?"bg-surface-4 text-fg":"text-fg-dim")} onClick={()=>setMode("split")}>Split</button></div>
        </div>
      </div>
    </header>
    <div className="grid min-h-0 flex-1 grid-rows-[minmax(180px,35vh)_minmax(0,1fr)] lg:grid-cols-[320px_minmax(0,1fr)] lg:grid-rows-1"><aside className="min-h-0 overflow-y-auto border-b border-line bg-surface-1 p-3 lg:border-r lg:border-b-0"><div className="mb-2 px-2 text-[10px] uppercase tracking-wider text-fg-dim">Changed files</div>{detail.files.length===0?<p className="px-2 text-sm text-fg-dim">This run did not change tracked source.</p>:detail.files.map(file=><button key={file.path} onClick={()=>setSelected(file.path)} className={cn("mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs",selected===file.path?"bg-surface-3 text-fg":"text-fg-muted hover:bg-surface-2 hover:text-fg")}><span className="w-4 shrink-0 font-mono uppercase text-accent">{file.status[0]}</span><span className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</span><span className="numeric shrink-0 text-[10px]"><b className="text-success">+{file.additions??"–"}</b> <b className="text-danger">−{file.deletions??"–"}</b></span></button>)}</aside>
      <main className="min-h-0 overflow-auto bg-surface-0">{selectedFile===null?<Empty text="Select a changed file."/>:<><div className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface-1/95 px-4 py-2 backdrop-blur"><span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{selectedFile.path}</span>{selectedFile.previousPath!==null&&<span className="truncate text-[10px] text-fg-dim">from {selectedFile.previousPath}</span>}</div>{diffError!==null?<Empty text={diffError}/>:diff===null?<div className="p-4"><Skeleton className="h-80 w-full"/></div>:<DiffPatch patch={diff.patch} split={mode==="split"}/>}</>}</main>
    </div>
    {detail.commits.length>0&&<footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-surface-1 px-5 py-2 text-xs text-fg-muted"><span className="text-[10px] uppercase tracking-wider text-fg-dim">Commits on</span><BranchChip branch={detail.branch}/>{detail.commits.map(commit=><span key={commit.sha} title={`${commit.author} · ${new Date(commit.authoredAt).toLocaleString()}`}><code>{shortSha(commit.sha)}</code> {commit.subject}</span>)}</footer>}
  </div>;
}

function DiffPatch({patch,split}:{patch:string;split:boolean}) {
  const lines=useMemo(()=>patch.split("\n"),[patch]);
  if(split){const rows:Array<{left:string|null;right:string|null}>=[];for(const line of lines){if(line.startsWith("-")&&!line.startsWith("---"))rows.push({left:line,right:null});else if(line.startsWith("+")&&!line.startsWith("+++")){const last=rows.at(-1);if(last?.right===null)last.right=line;else rows.push({left:null,right:line});}else rows.push({left:line,right:line});}return <div className="grid min-w-[900px] grid-cols-2 font-mono text-[12px] leading-5">{rows.flatMap((row,index)=>[<DiffLine key={`l${index}`} line={row.left??""}/>,<DiffLine key={`r${index}`} line={row.right??""}/>])}</div>;}
  return <pre className="min-w-max p-3 font-mono text-[12px] leading-5">{lines.map((line,index)=><DiffLine key={index} line={line}/>)}</pre>;
}
function DiffLine({line}:{line:string}) {const tone=line.startsWith("+")&&!line.startsWith("+++")?"bg-success/10 text-success":line.startsWith("-")&&!line.startsWith("---")?"bg-danger/10 text-danger":line.startsWith("@@")?"bg-accent/10 text-accent":"text-fg-muted";return <span className={cn("block min-h-5 whitespace-pre px-2",tone)}>{line||" "}</span>;}
function Empty({text}:{text:string}) {return <div className="flex min-h-[40vh] items-center justify-center p-6 text-center text-sm text-fg-dim">{text}</div>;}
