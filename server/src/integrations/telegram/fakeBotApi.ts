import { TelegramApiError, type TelegramBotApi, type TelegramEditRequest, type TelegramSendRequest, type TelegramUpdate } from "./botApi.ts";

export type { TelegramBotApi, TelegramEditRequest, TelegramSendRequest, TelegramUpdate } from "./botApi.ts";

/** The description Telegram really returns once a group has become a supergroup (B8). */
export const SUPERGROUP_UPGRADE_DESCRIPTION = "Bad Request: group chat was upgraded to a supergroup chat";

export class FakeTelegramBotApi implements TelegramBotApi {
  private updates: TelegramUpdate[] = [];
  private sendFailures: string[] = [];
  private readonly upgraded = new Map<string, string>();
  readonly sent: Array<TelegramSendRequest & { messageId: string }> = [];

  pushUpdate(update: TelegramUpdate): void {
    this.updates.push(update);
    this.updates.sort((a, b) => a.updateId - b.updateId);
  }

  failNextSend(message: string): void {
    this.sendFailures.push(message);
  }

  /**
   * Models Telegram upgrading a basic group to a supergroup: from here on the old
   * chat id exists only as a refusal that names the new one, in the shape the Bot
   * API really returns (B8).
   */
  upgradeChat(fromChatId: string, toChatId: string): void {
    this.upgraded.set(fromChatId, toChatId);
  }

  private refuseUpgraded(method: string, chatId: string): void {
    const migrateToChatId = this.upgraded.get(chatId);
    if (migrateToChatId === undefined) return;
    throw new TelegramApiError("rejected", `Telegram ${method} failed (400): ${SUPERGROUP_UPGRADE_DESCRIPTION}`, null, migrateToChatId);
  }

  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    return this.updates.filter(update => update.updateId >= offset);
  }

  async sendMessage(request: TelegramSendRequest): Promise<{ messageId: string }> {
    this.refuseUpgraded("sendMessage", request.chatId);
    const failure = this.sendFailures.shift();
    if (failure !== undefined) throw new Error(failure);
    const messageId = `fake-message-${this.sent.length + 1}`;
    this.sent.push({ ...request, messageId });
    return { messageId };
  }

  readonly edits: TelegramEditRequest[] = [];

  async editMessageText(request: TelegramEditRequest): Promise<{ modified: boolean }> {
    this.refuseUpgraded("editMessageText", request.chatId);
    const sent = this.sent.find(message => message.messageId === request.messageId && message.chatId === request.chatId);
    if (!sent) throw new TelegramApiError("rejected", "Telegram editMessageText failed (400): Bad Request: message to edit not found");
    const current = [sent.payload, ...this.edits.filter(edit => edit.messageId === request.messageId).map(edit => edit.payload)].at(-1);
    this.edits.push(request);
    return { modified: JSON.stringify(current) !== JSON.stringify(request.payload) };
  }
}
