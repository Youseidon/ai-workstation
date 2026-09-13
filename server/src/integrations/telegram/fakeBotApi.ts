export interface TelegramUpdate {
  updateId: number;
  payload: unknown;
}

export interface TelegramSendRequest {
  chatId: string;
  topicId: string | null;
  payload: unknown;
}

export interface TelegramBotApi {
  getUpdates(offset: number): Promise<TelegramUpdate[]>;
  sendMessage(request: TelegramSendRequest): Promise<{ messageId: string }>;
}

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
}
