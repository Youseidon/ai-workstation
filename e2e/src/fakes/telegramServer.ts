import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { messageEntities, type Entity } from "./telegramEntities.ts";

/*
 * Fake Telegram Bot API (docs/e2e-harness-plan.md 4.2): a loopback HTTP server
 * with Telegram's envelope, error codes, long polling and update shapes, plus
 * an in-process control surface for FakePhone and fault injection. Behaviour
 * that differs from real Telegram is a bug in this file; the same phone
 * scenarios also run against real Telegram to expose it.
 */

type Json = Record<string, unknown>;

export interface FakeBot {
  id: number;
  username: string;
  token: string;
}

export interface FakeUser {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
}

export interface FakeChat {
  id: number;
  type: "private" | "group" | "supergroup";
  title?: string;
  isForum?: boolean;
}

export interface InlineButton {
  text: string;
  callback_data?: string;
}

export interface StoredMessage {
  message_id: number;
  chat: FakeChat;
  from: { id: number; is_bot: boolean; first_name: string; username?: string };
  date: number;
  text: string;
  entities?: unknown[];
  /** Echoed only when the text holds a link, as real Telegram does. */
  link_preview_options?: unknown;
  reply_markup?: { inline_keyboard: InlineButton[][] };
  message_thread_id?: number;
  is_topic_message?: boolean;
  reply_to_message?: { message_id: number };
  edit_date?: number;
  /** Every text this message has shown, oldest first (control surface only). */
  history: string[];
}

export interface CallbackAnswer {
  callbackQueryId: string;
  text: string;
  answeredAt: number;
}

export interface ApiCall {
  method: string;
  body: Json;
  at: number;
  botId: number | null;
}

type ChatMember = { id: number; isBot: boolean; status: "member" | "administrator"; canPinMessages: boolean; canInviteUsers: boolean };
type Invite = { chatId: number; memberLimit: number; uses: number };

interface PendingPoll {
  botId: number;
  offset: number;
  resolve: (updates: Json[]) => void;
  timer: NodeJS.Timeout;
}

interface ScriptedFailure {
  method: string;
  errorCode: number;
  description: string;
  retryAfter?: number;
  remaining: number;
}

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden: bot was blocked by the user",
  404: "Not Found",
  409: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
  429: "Too Many Requests: retry after 3",
  500: "Internal Server Error",
  502: "Bad Gateway",
};

