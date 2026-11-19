"use client";

import Link from "next/link";
import { ChatWorkspace } from "@/components/chat/ChatWorkspace";
import { useChat } from "@/lib/chatController";
import { useWorkspace } from "@/lib/workspaceContext";

/**
 * Chat's conversations. Mounted by the shell, not the route, so open
 * conversations keep their drafts, queued messages and reading position while
 * another section is on screen. `visible` hides it without unmounting.
 */
export function ChatStage({ visible }: { visible: boolean }) {
  const chat = useChat();
  const { workspaces, status, error, refresh } = useWorkspace();
  const activeWorkspace = workspaces.find(workspace => workspace.id === chat.activeTab?.workspaceId);
  return <div className="chat-main" hidden={!visible} aria-hidden={!visible}>
    <h1 className="sr-only">{chat.activeTab?.title ?? "Chat"}</h1>
    {error && <div role="alert" className="chat-page-notice">{error}<button type="button" onClick={() => { void refresh(); }}>Retry</button></div>}
    {status === "empty" && <div className="m-auto p-6 text-center"><p>Create a workspace to start a conversation.</p><Link className="mt-3 inline-block text-accent" href="/workspaces">Create workspace →</Link></div>}
    {!activeWorkspace && status === "loading" && <p className="m-auto text-sm text-fg-muted">Loading workspace…</p>}
    {chat.tabs.map(tab => {
      const workspace = workspaces.find(item => item.id === tab.workspaceId);
      const state = chat.history[tab.id];
      if(!workspace) return null;
      if(!state?.loaded) return tab.id === chat.activeId ? <div key={tab.id} className="m-auto p-6 text-center text-sm text-fg-muted" role={state?.error ? "alert" : "status"}>{state?.error ?? "Opening conversation…"}{state?.error && <button type="button" className="ml-3 text-accent" onClick={() => { void chat.loadHistory(tab); }}>Retry</button>}</div> : null;
      return <ChatWorkspace key={tab.id} tabId={tab.id} workspace={workspace} visible={visible && tab.id === chat.activeId}
        initialPromptId={tab.id === chat.deepLink.thread ? chat.deepLink.prompt : null}
        historyLoading={state.loading} historyError={state.error} hasEarlier={state.next !== null}
        onLoadEarlier={() => { if(state.next) void chat.loadHistory(tab,state.next); }}
        onRead={timestamp => chat.markRead(tab.id,tab.workspaceId,timestamp)}
        onTitle={title => chat.rename(tab.id,title)} />;
    })}
  </div>;
}
