import type { TelegramBotApi } from "./fakeBotApi.ts";
import { workspaces } from "../../workspaces.ts";
import type { TaskControlService } from "../../taskControl.ts";

interface CallbackPayload {
  kind: "callback";
  ref: string;
  transportUserId: string;
  chatId: string;
  topicId?: string | null;
  messageId?: string | null;
  commandId: string;
  content?: string;
}

function callbackPayload(value: unknown): CallbackPayload | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "callback") return null;
  if (typeof record.ref !== "string" || typeof record.transportUserId !== "string" || typeof record.chatId !== "string" || typeof record.commandId !== "string") return null;
  return {
    kind: "callback",
    ref: record.ref,
    transportUserId: record.transportUserId,
    chatId: record.chatId,
    topicId: typeof record.topicId === "string" ? record.topicId : null,
    messageId: typeof record.messageId === "string" ? record.messageId : null,
    commandId: record.commandId,
    content: typeof record.content === "string" ? record.content : undefined,
  };
}

export class TelegramAdapter {
  constructor(
    private readonly botId: string,
    private readonly api: TelegramBotApi,
    private readonly taskControl?: TaskControlService,
  ) {}

  async pollOnce(): Promise<{ fetched: number; saved: number; nextOffset: number }> {
    const offset = workspaces.telegramCursor(this.botId);
    const updates = await this.api.getUpdates(offset);
    const saved = workspaces.saveTelegramUpdates(this.botId, updates);
    const nextOffset = updates.reduce((next, update) => Math.max(next, update.updateId + 1), offset);
    if (nextOffset !== offset) workspaces.advanceTelegramCursor(this.botId, nextOffset);
    return { fetched: updates.length, saved, nextOffset };
  }

  async sendOutbox(outboxId: number): Promise<"SENT" | "FAILED"> {
    const row = workspaces.telegramOutbox().find(entry => entry.id === outboxId);
    if (!row) throw new Error("Telegram outbox row was not found.");
    try {
      await this.api.sendMessage({ chatId: row.chatId, topicId: row.topicId, payload: row.payload });
      workspaces.markTelegramOutbox(outboxId, "SENT");
      return "SENT";
    } catch (error) {
      workspaces.markTelegramOutbox(outboxId, "FAILED", error instanceof Error ? error.message : String(error));
      return "FAILED";
    }
  }

  async processPendingCallbacks(): Promise<{ processed: number; ignored: number }> {
    let processed = 0;
    let ignored = 0;
    for (const update of workspaces.pendingTelegramInbox(this.botId)) {
      const callback = callbackPayload(update.payload);
      if (callback === null || this.taskControl === undefined) {
        ignored++;
        workspaces.markTelegramUpdateProcessed(this.botId, update.updateId);
        continue;
      }
      await this.taskControl.handleCallback({ ...callback, botId: this.botId });
      processed++;
      workspaces.markTelegramUpdateProcessed(this.botId, update.updateId);
    }
    return { processed, ignored };
  }
}
