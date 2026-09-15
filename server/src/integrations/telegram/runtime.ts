import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ProviderId, TaskControlReceipt, TelegramLiveState, TelegramLiveStatus, TelegramPairingState } from "@agent-console/shared";
import { isProviderId } from "@agent-console/shared";
import { assertHarnessBot, isHarnessMode } from "../../harnessGuard.ts";
import { harnessSeams } from "../../harnessSeams.ts";
import { createLogger, type Logger } from "../../lib/logger.ts";
import { runHub } from "../../runHub.ts";
import { settings as appSettings } from "../../settings.ts";
import { TaskControlService } from "../../taskControl.ts";
import { WorkspaceError, workspaces } from "../../workspaces.ts";
import { TelegramAdapter } from "./adapter.ts";
import { TelegramApiError, redactBotToken, type LiveTelegramBotApi, type TelegramMessagePayload } from "./botApi.ts";
import { bootTelegramCredential, type BotToken, type TelegramCredential } from "./credentials.ts";
import { HttpTelegramBotApi, TELEGRAM_POLL_TIMEOUT_SECONDS } from "./httpBotApi.ts";
import type { TelegramTextPayload } from "./liveFormat.ts";

export interface TelegramRuntimeSettings {
  enabled: boolean;
  notificationsEnabled: boolean;
  remoteActionsEnabled: boolean;
  transport: "fake_telegram" | "telegram";
}

export interface TelegramRuntimeOptions {
  settings: () => TelegramRuntimeSettings;
  credential: TelegramCredential;
  /** Builds the Bot API client; tests inject a stubbed fetch through this. */
  createApi?: (token: BotToken, contentForRef: (ref: string) => string | null) => LiveTelegramBotApi;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  logger?: Logger;
  deliverIntervalMs?: number;
  notifyIntervalMs?: number;
  /** Pause between consecutive sends; Telegram allows roughly one message per second per chat. */
  sendSpacingMs?: number;
  pairingTtlMs?: number;
  /** Refuses a bot before polling it; the harness uses this to never touch the operator's own bot. */
  assertBot?: (botId: string) => void;
  pollTimeoutSeconds?: number;
}

interface Session {
  controller: AbortController;
  botId: string;
  api: LiveTelegramBotApi;
  adapter: TelegramAdapter;
  control: TaskControlService;
  done: Promise<void>;
}

interface PairingSession {
  code: string;
  expiresAt: number;
  challenge: string | null;
  observed: TelegramPairingState["observed"];
}

const AUTH_RETRY_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60_000;
/** Rejections after which the phone gets the current question again (user-flows B12). */
const REISSUE_CODES = new Set(["action_expired", "question_changed", "wrong_message"]);

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function textPayload(text: string): TelegramTextPayload {
  return { kind: "text", text };
}

/**
 * Supervises the live Bot API transport (L1). Default-off: it makes no network
 * call unless task control is enabled, the transport is `telegram` and a token
 * was supplied at boot. Validation, receipts and revision binding all stay in
 * TaskControlService; this class only moves messages and decides when to post.
 */
export class TelegramLiveRuntime {
  private readonly settings: () => TelegramRuntimeSettings;
  private readonly credential: TelegramCredential;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly deliverIntervalMs: number;
  private readonly notifyIntervalMs: number;
  private readonly sendSpacingMs: number;
  private readonly pairingTtlMs: number;
  private readonly pollTimeoutSeconds: number;

  private session: Session | null = null;
  private transition: Promise<void> = Promise.resolve();
  private state: TelegramLiveState = "disabled";
  private reason = "Telegram task control is disabled.";
  private bot: TelegramLiveStatus["bot"] = null;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;
  private nextRetryAt: string | null = null;
  private sendPausedUntil = 0;
  private pairing: PairingSession | null = null;

