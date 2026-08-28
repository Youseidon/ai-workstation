import { AppNav } from "@/components/AppNav";
import { WorkspaceManager } from "@/components/WorkspaceManager";

const SERVER_URL = process.env.NEXT_PUBLIC_AGENT_SERVER_URL ?? "http://127.0.0.1:4000";

export default function WorkspacesPage() {
  return <main className="flex h-dvh flex-col bg-[#0b0d10]"><header className="flex items-center gap-4 border-b border-[#1d2229] bg-[#0e1115] px-4 py-2.5"><h1 className="text-xs uppercase tracking-[0.2em] text-[#7d8794]">agent console</h1><AppNav active="workspaces"/><span className="ml-auto text-xs text-[#59626e]">workspace library</span></header><WorkspaceManager serverUrl={SERVER_URL}/></main>;
}
