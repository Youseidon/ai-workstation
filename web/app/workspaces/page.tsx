import { AppNav } from "@/components/AppNav";
import { WorkspaceManager } from "@/components/WorkspaceManager";
import { SERVER_URL } from "@/lib/serverUrl";

export default function WorkspacesPage() {
  return <main className="flex h-full flex-col bg-surface-0"><header className="flex items-center gap-4 border-b border-line bg-surface-1 px-4 py-2.5"><h1 className="text-xs uppercase tracking-[0.2em] text-fg-muted">agent console</h1><AppNav active="workspaces"/><span className="ml-auto text-xs text-fg-dim">workspace library</span></header><WorkspaceManager serverUrl={SERVER_URL}/></main>;
}