  constructor(private readonly options: TelegramRuntimeOptions) {
    this.settings = options.settings;
    this.credential = options.credential;
    this.sleep = options.sleep ?? abortableSleep;
    this.now = options.now ?? Date.now;
    this.log = options.logger ?? createLogger("telegram");
    this.deliverIntervalMs = options.deliverIntervalMs ?? 1000;
    this.notifyIntervalMs = options.notifyIntervalMs ?? 5000;
    this.sendSpacingMs = options.sendSpacingMs ?? 1000;
    this.pairingTtlMs = options.pairingTtlMs ?? 10 * 60_000;
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? TELEGRAM_POLL_TIMEOUT_SECONDS;
    this.refreshIdleState();
  }

  /** Starts or stops the transport to match current settings. Safe to call repeatedly. */
  reconcile(): Promise<void> {
    this.transition = this.transition.then(() => this.apply()).catch(error => this.log.error(this.safe(`reconcile failed: ${String(error)}`)));
    return this.transition;
  }

  async stop(): Promise<void> {
    this.transition = this.transition.then(() => this.stopSession());
    await this.transition;
  }

  status(): TelegramLiveStatus {
    this.expirePairing();
    const botId = this.botRecordId();
    return {
      state: this.state,
      reason: this.reason,
      tokenConfigured: this.credential.token !== null,
      bot: this.bot,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      nextRetryAt: this.nextRetryAt,
      outbox: botId === null ? { queued: 0, retrying: 0, failed: 0 } : workspaces.telegramOutboxCounts(botId),
      pairing: this.pairing === null ? null : {
        code: this.pairing.code,
        deepLink: this.bot?.username ? `https://t.me/${this.bot.username}?start=${this.pairing.code}` : null,
        expiresAt: new Date(this.pairing.expiresAt).toISOString(),
        observed: this.pairing.observed,
      },
      actors: workspaces.taskControlActors("telegram").map(actor => ({
        id: actor.id,
        label: actor.label,
        transportUserId: actor.transport_user_id,
        chatId: actor.chat_id,
        createdAt: actor.created_at,
      })),
    };
  }

  startPairing(): TelegramPairingState {
    this.requireSession();
    this.pairing = { code: randomBytes(18).toString("base64url"), expiresAt: this.now() + this.pairingTtlMs, challenge: null, observed: null };
    return this.status().pairing!;
  }

  cancelPairing(): void {
    this.pairing = null;
  }

  confirmPairing(code: unknown): { id: string } {
    const session = this.requireSession();
    this.expirePairing();
    const pairing = this.pairing;
    if (pairing === null || typeof code !== "string" || !sameSecret(code, pairing.code)) throw new WorkspaceError(404, "pairing_not_found", "No active pairing matches this code. Start pairing again.");
    if (pairing.observed === null || pairing.challenge === null) throw new WorkspaceError(409, "pairing_not_observed", "Send the code to the bot from Telegram before confirming.");
    const actor = session.control.confirmPairing({ challenge: pairing.challenge, transportUserId: pairing.observed.transportUserId, chatId: pairing.observed.chatId, topicId: null });
    this.enqueueText(session, pairing.observed.chatId, null, "Paired with this workstation. Task questions will arrive in this chat.");
    this.pairing = null;
    return actor;
  }

  removeActor(actorId: string): void {
    const actor = workspaces.taskControlActorById(actorId);
    if (!actor || actor.transport !== "telegram" || actor.enabled !== 1) throw new WorkspaceError(404, "actor_not_found", "No enrolled Telegram actor has this id.");
    workspaces.disableTaskControlActor(actorId);
    if (this.session !== null) {
      workspaces.dropQueuedTelegramEdits(this.session.botId, actor.chat_id);
      this.enqueueText(this.session, actor.chat_id, actor.topic_id, "This chat was unpaired from the workstation. Its buttons no longer work.");
    }
  }

