import { Api, TelegramClient } from "telegram";
import { EditedMessage } from "telegram/events/EditedMessage.js";
import { NewMessage } from "telegram/events/index.js";
import { StringSession } from "telegram/sessions/index.js";
import { LiveSetupError, type LiveConfig } from "../env/liveConfig.ts";
import { TAP_ANSWER_WAIT_MS, type PhoneDriver, type PhoneMessage } from "./phone.ts";

/*
 * The operator's phone on real Telegram (docs/e2e-harness-plan.md 4.2): a
 * GramJS user client signed in as the operator, in the private chat with the
 * dedicated test bot. It sends, replies and taps through Telegram's servers
 * exactly as the mobile app does.
 *
 * Message ids here are the user's side of the chat. In private chats they
 * differ from the ids the bot sees, so scenarios compare phone messages with
 * each other (cursor, afterId), never with ids stored by the server.
 *
 * Messages arrive through the client's update stream and are resynchronised
 * from history every few seconds, so waits stay event-driven without polling
 * Telegram at a rate that invites flood limits.
 */

const RESYNC_MS = 4_000;
const HISTORY_WINDOW = 40;
/** Flood waits up to this many seconds are slept through; longer ones fail the step with the wait named. */
const FLOOD_SLEEP_SECONDS = 5;

/** Telegram errors carry RPC names and wait times, never credentials; the message is rebuilt so nothing else leaks. */
function phoneError(action: string, error: unknown): Error {
  const rpc = error as { errorMessage?: string; seconds?: number };
  if (typeof rpc.seconds === "number") return new Error(`phone: Telegram asked to wait ${rpc.seconds}s before ${action} (flood limit)`);
  return new Error(`phone: Telegram refused ${action}: ${rpc.errorMessage ?? (error instanceof Error ? error.name : "unknown error")}`);
}

function toPhoneMessage(message: Api.Message): PhoneMessage {
  const markup = message.replyMarkup instanceof Api.ReplyInlineMarkup ? message.replyMarkup : null;
  const replyTo = message.replyTo instanceof Api.MessageReplyHeader ? message.replyTo : null;
  return {
    id: message.id,
    text: message.message ?? "",
    buttons: (markup?.rows ?? []).flatMap((row) => row.buttons.map((button) => button.text)),
    fromBot: !message.out,
    edited: message.editDate !== undefined && message.editDate !== null,
    replyToId: replyTo?.replyToMsgId ?? null,
    topicId: replyTo?.forumTopic ? (replyTo.replyToTopId ?? replyTo.replyToMsgId ?? null) : null,
  };
}

export class TelegramUserPhone implements PhoneDriver {
  readonly backend = "real" as const;
  private readonly client: TelegramClient;
  private readonly cache = new Map<number, Api.Message>();
  private bot: Api.User | null = null;
  private self: Api.User | null = null;
  private lastSync = 0;
  /** Messages older than this belong to earlier runs and are never shown to a scenario. */
  private floorId = 0;

  constructor(private readonly config: LiveConfig) {
    this.client = new TelegramClient(new StringSession(config.userSession), config.apiId, config.apiHash, { connectionRetries: 5, autoReconnect: true, floodSleepThreshold: FLOOD_SLEEP_SECONDS });
    this.client.setLogLevel("error" as never);
  }

  get userId(): string {
    return this.config.operatorUserId;
  }

  /** In a private chat the Bot API chat id is the user's id. */
  get chatId(): string {
    return this.config.operatorUserId;
  }

  /** Connects with the saved session; setup problems are reported as blocked on setup, never as a crash. */
  async connect(): Promise<void> {
    try {
      await this.client.connect();
    } catch (error) {
      throw new LiveSetupError(`the Telegram user client could not connect (${phoneError("the connection", error).message})`);
    }
    if (!(await this.client.checkAuthorization())) throw new LiveSetupError("the saved Telegram user session is revoked or no longer authorized; run npm run e2e:live:login again");
    const me = await this.client.getMe();
    this.self = me;
    if (String(me.id) !== this.config.operatorUserId) throw new LiveSetupError("the saved session belongs to a different Telegram account than E2E_TELEGRAM_OPERATOR_USER_ID; run npm run e2e:live:login again");
    const bot = await this.client.getEntity(this.config.testBotUsername).catch(() => null);
    if (!(bot instanceof Api.User) || !bot.bot || String(bot.id) !== this.config.testBotId) throw new LiveSetupError("E2E_TELEGRAM_TEST_BOT_USERNAME does not resolve to the registered test bot id; run npm run e2e:live:login again");
    this.bot = bot;
    const chats = [bot];
    this.client.addEventHandler((event) => this.remember(event.message), new NewMessage({ chats }));
    this.client.addEventHandler((event) => this.remember(event.message), new EditedMessage({ chats }));
    await this.resync();
    this.floorId = Math.max(0, ...this.cache.keys());
  }

  /** The operator's names and username as Telegram knows them, so recordings can prove they were removed. */
  identityValues(): string[] {
    return [this.self?.firstName, this.self?.lastName, this.self?.username, this.self?.phone].filter((value): value is string => typeof value === "string" && value !== "");
  }

