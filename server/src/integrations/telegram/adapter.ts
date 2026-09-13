import type { TelegramBotApi } from "./fakeBotApi.ts";
import { workspaces } from "../../workspaces.ts";

export class TelegramAdapter {
  constructor(
    private readonly botId: string,
    private readonly api: TelegramBotApi,
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
}