  /** Harness seam only (workspaceApi gates it on harness mode): queues a plain message to an enrolled chat. */
  harnessQueueText(chatId: unknown, text: unknown): number {
    const session = this.requireSession();
    if (typeof chatId !== "string" || !workspaces.taskControlActors("telegram").some(actor => actor.chat_id === chatId)) throw new WorkspaceError(404, "actor_not_found", "No enrolled Telegram chat has this id.");
    if (typeof text !== "string" || text.trim() === "") throw new WorkspaceError(400, "invalid_text", "Text is required.");
    return workspaces.enqueueTelegramOutbox({ botId: session.botId, chatId, topicId: null, payload: textPayload(text) });
  }

  /** Harness seam only: queues an edit of a message this bot's outbox sent, through the same path a product edit uses. */
  harnessQueueEdit(targetOutboxId: number, payload: unknown): number {
    const session = this.requireSession();
    if (payload === null || typeof payload !== "object" || typeof (payload as { kind?: unknown }).kind !== "string") throw new WorkspaceError(400, "invalid_payload", "An edit needs a message payload.");
    return workspaces.enqueueTelegramEdit({ botId: session.botId, targetOutboxId, payload });
  }

  /* ------------------------------------------------------------------------ */

  private botRecordId(): string | null {
    return this.credential.token === null ? null : `telegram-${this.credential.token.botId}`;
  }

  private safe(text: string): string {
    return redactBotToken(text, this.credential.token?.reveal());
  }

  private wanted(): boolean {
    const current = this.settings();
    return current.enabled && current.transport === "telegram" && this.credential.token !== null;
  }

  private refreshIdleState(): void {
    const current = this.settings();
    if (!current.enabled) this.setState("disabled", "Telegram task control is disabled.");
    else if (current.transport !== "telegram") this.setState("disabled", "Transport is Fake Telegram, so the live Bot API is not used.");
    else if (this.credential.token === null) this.setState("missing_token", this.credential.problem ?? "Set TELEGRAM_BOT_TOKEN in .env and restart the server.");
  }

  private setState(state: TelegramLiveState, reason: string): void {
    this.state = state;
    this.reason = reason;
  }

  private async apply(): Promise<void> {
    if (this.wanted()) {
      if (this.session === null) this.startSession();
      return;
    }
    await this.stopSession();
    this.refreshIdleState();
  }

  private startSession(): void {
    const token = this.credential.token!;
    const botId = this.botRecordId()!;
    const contentForRef = (ref: string) => workspaces.telegramActionContent(ref);
    const api = this.options.createApi?.(token, contentForRef) ?? new HttpTelegramBotApi({ token, contentForRef });
    const control = new TaskControlService(() => {
      const current = this.settings();
      return { enabled: current.enabled, notificationsEnabled: current.notificationsEnabled, remoteActionsEnabled: current.remoteActionsEnabled, transport: "telegram", botId };
    });
    const controller = new AbortController();
    const session: Session = { controller, botId, api, control, adapter: undefined as unknown as TelegramAdapter, done: Promise.resolve() };
    session.adapter = new TelegramAdapter(botId, api, control, {
      bindSentMessageIds: true,
      callbackContent: contentForRef,
      onMessage: message => this.handleMessage(session, message),
      onCallbackResult: (callback, receipt) => this.handleCallbackResult(session, callback, receipt),
      now: this.now,
    });
    this.session = session;
    this.lastError = null;
    this.nextRetryAt = null;
    this.setState("connecting", "Connecting to Telegram.");
    this.log.info(`starting live transport for bot ${token.botId}`);
    session.done = this.run(session).catch(error => {
      this.log.error(this.safe(`live transport stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`));
    });
  }

  private async stopSession(): Promise<void> {
    const session = this.session;
    if (session === null) return;
    this.session = null;
    this.pairing = null;
    session.controller.abort();
    await session.done;
    this.bot = null;
    this.log.info("live transport stopped");
  }