  /** Drops the MTProto connection without signing out, as a network blip would (S-H6-10); the next call reconnects. */
  async dropConnection(): Promise<void> {
    await this.client.disconnect();
  }

  /** Sends a note to the operator's Saved Messages: activity in another chat that advances the account's message ids (S-H6-06). */
  async noteToSelf(text: string): Promise<void> {
    await this.ensureConnected();
    await this.client.sendMessage("me", { message: text, formattingEntities: [] });
  }

  /** How many sessions the operator's account has signed in, so a run can prove it reused the saved one (S-H6-27). */
  async activeSessionCount(): Promise<number> {
    await this.ensureConnected();
    const result = await this.client.invoke(new Api.account.GetAuthorizations());
    return result.authorizations.length;
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
    await this.client.destroy();
  }

  async send(text: string, options: { replyTo?: PhoneMessage } = {}): Promise<PhoneMessage> {
    // Telegram silently drops a reply to a message that does not exist, which would turn a reply into plain text.
    await this.ensureConnected();
    if (options.replyTo && !(await this.find(options.replyTo.id))) throw new Error(`phone: cannot reply to message ${options.replyTo.id}: it is not in the chat with the test bot`);
    try {
      // Empty formatting entities send the text literally: GramJS would otherwise parse Markdown.
      const sent = await this.client.sendMessage(this.peer(), { message: text, formattingEntities: [], linkPreview: false, ...(options.replyTo ? { replyTo: options.replyTo.id } : {}) });
      this.remember(sent);
      return toPhoneMessage(sent);
    } catch (error) {
      throw phoneError("the message", error);
    }
  }

  async tap(message: PhoneMessage, button: string): Promise<{ toast: string | null }> {
    await this.ensureConnected();
    const stored = await this.find(message.id);
    const markup = stored?.replyMarkup instanceof Api.ReplyInlineMarkup ? stored.replyMarkup : null;
    const target = markup?.rows.flatMap((row) => row.buttons).find((item): item is Api.KeyboardButtonCallback => item instanceof Api.KeyboardButtonCallback && item.text === button);
    if (!target) throw new Error(`phone: message ${message.id} has no button "${button}" (has: ${stored ? toPhoneMessage(stored).buttons.join(", ") : "message not found"})`);
    const answer = this.client.invoke(new Api.messages.GetBotCallbackAnswer({ peer: this.peer(), msgId: message.id, data: target.data }));
    // Telegram delivers the callback to the bot even when the answer never comes (the bot is offline).
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), TAP_ANSWER_WAIT_MS).unref());
    const result = await Promise.race([answer.catch(() => null), timeout]);
    return { toast: result?.message ?? null };
  }

  async messages(): Promise<PhoneMessage[]> {
    await this.resync();
    // A disconnected client reconnects on the next request, so a dropped connection costs one resync.
    return this.visible();
  }

  async deleteMessage(message: PhoneMessage): Promise<void> {
    await this.ensureConnected();
    try {
      await this.client.deleteMessages(this.peer(), [message.id], { revoke: true });
    } catch (error) {
      throw phoneError("deleting the message", error);
    }
    this.cache.delete(message.id);
  }

  async cursor(): Promise<number> {
    await this.resync();
    return Math.max(this.floorId, ...this.cache.keys());
  }

  async waitForBotMessage(description: string, predicate: (message: PhoneMessage) => boolean, options: { afterId?: number; timeoutMs?: number } = {}): Promise<PhoneMessage> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (Date.now() - this.lastSync >= RESYNC_MS) await this.resync();
      const found = this.visible().find((message) => message.fromBot && message.id > (options.afterId ?? 0) && predicate(message));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`phone: timed out after ${timeoutMs}ms waiting for ${description}`);
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.connected) return;
    try {
      await this.client.connect();
    } catch (error) {
      throw phoneError("reconnecting", error);
    }
  }

  private async find(id: number): Promise<Api.Message | undefined> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    await this.ensureConnected();
    const [fetched] = await this.client.getMessages(this.peer(), { ids: id });
    if (fetched instanceof Api.Message) this.remember(fetched);
    return fetched instanceof Api.Message ? fetched : undefined;
  }

  private peer(): Api.User {
    if (!this.bot) throw new Error("phone: not connected");
    return this.bot;
  }

  private remember(message: Api.Message | undefined): void {
    if (message instanceof Api.Message) this.cache.set(message.id, message);
  }

  private visible(): PhoneMessage[] {
    return [...this.cache.values()].filter((message) => message.id > this.floorId).sort((a, b) => a.id - b.id).map(toPhoneMessage);
  }

  private async resync(): Promise<void> {
    await this.ensureConnected();
    const history = await this.client.getMessages(this.peer(), { limit: HISTORY_WINDOW }).catch((error: unknown) => {
      throw phoneError("reading the chat", error);
    });
    const oldest = Math.min(...history.map((message) => message.id));
    // Anything inside the fetched window that Telegram no longer returns was deleted.
    if (history.length > 0) for (const id of [...this.cache.keys()]) if (id >= oldest && !history.some((message) => message.id === id)) this.cache.delete(id);
    for (const message of history) this.remember(message);
    this.lastSync = Date.now();
  }
}
