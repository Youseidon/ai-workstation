import { TelegramApiError, type TelegramBotApi, type TelegramEditRequest, type TelegramSendRequest, type TelegramUpdate } from "./botApi.ts";

export type { TelegramBotApi, TelegramEditRequest, TelegramSendRequest, TelegramUpdate } from "./botApi.ts";

export class FakeTelegramBotApi implements TelegramBotApi {
  private updates: TelegramUpdate[] = [];
  private sendFailures: string[] = [];
  readonly sent: Array<TelegramSendRequest & { messageId: string }> = [];

  pushUpdate(update: TelegramUpdate): void {
    this.updates.push(update);
    this.updates.sort((a, b) => a.updateId - b.updateId);
  }

  failNextSend(message: string): void {
    this.sendFailures.push(message);
  }

  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    return this.updates.filter(update => update.updateId >= offset);
  }

  async sendMessage(request: TelegramSendRequest): Promise<{ messageId: string }> {
    const failure = this.sendFailures.shift();
    if (failure !== undefined) throw new Error(failure);
    const messageId = `fake-message-${this.sent.length + 1}`;
    this.sent.push({ ...request, messageId });
    return { messageId };
  }

  readonly edits: TelegramEditRequest[] = [];

  async editMessageText(request: TelegramEditRequest): Promise<{ modified: boolean }> {
    const sent = this.sent.find(message => message.messageId === request.messageId && message.chatId === request.chatId);
    if (!sent) throw new TelegramApiError("rejected", "Telegram editMessageText failed (400): Bad Request: message to edit not found");
    const current = [sent.payload, ...this.edits.filter(edit => edit.messageId === request.messageId).map(edit => edit.payload)].at(-1);
    this.edits.push(request);
    return { modified: JSON.stringify(current) !== JSON.stringify(request.payload) };
  }
}
