import { randomBytes } from "node:crypto";
import type { TelegramAccess, TelegramBotView, UserIdentity } from "@hydra/shared";
import type { RemoteOverview, TelegramNotice } from "../../contracts/remote.ts";
import { IdentityError, type IdentityStore, type TelegramLink } from "../../repositories/identities.ts";
import { createBotApi, TelegramApiError, type BotApi, type TelegramCallbackQuery, type TelegramMessage, type TelegramUpdate } from "./botApi.ts";
import { clip, confirmText, escapeHtml, gatesMessage, helpMessage, noticeMessage, pipelinesMessage, statusMessage, type BotAction, type ChatMessage } from "./messages.ts";

export interface RuntimeCaller {
  call(user: UserIdentity, method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
}

interface Logger { info(message: string): void; warn(message: string, error?: unknown): void; error(message: string, error?: unknown): void }

export interface TelegramBotOptions {
  identities: IdentityStore;
  runtime: RuntimeCaller;
  log: Logger;
  createApi?: (token: string) => BotApi;
  pollSeconds?: number;
  chatGapMs?: number;
  enabled?: boolean;
}

const ACTION_MS = 15 * 60 * 1000;
const COMPOSE_MS = 10 * 60 * 1000;
const MAX_TRACKED = 500;

interface PendingAction { userId: string; action: BotAction; label: string; expiresAt: number }
interface Compose { userId: string; promptId: number; title: string; expiresAt: number }

const COMMANDS = [
  { command: "status", description: "Running agents and pipelines" },
  { command: "pipelines", description: "Current and next step of each pipeline" },
  { command: "next", description: "Next step of each pipeline" },
  { command: "gates", description: "Questions agents are waiting on" },
  { command: "cancel", description: "Drop the answer you are writing" },
  { command: "help", description: "What this bot can do" },
];

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error: unknown }).error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  }
  return fallback;
}