export class FakeTelegramServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly bots = new Map<string, FakeBot>();
  private readonly updates = new Map<number, Json[]>();
  private readonly polls = new Map<number, PendingPoll>();
  private readonly messages = new Map<number, StoredMessage[]>();
  private readonly callbackAnswers: CallbackAnswer[] = [];
  private readonly openCallbacks = new Map<string, { botId: number; createdAt: number }>();
  private readonly failures: ScriptedFailure[] = [];
  private readonly topics = new Map<string, { name: string; closed: boolean; deleted: boolean }>();
  private readonly pinnedMessages = new Map<number, number>();
  private readonly members = new Map<number, Map<number, ChatMember>>();
  private readonly invites = new Map<string, Invite>();
  private nextInviteId = 1;
  readonly calls: ApiCall[] = [];
  private nextUpdateId = 100_000;
  private nextMessageId = 1;
  private nextCallbackId = 1;
  private nextTopicId = 1000;
  private outage: "refuse" | "hang" | null = null;
  private duplicateNext = false;
  private readonly dropResponses = new Map<string, number>();
  private readonly pushedAt = new WeakMap<Json, number>();
  private readonly delayedResponses: Array<{ method: string; ms: number }> = [];
  /**
   * Real Telegram refuses answers to a callback query about 15s after the tap, the time the app waits for a toast
   * ("query is too old"). Measured on the test bot 2026-09-15: sent 13s after the bot received the update accepted,
   * 14s refused (S-H6-09).
   */
  callbackAnswerWindowMs = 15_000;
  /**
   * Real Telegram drops a tap's callback_query update that the bot has not confirmed about two and a half minutes
   * after the tap, even if it was fetched; messages stay. Measured on the test bot 2026-09-15: pending 141s after
   * the tap, gone at 151s. So a tap made while the workstation is offline longer than that never arrives.
   */
  callbackUpdateRetentionMs = 145_000;
  /** Upper bound on a held getUpdates, so harness teardown never waits 25s. */
  maxPollHoldMs = 60_000;

  addBot(bot: FakeBot): void {
    this.bots.set(bot.token, bot);
    this.updates.set(bot.id, []);
  }

  addChatMember(chat: FakeChat, user: FakeUser | FakeBot, options: { administrator?: boolean; canPinMessages?: boolean; canInviteUsers?: boolean } = {}): void {
    this.registerChat(chat);
    const roster = this.members.get(chat.id)!;
    roster.set(user.id, { id: user.id, isBot: "token" in user, status: options.administrator ? "administrator" : "member", canPinMessages: options.canPinMessages ?? options.administrator ?? false, canInviteUsers: options.canInviteUsers ?? options.administrator ?? false });
  }

  removeChatMember(chatId: number, userId: number): void {
    this.members.get(chatId)?.delete(userId);
  }

  async joinChatByInvite(user: FakeUser | FakeBot, inviteLink: string): Promise<void> {
    const invite = this.invites.get(inviteLink);
    if (!invite || invite.uses >= invite.memberLimit) throw apiError(400, "Bad Request: invite link expired");
    const chat = this.knownChat(invite.chatId);
    if (!chat) throw apiError(400, "Bad Request: chat not found");
    this.addChatMember(chat, user);
    invite.uses += 1;
  }

  get url(): string {
    const address = this.server?.address() as AddressInfo | null;
    if (!address) throw new Error("fake Telegram server is not listening");
    return `http://127.0.0.1:${address.port}`;
  }

  async listen(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on("connection", (socket) => {
      if (this.outage === "refuse") {
        socket.destroy();
        return;
      }
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
  }

  async close(): Promise<void> {
    for (const poll of this.polls.values()) {
      clearTimeout(poll.timer);
      poll.resolve([]);
    }
    this.polls.clear();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  /* ---------------------------- fault injection --------------------------- */

  /** Answer the next `count` calls of `method` (or "*") with a Telegram error envelope. */
  failNext(method: string, errorCode: number, options: { count?: number; description?: string; retryAfter?: number } = {}): void {
    this.failures.push({ method, errorCode, description: options.description ?? ERROR_DESCRIPTIONS[errorCode] ?? "Error", ...(options.retryAfter === undefined ? {} : { retryAfter: options.retryAfter }), remaining: options.count ?? 1 });
  }

  /** "refuse" drops new connections; "hang" accepts requests and never answers; null restores service. */
  setOutage(mode: "refuse" | "hang" | null): void {
    this.outage = mode;
    if (mode !== null) for (const socket of this.sockets) socket.destroy();
  }

  /** Performs the next `count` calls of `method` but drops the response, as a lost network reply would. */
  dropNextResponse(method: string, count = 1): void {
    this.dropResponses.set(method, (this.dropResponses.get(method) ?? 0) + count);
  }

  /**
   * Performs the next `count` calls of `method` at once but holds each response for `ms`. Real Telegram shows a sent
   * message to the chat as soon as it processes the call, so a quick reply can reach the bot's poll before the
   * sendMessage response with that message's id reaches the bot (found by S-L1-32 on real Telegram).
   */
  delayNextResponse(method: string, ms: number, count = 1): void {
    for (let index = 0; index < count; index++) this.delayedResponses.push({ method, ms });
  }

  /** The next getUpdates response is delivered twice (the client's next poll sees it again). */
  duplicateNextDelivery(): void {
    this.duplicateNext = true;
  }

  /* ------------------------------ phone side ------------------------------ */

  userSendsMessage(bot: FakeBot, user: FakeUser, chat: FakeChat, text: string, options: { replyToMessageId?: number; topicId?: number } = {}): StoredMessage {
    const message = this.store(chat, { id: user.id, is_bot: false, first_name: user.firstName, ...(user.username ? { username: user.username } : {}) }, text, {
      ...(options.replyToMessageId === undefined ? {} : { reply_to_message: { message_id: options.replyToMessageId } }),
      ...(options.topicId === undefined ? {} : { message_thread_id: options.topicId, is_topic_message: true }),
    });
    const { history: _history, ...wire } = message;
    // Telegram embeds the whole replied-to message (one level deep), not just its id.
    const repliedTo = options.replyToMessageId === undefined ? undefined : this.find(chat.id, options.replyToMessageId);
    const update = {
      message: {
        ...wire,
        ...(repliedTo ? { reply_to_message: (({ reply_to_message: _nested, ...inner }) => inner)(wireMessage(repliedTo) as Json & { reply_to_message?: unknown }) } : {}),
        from: { id: user.id, is_bot: false, first_name: user.firstName, ...(user.lastName ? { last_name: user.lastName } : {}), ...(user.username ? { username: user.username } : {}) },
        chat: this.wireChat(chat, user),
      },
    };
    if (chat.type === "private") this.pushUpdate(bot.id, update);
    else {
      for (const member of this.members.get(chat.id)?.values() ?? []) {
        if (member.isBot && member.status === "administrator") this.pushUpdate(member.id, update);
      }
    }
    return message;
  }

  /** Taps an inline button; resolves with the toast once the bot answers the callback query, or null. */
  userTapsButton(bot: FakeBot, user: FakeUser, chat: FakeChat, messageId: number, callbackData: string, options: { messageChatId?: number } = {}): string {
    // `messageChatId` locates a message in one chat while the update claims another: a forged
    // callback no Telegram client can send, which the server must still refuse.
    const message = this.find(options.messageChatId ?? chat.id, messageId);
    if (!message) throw new Error(`message ${messageId} not in chat ${options.messageChatId ?? chat.id}`);
    const callbackQueryId = `${bot.id}${this.nextCallbackId++}`;
    this.openCallbacks.set(callbackQueryId, { botId: bot.id, createdAt: Date.now() });
    const { history: _history, ...wire } = message;
    this.pushUpdate(bot.id, {
      callback_query: {
        id: callbackQueryId,
        from: { id: user.id, is_bot: false, first_name: user.firstName, ...(user.username ? { username: user.username } : {}) },
        message: { ...wire, chat: this.wireChat(chat, user) },
        chat_instance: `ci-${chat.id}`,
        data: callbackData,
      },
    });
    return callbackQueryId;
  }

  callbackAnswer(callbackQueryId: string): CallbackAnswer | undefined {
    return this.callbackAnswers.find((answer) => answer.callbackQueryId === callbackQueryId);
  }

  transcript(chatId: number): StoredMessage[] {
    return [...(this.messages.get(chatId) ?? [])];
  }

  pendingUpdateCount(botId: number): number {
    if (!this.updates.has(botId)) return 0;
    return this.pending(botId).length;
  }

  /* ------------------------------ bot side -------------------------------- */

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.outage === "hang") return; // Never answer; the client's own timeout must fire.
    const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(req.url ?? "");
    const body = await readBody(req);
    const bot = match ? this.bots.get(match[1]!) : undefined;
    const method = match?.[2] ?? "";
    this.calls.push({ method, body, at: Date.now(), botId: bot?.id ?? null });
    if (!match) return send(res, 404, { ok: false, error_code: 404, description: "Not Found" });
    if (!bot) return send(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });

    const scripted = this.failures.find((failure) => failure.remaining > 0 && (failure.method === method || failure.method === "*"));
    if (scripted) {
      scripted.remaining -= 1;
      return send(res, scripted.errorCode, {
        ok: false,
        error_code: scripted.errorCode,
        description: scripted.description,
        ...(scripted.retryAfter === undefined ? {} : { parameters: { retry_after: scripted.retryAfter } }),
      });
    }

    try {
      const result = await this.dispatch(bot, method, body);
      const drops = this.dropResponses.get(method) ?? 0;
      if (drops > 0) {
        this.dropResponses.set(method, drops - 1);
        req.socket.destroy();
        return;
      }
      const delayed = this.delayedResponses.findIndex((entry) => entry.method === method);
      if (delayed >= 0) {
        const { ms } = this.delayedResponses.splice(delayed, 1)[0]!;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
      }
      send(res, 200, result instanceof Described ? { ok: true, result: result.result, description: result.description } : { ok: true, result });
    } catch (error) {
      const failure = error as { code?: number; description?: string };
      const code = failure.code ?? 400;
      send(res, code, { ok: false, error_code: code, description: failure.description ?? String(error) });
    }
  }

  private async dispatch(bot: FakeBot, method: string, body: Json): Promise<unknown> {
    switch (method) {
      case "getMe":
        return { id: bot.id, is_bot: true, first_name: bot.username, username: bot.username, can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, supports_guest_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
      case "getUpdates":
        return this.getUpdates(bot, body);
      case "getWebhookInfo":
        // Bots here only long poll, so the webhook is always unset.
        return { url: "", has_custom_certificate: false, pending_update_count: this.pending(bot.id).length };
      case "deleteWebhook":
        if (body.drop_pending_updates === true) this.updates.set(bot.id, []);
        // Bots here only long poll, so there is never a webhook to delete.
        return new Described(true, "Webhook is already deleted");
      case "sendMessage":
        return this.sendMessage(bot, body);
      case "editMessageText":
        return this.editMessageText(bot, body);
      case "answerCallbackQuery":
        return this.answerCallbackQuery(body);
      case "pinChatMessage":
        return this.pinChatMessage(bot, body);
      case "unpinChatMessage":
        return this.unpinChatMessage(bot, body);
      case "getChatMember":
        return this.getChatMember(body);
      case "createChatInviteLink":
        return this.createChatInviteLink(bot, body);
      case "setMyCommands":
        if (!Array.isArray(body.commands)) throw apiError(400, "Bad Request: commands must be an array");
        return true;
      case "createForumTopic":
        return this.createForumTopic(body);
      case "editForumTopic":
      case "closeForumTopic":
      case "reopenForumTopic":
      case "deleteForumTopic":
        return this.changeForumTopic(method, body);
      default:
        throw apiError(404, "Not Found");
    }
  }

  private getUpdates(bot: FakeBot, body: Json): Promise<Json[]> {
    const offset = typeof body.offset === "number" ? body.offset : 0;
    const timeout = typeof body.timeout === "number" ? body.timeout : 0;
    const queue = this.updates.get(bot.id)!;
    // Telegram confirms (forgets) every update below the requested offset.
    this.updates.set(bot.id, queue.filter((update) => (update.update_id as number) >= offset));
    this.pending(bot.id);
    const existing = this.polls.get(bot.id);
    if (existing) {
      clearTimeout(existing.timer);
      this.polls.delete(bot.id);
      existing.resolve(Object.assign([], { conflict: true }) as Json[]);
    }
    const ready = this.updates.get(bot.id)!;
    if (ready.length > 0 || timeout === 0) return Promise.resolve(this.deliver(ready));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.polls.delete(bot.id);
        resolve([]);
      }, Math.min(timeout * 1000, this.maxPollHoldMs));
      this.polls.set(bot.id, { botId: bot.id, offset, resolve, timer });
    }).then((updates) => {
      if ((updates as { conflict?: boolean }).conflict) throw apiError(409, ERROR_DESCRIPTIONS[409]!);
      return updates as Json[];
    });
  }

  private deliver(updates: Json[]): Json[] {
    const batch = updates.slice(0, 100);
    if (this.duplicateNext && batch.length > 0) {
      this.duplicateNext = false;
      return [...batch, ...batch];
    }
    return batch;
  }

  /** The bot's unconfirmed updates, after Telegram has dropped taps older than the retention (S-L1-15). */
  private pending(botId: number): Json[] {
    const queue = this.updates.get(botId)!;
    const kept = queue.filter((update) => !(update.callback_query && Date.now() - (this.pushedAt.get(update) ?? Date.now()) > this.callbackUpdateRetentionMs));
    if (kept.length !== queue.length) this.updates.set(botId, kept);
    return kept;
  }

  private pushUpdate(botId: number, update: Json): void {
    const queue = this.updates.get(botId);
    if (!queue) throw new Error(`unknown bot ${botId}`);
    const stored = { update_id: this.nextUpdateId++, ...update };
    this.pushedAt.set(stored, Date.now());
    queue.push(stored);
    const poll = this.polls.get(botId);
    if (poll) {
      clearTimeout(poll.timer);
      this.polls.delete(botId);
      poll.resolve(this.deliver(queue.filter((item) => (item.update_id as number) >= poll.offset)));
    }
  }

  private sendMessage(bot: FakeBot, body: Json): Json {
    const chatId = Number(body.chat_id);
    const chat = this.knownChat(chatId);
    if (!chat) throw apiError(400, "Bad Request: chat not found");
    this.validateText(body);
    const threadId = typeof body.message_thread_id === "number" ? body.message_thread_id : undefined;
    if (threadId !== undefined) {
      const topic = this.topics.get(`${chatId}:${threadId}`);
      if (!topic || topic.deleted) throw apiError(400, "Bad Request: message thread not found");
      if (topic.closed) throw apiError(400, "Bad Request: TOPIC_CLOSED");
    }
    // A reply keeps a subject's messages together where there are no topics (L3 C1).
    // Telegram refuses a reply to a message that is gone unless the sender allows it.
    const replyTo = typeof body.reply_to_message_id === "number" ? body.reply_to_message_id : undefined;
    const replied = replyTo === undefined ? undefined : this.find(chatId, replyTo);
    if (replyTo !== undefined && !replied && body.allow_sending_without_reply !== true) throw apiError(400, "Bad Request: message to be replied not found");
    const message = this.store(chat, { id: bot.id, is_bot: true, first_name: bot.username, username: bot.username }, body.text, {
      ...(isKeyboard(body.reply_markup) ? { reply_markup: body.reply_markup } : {}),
      ...entitiesField(body),
      ...(threadId === undefined ? {} : { message_thread_id: threadId, is_topic_message: true }),
      ...(replied ? { reply_to_message: { message_id: replied.message_id } } : {}),
    });
    return wireMessage(message);
  }

  /** Pins a message in a chat, as the control panel is pinned once (L3 C1). */
  private pinChatMessage(bot: FakeBot, body: Json): boolean {
    const chatId = Number(body.chat_id);
    const chat = this.knownChat(chatId);
    if (!chat) throw apiError(400, "Bad Request: chat not found");
    const message = this.find(chatId, Number(body.message_id));
    if (!message) throw apiError(400, "Bad Request: message to pin not found");
    if (chat.type !== "private" && !this.can(bot.id, chatId, "canPinMessages")) throw apiError(403, "Forbidden: not enough rights to pin messages");
    this.pinnedMessages.set(chatId, message.message_id);
    return true;
  }

  private unpinChatMessage(bot: FakeBot, body: Json): boolean {
    const chatId = Number(body.chat_id);
    const chat = this.knownChat(chatId);
    if (!chat) throw apiError(400, "Bad Request: chat not found");
    if (chat.type !== "private" && !this.can(bot.id, chatId, "canPinMessages")) throw apiError(403, "Forbidden: not enough rights to pin messages");
    if (this.pinnedMessages.get(chatId) === Number(body.message_id)) this.pinnedMessages.delete(chatId);
    return true;
  }

  private getChatMember(body: Json): Json {
    const chatId = Number(body.chat_id);
    if (!this.knownChat(chatId)) throw apiError(400, "Bad Request: chat not found");
    const member = this.members.get(chatId)?.get(Number(body.user_id));
    if (!member) throw apiError(400, "Bad Request: user not found");
    return { user: { id: member.id, is_bot: member.isBot, first_name: member.isBot ? "Bot" : "User" }, status: member.status, ...(member.status === "administrator" ? { can_pin_messages: member.canPinMessages, can_invite_users: member.canInviteUsers } : {}) };
  }

  private createChatInviteLink(bot: FakeBot, body: Json): Json {
    const chatId = Number(body.chat_id);
    if (!this.knownChat(chatId)) throw apiError(400, "Bad Request: chat not found");
    if (!this.can(bot.id, chatId, "canInviteUsers")) throw apiError(403, "Forbidden: not enough rights to invite users");
    const memberLimit = typeof body.member_limit === "number" ? body.member_limit : 0;
    if (memberLimit < 1) throw apiError(400, "Bad Request: member_limit must be positive");
    const invite_link = `https://t.me/+fake${this.nextInviteId++}`;
    this.invites.set(invite_link, { chatId, memberLimit, uses: 0 });
    return { invite_link, creator: { id: bot.id, is_bot: true, first_name: bot.username, username: bot.username }, creates_join_request: false, is_primary: false, is_revoked: false, member_limit: memberLimit, pending_join_request_count: 0 };
  }

  /** Test control: the message currently pinned in a chat, if any. */
  pinnedMessageId(chatId: number): number | undefined {
    return this.pinnedMessages.get(chatId);
  }

  /** Telegram's limits: 4096 UTF-16 units of text, and entities that fit inside it. */
  private validateText(body: Json): asserts body is Json & { text: string } {
    if (typeof body.text !== "string" || body.text.trim() === "") throw apiError(400, "Bad Request: message text is empty");
    if (body.text.length > 4096) throw apiError(400, "Bad Request: message is too long");
    if (body.parse_mode !== undefined) throw apiError(400, "Bad Request: the harness fake does not model parse_mode");
    if (body.entities === undefined) return;
    if (!Array.isArray(body.entities)) throw apiError(400, "Bad Request: can't parse entities: entities must be an array");
    for (const entity of body.entities as Array<Record<string, unknown>>) {
      const offset = entity.offset;
      const length = entity.length;
      if (typeof entity.type !== "string" || !KNOWN_ENTITY_TYPES.has(entity.type)) throw apiError(400, `Bad Request: can't parse entities: unsupported entity type "${String(entity.type)}"`);
      if (typeof offset !== "number" || typeof length !== "number" || offset < 0 || length <= 0 || offset + length > body.text.length) throw apiError(400, "Bad Request: can't parse entities: entity is out of the text bounds");
    }
  }

  private editMessageText(bot: FakeBot, body: Json): Json {
    const message = this.find(Number(body.chat_id), Number(body.message_id));
    if (!message) throw apiError(400, "Bad Request: message to edit not found");
    if (message.from.id !== bot.id) throw apiError(400, "Bad Request: message can't be edited");
    this.validateText(body);
    const markup = isKeyboard(body.reply_markup) ? body.reply_markup : undefined;
    if (message.text === body.text && JSON.stringify(message.reply_markup) === JSON.stringify(markup)) {
      throw apiError(400, "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message");
    }
    message.text = body.text;
    message.history.push(body.text);
    message.edit_date = Math.floor(Date.now() / 1000);
    if (markup) message.reply_markup = markup;
    else delete message.reply_markup;
    // An edit replaces the entities too: the ones it passes plus what Telegram detects in the new text.
    delete message.entities;
    delete message.link_preview_options;
    Object.assign(message, entitiesField(body));
    return wireMessage(message);
  }

  private answerCallbackQuery(body: Json): boolean {
    const id = String(body.callback_query_id ?? "");
    const open = this.openCallbacks.get(id);
    if (!open || Date.now() - open.createdAt > this.callbackAnswerWindowMs) throw apiError(400, "Bad Request: query is too old and response timeout expired or query ID is invalid");
    // Real Telegram accepts a repeated answer while the query is open; the phone shows only the first.
    this.callbackAnswers.push({ callbackQueryId: id, text: typeof body.text === "string" ? body.text : "", answeredAt: Date.now() });
    return true;
  }

  private createForumTopic(body: Json): Json {
    const chatId = Number(body.chat_id);
    const chat = this.knownChat(chatId);
    if (!chat) throw apiError(400, "Bad Request: chat not found");
    if (!chat.isForum) throw apiError(400, "Bad Request: the chat is not a forum");
    if (typeof body.name !== "string" || body.name.length < 1 || body.name.length > 128) throw apiError(400, "Bad Request: invalid topic name");
    const threadId = this.nextTopicId++;
    this.topics.set(`${chatId}:${threadId}`, { name: body.name, closed: false, deleted: false });
    return { message_thread_id: threadId, name: body.name, icon_color: 7322096 };
  }

  private changeForumTopic(method: string, body: Json): boolean {
    const topic = this.topics.get(`${Number(body.chat_id)}:${Number(body.message_thread_id)}`);
    if (!topic || topic.deleted) throw apiError(400, "Bad Request: TOPIC_ID_INVALID");
    if (method === "closeForumTopic") {
      if (topic.closed) throw apiError(400, "Bad Request: TOPIC_NOT_MODIFIED");
      topic.closed = true;
    } else if (method === "reopenForumTopic") {
      if (!topic.closed) throw apiError(400, "Bad Request: TOPIC_NOT_MODIFIED");
      topic.closed = false;
    } else if (method === "deleteForumTopic") {
      topic.deleted = true;
    } else if (typeof body.name === "string") {
      topic.name = body.name;
    }
    return true;
  }

  /** Test control: the operator deletes a topic from their phone. */
  /** The user deletes a message for everyone in a private chat; later edits of it are "message to edit not found". */
  userDeletesMessage(chatId: number, messageId: number): void {
    const list = this.messages.get(chatId) ?? [];
    this.messages.set(chatId, list.filter((message) => message.message_id !== messageId));
  }

  userDeletesTopic(chatId: number, threadId: number): void {
    const topic = this.topics.get(`${chatId}:${threadId}`);
    if (topic) topic.deleted = true;
  }

  topicState(chatId: number, threadId: number): { name: string; closed: boolean; deleted: boolean } | undefined {
    return this.topics.get(`${chatId}:${threadId}`);
  }

  /* ------------------------------ internals ------------------------------- */

  private readonly chats = new Map<number, FakeChat>();

  registerChat(chat: FakeChat): void {
    this.chats.set(chat.id, chat);
    if (!this.members.has(chat.id)) this.members.set(chat.id, new Map());
  }

  private can(botId: number, chatId: number, right: "canPinMessages" | "canInviteUsers"): boolean {
    const member = this.members.get(chatId)?.get(botId);
    return member?.status === "administrator" && member[right];
  }

  private knownChat(chatId: number): FakeChat | undefined {
    return this.chats.get(chatId);
  }

  private wireChat(chat: FakeChat, user: FakeUser): Json {
    return chat.type === "private"
      ? { id: chat.id, type: "private", first_name: user.firstName, ...(user.username ? { username: user.username } : {}) }
      : { id: chat.id, type: chat.type, title: chat.title ?? "Group", ...(chat.isForum ? { is_forum: true } : {}) };
  }

  private store(chat: FakeChat, from: StoredMessage["from"], text: string, extra: Partial<StoredMessage>): StoredMessage {
    this.registerChat(chat);
    const message: StoredMessage = { message_id: this.nextMessageId++, chat, from, date: Math.floor(Date.now() / 1000), text, history: [text], ...extra };
    const list = this.messages.get(chat.id) ?? [];
    list.push(message);
    this.messages.set(chat.id, list);
    return message;
  }

  private find(chatId: number, messageId: number): StoredMessage | undefined {
    return this.messages.get(chatId)?.find((message) => message.message_id === messageId);
  }
}

