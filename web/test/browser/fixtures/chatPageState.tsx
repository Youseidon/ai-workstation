import { useSyncExternalStore } from "react";
import type { AgentSession, ProviderInfo, WorkspaceRecord } from "@agent-console/shared";
import type { useAgentConsole as ConsoleHook } from "@/lib/useAgentConsole";
import { appendPrompt, applyEvent, type LogItem } from "@/lib/log";

type ConsoleApi = ReturnType<typeof ConsoleHook>;
const now="2026-11-19T00:00:00.000Z";
const projects:WorkspaceRecord[]=[1,2].map(id=>({id,name:id===1 ? "ai-orchestration" : "Review project",description:"",workDirectory:`/tmp/project-${id}`,workDirectoryExists:true,createdAt:now,updatedAt:now,claudeMd:"",agentsMd:""}));
const providers=[{id:"codex",label:"Codex",available:true,model:null,models:[{id:null,label:"Default",hint:"Provider default"}],modelSelectionMode:"manual",modelAccessTier:"all",totalModels:1,tierDefaultModel:null,reasoningEffort:"medium",permissionMode:"read-only",cooling:null}] as unknown as ProviderInfo[];
let owner=1;
let items:LogItem[]=[];
let ownership:Record<string,string>={};
const listeners=new Set<() => void>();
const subscribe=(callback:() => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; };
const notify=() => { api=makeApi(); for(const callback of listeners) callback(); };
const makeApi=():ConsoleApi => ({
  providers,connection:"open",operationsRevision:0,items,runs:[],pendingLaunches:[],launchFailuresByTab:{},runTabIds:ownership,consultIds:[],inputRequests:{},
  itemsForTab:(id:string) => items.filter(item=>ownership[item.runId]===id),
  restoreThread:(id:string,sessions:AgentSession[]) => {
    for(const session of sessions) {
      ownership={...ownership,[session.id]:id};
      items=items.filter(item=>item.runId!==session.id);
      items=appendPrompt(items,{runId:session.id,provider:"codex",model:null,text:session.displayText ?? "",timestamp:session.startedAt});
      for(const event of session.events) items=applyEvent(items,event);
    }
    notify();
  },
  claimRun:() => {},claimWorkspaceRuns:() => {},interrupt:() => {},dismissLaunchFailure:() => {},startRun:() => false,startConsult:() => false,
}) as unknown as ConsoleApi;
let api=makeApi();
export function useAgentConsole() { return useSyncExternalStore(subscribe,()=>api,()=>api); }
export function useWorkspace() {
  useSyncExternalStore(subscribe,()=>owner,()=>owner);
  return {workspaces:projects,workspaceId:owner,workspace:projects.find(project=>project.id===owner)!,status:"ready" as const,error:null,
    setWorkspaceId:(id:number) => { if(owner!==id) { owner=id; notify(); } },refresh:async () => {}};
}
