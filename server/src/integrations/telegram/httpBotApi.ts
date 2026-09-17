import { TelegramApiError, redactBotToken, type LiveTelegramBotApi, type TelegramCallbackPayload, type TelegramEditRequest, type TelegramMessagePayload, type TelegramSendRequest, type TelegramUnsupportedPayload, type TelegramUpdate } from "./botApi.ts";
import type { BotToken } from "./credentials.ts";
import { formatTelegramMessage } from "./liveFormat.ts";

/** Long-poll window from the design defaults (README "Telegram polling"). */
export const TELEGRAM_POLL_TIMEOUT_SECONDS = 25;

export interface HttpTelegramBotApiOptions {
  token: BotToken;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  baseUrl?: string;
  pollTimeoutSeconds?: number;
  requestTimeoutMs?: number;
  /** Looks up the answer bound to a button's action reference when rendering. */
  contentForRef?: (ref: string) => string | null;
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function id(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" && value !== "" ? value : null;
}

function topicOf(message: Json): string | null {
  return message.is_topic_message === true ? id(message.message_thread_id) : null;
}

/**
 * Keeps only the fields task control needs from a raw Bot API update, so the
 * inbox stores task-related input rather than the whole Telegram object.
 */
export function normalizeTelegramUpdate(raw: unknown): TelegramUpdate | null {
  const update = record(raw);
  if (!update || typeof update.update_id !== "number" || !Number.isSafeInteger(update.update_id)) return null;
  const updateId = update.update_id;
  const callback = record(update.callback_query);
  if (callback) {
    const message = record(callback.message);
    const chat = record(message?.chat);
    const from = record(callback.from);
    const callbackQueryId = id(callback.id);
    const userId = id(from?.id);
    const chatId = id(chat?.id);
    const messageId = id(message?.message_id);
    if (!message || typeof callback.data !== "string" || !callbackQueryId || !userId || !chatId || !messageId) {
      return { updateId, payload: { kind: "unsupported", type: "callback_query" } satisfies TelegramUnsupportedPayload };
    }
    return {
      updateId,
      payload: {
        kind: "callback",
        ref: callback.data,
        transportUserId: userId,
        chatId,
        topicId: topicOf(message),
        messageId,
        commandId: `tg-callback-${callbackQueryId}`,
        callbackQueryId,
      } satisfies TelegramCallbackPayload,
    };
  }
  const message = record(update.message);
  if (message) {
    const chat = record(message.chat);
    const from = record(message.from);
    const userId = id(from?.id);
    const chatId = id(chat?.id);
    const messageId = id(message.message_id);
    if (typeof message.text !== "string" || !userId || !chatId || !messageId || from?.is_bot === true) {
      return { updateId, payload: { kind: "unsupported", type: "message" } satisfies TelegramUnsupportedPayload };
    }
    const label = [from?.first_name, from?.last_name].filter((part): part is string => typeof part === "string" && part !== "").join(" ");
    return {
      updateId,
      payload: {
        kind: "message",
        transportUserId: userId,
        chatId,
        chatType: typeof chat?.type === "string" ? chat.type : "unknown",
        topicId: topicOf(message),
        messageId,
        replyToMessageId: id(record(message.reply_to_message)?.message_id),
        text: message.text,
        label: label || (typeof from?.username === "string" ? from.username : `Telegram user ${userId}`),
        username: typeof from?.username === "string" ? from.username : null,
      } satisfies TelegramMessagePayload,
    };
  }
  const type = Object.keys(update).find(key => key !== "update_id") ?? "unknown";
  return { updateId, payload: { kind: "unsupported", type } satisfies TelegramUnsupportedPayload };
}

/** The real Bot API over HTTPS. Outbound only: long polling, never a webhook. */
export class HttpTelegramBotApi implements LiveTelegramBotApi {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly pollTimeoutSeconds: number;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: HttpTelegramBotApiOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = (options.baseUrl ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? TELEGRAM_POLL_TIMEOUT_SECONDS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  async getMe(options?: { signal?: AbortSignal }): Promise<{ id: string; username: string | null }> {
    const result = record(await this.call("getMe", {}, { signal: options?.signal }));
    const botId = id(result?.id);
    if (!botId) throw new TelegramApiError("transient", "Telegram getMe returned an unexpected result.");
    return { id: botId, username: typeof result?.username === "string" ? result.username : null };
  }

  async getUpdates(offset: number, options?: { signal?: AbortSignal }): Promise<TelegramUpdate[]> {
    const result = await this.call(
      "getUpdates",
      { offset, timeout: this.pollTimeoutSeconds, allowed_updates: ["message", "callback_query"] },
      { signal: options?.signal, timeoutMs: this.pollTimeoutSeconds * 1000 + 10_000 },
    );
    if (!Array.isArray(result)) throw new TelegramApiError("transient", "Telegram getUpdates returned an unexpected result.");
    return result.flatMap(raw => {
      const update = normalizeTelegramUpdate(raw);
      return update ? [update] : [];
    });
  }

  async sendMessage(request: TelegramSendRequest): Promise<{ messageId: string }> {
    const message = formatTelegramMessage(request.payload, this.options.contentForRef ?? (() => null));
    const body: Json = {
      chat_id: request.chatId,
      text: message.text,
      link_preview_options: { is_disabled: true },
    };
    if (request.topicId !== null) body.message_thread_id = Number(request.topicId);
    if (request.replyToMessageId !== undefined && request.replyToMessageId !== null) {
      // The anchor may have been deleted between queueing and sending; the message still
      // has to arrive, so Telegram is told to send it without the quote in that case.
      body.reply_to_message_id = Number(request.replyToMessageId);
      body.allow_sending_without_reply = true;
    }
    if (message.replyMarkup !== null) body.reply_markup = message.replyMarkup;
    if (message.entities.length > 0) body.entities = message.entities;
    const messageId = id(record(await this.withoutRejectedEntities("sendMessage", body))?.message_id);
    if (!messageId) throw new TelegramApiError("transient", "Telegram sendMessage returned no message id.");
    return { messageId };
  }

  async editMessageText(request: TelegramEditRequest): Promise<{ modified: boolean }> {
    const messageId = Number(request.messageId);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new TelegramApiError("rejected", "Telegram editMessageText needs a sent message id.");
    const message = formatTelegramMessage(request.payload, this.options.contentForRef ?? (() => null));
    const body: Json = {
      chat_id: request.chatId,
      message_id: messageId,
      text: message.text,
      link_preview_options: { is_disabled: true },
    };
    if (message.replyMarkup !== null) body.reply_markup = message.replyMarkup;
    if (message.entities.length > 0) body.entities = message.entities;
    try {
      await this.withoutRejectedEntities("editMessageText", body);
      return { modified: true };
    } catch (error) {
      // Telegram refuses an edit that changes nothing; the message already shows this content.
      if (error instanceof TelegramApiError && error.kind === "rejected" && /\(400\): Bad Request: message is not modified/.test(error.message)) return { modified: false };
      throw error;
    }
  }

  /**
   * If Telegram refuses a message only because of its entities, the same text is sent once more
   * without them, so the operator still gets the question (operator question 8 in l3-f3-a.md).
   */
  private async withoutRejectedEntities(method: string, body: Json): Promise<unknown> {
    try {
      return await this.call(method, body);
    } catch (error) {
      if (!("entities" in body) || !(error instanceof TelegramApiError) || error.kind !== "rejected" || !/entit/i.test(error.message)) throw error;
      const { entities: _entities, ...plain } = body;
      return this.call(method, plain);
    }
  }

  async setMyCommands(commands: ReadonlyArray<{ command: string; description: string }>): Promise<void> {
    await this.call("setMyCommands", { commands });
  }

  async pinChatMessage(chatId: string, messageId: string): Promise<void> {
    // Silent: the panel is a reference, not news, and a pin notification on every
    // workstation would be exactly the churn this slice avoids.
    await this.call("pinChatMessage", { chat_id: chatId, message_id: Number(messageId), disable_notification: true });
  }

  async getChatMember(chatId: string, userId: string): Promise<{ status: string; canPinMessages: boolean; canInviteUsers: boolean }> {
    const member = record(await this.call("getChatMember", { chat_id: chatId, user_id: Number(userId) }));
    const status = typeof member?.status === "string" ? member.status : "left";
    return { status, canPinMessages: member?.can_pin_messages === true, canInviteUsers: member?.can_invite_users === true };
  }

  async answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: callbackQueryId, text: text.slice(0, 200) });
  }

  private redact(text: string): string {
    return redactBotToken(text, this.options.token.reveal());
  }

  private async call(method: string, body: Json, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.requestTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/bot${this.options.token.reveal()}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // Never rethrow the raw error: its message, cause or stack can carry the URL.
      if (options.signal?.aborted) throw new TelegramApiError("transient", `Telegram ${method} was cancelled.`);
      if (timeout.aborted) throw new TelegramApiError("transient", `Telegram ${method} timed out.`);
      throw new TelegramApiError("transient", `Telegram ${method} network failure: ${this.describe(error)}`);
    }
    let parsed: Json | null = null;
    try {
      parsed = record(await response.json());
    } catch {
      parsed = null;
    }
    if (response.ok && parsed?.ok === true) return parsed.result;
    const code = typeof parsed?.error_code === "number" ? parsed.error_code : response.status;
    const description = this.redact(typeof parsed?.description === "string" ? parsed.description : response.statusText || "no description");
    const message = `Telegram ${method} failed (${code}): ${description}`;
    if (code === 429) {
      const seconds = record(parsed?.parameters)?.retry_after;
      return this.fail("rate_limited", message, typeof seconds === "number" && seconds >= 0 ? seconds * 1000 : 1000);
    }
    if (code === 401 || code === 404) return this.fail("unauthorized", message);
    if (code === 409) return this.fail("conflict", message);
    if (code >= 500) return this.fail("transient", message);
    return this.fail("rejected", message);
  }

  private fail(kind: TelegramApiError["kind"], message: string, retryAfterMs: number | null = null): never {
    throw new TelegramApiError(kind, message, retryAfterMs);
  }

  private describe(error: unknown): string {
    const parts: string[] = [];
    if (error instanceof Error) {
      parts.push(error.message);
      const cause = record((error as { cause?: unknown }).cause);
      if (typeof cause?.code === "string") parts.push(cause.code);
    } else {
      parts.push(String(error));
    }
    return this.redact(parts.join(" / "));
  }
}
