import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

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
  readonly calls: ApiCall[] = [];
  private nextUpdateId = 100_000;
  private nextMessageId = 1;
  private nextCallbackId = 1;
  private nextTopicId = 1000;
  private outage: "refuse" | "hang" | null = null;
  private duplicateNext = false;
  /** Real Telegram ignores answers to queries older than about 15 minutes. */
  callbackAnswerWindowMs = 15 * 60_000;
  /** Upper bound on a held getUpdates, so harness teardown never waits 25s. */
  maxPollHoldMs = 60_000;

  addBot(bot: FakeBot): void {
    this.bots.set(bot.token, bot);
    this.updates.set(bot.id, []);
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
    this.pushUpdate(bot.id, {
      message: {
        ...wire,
        from: { id: user.id, is_bot: false, first_name: user.firstName, ...(user.lastName ? { last_name: user.lastName } : {}), ...(user.username ? { username: user.username } : {}) },
        chat: this.wireChat(chat, user),
      },
    });
    return message;
  }

  /** Taps an inline button; resolves with the toast once the bot answers the callback query, or null. */
  userTapsButton(bot: FakeBot, user: FakeUser, chat: FakeChat, messageId: number, callbackData: string): string {
    const message = this.find(chat.id, messageId);
    if (!message) throw new Error(`message ${messageId} not in chat ${chat.id}`);
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
    return this.updates.get(botId)?.length ?? 0;
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
      send(res, 200, { ok: true, result });
    } catch (error) {
      const failure = error as { code?: number; description?: string };
      const code = failure.code ?? 400;
      send(res, code, { ok: false, error_code: code, description: failure.description ?? String(error) });
    }
  }

  private async dispatch(bot: FakeBot, method: string, body: Json): Promise<unknown> {
    switch (method) {
      case "getMe":
        return { id: bot.id, is_bot: true, first_name: bot.username, username: bot.username, can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
      case "getUpdates":
        return this.getUpdates(bot, body);
      case "sendMessage":
        return this.sendMessage(bot, body);
      case "editMessageText":
        return this.editMessageText(body);
      case "answerCallbackQuery":
        return this.answerCallbackQuery(body);
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
        throw apiError(404, "Not Found: method not found");
    }
  }

  private getUpdates(bot: FakeBot, body: Json): Promise<Json[]> {
    const offset = typeof body.offset === "number" ? body.offset : 0;
    const timeout = typeof body.timeout === "number" ? body.timeout : 0;
    const queue = this.updates.get(bot.id)!;
    // Telegram confirms (forgets) every update below the requested offset.
    this.updates.set(bot.id, queue.filter((update) => (update.update_id as number) >= offset));
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

  private pushUpdate(botId: number, update: Json): void {
    const queue = this.updates.get(botId);
    if (!queue) throw new Error(`unknown bot ${botId}`);
    queue.push({ update_id: this.nextUpdateId++, ...update });
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
    if (typeof body.text !== "string" || body.text.trim() === "") throw apiError(400, "Bad Request: message text is empty");
    if (body.text.length > 4096) throw apiError(400, "Bad Request: message is too long");
    const threadId = typeof body.message_thread_id === "number" ? body.message_thread_id : undefined;
    if (threadId !== undefined) {
      const topic = this.topics.get(`${chatId}:${threadId}`);
      if (!topic || topic.deleted) throw apiError(400, "Bad Request: message thread not found");
      if (topic.closed) throw apiError(400, "Bad Request: TOPIC_CLOSED");
    }
    const message = this.store(chat, { id: bot.id, is_bot: true, first_name: bot.username, username: bot.username }, body.text, {
      ...(isKeyboard(body.reply_markup) ? { reply_markup: body.reply_markup } : {}),
      ...(Array.isArray(body.entities) ? { entities: body.entities } : {}),
      ...(threadId === undefined ? {} : { message_thread_id: threadId, is_topic_message: true }),
    });
    return wireMessage(message);
  }

  private editMessageText(body: Json): Json {
    const message = this.find(Number(body.chat_id), Number(body.message_id));
    if (!message) throw apiError(400, "Bad Request: message to edit not found");
    if (typeof body.text !== "string" || body.text.trim() === "") throw apiError(400, "Bad Request: message text is empty");
    const markup = isKeyboard(body.reply_markup) ? body.reply_markup : undefined;
    if (message.text === body.text && JSON.stringify(message.reply_markup) === JSON.stringify(markup)) {
      throw apiError(400, "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message");
    }
    message.text = body.text;
    message.history.push(body.text);
    message.edit_date = Math.floor(Date.now() / 1000);
    if (markup) message.reply_markup = markup;
    else delete message.reply_markup;
    if (Array.isArray(body.entities)) message.entities = body.entities;
    return wireMessage(message);
  }

  private answerCallbackQuery(body: Json): boolean {
    const id = String(body.callback_query_id ?? "");
    const open = this.openCallbacks.get(id);
    if (!open || Date.now() - open.createdAt > this.callbackAnswerWindowMs) throw apiError(400, "Bad Request: query is too old and response timeout expired or query ID is invalid");
    this.openCallbacks.delete(id);
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

function isKeyboard(value: unknown): value is { inline_keyboard: InlineButton[][] } {
  return value !== null && typeof value === "object" && Array.isArray((value as Json).inline_keyboard);
}

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
