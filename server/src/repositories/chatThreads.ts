import type Database from "better-sqlite3";
import type { ChatThread, ChatThreadPage, ChatThreadPatch } from "@hydra/shared";

export class ChatThreadError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** Metadata only: listing/searching threads never loads transcript events. */
export function createChatThreadStore(db: Database.Database) {
  const select = `SELECT thread_id id, workspace_id workspaceId, title, pinned, archived,
    updated_at updatedAt, last_reply_at lastReplyAt, last_read_at lastReadAt,
    (SELECT state FROM agent_run r WHERE r.workspace_id=chat_thread.workspace_id AND r.thread_id=chat_thread.thread_id
      ORDER BY r.started_at DESC,r.id DESC LIMIT 1) lastRunState FROM chat_thread`;
  const hydrate = (row: Record<string, unknown>): ChatThread => ({ ...row,
    pinned: row.pinned === 1, archived: row.archived === 1,
    unread: typeof row.lastReplyAt === "string" && (row.lastReadAt === null || row.lastReplyAt > String(row.lastReadAt)),
  } as unknown as ChatThread);
  const get = (workspaceId: number, threadId: string) => {
    const row = db.prepare(`${select} WHERE workspace_id=? AND thread_id=?`).get(workspaceId, threadId);
    if (!row) throw new ChatThreadError(404, "not_found", "Conversation not found in this workspace");
    return hydrate(row as Record<string, unknown>);
  };
  return {
    get,
    list(workspaceId: number, options: { query?: string; archived?: boolean; cursor?: string; limit?: number } = {}): ChatThreadPage {
      if (!db.prepare("SELECT 1 FROM workspace WHERE id=?").get(workspaceId)) throw new ChatThreadError(404, "not_found", "Workspace not found");
      const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)));
      const params: (string | number)[] = [workspaceId, options.archived ? 1 : 0];
      let where = "workspace_id=? AND archived=?";
      if (options.query) {
        where += " AND title LIKE ? ESCAPE '\\'";
        params.push(`%${options.query.slice(0, 200).replace(/[\\%_]/g, "\\$&")}%`);
      }
      if (options.cursor) {
        let cursor: unknown;
        try { cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString()); } catch { /* rejected below */ }
        if (!Array.isArray(cursor) || cursor.length !== 3 || ![0, 1].includes(cursor[0]) || typeof cursor[1] !== "string" || typeof cursor[2] !== "string") throw new ChatThreadError(400, "invalid_cursor", "Invalid conversation cursor");
        where += " AND (pinned,updated_at,thread_id)<(?,?,?)";
        params.push(cursor[0], cursor[1], cursor[2]);
      }
      const rows = db.prepare(`${select} WHERE ${where} ORDER BY pinned DESC, updated_at DESC, thread_id DESC LIMIT ?`).all(...params, limit + 1) as Record<string, unknown>[];
      const threads = rows.slice(0, limit).map(hydrate);
      const last = threads.at(-1);
      return { threads, next: rows.length > limit && last ? Buffer.from(JSON.stringify([last.pinned ? 1 : 0, last.updatedAt, last.id])).toString("base64url") : null };
    },
    patch(workspaceId: number, threadId: string, input: ChatThreadPatch): ChatThread {
      const current = get(workspaceId, threadId);
      if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 120)) throw new ChatThreadError(422, "validation_error", "Title must contain 1–120 characters");
      for (const key of ["pinned", "archived"] as const) if (input[key] !== undefined && typeof input[key] !== "boolean") throw new ChatThreadError(422, "validation_error", `${key} must be a boolean`);
      if (input.readAt !== undefined && (typeof input.readAt !== "string" || !Number.isFinite(Date.parse(input.readAt)) || new Date(input.readAt).toISOString() !== input.readAt || Date.parse(input.readAt) > Date.now())) throw new ChatThreadError(422, "validation_error", "Read time must be a valid past timestamp");
      const readAt = input.readAt && current.lastReplyAt
        ? [input.readAt, current.lastReplyAt].sort()[0]! : current.lastReadAt;
      db.prepare(`UPDATE chat_thread SET title=?, pinned=?, archived=?, last_read_at=? WHERE workspace_id=? AND thread_id=?`)
        .run(input.title?.trim() ?? current.title, input.pinned === undefined ? +current.pinned : +input.pinned,
          input.archived === undefined ? +current.archived : +input.archived,
          current.lastReadAt && readAt && current.lastReadAt > readAt ? current.lastReadAt : readAt, workspaceId, threadId);
      return get(workspaceId, threadId);
    },
  };
}