  private requireSession(): Session {
    if (this.session === null || this.state === "connecting" || this.state === "auth_failed") {
      throw new WorkspaceError(409, "telegram_not_running", "The live Telegram transport is not connected. Check its status first.");
    }
    return this.session;
  }

  private expirePairing(): void {
    if (this.pairing !== null && this.pairing.expiresAt <= this.now()) this.pairing = null;
  }

  private async run(session: Session): Promise<void> {
    const { signal } = session.controller;
    let failures = 0;
    while (!signal.aborted) {
      try {
        const me = await session.api.getMe({ signal });
        try {
          this.options.assertBot?.(me.id);
        } catch (error) {
          this.setState("auth_failed", error instanceof Error ? error.message : String(error));
          this.log.error(this.safe(`refusing bot ${me.id}: ${this.reason}`));
          return;
        }
        this.bot = { id: me.id, username: me.username };
        break;
      } catch (error) {
        if (signal.aborted) return;
        await this.backoff(error, failures++, signal);
      }
    }
    if (signal.aborted) return;
    this.lastError = null;
    this.nextRetryAt = null;
    this.setState("polling", `Long polling Telegram (${this.pollTimeoutSeconds}s window).`);
    this.log.info(`connected as @${this.bot?.username ?? "unknown"}`);
    await Promise.all([this.pollLoop(session), this.deliverLoop(session)]);
  }

  private async pollLoop(session: Session): Promise<void> {
    const { signal } = session.controller;
    let failures = 0;
    while (!signal.aborted) {
      try {
        // Drain what is already durable first: updates saved before a restart
        // must not wait for the next long poll to return.
        await session.adapter.processPendingCallbacks();
        if (signal.aborted) return;
        await session.adapter.pollOnce({ signal });
        if (signal.aborted) return;
        failures = 0;
        this.lastPollAt = new Date(this.now()).toISOString();
        if (this.state !== "polling") {
          this.log.info("polling recovered");
          this.setState("polling", `Long polling Telegram (${this.pollTimeoutSeconds}s window).`);
        }
        this.lastError = null;
        this.nextRetryAt = null;
      } catch (error) {
        if (signal.aborted) return;
        await this.backoff(error, failures++, signal);
      }
    }
  }

