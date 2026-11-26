"use client";

import { userSessionStorage } from "@/lib/identityStorage";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LogItem } from "@/features/runs/lib/log";
import { conversationProgress, conversationTurns, type LiveConversationRun } from "@/features/chat/lib/conversation";
import { workspaceApi } from "@/api/workspacesApi";
import { SERVER_URL } from "@/api/serverUrl";
import { LogPanel } from "@/features/runs/components/LogPanel";
import { Menu } from "@/components/ui/Menu";
import { ConversationExchange, type PendingConversationTurn } from "./ConversationExchange";

interface ReadingAnchor { id: string; offset: number; top: number; following: boolean; tail?: string }
function readSaved(key:string): ReadingAnchor | null {
  try { const saved=JSON.parse(userSessionStorage.getItem(`chat-anchor:${key}`) ?? "null"); return saved && typeof saved.id === "string" && Number.isFinite(saved.offset) && Number.isFinite(saved.top) ? saved : null; } catch { return null; }
}

export function ConversationPanel({ items, workdir, storageKey, workspaceId, pending, pendingTurn, liveRuns = [], disconnected = false, footer, onQuote,
  active = true, hasEarlier = false, historyLoading = false, historyError, onLoadEarlier, onRead }: {
  items: LogItem[]; workdir: string | null; storageKey: string; workspaceId?: number; pending?: ReactNode; pendingTurn?: PendingConversationTurn;
  liveRuns?: LiveConversationRun[]; disconnected?: boolean; footer?: ReactNode; onQuote?(text: string): void;
  active?: boolean; hasEarlier?: boolean; historyLoading?: boolean; historyError?: string | null; onLoadEarlier?():void; onRead?(timestamp:string):void;
}) {
  const turns = useMemo(() => conversationTurns(items), [items]);
  const [changes,setChanges] = useState<string[]>([]);
  const completions = items.filter(item => item.kind === "result").length;
  useEffect(() => {
    if(workspaceId === undefined || !active) return;
    let disposed=false;
    void workspaceApi.changes(SERVER_URL,workspaceId).then(rows => { if(!disposed) setChanges(rows.filter(row => row.filesChanged > 0).map(row => row.runId)); }).catch(() => {});
    return () => { disposed=true; };
  },[workspaceId,completions,active]);
  const [log,setLog] = useState(false);
  const [wide,setWide] = useState(false);
  const [outline,setOutline] = useState(false);
  const [pinned,setPinned] = useState(true);
  const [unread,setUnread] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const anchor = useRef<ReadingAnchor | null>(null);
  const restored = useRef(false);
  const following = useRef(true);
  const lastSubmission = useRef<string | undefined>(undefined);
  const latest=turns.at(-1);
  const tail=latest?.blocks.filter(item => item.kind === "text" && item.textKind === "message" || item.kind === "decision" || item.kind === "error").at(-1) ?? latest?.prompt;
  const fingerprint = tail ? `${tail.eventIds?.at(-1) ?? tail.id}:${tail.kind === "text" ? tail.text.length : tail.timestamp}:${latest?.result?.state ?? ""}` : "";
  const readTimestamp=latest?.result?.timestamp ?? tail?.timestamp;
  const previousTail = useRef(fingerprint);
  const acknowledgedTail=useRef(fingerprint);
  const capture = useCallback(() => {
    const el=container.current;
    if(!el || !active || log) return;
    const top=el.getBoundingClientRect().top;
    const visible=[...el.querySelectorAll<HTMLElement>("[data-reading-anchor]")].find(node => node.getBoundingClientRect().bottom > top + 8);
    if(following.current) acknowledgedTail.current=fingerprint;
    anchor.current={id:visible?.id ?? "",offset:visible ? visible.getBoundingClientRect().top-top : 0,top:el.scrollTop,following:following.current,tail:acknowledgedTail.current};
    try { userSessionStorage.setItem(`chat-anchor:${storageKey}`,JSON.stringify(anchor.current)); } catch { /* storage is optional */ }
  },[storageKey,active,log,fingerprint]);
  const restore = useCallback(() => {
    const el=container.current;
    if(!el || !active || log) return;
    if(following.current) { el.scrollTop=el.scrollHeight; return; }
    const saved=anchor.current;
    if(!saved) return;
    const target=saved.id ? document.getElementById(saved.id) : null;
    if(target && el.contains(target)) el.scrollTop+=target.getBoundingClientRect().top-el.getBoundingClientRect().top-saved.offset;
    else el.scrollTop=saved.top;
  },[active,log]);
  useEffect(() => {
    const timer=setTimeout(() => { try { setWide(userSessionStorage.getItem(`chat-width:${storageKey}`) === "wide"); } catch { /* optional */ } },0);
    return () => clearTimeout(timer);
  },[storageKey]);
  useLayoutEffect(() => {
    if(!active || log) return;
    let restoredUnread=false;
    if(!restored.current && (items.length > 0 || pendingTurn)) {
      restored.current=true;
      const saved=readSaved(storageKey);
      if(saved) {
        anchor.current=saved; following.current=saved.following;
        acknowledgedTail.current=saved.tail ?? fingerprint;
        restoredUnread=!!saved.tail && saved.tail !== fingerprint;
      }
      previousTail.current=fingerprint;
    }
    if(pendingTurn?.id && pendingTurn.id !== lastSubmission.current) { lastSubmission.current=pendingTurn.id; following.current=true; }
    if(following.current) acknowledgedTail.current=fingerprint;
    restore();
    const frame=requestAnimationFrame(() => { setPinned(following.current); if(following.current) setUnread(false); else if(restoredUnread) setUnread(true); });
    return () => cancelAnimationFrame(frame);
  },[items,pendingTurn,storageKey,active,log,wide,restore,fingerprint]);
  useEffect(() => {
    if(previousTail.current !== fingerprint && !following.current) setUnread(true);
    previousTail.current=fingerprint;
  },[fingerprint]);
  useEffect(() => {
    const saved=anchor.current;
    if(active && !log && saved?.id && !following.current && !document.getElementById(saved.id) && hasEarlier && !historyLoading && !historyError) onLoadEarlier?.();
  },[active,log,items,hasEarlier,historyLoading,historyError,onLoadEarlier]);
  useEffect(() => {
    const el=container.current, body=content.current;
    if(!el || !body || !active || log) return;
    const observer=new ResizeObserver(() => { restore(); });
    observer.observe(el); observer.observe(body);
    return () => observer.disconnect();
  },[active,log,restore]);
  useEffect(() => {
    if(!active || !pinned || log || !onRead) return;
    const timestamp=readTimestamp;
    if(!timestamp) return;
    const timer=setTimeout(() => { if(following.current && document.visibilityState === "visible") onRead(timestamp); },600);
    return () => clearTimeout(timer);
  },[active,pinned,log,readTimestamp,onRead]);

  return <div className="chat-workspace relative flex min-h-0 min-w-0 flex-1 flex-col font-sans text-fg" data-width={wide ? "wide" : "reading"}>
    <div className="chat-view-actions">
      {log && <button type="button" className="chat-text-button" onClick={() => setLog(false)}>← Conversation</button>}
      <Menu label="Conversation options" items={[
        {id:"log",label:log ? "Show conversation" : "Execution log",onSelect:() => { capture(); setLog(!log); }},
        {id:"width",label:wide ? "Comfortable width" : "Wider conversation",onSelect:() => { capture(); setWide(!wide); try { userSessionStorage.setItem(`chat-width:${storageKey}`,wide ? "reading" : "wide"); } catch { /* optional */ } }},
        ...(turns.length >= 6 ? [{id:"outline",label:"Jump to a message",onSelect:() => setOutline(!outline)}] : []),
      ]} />
    </div>
    {outline && <nav className="chat-outline" aria-label="Conversation outline"><div className="flex items-center justify-between gap-3"><span>Jump to a message</span><button type="button" className="app-icon-button" aria-label="Close conversation outline" onClick={() => setOutline(false)}>×</button></div>{turns.map((turn,index) => <button key={turn.id} type="button" onClick={() => {
      following.current=false; setPinned(false); setOutline(false);
      const node=document.getElementById(`prompt-${turn.id}`) ?? document.getElementById(`turn-${turn.id}`);
      node?.scrollIntoView({block:"start"}); node?.focus({preventScroll:true}); capture();
    }}>{index+1}. {turn.prompt?.text.replace(/\s+/g," ").slice(0,100) ?? "Recorded reply"}</button>)}</nav>}
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className={log ? "chat-canvas flex min-h-0 flex-1 px-2 pt-14 sm:px-4" : "hidden"}><LogPanel items={items} workdir={workdir} /></div>
      <div ref={container} className={log ? "hidden" : "chat-scroll"} aria-label="Chat messages" tabIndex={0} onScroll={() => {
        const el=container.current!;
        following.current=el.scrollHeight-el.scrollTop-el.clientHeight < 48;
        setPinned(following.current);
        if(following.current) setUnread(false);
        capture();
      }}>
        <div ref={content} className="chat-canvas chat-turns">
          {hasEarlier && <button type="button" className="chat-load-earlier" disabled={historyLoading} onClick={() => { capture(); following.current=false; setPinned(false); onLoadEarlier?.(); }}>{historyLoading ? "Loading earlier messages…" : "Load earlier messages"}</button>}
          {historyError && <p role="alert" className="text-sm text-danger">{historyError}</p>}
          {turns.map((turn,index) => {
            const live=liveRuns.find(run => run.runId === turn.id);
            const progress=disconnected && !turn.result && index === turns.length-1
              ? {phase:"disconnected" as const,label:"Reconnecting",active:false} : conversationProgress(turn,live);
            return <ConversationExchange key={turn.id} turn={turn} number={index+1} progress={progress} hasChanges={changes.includes(turn.id)} onQuote={onQuote} />;
          })}
          {pendingTurn && <ConversationExchange key={pendingTurn.id} number={turns.length+1}
            turn={{id:pendingTurn.id,blocks:[],attribution:pendingTurn,prompt:{id:pendingTurn.id,runId:pendingTurn.id,kind:"prompt",text:pendingTurn.prompt,provider:pendingTurn.provider,model:pendingTurn.model,timestamp:""}}}
            progress={{phase:"sending",label:"Sending prompt",active:true}} />}
          {pending}
        </div>
      </div>
      {!pinned && !log && <button type="button" className="chat-jump" onClick={() => { following.current=true; setPinned(true); setUnread(false); restore(); }}>{unread ? "New reply · " : ""}Jump to latest ↓</button>}
    </div>
    {footer && <div className="chat-compose-zone"><div className="chat-canvas">{footer}</div></div>}
  </div>;
}
