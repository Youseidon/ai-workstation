"use client";

import { useId } from "react";
import { Menu } from "@/components/ui/Menu";
import { useDialogs } from "@/components/ui/Dialogs";
import { useChat, type ThreadRow } from "@/features/chat/hooks/useChatController";

function groupName(thread: ThreadRow): string {
  if (thread.pinned) return "Pinned";
  if (thread.status === "Failed" || thread.status === "Needs your answer") return "Needs attention";
  if (thread.status) return "Active";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const time = Date.parse(thread.updatedAt);
  return time >= +today ? "Today" : time >= +yesterday ? "Yesterday" : "Earlier";
}

export function ChatCollection({ onNavigate }: { onNavigate(): void }) {
  const chat = useChat();
  const dialogs = useDialogs();
  const searchId = useId();
  const groups = new Map<string, ThreadRow[]>();
  for (const thread of chat.rows) {
    const group = groupName(thread);
    groups.set(group, [...(groups.get(group) ?? []), thread]);
  }
  return <>
    <div className="app-sidebar-tools">
      <button type="button" className="app-sidebar-new" onClick={() => { chat.newChat(); onNavigate(); }} disabled={!chat.workspaceReady}><span aria-hidden>＋</span> New chat</button>
      <label htmlFor={searchId} className="sr-only">Search chats</label>
      <input id={searchId} className="app-sidebar-search" type="search" placeholder="Search chats" value={chat.query} onChange={event => chat.setQuery(event.target.value)} />
    </div>
    <nav className="app-sidebar-collection" aria-label={chat.archived ? "Archived conversations" : "Conversations"}>
      {chat.archived && <p className="app-sidebar-group">Archived chats</p>}
      {["Pinned", "Needs attention", "Active", "Today", "Yesterday", "Earlier"].map(group => groups.has(group) && <div key={group} className="mb-4">
        <p className="app-sidebar-group">{group}</p>
        {groups.get(group)!.map(thread => <div key={thread.id} className="app-sidebar-row" data-selected={thread.id === chat.activeId}>
          <button type="button" className="app-sidebar-link" aria-label={thread.title} aria-describedby={thread.status || thread.unread ? `thread-state-${searchId}-${thread.id}` : undefined} aria-current={thread.id === chat.activeId ? "page" : undefined} title={thread.title} onClick={() => { chat.select(thread); onNavigate(); }}>
            <span className="truncate">{thread.title}</span>
            {thread.status || thread.unread ? <span id={`thread-state-${searchId}-${thread.id}`} className="app-sidebar-status" data-state={thread.status}>{thread.status ?? "Unread reply"}</span> : null}
          </button>
          <Menu portal label={`Actions for ${thread.title}`} className="app-sidebar-row-menu" items={[
            {id:"rename",label:"Rename",onSelect:async () => {
              const title = await dialogs.prompt({title:"Rename conversation",label:"Conversation name",initialValue:thread.title,confirmLabel:"Save",validate:value => value.trim().length > 0 && value.trim().length <= 120 ? null : "Use 1–120 characters."});
              if (title !== null) await chat.patch(thread,{title:title.trim()});
            }},
            {id:"pin",label:thread.pinned ? "Unpin" : "Pin conversation",disabled:thread.local,onSelect:() => { void chat.patch(thread,{pinned:!thread.pinned}); }},
            {id:"archive",label:thread.archived ? "Restore to recent chats" : thread.local ? "Close draft" : "Archive conversation",disabled:!!thread.runId || thread.status === "Starting…",onSelect:() => { void chat.patch(thread,{archived:!thread.archived}); }},
            ...(thread.runId ? [{id:"stop",label:"Stop agent",tone:"danger" as const,onSelect:() => chat.stop(thread.runId!)}] : []),
          ]} />
        </div>)}
      </div>)}
      {chat.loading && <p className="app-sidebar-empty" role="status">Loading conversations…</p>}
      {chat.error && <div className="app-sidebar-empty" role="alert"><p>{chat.error}</p><button type="button" className="mt-2 text-accent" onClick={chat.retry}>Retry</button></div>}
      {!chat.loading && !chat.error && chat.rows.length === 0 && <p className="app-sidebar-empty">{chat.query ? "No conversations match your search." : chat.archived ? "No archived conversations." : "Your conversations will appear here."}</p>}
      {chat.hasMore && <button type="button" className="app-sidebar-action" onClick={chat.loadMore} disabled={chat.loading}>Load more chats</button>}
      <button type="button" className="app-sidebar-action" onClick={() => chat.setArchived(!chat.archived)}>{chat.archived ? "← Recent chats" : "Archived chats"}</button>
    </nav>
  </>;
}
