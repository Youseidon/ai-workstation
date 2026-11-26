"use client";

import { userLocalStorage } from "@/lib/identityStorage";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatThread, ChatThreadPatch, RunSource } from "@hydra/shared";
import { useToast } from "@/components/ui/Toast";
import { useHydra } from "@/hooks/useHydra";
import { useWorkspace } from "@/contexts/workspaceContext";
import { workspaceApi, ApiError } from "@/api/workspacesApi";
import { SERVER_URL } from "@/api/serverUrl";

/**
 * Chat's thread library and open conversations, owned by the shell rather than
 * the `/` route. The sidebar collection and the conversation stage both read
 * this one controller, and leaving Chat does not discard open conversations,
 * queued messages or in-flight acceptance handling.
 */

const STORAGE_KEY = "hydra.chat-tabs.v1";
export interface WorkTab { id: string; workspaceId: number; title: string | null; updatedAt?: string }
export interface ThreadHistory { loaded: boolean; loading: boolean; next: string | null; error: string | null }
export interface ThreadRow extends ChatThread { local?: boolean; status?: string; runId?: string }
interface DeepLink { thread: string | null; prompt: number | null }

const emptyHistory: ThreadHistory = { loaded:false, loading:false, next:null, error:null };

function sourceTitle(source: RunSource) {
  if (source.type === "custom") return source.title ?? source.displayText;
  if (source.type === "consult") return source.title ?? source.question;
  if ("title" in source) return source.title;
  return "Agent conversation";
}

function parseLink(search: string) {
  const params = new URLSearchParams(search);
  const thread = params.get("thread")?.slice(0,200) || null;
  const owner = Number(params.get("workspace"));
  const prompt = Number(params.get("prompt"));
  return { thread, owner:Number.isSafeInteger(owner) && owner > 0 ? owner : null, prompt:Number.isSafeInteger(prompt) && prompt > 0 ? prompt : null, hasWorkspace:params.has("workspace") };
}

export interface ChatController {
  /** True once Chat has been opened in this page session. */
  started: boolean;
  tabs: WorkTab[];
  activeId: string | null;
  activeTab: WorkTab | undefined;
  history: Record<string,ThreadHistory>;
  deepLink: DeepLink;
  rows: ThreadRow[];
  query: string;
  archived: boolean;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  workspaceReady: boolean;
  setQuery(value: string): void;
  setArchived(value: boolean): void;
  select(thread: { id: string; workspaceId: number; title: string | null }): void;
  newChat(): void;
  loadMore(): void;
  retry(): void;
  patch(thread: ThreadRow, value: ChatThreadPatch): Promise<void>;
  stop(runId: string): void;
  loadHistory(tab: WorkTab, before?: string): Promise<void>;
  markRead(threadId: string, owner: number, timestamp: string): void;
  rename(tabId: string, title: string): void;
  /** Applies a `?thread=&workspace=&prompt=` link that arrived after Chat started. */
  openLink(search: string): void;
}

const ChatContext = createContext<ChatController | null>(null);

export function useChat(): ChatController {
  const value = useContext(ChatContext);
  if (value === null) throw new Error("useChat must be used inside <ChatProvider>");
  return value;
}

/**
 * `active` is true while the Chat section is on screen. The controller starts
 * on the first visit (so a deep link to another section never adopts Chat's
 * last workspace), and it polls the library only while Chat is visible.
 */