export function createTelegramBot(options: TelegramBotOptions) {
  const { identities, runtime, log } = options;
  const createApi = options.createApi ?? ((token: string) => createBotApi(token));
  const pollSeconds = options.pollSeconds ?? 25;
  const chatGapMs = options.chatGapMs ?? 1100;
  const enabled = options.enabled ?? true;
  let api: BotApi | null = null;
  let controller: AbortController | null = null;
  let generation = 0;
  let view: TelegramBotView | null = null;
  let loop: Promise<void> = Promise.resolve();
  const actions = new Map<string, PendingAction>();
  const composing = new Map<number, Compose>();
  const gateMessages = new Map<string, { promptId: number; title: string }>();
  const queues = new Map<number, Promise<unknown>>();

  const remember = <K, V>(map: Map<K, V>, key: K, value: V) => {
    map.set(key, value);
    while (map.size > MAX_TRACKED) { const first = map.keys().next(); if (first.done) break; map.delete(first.value); }
  };

  const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

  function deliver<T>(chatId: number, send: (bot: BotApi) => Promise<T>): Promise<T | null> {
    const previous = queues.get(chatId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const bot = api;
      if (bot === null) return null;
      try {
        return await send(bot);
      } catch (error) {
        if (error instanceof TelegramApiError && error.status === 429 && error.retryAfterSeconds !== null && error.retryAfterSeconds <= 60) {
          await sleep(error.retryAfterSeconds * 1000);
          return await send(bot);
        }
        throw error;
      } finally {
        await sleep(chatGapMs);
      }
    }).catch((error: unknown) => { log.warn("telegram send failed", error); return null; });
    queues.set(chatId, next);
    void next.finally(() => { if (queues.get(chatId) === next) queues.delete(chatId); });
    return next;
  }

  const send = (chatId: number, message: ChatMessage) => deliver(chatId, bot => bot.sendMessage(chatId, message.text, message.markup));
  const edit = (chatId: number, messageId: number, message: ChatMessage) => deliver(chatId, bot => bot.editMessageText(chatId, messageId, message.text, message.markup));

  function token(userId: string): (action: BotAction, label: string) => string {
    return (action, label) => {
      const id = randomBytes(9).toString("base64url");
      remember(actions, id, { userId, action, label, expiresAt: Date.now() + ACTION_MS });
      return `x:${id}`;
    };
  }

  async function overview(user: UserIdentity): Promise<RemoteOverview> {
    const result = await runtime.call(user, "GET", "/api/remote/overview");
    if (result.status !== 200) throw new Error(errorMessage(result.body, "Hydra could not read this account."));
    return result.body as RemoteOverview;
  }

  async function render(user: UserIdentity, access: TelegramAccess, kind: "status" | "pipes" | "gates"): Promise<ChatMessage> {
    const state = await overview(user);
    const action = token(user.id);
    if (kind === "pipes") return pipelinesMessage(state, access, action);
    if (kind === "gates") return gatesMessage(state.gates, access, action);
    return statusMessage(state, access, action);
  }

  async function perform(user: UserIdentity, action: BotAction): Promise<string> {
    const post = async (path: string, body: Record<string, unknown> = {}) => {
      const result = await runtime.call(user, "POST", path, body);
      if (result.status >= 400) throw new Error(errorMessage(result.body, "Hydra refused that."));
      return result.body;
    };
    switch (action.kind) {
      case "stop_run": {
        const result = await post(`/api/runs/${encodeURIComponent(action.runId)}/interrupt`) as { pipelinePaused?: boolean };
        return result.pipelinePaused ? "Stopped. Its pipeline is paused." : "Stopped.";
      }
      case "play": await post(`/api/pipelines/${action.pipelineId}/play`); return "Started.";
      case "pause": await post(`/api/pipelines/${action.pipelineId}/pause`); return "Paused.";
      case "stop_pipeline": await post(`/api/pipelines/${action.pipelineId}/stop`); return "Stopped.";
      case "answer": await post(`/api/prompts/${action.promptId}/human-response`, { content: action.content }); return "Answer sent. The work item is ready to resume.";
      case "compose": return "";
    }
  }

  function auditDetail(action: BotAction, label: string): string {
    switch (action.kind) {
      case "stop_run": return `stopped agent: ${label}`;
      case "play": return `played pipeline: ${label}`;
      case "pause": return `paused pipeline: ${label}`;
      case "stop_pipeline": return `stopped pipeline: ${label}`;
      case "answer": return `answered: ${label}`;
      case "compose": return label;
    }
  }

  function startCompose(chatId: number, userId: string, promptId: number, title: string) {
    remember(composing, chatId, { userId, promptId, title, expiresAt: Date.now() + COMPOSE_MS });
    void send(chatId, { text: `✍️ Write your answer for <b>${escapeHtml(clip(title, 120))}</b>. /cancel to stop.`, markup: { force_reply: true, input_field_placeholder: "Your answer" } });
  }

  function confirmAnswer(chatId: number, userId: string, promptId: number, title: string, content: string) {
    const action: BotAction = { kind: "answer", promptId, content: clip(content, 20_000) };
    const id = token(userId)(action, title).slice(2);
    void send(chatId, { text: confirmText(action, title), markup: { inline_keyboard: [[{ text: "✅ Send", callback_data: `c:${id}` }, { text: "Cancel", callback_data: `n:${id}` }]] } });
  }

  function sender(from: { id: number } | undefined, chatId: number, chatType: string): { link: TelegramLink; user: UserIdentity } | null {
    if (from === undefined || chatType !== "private" || chatId !== from.id) return null;
    const found = identities.telegramLinkFor(from.id);
    return found !== null && found.link.chatId === chatId ? found : null;
  }

  async function onMessage(message: TelegramMessage) {
    const from = message.from;
    if (from === undefined || from.is_bot || message.chat.type !== "private" || message.chat.id !== from.id) return;
    const text = (message.text ?? "").trim();
    const command = /^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
    const name = command?.[1]?.toLowerCase();
    if (name === "start" && command?.[2]) {
      let user: UserIdentity | null = null;
      try {
        user = identities.claimTelegramLink(command[2].trim(), { telegramUserId: from.id, chatId: message.chat.id, telegramUsername: from.username ?? null });
      } catch (error) {
        if (error instanceof IdentityError) { await send(message.chat.id, { text: escapeHtml(error.message) }); return; }
        throw error;
      }
      if (user === null) { await send(message.chat.id, { text: "This link has expired or was already used. Create a new one on Hydra's Account page." }); return; }
      identities.audit(user.id, "linked", `Telegram ${from.username ? `@${from.username}` : from.id} connected`);
      await send(message.chat.id, { text: `✅ Connected to Hydra account <b>${escapeHtml(user.username)}</b>.\n\nYou will get a message when an agent needs your answer, a run fails or a pipeline finishes.` });
      await send(message.chat.id, helpMessage("notify"));
      return;
    }
    const linked = sender(from, message.chat.id, message.chat.type);
    if (linked === null) return;
    const { link, user } = linked;
    const chatId = message.chat.id;
    if (name === "start" || name === "help") { await send(chatId, helpMessage(link.access)); return; }
    if (name === "cancel") { composing.delete(chatId); await send(chatId, { text: "Cancelled." }); return; }
    if (name === "status" || name === "pipelines" || name === "next" || name === "gates") {
      await send(chatId, await render(user, link.access, name === "status" ? "status" : name === "gates" ? "gates" : "pipes"));
      return;
    }
    if (command) { await send(chatId, helpMessage(link.access)); return; }
    if (text === "") return;
    const replyTo = message.reply_to_message ? gateMessages.get(`${chatId}:${message.reply_to_message.message_id}`) : undefined;
    const draft = composing.get(chatId);
    const target = replyTo ?? (draft && draft.userId === user.id && draft.expiresAt > Date.now() ? { promptId: draft.promptId, title: draft.title } : undefined);
    if (target === undefined) { await send(chatId, helpMessage(link.access)); return; }
    if (link.access !== "control") { await send(chatId, { text: "This chat has notifications only. Allow full control on Hydra's Account page to answer from here." }); return; }
    composing.delete(chatId);
    confirmAnswer(chatId, user.id, target.promptId, target.title, text);
  }

  async function onCallback(query: TelegramCallbackQuery) {
    const bot = api;
    if (bot === null) return;
    const message = query.message;
    const linked = message ? sender(query.from, message.chat.id, message.chat.type) : null;
    const answer = (text?: string) => bot.answerCallbackQuery(query.id, text).catch((error: unknown) => log.warn("telegram callback answer failed", error));
    if (linked === null || message === undefined) { await answer(); return; }
    const { link, user } = linked;
    const chatId = message.chat.id;
    const data = query.data ?? "";
    const viewMatch = /^v:(status|pipes|gates)$/.exec(data);
    if (viewMatch) {
      await answer();
      await edit(chatId, message.message_id, await render(user, link.access, viewMatch[1] as "status" | "pipes" | "gates"));
      return;
    }
    const match = /^([xcn]):([A-Za-z0-9_-]{12})$/.exec(data);
    const step = match?.[1];
    const id = match?.[2];
    const pending = id === undefined ? undefined : actions.get(id);
    if (step === undefined || id === undefined || pending === undefined || pending.userId !== user.id || pending.expiresAt <= Date.now()) {
      await answer("That button has expired. Send /status for fresh ones.");
      return;
    }
    if (link.access !== "control") { await answer("This chat has notifications only."); return; }
    if (step === "n") { actions.delete(id); await answer("Cancelled."); await edit(chatId, message.message_id, { text: "Cancelled." }); return; }
    if (pending.action.kind === "compose") {
      actions.delete(id);
      await answer();
      startCompose(chatId, user.id, pending.action.promptId, pending.label);
      return;
    }
    if (step === "x") {
      await answer();
      await send(chatId, { text: confirmText(pending.action, pending.label), markup: { inline_keyboard: [[{ text: "✅ Confirm", callback_data: `c:${id}` }, { text: "Cancel", callback_data: `n:${id}` }]] } });
      return;
    }
    actions.delete(id);
    await answer("Working…");
    try {
      const result = await perform(user, pending.action);
      identities.audit(user.id, pending.action.kind, auditDetail(pending.action, pending.label));
      await edit(chatId, message.message_id, { text: `✅ ${escapeHtml(result)}`, markup: { inline_keyboard: [[{ text: "🔄 Status", callback_data: "v:status" }]] } });
    } catch (error) {
      identities.audit(user.id, `${pending.action.kind}_failed`, `${auditDetail(pending.action, pending.label)} · ${error instanceof Error ? error.message : "failed"}`);
      await edit(chatId, message.message_id, { text: `⚠️ ${escapeHtml(error instanceof Error ? error.message : "That did not work.")}` });
    }
  }

  async function handle(update: TelegramUpdate) {
    try {
      if (update.message) await onMessage(update.message);
      else if (update.callback_query) await onCallback(update.callback_query);
    } catch (error) {
      log.warn("telegram update failed", error);
      const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
      const fromId = update.message?.from?.id ?? update.callback_query?.from.id;
      if (chatId !== undefined && fromId !== undefined && identities.telegramLinkFor(fromId)?.link.chatId === chatId) {
        await send(chatId, { text: `⚠️ ${escapeHtml(error instanceof Error ? clip(error.message, 300) : "Something went wrong.")}` });
      }
    }
  }

  async function poll(bot: BotApi, mine: number, signal: AbortSignal, botUsername: string) {
    let backoff = 1000;
    let webhookCleared = false;
    while (!signal.aborted && mine === generation) {
      try {
        const offset = identities.telegramBot()?.updateOffset ?? 0;
        const updates = await bot.getUpdates(offset, pollSeconds, signal);
        if (mine !== generation) return;
        view = { username: botUsername, status: "polling", error: null };
        backoff = 1000;
        for (const update of updates) {
          identities.setTelegramOffset(update.update_id + 1);
          await handle(update);
        }
      } catch (error) {
        if (signal.aborted || mine !== generation) return;
        if (error instanceof TelegramApiError && (error.status === 401 || error.status === 404)) {
          view = { username: botUsername, status: "error", error: "Telegram rejected the bot token. Paste a current token from @BotFather." };
          log.warn("telegram bot token rejected; polling stopped");
          return;
        }
        if (error instanceof TelegramApiError && error.status === 409 && !webhookCleared) {
          webhookCleared = true;
          await bot.deleteWebhook().catch(() => undefined);
          continue;
        }
        view = {
          username: botUsername, status: "error",
          error: error instanceof TelegramApiError && error.status === 409
            ? "Another program is reading this bot's messages. Give Hydra a bot of its own."
            : "Cannot reach Telegram. Retrying.",
        };
        log.warn("telegram poll failed", error);
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  async function stopPolling() {
    generation++;
    controller?.abort();
    controller = null;
    api = null;
    await loop.catch(() => undefined);
  }

  async function startPolling() {
    await stopPolling();
    const record = identities.telegramBot();
    if (record === null) { view = null; return; }
    if (!enabled) {
      view = { username: record.username, status: "stopped", error: "Telegram only runs in the live console (npm run serve), so a sandbox never competes with it for the bot's messages." };
      return;
    }
    const mine = generation;
    let bot: BotApi;
    try { bot = createApi(record.token); } catch {
      view = { username: record.username, status: "error", error: "The saved bot token is malformed. Paste it again." };
      return;
    }
    api = bot;
    controller = new AbortController();
    view = { username: record.username, status: "connecting", error: null };
    void bot.setMyCommands(COMMANDS).catch((error: unknown) => log.warn("telegram setMyCommands failed", error));
    loop = poll(bot, mine, controller.signal, record.username);
  }

  return {
    start: startPolling,
    stop: stopPolling,
    status(): TelegramBotView | null { return view; },
    async configure(token: string | null): Promise<TelegramBotView | null> {
      if (token === null) {
        await stopPolling();
        identities.setTelegramBot(null);
        view = null;
        log.info("telegram bot removed");
        return null;
      }
      let me;
      try { me = await createApi(token.trim()).getMe(); } catch (error) {
        if (error instanceof TelegramApiError && error.status === 0) throw new IdentityError(502, "Telegram could not be reached. Check this machine's internet connection.");
        if (error instanceof TelegramApiError && error.status === 400 && /BotFather/.test(error.message)) throw new IdentityError(422, error.message);
        throw new IdentityError(422, "Telegram rejected that token. Copy it again from @BotFather.");
      }
      if (!me.is_bot || !me.username) throw new IdentityError(422, "That token does not belong to a bot.");
      await stopPolling();
      identities.setTelegramBot({ token: token.trim(), botId: me.id, username: me.username });
      log.info(`telegram bot @${me.username} configured`);
      await startPolling();
      return view;
    },
    linkUrl(code: string): string | null {
      const record = identities.telegramBot();
      return record ? `https://t.me/${record.username}?start=${code}` : null;
    },
    notify(user: UserIdentity, notice: TelegramNotice) {
      const link = identities.telegramLink(user.id);
      if (link === null || api === null) return;
      const message = noticeMessage(notice, link.access, token(user.id));
      void send(link.chatId, message).then(sent => {
        if (sent && notice.kind === "gate" && link.access === "control") remember(gateMessages, `${link.chatId}:${sent.message_id}`, { promptId: notice.gate.promptId, title: notice.gate.title });
      });
    },
    async sendToUser(userId: string, text: string): Promise<boolean> {
      const link = identities.telegramLink(userId);
      if (link === null || api === null) return false;
      return (await send(link.chatId, { text })) !== null;
    },
    async sendToChat(chatId: number, text: string): Promise<boolean> {
      if (api === null) return false;
      return (await send(chatId, { text })) !== null;
    },
  };
}

export type TelegramBot = ReturnType<typeof createTelegramBot>;
