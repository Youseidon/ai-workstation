export interface TelegramUser { id: number; is_bot: boolean; first_name: string; username?: string }
export interface TelegramChat { id: number; type: string }
export interface TelegramMessage { message_id: number; from?: TelegramUser; chat: TelegramChat; text?: string; reply_to_message?: TelegramMessage }
export interface TelegramCallbackQuery { id: string; from: TelegramUser; message?: TelegramMessage; data?: string }
export interface TelegramUpdate { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallbackQuery }
export interface InlineButton { text: string; callback_data: string }
export type ReplyMarkup =
  | { inline_keyboard: InlineButton[][] }
  | { force_reply: true; input_field_placeholder?: string };

export interface BotApi {
  getMe(): Promise<TelegramUser>;
  getUpdates(offset: number, timeoutSeconds: number, signal: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number, text: string, markup?: ReplyMarkup): Promise<TelegramMessage>;
  editMessageText(chatId: number, messageId: number, text: string, markup?: ReplyMarkup): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void>;
  deleteWebhook(): Promise<void>;
}

export class TelegramApiError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterSeconds: number | null = null) { super(message); }
}

export function isBotToken(value: string): boolean {
  return /^\d{3,20}:[A-Za-z0-9_-]{30,80}$/.test(value);
}

const API_ORIGIN = "https://api.telegram.org";

export function createBotApi(token: string, fetchImpl: typeof fetch = fetch): BotApi {
  if (!isBotToken(token)) throw new TelegramApiError(400, "That does not look like a bot token from @BotFather.");
  async function call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 15_000): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${API_ORIGIN}/bot${token}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new TelegramApiError(0, "Telegram could not be reached.");
    }
    let data: { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
    try { data = await response.json() as typeof data; } catch { throw new TelegramApiError(response.status, "Telegram sent an unreadable reply."); }
    if (!response.ok || data.ok !== true) {
      const description = typeof data.description === "string" ? data.description.replaceAll(token, "[token]").slice(0, 200) : "request failed";
      throw new TelegramApiError(response.status, `Telegram ${method}: ${description}`, data.parameters?.retry_after ?? null);
    }
    return data.result as T;
  }
  const options = { parse_mode: "HTML", link_preview_options: { is_disabled: true } };
  return {
    getMe: () => call<TelegramUser>("getMe", {}),
    getUpdates: (offset, timeoutSeconds, signal) => call<TelegramUpdate[]>("getUpdates", { offset, timeout: timeoutSeconds, allowed_updates: ["message", "callback_query"] }, signal, (timeoutSeconds + 15) * 1000),
    sendMessage: (chatId, text, markup) => call<TelegramMessage>("sendMessage", { chat_id: chatId, text, ...options, ...(markup ? { reply_markup: markup } : {}) }),
    async editMessageText(chatId, messageId, text, markup) {
      try {
        await call("editMessageText", { chat_id: chatId, message_id: messageId, text, ...options, ...(markup ? { reply_markup: markup } : {}) });
      } catch (error) {
        if (!(error instanceof TelegramApiError && /message is not modified/i.test(error.message))) throw error;
      }
    },
    answerCallbackQuery: async (id, text) => { await call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) }); },
    setMyCommands: async (commands) => { await call("setMyCommands", { commands }); },
    deleteWebhook: async () => { await call("deleteWebhook", { drop_pending_updates: false }); },
  };
}