/** A successful result Telegram sends with a description, as deleteWebhook does. */
class Described {
  constructor(
    readonly result: unknown,
    readonly description: string,
  ) {}
}

/**
 * A bot message's `entities` field as real Telegram returns it (absent when there are none), and its
 * `link_preview_options`, which Telegram echoes only when the text holds a link.
 */
function entitiesField(body: Json & { text: string }): { entities?: Entity[]; link_preview_options?: unknown } {
  const entities = messageEntities(body.text, Array.isArray(body.entities) ? (body.entities as Entity[]) : undefined);
  const preview = body.link_preview_options !== undefined && entities.some((entity) => entity.type === "url") ? { link_preview_options: body.link_preview_options } : {};
  return { ...(entities.length > 0 ? { entities } : {}), ...preview };
}

function isKeyboard(value: unknown): value is { inline_keyboard: InlineButton[][] } {
  return value !== null && typeof value === "object" && Array.isArray((value as Json).inline_keyboard);
}

const KNOWN_ENTITY_TYPES = new Set(["mention", "hashtag", "cashtag", "bot_command", "url", "email", "phone_number", "bold", "italic", "underline", "strikethrough", "spoiler", "blockquote", "expandable_blockquote", "code", "pre", "text_link", "text_mention", "custom_emoji"]);

function wireMessage(message: StoredMessage): Json {
  const { history: _history, chat, ...rest } = message;
  return { ...rest, chat: chat.type === "private" ? { id: chat.id, type: "private" } : { id: chat.id, type: chat.type, title: chat.title } };
}

function apiError(code: number, description: string): Error {
  return Object.assign(new Error(description), { code, description });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Json> {
  return new Promise((resolve) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (raw += chunk));
    req.on("end", () => {
      try {
        const parsed = raw === "" ? {} : (JSON.parse(raw) as unknown);
        resolve(parsed !== null && typeof parsed === "object" ? (parsed as Json) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}
