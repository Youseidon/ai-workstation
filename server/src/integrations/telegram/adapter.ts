import type { TaskControlReceipt } from "@agent-console/shared";
import { TelegramApiError, redactBotToken, type TelegramBotApi, type TelegramMessagePayload } from "./botApi.ts";
import { WorkspaceError, workspaces } from "../../workspaces.ts";
import type { TaskControlService } from "../../taskControl.ts";

interface CallbackPayload {
  kind: "callback";
  ref: string;
  transportUserId: string;
  chatId: string;
  topicId?: string | null;
  messageId?: string | null;
  commandId: string;
  content?: string;
  callbackQueryId?: string;
}

function callbackPayload(value: unknown): CallbackPayload | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "callback") return null;
  if (typeof record.ref !== "string" || typeof record.transportUserId !== "string" || typeof record.chatId !== "string" || typeof record.commandId !== "string") return null;
  return {
    kind: "callback",
    ref: record.ref,
    transportUserId: record.transportUserId,
    chatId: record.chatId,
    topicId: typeof record.topicId === "string" ? record.topicId : null,
    messageId: typeof record.messageId === "string" ? record.messageId : null,
    commandId: record.commandId,
    content: typeof record.content === "string" ? record.content : undefined,
    callbackQueryId: typeof record.callbackQueryId === "string" ? record.callbackQueryId : undefined,
  };
}

function messagePayload(value: unknown): TelegramMessagePayload | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "message" || typeof record.transportUserId !== "string" || typeof record.chatId !== "string" || typeof record.messageId !== "string" || typeof record.text !== "string") return null;
  return value as TelegramMessagePayload;
}

function actionRefs(payload: unknown): string[] {
  if (payload === null || typeof payload !== "object") return [];
  const actions = (payload as { actions?: unknown }).actions;
  return Array.isArray(actions) ? actions.flatMap(entry => typeof entry?.ref === "string" ? [entry.ref as string] : []) : [];
}

const MAX_RETRY_DELAY_MS = 60_000;

/**
 * When a failed send may be retried. Telegram's own retry_after wins; other
 * transient failures back off exponentially with jitter up to one minute.
 * Returns null for failures a retry cannot fix (e.g. the chat does not exist).
 */
export function telegramRetryDelayMs(error: unknown, priorAttempts: number, random: () => number = Math.random): number | null {
  if (error instanceof TelegramApiError) {
    if (error.kind === "rate_limited") return (error.retryAfterMs ?? 1000) + 250;
    if (!error.retryable) return null;
  }
  const base = Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** Math.min(priorAttempts, 16));
  return Math.round(base / 2 + random() * (base / 2));
}

export interface TelegramDelivery {
  state: "SENT" | "FAILED";
  retryAt: Date | null;
  rateLimited: boolean;
}

export interface TelegramAdapterOptions {
  /**
   * Rebind a card's actions to the real Bot API message id once sent, so a tap
   * is validated against the message that carried the button. The fake
   * transport's tests address the placeholder id and leave this off.
   */
  bindSentMessageIds?: boolean;
  /** Supplies the answer text a button tap submits; Telegram callbacks carry none. */
  callbackContent?: (ref: string) => string | null;
  /** Handles text messages. Must not throw for input it rejects. */
  onMessage?: (message: TelegramMessagePayload) => void | Promise<void>;
  /** Reports a callback's receipt before the update is marked processed. Must not throw. */
  onCallbackResult?: (callback: CallbackPayload, receipt: TaskControlReceipt) => void | Promise<void>;
  /** Navigation taps (`nv_` data, slice B) go here and never reach task control, so they cannot create a receipt. */
  onNavigation?: (callback: CallbackPayload & { callbackQueryId?: string }) => void | Promise<void>;
  now?: () => number;
}

export class TelegramAdapter {
  constructor(
    private readonly botId: string,
    private readonly api: TelegramBotApi,
    private readonly taskControl?: TaskControlService,
    private readonly options: TelegramAdapterOptions = {},
  ) {}

  async pollOnce(options?: { signal?: AbortSignal }): Promise<{ fetched: number; saved: number; nextOffset: number }> {
    const offset = workspaces.telegramCursor(this.botId);
    const updates = await this.api.getUpdates(offset, options);
    const saved = workspaces.saveTelegramUpdates(this.botId, updates);
    const nextOffset = updates.reduce((next, update) => Math.max(next, update.updateId + 1), offset);
    if (nextOffset !== offset) workspaces.advanceTelegramCursor(this.botId, nextOffset);
    return { fetched: updates.length, saved, nextOffset };
  }

  async sendOutbox(outboxId: number): Promise<"SENT" | "FAILED"> {
    return (await this.deliverOutbox(outboxId)).state;
  }