export function ChatProvider({ active, children }: { active: boolean; children: ReactNode }) {
  const console_ = useHydra();
  const latestConsole = useRef(console_);
  useEffect(() => { latestConsole.current = console_; },[console_]);
  const { workspaces, workspaceId, status, setWorkspaceId } = useWorkspace();
  const toast = useToast();
  const [tabs,setTabs] = useState<WorkTab[]>([]);
  const [activeId,setActiveId] = useState<string | null>(null);
  const [hydrated,setHydrated] = useState(false);
  const [records,setRecords] = useState<Record<string,ChatThread>>({});
  const [library,setLibrary] = useState<string[]>([]);
  const [query,setQuery] = useState("");
  const [archived,setArchivedState] = useState(false);
  const [next,setNext] = useState<string | null>(null);
  const [loading,setLoading] = useState(false);
  const [libraryError,setLibraryError] = useState<string | null>(null);
  const [history,setHistory] = useState<Record<string,ThreadHistory>>({});
  const [deepLink,setDeepLink] = useState<DeepLink>({thread:null,prompt:null});
  const inFlight = useRef(new Set<string>());
  const libraryRequest = useRef(0);
  const lastActive = useRef<Record<number,string>>({});
  const [revision,setRevision] = useState(0);
  const paginated = useRef(false);
  const readTimes = useRef<Record<string,string>>({});

  useEffect(() => {
    if(!active || hydrated) return;
    let stored: {tabs?:WorkTab[];activeId?:string;lastActive?:Record<number,string>} = {};
    try { stored = JSON.parse(userLocalStorage.getItem(STORAGE_KEY) ?? "{}"); } catch { /* start with a new draft */ }
    const valid = Array.isArray(stored?.tabs) ? stored.tabs.filter(tab => typeof tab.id === "string" && tab.id && Number.isSafeInteger(tab.workspaceId) && tab.workspaceId > 0 && (tab.title === null || typeof tab.title === "string")) : [];
    const link = parseLink(location.search);
    if (link.thread && link.owner !== null && !valid.some(tab => tab.id === link.thread)) valid.push({id:link.thread,workspaceId:link.owner,title:null});
    const selected = valid.find(tab => tab.id === (link.thread ?? stored?.activeId)) ?? valid[0];
    setTabs(valid); setActiveId(selected?.id ?? null);
    lastActive.current = stored?.lastActive ?? {};
    setDeepLink({thread:link.thread,prompt:link.prompt});
    if (selected && !link.hasWorkspace) setWorkspaceId(selected.workspaceId);
    setHydrated(true);
  },[active,hydrated,setWorkspaceId]);

  useEffect(() => {
    if(!hydrated) return;
    try { userLocalStorage.setItem(STORAGE_KEY,JSON.stringify({tabs,activeId,lastActive:lastActive.current})); } catch { /* drafts remain usable */ }
  },[tabs,activeId,hydrated]);

  useEffect(() => {
    if (!hydrated || !active || workspaceId === null) return;
    const activeTab = tabs.find(tab => tab.id === activeId);
    if (activeTab?.workspaceId === workspaceId) { lastActive.current[workspaceId] = activeTab.id; return; }
    const previous = tabs.find(tab => tab.id === lastActive.current[workspaceId]) ?? [...tabs].reverse().find(tab => tab.workspaceId === workspaceId);
    if(previous) setActiveId(previous.id);
    else {
      const id = `work-${crypto.randomUUID()}`;
      setTabs(current => [...current,{id,workspaceId,title:null,updatedAt:new Date().toISOString()}]); setActiveId(id);
      if(deepLink.prompt !== null && !deepLink.thread) setDeepLink(current => ({...current,thread:id}));
    }
  },[hydrated,active,workspaceId,tabs,activeId,deepLink]);

  useEffect(() => {
    if(status !== "ready") return;
    setTabs(current => current.filter(tab => workspaces.some(workspace => workspace.id === tab.workspaceId)));
  },[status,workspaces]);

  const refreshLibrary = useCallback(async (cursor?:string) => {
    if(workspaceId === null) return;
    const request = ++libraryRequest.current;
    setLoading(true); setLibraryError(null);
    try {
      const page = await workspaceApi.threads(SERVER_URL,workspaceId,{query,archived,cursor});
      if(request !== libraryRequest.current) return;
      setRecords(current => ({...current,...Object.fromEntries(page.threads.map(thread => [thread.id,thread]))}));
      setLibrary(current => cursor ? [...new Set([...current,...page.threads.map(thread => thread.id)])]
        : paginated.current ? [...new Set([...page.threads.map(thread => thread.id),...current])] : page.threads.map(thread => thread.id));
      if(cursor || !paginated.current) setNext(page.next);
      if(cursor) paginated.current=true;
    } catch(error) { if(request === libraryRequest.current) setLibraryError(error instanceof Error ? error.message : "Could not load conversations"); }
    finally { if(request === libraryRequest.current) setLoading(false); }
  },[workspaceId,query,archived]);

  // Search is server-side over titles. Poll only summaries, never every
  // transcript, and only while the Chat collection is on screen.
  useEffect(() => {
    if(!active) return;
    const timer = setTimeout(() => { void refreshLibrary(); },180);
    const poll = setInterval(() => { if(document.visibilityState === "visible") void refreshLibrary(); },15000);
    const invalidate=() => { libraryRequest.current++; };
    return () => { clearTimeout(timer); clearInterval(poll); invalidate(); };
  },[active,refreshLibrary,console_.operationsRevision,revision]);

  useEffect(() => {
    paginated.current=false;
    const timer=setTimeout(() => { setLibrary([]); setNext(null); },0);
    return () => clearTimeout(timer);
  },[workspaceId,query,archived]);

  const activeTab = tabs.find(tab => tab.id === activeId);
  const loadHistory = useCallback(async (tab:WorkTab,before?:string) => {
    if(inFlight.current.has(tab.id)) return;
    inFlight.current.add(tab.id);
    setHistory(current => ({...current,[tab.id]:{...(current[tab.id] ?? emptyHistory),loading:true,error:null}}));
    try {
      let page;
      try { page = await workspaceApi.threadHistory(SERVER_URL,tab.workspaceId,tab.id,before); }
      catch(error) {
        if(!(error instanceof ApiError) || error.status !== 404 || before) throw error;
        // Pipeline's Open in Chat uses the run identity, including saved/legacy runs.
        const session = await workspaceApi.session(SERVER_URL,tab.id);
        if(session.workspaceId !== tab.workspaceId) throw new Error("Conversation belongs to another workspace");
        page = {sessions:[session],next:null};
      }
      latestConsole.current.restoreThread(tab.id,page.sessions);
      setHistory(current => ({...current,[tab.id]:{loaded:true,loading:false,next:page.next,error:null}}));
    } catch(error) {
      // A local unsent draft has no durable row yet.
      const local = error instanceof ApiError && error.status === 404 && !records[tab.id] && tab.id.startsWith("work-");
      setHistory(current => ({...current,[tab.id]:{loaded:local,loading:false,next:null,error:local ? null : error instanceof Error ? error.message : "Could not restore conversation"}}));
    } finally { inFlight.current.delete(tab.id); }
  },[records]);

  useEffect(() => {
    if(!activeTab || history[activeTab.id]?.loaded || history[activeTab.id]?.loading || history[activeTab.id]?.error) return;
    if(records[activeTab.id] || activeTab.title || activeTab.id === deepLink.thread && deepLink.prompt === null) void loadHistory(activeTab);
    else setHistory(current => ({...current,[activeTab.id]:{...emptyHistory,loaded:true}}));
  },[activeTab,history,records,loadHistory,deepLink]);

  // Only the Chat route owns `?thread=` and the document title.
  useEffect(() => {
    if(!active || !activeTab) return;
    const url = new URL(location.href);
    url.searchParams.set("thread",activeTab.id); url.searchParams.set("workspace",String(activeTab.workspaceId));
    window.history.replaceState(window.history.state,"",url);
    document.title = `${records[activeTab.id]?.title ?? activeTab.title ?? "New chat"} · Hydra`;
  },[active,activeTab,records]);

  const select = useCallback((thread:{id:string;workspaceId:number;title:string | null}) => {
    setTabs(current => current.some(tab => tab.id === thread.id) ? current : [...current,{id:thread.id,workspaceId:thread.workspaceId,title:thread.title}]);
    setActiveId(thread.id); setWorkspaceId(thread.workspaceId); lastActive.current[thread.workspaceId] = thread.id;
  },[setWorkspaceId]);

  const openLink = useCallback((search:string) => {
    if(!hydrated) return;
    const link = parseLink(search);
    if(!link.thread || link.owner === null || link.thread === activeId) return;
    setDeepLink({thread:link.thread,prompt:link.prompt});
    select({id:link.thread,workspaceId:link.owner,title:null});
  },[hydrated,activeId,select]);

  const newChat = useCallback(() => {
    if(workspaceId === null) return;
    const id = `work-${crypto.randomUUID()}`;
    setTabs(current => [...current,{id,workspaceId,title:null,updatedAt:new Date().toISOString()}]);
    setHistory(current => ({...current,[id]:{...emptyHistory,loaded:true}}));
    setActiveId(id); setQuery(""); setArchivedState(false); lastActive.current[workspaceId] = id;
  },[workspaceId]);

  const patch = useCallback(async (thread:ThreadRow,value:ChatThreadPatch) => {
    if(thread.local) {
      if(value.archived) { setTabs(current => current.filter(tab => tab.id !== thread.id)); if(activeId === thread.id) setActiveId(null); }
      if(value.title) setTabs(current => current.map(tab => tab.id === thread.id ? {...tab,title:value.title!} : tab));
      return;
    }
    try {
      const updated = await workspaceApi.patchThread(SERVER_URL,thread.workspaceId,thread.id,value);
      setRecords(current => ({...current,[thread.id]:updated}));
      setTabs(current => current.map(tab => tab.id === thread.id ? {...tab,title:updated.title} : tab));
      if(value.archived !== undefined && updated.archived !== archived) {
        setLibrary(current => current.filter(id => id !== thread.id));
        if(activeId === thread.id) { setTabs(current => current.filter(tab => tab.id !== thread.id)); setActiveId(null); }
      }
      setRevision(current => current + 1);
    } catch(error) { toast.error("Could not update conversation",error instanceof Error ? error.message : String(error)); }
  },[activeId,archived,toast]);

  const markRead = useCallback((threadId:string,owner:number,timestamp:string) => {
    if(document.visibilityState !== "visible" || !timestamp || readTimes.current[threadId] && readTimes.current[threadId]! >= timestamp) return;
    readTimes.current[threadId] = timestamp;
    void workspaceApi.patchThread(SERVER_URL,owner,threadId,{readAt:timestamp}).then(thread => {
      setRecords(current => ({...current,[thread.id]:thread}));
    }).catch(() => { delete readTimes.current[threadId]; });
  },[]);

  const rename = useCallback((tabId:string,title:string) => {
    setTabs(current => current.map(item => item.id === tabId ? {...item,title} : item)); setRevision(current => current + 1);
  },[]);

  const setArchived = useCallback((value:boolean) => { setArchivedState(value); setLibrary([]); setNext(null); },[]);
  const interrupt = console_.interrupt;
  const stop = useCallback((runId:string) => interrupt(runId),[interrupt]);

  const rows = useMemo(() => {
    const result = new Map<string,ThreadRow>();
    for(const id of library) {
      const record = records[id];
      if(record && record.workspaceId === workspaceId && record.archived === archived && record.title.toLowerCase().includes(query.toLowerCase())) result.set(id,{...record,...(record.lastRunState === "ERROR" ? {status:"Failed"} : {})});
    }
    for(const tab of tabs) {
      if(tab.workspaceId !== workspaceId) continue;
      const record = records[tab.id];
      if(record) continue;
      const title = tab.title ?? "New chat";
      if(!archived && title.toLowerCase().includes(query.toLowerCase())) result.set(tab.id,{id:tab.id,workspaceId:tab.workspaceId,title,pinned:false,archived:false,unread:false,updatedAt:tab.updatedAt ?? "1970-01-01T00:00:00.000Z",lastReplyAt:null,lastReadAt:null,local:true});
    }
    // Running and waiting conversations remain discoverable even if archived or filtered.
    for(const run of console_.runs) {
      if(run.workspace.id !== workspaceId) continue;
      const id = console_.runTabIds[run.runId] ?? (run.source.type === "custom" ? run.source.threadId : undefined) ?? run.runId;
      const record = records[id];
      const waiting = Object.values(console_.inputRequests).some(request => request.runId === run.runId);
      result.set(id,{...(record ?? {id,workspaceId:run.workspace.id,title:sourceTitle(run.source),pinned:false,archived:false,updatedAt:run.startedAt,lastReplyAt:null,lastReadAt:null,unread:false,local:true}),status:waiting ? "Needs your answer" : "Working",runId:run.runId});
    }
    for(const launch of console_.pendingLaunches) {
      const row = result.get(launch.tabId);
      if(row) result.set(launch.tabId,{...row,status:"Starting…"});
    }
    return [...result.values()].sort((a,b) => +b.pinned - +a.pinned || +!!b.status - +!!a.status || b.updatedAt.localeCompare(a.updatedAt));
  },[library,records,tabs,workspaceId,archived,query,console_.runs,console_.runTabIds,console_.inputRequests,console_.pendingLaunches]);

  const value = useMemo<ChatController>(() => ({
    started:hydrated, tabs, activeId, activeTab, history, deepLink, rows, query, archived, loading, error:libraryError, hasMore:next !== null,
    workspaceReady:workspaceId !== null, setQuery, setArchived, select, newChat,
    loadMore:() => { if(next) void refreshLibrary(next); }, retry:() => { void refreshLibrary(); },
    patch, stop, loadHistory, markRead, rename, openLink,
  }),[hydrated,tabs,activeId,activeTab,history,deepLink,rows,query,archived,loading,libraryError,next,workspaceId,setArchived,select,newChat,refreshLibrary,patch,stop,loadHistory,markRead,rename,openLink]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
