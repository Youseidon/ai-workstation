export interface TelegramUpdate {
  updateId: number;
  payload: unknown;
}

export interface TelegramSendRequest {
  chatId: string;
  topicId: string | null;
  payload: unknown;
}

/** Normalized inbox payload for a button tap. Matches the adapter's callback shape. */
export interface TelegramCallbackPayload {
  kind: "callback";
  ref: string;
  transportUserId: string;
  chatId: string;
  topicId: string | null;
  messageId: string;
  commandId: string;
  callbackQueryId: string;
}

/** Normalized inbox payload for a text message sent to the bot. */
export interface TelegramMessagePayload {
  kind: "message";
  transportUserId: string;
  chatId: string;
  chatType: string;
  topicId: string | null;
  messageId: string;
  replyToMessageId: string | null;
  text: string;
  label: string;
  username: string | null;
}

export interface TelegramUnsupportedPayload {
  kind: "unsupported";
  type: string;
}

export interface TelegramBotApi {
  getUpdates(offset: number, options?: { signal?: AbortSignal }): Promise<TelegramUpdate[]>;
  sendMessage(request: TelegramSendRequest): Promise<{ messageId: string }>;
}

/** Operations only the live Bot API needs; the fake transport has no use for them. */
export interface LiveTelegramBotApi extends TelegramBotApi {
  getMe(options?: { signal?: AbortSignal }): Promise<{ id: string; username: string | null }>;
  answerCallbackQuery(callbackQueryId: string, text: string): Promise<void>;
}

export type TelegramApiErrorKind =
  /** 429: Telegram told us how long to wait. */
  | "rate_limited"
  /** Network failure, timeout or 5xx: safe to retry with backoff. */
  | "transient"
  /** 401/404 on the token: retrying will not help until the token changes. */
  | "unauthorized"
  /** 409: a webhook is set or another process is polling this bot. */
  | "conflict"
  /** Any other 4xx, e.g. chat not found or the user blocked the bot. */
  | "rejected";

/**
 * Every error the live client throws. Its message is always sanitized: Bot API
 * tokens sit inside the request URL, so a raw fetch error must never escape.
 */
export class TelegramApiError extends Error {
  constructor(
    readonly kind: TelegramApiErrorKind,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }

  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "transient" || this.kind === "conflict";
  }
}

const TOKEN_SHAPE = /\d{5,}:[A-Za-z0-9_-]{20,}/g;

/** Removes the given token, and anything shaped like a Bot API token, from text. */
export function redactBotToken(text: string, token?: string | null): string {
  let output = text;
  if (token) output = output.split(token).join("[redacted-token]");
  return output.replace(TOKEN_SHAPE, "[redacted-token]");
}