  async deliverOutbox(outboxId: number): Promise<TelegramDelivery> {
    const row = workspaces.telegramOutboxRow(outboxId);
    if (!row) throw new Error("Telegram outbox row was not found.");
    if (row.operation === "edit") return this.deliverEdit(row);
    try {
      const sent = await this.api.sendMessage({ chatId: row.chatId, topicId: row.topicId, payload: row.payload, replyToMessageId: row.replyToMessageId });
      workspaces.markTelegramOutbox(outboxId, "SENT", null, { sentMessageId: sent.messageId });
      if (this.options.bindSentMessageIds) {
        const refs = actionRefs(row.payload);
        if (refs.length > 0) workspaces.bindTaskControlActionsToMessage(this.botId, refs, sent.messageId);
      }
      return { state: "SENT", retryAt: null, rateLimited: false };
    } catch (error) {
      const delay = telegramRetryDelayMs(error, row.attemptCount);
      const retryAt = delay === null ? null : new Date((this.options.now?.() ?? Date.now()) + delay);
      const message = redactBotToken(error instanceof Error ? error.message : String(error));
      workspaces.markTelegramOutbox(outboxId, "FAILED", message, { nextAttemptAt: retryAt?.toISOString() ?? null });
      // A message that will never arrive cannot stay a subject's anchor (C1).
      if (retryAt === null) workspaces.markTelegramThreadAnchorGone(outboxId);
      return { state: "FAILED", retryAt, rateLimited: error instanceof TelegramApiError && error.kind === "rate_limited" };
    }
  }

  /** Edits the message the target send row delivered; a delivery that raced a newer edit leaves the row queued for it. */
  private async deliverEdit(row: NonNullable<ReturnType<typeof workspaces.telegramOutboxRow>>): Promise<TelegramDelivery> {
    const target = row.target!;
    if (target.sentMessageId === null) {
      // The send it would edit failed for good, so there is no message to change.
      workspaces.markTelegramOutbox(row.id, "FAILED", "The message to edit was never delivered.");
      workspaces.markTelegramThreadAnchorGone(row.targetOutboxId!);
      return { state: "FAILED", retryAt: null, rateLimited: false };
    }
    try {
      await this.api.editMessageText({ chatId: row.chatId, messageId: target.sentMessageId, payload: row.payload });
      workspaces.markTelegramOutbox(row.id, "SENT", null, { ifPayloadVersion: row.payloadVersion });
      if (this.options.bindSentMessageIds) {
        const refs = actionRefs(row.payload);
        if (refs.length > 0) workspaces.bindTaskControlActionsToMessage(this.botId, refs, target.sentMessageId);
      }
      return { state: "SENT", retryAt: null, rateLimited: false };
    } catch (error) {
      const delay = telegramRetryDelayMs(error, row.attemptCount);
      const retryAt = delay === null ? null : new Date((this.options.now?.() ?? Date.now()) + delay);
      const message = redactBotToken(error instanceof Error ? error.message : String(error));
      workspaces.markTelegramOutbox(row.id, "FAILED", message, { nextAttemptAt: retryAt?.toISOString() ?? null });
      // The edit is not retried (F1); if the message it addressed was a subject's anchor,
      // the operator deleted it, so the registry gives up on it and the next message for
      // that subject registers a new anchor (C1 recovery).
      if (retryAt === null) workspaces.markTelegramThreadAnchorGone(row.targetOutboxId!);
      return { state: "FAILED", retryAt, rateLimited: error instanceof TelegramApiError && error.kind === "rate_limited" };
    }
  }

  async processPendingCallbacks(): Promise<{ processed: number; ignored: number }> {
    let processed = 0;
    let ignored = 0;
    for (const update of workspaces.pendingTelegramInbox(this.botId)) {
      const message = messagePayload(update.payload);
      if (message !== null && this.options.onMessage !== undefined) {
        await this.options.onMessage(message);
        processed++;
        workspaces.markTelegramUpdateProcessed(this.botId, update.updateId);
        continue;
      }
      const callback = callbackPayload(update.payload);
      if (callback !== null && callback.ref.startsWith("nv_")) {
        if (this.options.onNavigation) await this.options.onNavigation(callback);
        processed++;
        workspaces.markTelegramUpdateProcessed(this.botId, update.updateId);
        continue;
      }
      if (callback === null || this.taskControl === undefined) {
        ignored++;
        workspaces.markTelegramUpdateProcessed(this.botId, update.updateId);
        continue;
      }
      const { kind: _kind, callbackQueryId: _callbackQueryId, ...input } = callback;
      let receipt: TaskControlReceipt;
      try {
        receipt = await this.taskControl.handleCallback({
          ...input,
          content: input.content ?? this.options.callbackContent?.(input.ref) ?? undefined,
          botId: this.botId,
        });
      } catch (error) {
        // A deterministic refusal (e.g. remote actions disabled) is an answer,
        // not a processing failure: record it and move on rather than retrying
        // the same update forever. Anything else stays pending for a retry.
        if (!(error instanceof WorkspaceError)) throw error;
        receipt = { commandId: input.commandId, state: "REJECTED", action: "save_human_response", promptId: 0, message: error.message, responseId: null, started: false, runId: null, errorCode: error.code, createdAt: new Date().toISOString() };
      }
      await this.options.onCallbackResult?.(callback, receipt);
      processed++;
      workspaces.markTelegramUpdateProcessed(this.botId, update.updateId);
    }
    return { processed, ignored };
  }
}
