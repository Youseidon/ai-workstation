import type { AgentSession } from "./runs.ts";

export interface ChatThread {
  id: string;
  workspaceId: number;
  title: string;
  pinned: boolean;
  archived: boolean;
  updatedAt: string;
  lastReplyAt: string | null;
  lastReadAt: string | null;
  unread: boolean;
  lastRunState?: string | null;
}

export interface ChatThreadPage { threads: ChatThread[]; next: string | null }
export interface ChatHistoryPage { sessions: AgentSession[]; next: string | null }
export interface ChatThreadPatch { title?: string; pinned?: boolean; archived?: boolean; readAt?: string }
