import type { FakeBot, FakeChat, FakeTelegramServer, FakeUser, StoredMessage } from "../fakes/telegramServer.ts";

/*
 * The operator's phone (docs/e2e-harness-plan.md 4). Scenarios talk to this
 * interface only, so the same scenario runs on the fake server (FakePhone)
 * and on real Telegram through a user client (TelegramUserPhone, H6).
 */

export interface PhoneMessage {
  id: number;
  text: string;
  /** Inline button labels, row by row flattened. */
  buttons: string[];
  fromBot: boolean;
  edited: boolean;
  replyToId: number | null;
  topicId: number | null;
}

/**
 * How long a tap waits for the bot's callback answer before resolving with no
 * toast, on both backends. Real Telegram stops waiting on its own after about
 * 15 seconds; the callback itself still reaches the bot when it polls later.
 */
export const TAP_ANSWER_WAIT_MS = 12_000;

export interface PhoneDriver {
  readonly backend: "fake" | "real";
  readonly userId: string;
  readonly chatId: string;
  send(text: string, options?: { replyTo?: PhoneMessage }): Promise<PhoneMessage>;
  /** Taps a button by label; resolves with the toast the bot answered, or null if none arrived in time. */
  tap(message: PhoneMessage, button: string): Promise<{ toast: string | null }>;
  /** Messages of this run only: anything already in the chat when the driver was created is left out. */
  messages(): Promise<PhoneMessage[]>;
  /** Deletes a message from the chat for both sides, as the operator can on the phone. */
  deleteMessage(message: PhoneMessage): Promise<void>;
  /** Waits for a bot message matching `predicate` whose id is greater than `afterId`. */
  waitForBotMessage(description: string, predicate: (message: PhoneMessage) => boolean, options?: { afterId?: number; timeoutMs?: number }): Promise<PhoneMessage>;
  /** The newest message id so far; pass to `waitForBotMessage` to ignore older ones. */
  cursor(): Promise<number>;
}

export async function pollUntil<T>(description: string, probe: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`phone: timed out after ${timeoutMs}ms waiting for ${description}`);
}

function toPhoneMessage(message: StoredMessage): PhoneMessage {
  return {
    id: message.message_id,
    text: message.text,
    buttons: (message.reply_markup?.inline_keyboard ?? []).flat().map((button) => button.text),
    fromBot: message.from.is_bot,
    edited: message.history.length > 1,
    replyToId: message.reply_to_message?.message_id ?? null,
    topicId: message.message_thread_id ?? null,
  };
}

export class FakePhone implements PhoneDriver {
  readonly backend = "fake" as const;
  private readonly floorId: number;

  constructor(
    private readonly server: FakeTelegramServer,
    private readonly bot: FakeBot,
    readonly user: FakeUser,
    readonly chat: FakeChat,
  ) {
    server.registerChat(chat);
    this.floorId = server.transcript(chat.id).at(-1)?.message_id ?? 0;
  }

  get userId(): string {
    return String(this.user.id);
  }

  get chatId(): string {
    return String(this.chat.id);
  }

  async send(text: string, options: { replyTo?: PhoneMessage } = {}): Promise<PhoneMessage> {
    return toPhoneMessage(this.server.userSendsMessage(this.bot, this.user, this.chat, text, options.replyTo ? { replyToMessageId: options.replyTo.id } : {}));
  }

  async tap(message: PhoneMessage, button: string): Promise<{ toast: string | null }> {
    const stored = this.server.transcript(this.chat.id).find((item) => item.message_id === message.id);
    const data = stored?.reply_markup?.inline_keyboard.flat().find((item) => item.text === button)?.callback_data;
    if (!data) throw new Error(`phone: message ${message.id} has no button "${button}" (has: ${toPhoneMessage(stored!).buttons.join(", ")})`);
    const queryId = this.server.userTapsButton(this.bot, this.user, this.chat, message.id, data);
    try {
      const answer = await pollUntil("the callback answer", async () => this.server.callbackAnswer(queryId), TAP_ANSWER_WAIT_MS);
      return { toast: answer.text };
    } catch {
      return { toast: null };
    }
  }

  async messages(): Promise<PhoneMessage[]> {
    return this.server.transcript(this.chat.id).filter((message) => message.message_id > this.floorId).map(toPhoneMessage);
  }

  async cursor(): Promise<number> {
    return this.server.transcript(this.chat.id).at(-1)?.message_id ?? this.floorId;
  }

  async deleteMessage(message: PhoneMessage): Promise<void> {
    this.server.userDeletesMessage(this.chat.id, message.id);
  }

  waitForBotMessage(description: string, predicate: (message: PhoneMessage) => boolean, options: { afterId?: number; timeoutMs?: number } = {}): Promise<PhoneMessage> {
    return pollUntil(description, async () => (await this.messages()).find((message) => message.fromBot && message.id > (options.afterId ?? 0) && predicate(message)), options.timeoutMs ?? 20_000);
  }
}