  private async backoff(error: unknown, failures: number, signal: AbortSignal): Promise<void> {
    const apiError = error instanceof TelegramApiError
      ? error
      : new TelegramApiError("transient", this.safe(error instanceof Error ? error.message : String(error)));
    let delay: number;
    if (apiError.kind === "unauthorized") {
      delay = AUTH_RETRY_MS;
      this.setState("auth_failed", "Telegram rejected the bot token. Fix TELEGRAM_BOT_TOKEN in .env and restart the server.");
    } else if (apiError.kind === "rate_limited") {
      delay = apiError.retryAfterMs ?? 1000;
      this.setState("backoff", "Telegram asked this bot to slow down.");
    } else {
      const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures, 16));
      delay = Math.round(base / 2 + Math.random() * (base / 2));
      this.setState("backoff", apiError.kind === "conflict"
        ? "Another process is polling this bot, or a webhook is set on it. Stop the other poller or delete the webhook."
        : "Telegram is unreachable; retrying.");
    }
    this.lastError = this.safe(apiError.message);
    this.nextRetryAt = new Date(this.now() + delay).toISOString();
    this.log.warn(`${this.lastError}; retrying in ${Math.ceil(delay / 1000)}s`);
    await this.sleep(delay, signal);
  }

  private async deliverLoop(session: Session): Promise<void> {
    const { signal } = session.controller;
    let nextNotifyAt = 0;
    while (!signal.aborted) {
      try {
        if (this.now() >= nextNotifyAt) {
          this.notifyWaitingTasks(session);
          nextNotifyAt = this.now() + this.notifyIntervalMs;
        }
        await this.sendDue(session);
      } catch (error) {
        this.log.warn(this.safe(`delivery cycle failed: ${error instanceof Error ? error.message : String(error)}`));
      }
      await this.sleep(this.deliverIntervalMs, signal);
    }
  }

  private async sendDue(session: Session): Promise<void> {
    const { signal } = session.controller;
    if (this.now() < this.sendPausedUntil) return;
    for (const row of workspaces.dueTelegramOutbox(session.botId, new Date(this.now()))) {
      if (signal.aborted) return;
      const delivery = await session.adapter.deliverOutbox(row.id);
      if (delivery.state === "FAILED") {
        const failed = workspaces.telegramOutbox().find(entry => entry.id === row.id);
        const retry = delivery.retryAt === null ? "not retrying" : `retry at ${delivery.retryAt.toISOString()}`;
        this.log.warn(this.safe(`send of outbox ${row.id} failed (${failed?.lastError ?? "unknown error"}); ${retry}`));
        if (delivery.rateLimited && delivery.retryAt !== null) {
          this.sendPausedUntil = delivery.retryAt.getTime();
          return;
        }
        // A transient failure will hit every queued message alike; wait for the
        // next cycle. A permanent one only concerns this row.
        if (delivery.retryAt !== null) return;
      }
      if (this.sendSpacingMs > 0) await this.sleep(this.sendSpacingMs, signal);
    }
  }

  /** Posts each waiting task once per question revision to every enrolled chat. */
  private notifyWaitingTasks(session: Session): void {
    if (!this.settings().notificationsEnabled) return;
    const actors = workspaces.taskControlActors("telegram");
    if (actors.length === 0) return;
    for (const prompt of workspaces.promptsAwaitingResponse()) {
      const revision = workspaces.humanInputState(prompt.id).revision;
      for (const actor of actors) {
        if (workspaces.hasTaskControlActionForRevision({ promptId: prompt.id, actorId: actor.id, botId: session.botId, revision })) continue;
        this.postQuestion(session, prompt.id, actor.id);
      }
    }
  }

  /**
   * Queues a question card. With `answer`, it is an answer card: the reply text
   * is bound to both action references so the buttons submit exactly that text.
   * Without it, a saved answer is bound to the resume action only.
   */
  private postQuestion(session: Session, promptId: number, actorId: string, answer?: string): void {
    const target = this.resumeTarget(promptId);
    const card = session.control.postPersonalQuestion(promptId, actorId, target);
    const content = answer ?? this.savedAnswer(promptId);
    if (content === null) return;
    for (const action of card.actions) {
      if (action.action === "answer_and_resume" && target.provider === null) continue;
      if (action.action === "save_human_response" && answer === undefined) continue;
      workspaces.setTelegramActionContent(action.ref, content);
    }
  }

  private savedAnswer(promptId: number): string | null {
    const savedId = workspaces.humanInputState(promptId).savedResponseId;
    if (savedId === null) return null;
    return workspaces.promptActivity(promptId).remarks.find(remark => remark.id === savedId)?.content ?? null;
  }

  /** Resume continues with the agent that last ran the task, else the suite default. */
  private resumeTarget(promptId: number): { provider: ProviderId | null; model: string | null } {
    const activity = workspaces.promptActivity(promptId);
    const last = activity.sessions
      .filter(run => run.role === "execute" && isProviderId(run.provider))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (last) return { provider: last.provider as ProviderId, model: last.model };
    const defaults = workspaces.suitePipelineDefaults(activity.item.prompt.suiteId);
    return { provider: defaults.defaultProvider, model: defaults.defaultModel };
  }

  /** Queues a plain reply in the chat and topic it answers (RTC-21), so it never lands in General or another topic. */
  private enqueueText(session: Session, chatId: string, topicId: string | null, text: string): void {
    workspaces.enqueueTelegramOutbox({ botId: session.botId, chatId, topicId, payload: textPayload(text) });
  }

  /** The question revision a card's buttons were issued for, or null when it has none. */
  private cardRevision(payload: unknown): string | null {
    const actions = (payload as { actions?: Array<{ ref?: unknown }> } | undefined)?.actions;
    const ref = Array.isArray(actions) ? actions.find(action => typeof action.ref === "string")?.ref : undefined;
    return typeof ref === "string" ? workspaces.taskControlAction(ref)?.expected_revision ?? null : null;
  }

    private isAwaiting(promptId: number): boolean {
    return workspaces.promptsAwaitingResponse().some(prompt => prompt.id === promptId);
  }

  private async handleMessage(session: Session, message: TelegramMessagePayload): Promise<void> {
    try {
      const text = message.text.trim();
      const pairingCode = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]+)$/.exec(text)?.[1];
      if (pairingCode !== undefined) {
        this.handlePairingCode(session, message, pairingCode);
        return;
      }
      const actor = workspaces.taskControlActorFor({ transport: "telegram", transportUserId: message.transportUserId, chatId: message.chatId, topicId: message.topicId });
      // Unknown users and chats are ignored without a reply (protocol section 7).
      if (!actor || actor.enabled !== 1) return;
      if (message.replyToMessageId === null) {
        this.enqueueText(session, message.chatId, message.topicId, "To answer a task, reply to its question message. Ordinary messages are not task instructions.");
        return;
      }
      const card = workspaces.telegramOutboxBySentMessage(session.botId, message.chatId, message.replyToMessageId);
      const payload = card?.payload as { kind?: unknown; promptId?: unknown } | undefined;
      if (payload?.kind !== "personal_question" || typeof payload.promptId !== "number") {
        this.enqueueText(session, message.chatId, message.topicId, "That message is not a task question. Reply to a question message to answer it.");
        return;
      }
      if (!this.isAwaiting(payload.promptId)) {
        this.enqueueText(session, message.chatId, message.topicId, "This task no longer needs input. Review it in the local app.");
        return;
      }
      // Answers bind to the question they were written for (user-flows 5, B12):
      // a reply to a superseded card is refused, never rebound to the new question.
      const revision = workspaces.humanInputState(payload.promptId).revision;
      if (this.cardRevision(card?.payload) !== revision) {
        this.enqueueText(session, message.chatId, message.topicId, "Not recorded: that question has changed since this message. Reply to the latest question for this task.");
        if (!workspaces.hasTaskControlActionForRevision({ promptId: payload.promptId, actorId: actor.id, botId: session.botId, revision })) this.postQuestion(session, payload.promptId, actor.id);
        return;
      }
      this.postQuestion(session, payload.promptId, actor.id, text);
    } catch (error) {
      const detail = error instanceof WorkspaceError ? error.message : "The answer could not be prepared.";
      this.log.warn(this.safe(`message handling failed: ${error instanceof Error ? error.message : String(error)}`));
      if (workspaces.taskControlActorFor({ transport: "telegram", transportUserId: message.transportUserId, chatId: message.chatId, topicId: message.topicId })?.enabled === 1) {
        this.enqueueText(session, message.chatId, message.topicId, `Not recorded: ${detail}`);
      }
    }
  }

  private handlePairingCode(session: Session, message: TelegramMessagePayload, code: string): void {
    this.expirePairing();
    const pairing = this.pairing;
    // A wrong or stale code gets no reply, so the bot cannot be used to probe codes.
    if (pairing === null || !sameSecret(code, pairing.code)) return;
    if (pairing.observed !== null) {
      this.enqueueText(session, message.chatId, message.topicId, "This pairing code was already used. Start pairing again from the local app.");
      return;
    }
    if (message.chatType !== "private" || message.topicId !== null) {
      this.enqueueText(session, message.chatId, message.topicId, "Pair from a private chat with this bot, not a group.");
      return;
    }
    const challenge = session.control.createPairingChallenge({ chatId: message.chatId, topicId: null, label: message.label, ttlMs: Math.max(1000, pairing.expiresAt - this.now()) });
    pairing.challenge = challenge.challenge;
    pairing.observed = { transportUserId: message.transportUserId, chatId: message.chatId, label: message.label, username: message.username, observedAt: new Date(this.now()).toISOString() };
    this.enqueueText(session, message.chatId, message.topicId, "Pairing requested. Confirm it in the local app to finish.");
  }

  private async handleCallbackResult(session: Session, callback: { ref: string; transportUserId: string; chatId: string; topicId?: string | null; commandId: string; callbackQueryId?: string }, receipt: TaskControlReceipt): Promise<void> {
    try {
      const replay = receipt.state === "APPLIED" && receipt.commandId !== callback.commandId;
      const toast = replay ? "Already applied." : receipt.state === "APPLIED" ? receipt.message : `Not applied: ${receipt.message}`;
      if (callback.callbackQueryId !== undefined) {
        // Best effort: Telegram refuses answers to old queries, e.g. taps made
        // while this workstation was offline. The durable receipt below remains.
        void session.api.answerCallbackQuery(callback.callbackQueryId, toast)
          .catch(error => this.log.warn(this.safe(`answerCallbackQuery failed: ${error instanceof Error ? error.message : String(error)}`)));
      }
      const actor = workspaces.taskControlActorFor({ transport: "telegram", transportUserId: callback.transportUserId, chatId: callback.chatId, topicId: callback.topicId ?? null });
      if (!actor || actor.enabled !== 1 || replay) return;
      if (receipt.state === "APPLIED") {
        this.enqueueText(session, callback.chatId, callback.topicId ?? null, receipt.errorCode === null ? `Done: ${receipt.message}` : `Answer saved, but resume did not start: ${receipt.message}`);
        runHub.operationsChanged();
        return;
      }
      this.enqueueText(session, callback.chatId, callback.topicId ?? null, `Not applied: ${receipt.message}`);
      if (receipt.errorCode !== null && REISSUE_CODES.has(receipt.errorCode) && receipt.promptId > 0 && this.isAwaiting(receipt.promptId)) {
        // An expired action shares its revision with the dead card, so it always
        // needs a fresh one; a changed question may already have been reposted.
        const revision = workspaces.humanInputState(receipt.promptId).revision;
        const current = workspaces.hasTaskControlActionForRevision({ promptId: receipt.promptId, actorId: actor.id, botId: session.botId, revision });
        if (receipt.errorCode === "action_expired" || !current) this.postQuestion(session, receipt.promptId, actor.id);
      }
    } catch (error) {
      this.log.warn(this.safe(`callback result handling failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
}

export const telegramRuntime = new TelegramLiveRuntime({
  settings: () => appSettings.taskControl,
  credential: bootTelegramCredential,
  ...(harnessSeams.telegramApiBaseUrl === null && harnessSeams.telegramPollTimeoutSeconds === null
    ? {}
    : {
        createApi: (token: BotToken, contentForRef: (ref: string) => string | null) => new HttpTelegramBotApi({
          token,
          contentForRef,
          ...(harnessSeams.telegramApiBaseUrl === null ? {} : { baseUrl: harnessSeams.telegramApiBaseUrl }),
          ...(harnessSeams.telegramPollTimeoutSeconds === null ? {} : { pollTimeoutSeconds: harnessSeams.telegramPollTimeoutSeconds }),
        }),
      }),
  ...(harnessSeams.telegramPollTimeoutSeconds === null ? {} : { pollTimeoutSeconds: harnessSeams.telegramPollTimeoutSeconds }),
  ...(harnessSeams.pairingTtlMs === null ? {} : { pairingTtlMs: harnessSeams.pairingTtlMs }),
  ...(isHarnessMode() ? { assertBot: (botId: string) => assertHarnessBot(botId, { forbidden: harnessSeams.forbiddenBotIds ?? undefined, testBots: harnessSeams.testBotIds ?? undefined }) } : {}),
});
