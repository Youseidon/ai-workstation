import { randomBytes } from "node:crypto";
import type { ProviderId, QuotaWarning, TaskControlAction, TaskControlCapability, TaskControlReceipt } from "@agent-console/shared";
import { harnessSeams } from "./harnessSeams.ts";
import { respondAndContinue, saveHumanResponse } from "./humanInput.ts";
import { settings } from "./settings.ts";
import { renderPersonalQuestion, renderQuotaWarning } from "./taskControlRenderer.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

export interface TaskControlConfig {
  enabled: boolean;
  notificationsEnabled: boolean;
  remoteActionsEnabled: boolean;
  transport: "fake_telegram" | "telegram";
  botId: string;
}

export interface TaskControlActorInput {
  transportUserId: string;
  chatId: string;
  topicId?: string | null;
  label: string;
}

export interface TaskControlCallbackInput {
  ref: string;
  transportUserId: string;
  chatId: string;
  topicId?: string | null;
  botId: string;
  messageId?: string | null;
  commandId: string;
  content?: string;
}

export interface TaskControlQuestionCard {
  outboxId: number;
  actions: Array<{ ref: string; action: TaskControlAction }>;
}

export class TaskControlService {
  constructor(private readonly configSource: TaskControlConfig | (() => TaskControlConfig)) {}

  private get config(): TaskControlConfig {
    return typeof this.configSource === "function" ? this.configSource() : this.configSource;
  }

  capability(): TaskControlCapability {
    if (!this.config.enabled) {
      return {
        enabled: false,
        notificationsEnabled: false,
        remoteActionsEnabled: false,
        transport: "disabled",
        status: "disabled",
        setup: "disabled",
        reason: "Telegram task control is default-off until local setup enables a fake or real transport.",
        gates: [
          { id: "G01", status: "blocked", reason: "Provider subscription delegation is not evidenced." },
          { id: "G02", status: "blocked", reason: "Runtime secret isolation is not certified." },
          { id: "G03", status: "blocked", reason: "Shared Git control integrity is not configured." },
          { id: "G04", status: "blocked", reason: "Team governance and retention are not approved." },
        ],
      };
    }
    return {
      enabled: true,
      notificationsEnabled: this.config.notificationsEnabled,
      remoteActionsEnabled: this.config.remoteActionsEnabled,
      transport: this.config.transport,
      status: this.config.remoteActionsEnabled ? "ready" : "blocked",
      setup: this.config.transport === "telegram" && this.config.notificationsEnabled && this.config.remoteActionsEnabled
        ? "telegram_configured"
        : "fake_only",
      reason: this.config.remoteActionsEnabled
        ? this.config.transport === "telegram"
          ? "Local Telegram setup is configured and gated for personal task-control actions."
          : "Fake Telegram task-control actions are enabled for local tests and development."
        : "Notifications are enabled, but remote execution controls are off.",
      gates: [
        { id: "G01", status: "blocked", reason: "Teammate-sponsored execution remains disabled." },
        { id: "G02", status: "blocked", reason: "Unattended team execution remains disabled." },
        { id: "G03", status: "blocked", reason: "Cross-workstation execution remains disabled." },
        { id: "G04", status: "blocked", reason: "Enterprise deployment remains disabled." },
      ],
    };
  }

  enrollFakeActor(input: TaskControlActorInput): { id: string } {
    this.assertEnabled();
    if (this.config.transport !== "fake_telegram") throw new WorkspaceError(409, "fake_transport_required", "Fake actor enrollment is only available for fake Telegram tests.");
    const actor = workspaces.upsertTaskControlActor({
      id: `fake-tg-${input.transportUserId}-${input.chatId}-${input.topicId ?? "main"}`,
      transport: "fake_telegram",
      transportUserId: input.transportUserId,
      chatId: input.chatId,
      topicId: input.topicId ?? null,
      label: input.label,
    });
    return { id: actor.id };
  }

  createPairingChallenge(input: { chatId: string; topicId?: string | null; label: string; ttlMs?: number }): { challenge: string; expiresAt: string } {
    this.assertEnabled();
    const challenge = `pair_${randomBytes(18).toString("base64url")}`;
    return workspaces.createTaskControlPairing({
      challenge,
      transport: this.config.transport,
      chatId: input.chatId,
      topicId: input.topicId ?? null,
      label: input.label,
      expiresAt: new Date(Date.now() + (input.ttlMs ?? harnessSeams.pairingTtlMs ?? 10 * 60 * 1000)).toISOString(),
    });
  }

  confirmPairing(input: { challenge: string; transportUserId: string; chatId: string; topicId?: string | null }): { id: string } {
    this.assertEnabled();
    const actor = workspaces.consumeTaskControlPairing({
      challenge: input.challenge,
      transport: this.config.transport,
      transportUserId: input.transportUserId,
      chatId: input.chatId,
      topicId: input.topicId ?? null,
    });
    return { id: actor.id };
  }

  postPersonalQuestion(promptId: number, actorId: string, options?: { provider?: ProviderId | null; model?: string | null; ttlMs?: number }): TaskControlQuestionCard {
    this.assertEnabled();
    if (!this.config.notificationsEnabled) throw new WorkspaceError(409, "notifications_disabled", "Task-control notifications are disabled.");
    const actor = this.actorById(actorId);
    const humanInput = workspaces.humanInputState(promptId);
    const expiresAt = new Date(Date.now() + (options?.ttlMs ?? harnessSeams.actionTtlMs ?? 10 * 60 * 1000)).toISOString();
    const actions: TaskControlQuestionCard["actions"] = [
      { ref: this.createRef(), action: "save_human_response" },
      { ref: this.createRef(), action: "answer_and_resume" },
    ];
    for (const action of actions) {
      workspaces.createTaskControlAction({
        ref: action.ref,
        action: action.action,
        promptId,
        actorId: actor.id,
        chatId: actor.chat_id,
        topicId: actor.topic_id,
        botId: this.config.botId,
        messageId: `question-${promptId}`,
        expectedRevision: humanInput.revision,
        provider: action.action === "answer_and_resume" ? options?.provider ?? null : null,
        model: action.action === "answer_and_resume" ? options?.model ?? null : null,
        expiresAt,
      });
    }
    const outboxId = workspaces.enqueueTelegramOutbox({
      botId: this.config.botId,
      chatId: actor.chat_id,
      topicId: actor.topic_id,
      payload: renderPersonalQuestion(promptId, actions.map(action => ({ ...action, promptId, expectedRevision: humanInput.revision, expiresAt }))),
    });
    return { outboxId, actions };
  }

  postQuotaWarning(actorId: string, warning: QuotaWarning): { outboxId: number } {
    this.assertEnabled();
    if (!this.config.notificationsEnabled) throw new WorkspaceError(409, "notifications_disabled", "Task-control notifications are disabled.");
    const actor = this.actorById(actorId);
    const outboxId = workspaces.enqueueTelegramOutbox({
      botId: this.config.botId,
      chatId: actor.chat_id,
      topicId: actor.topic_id,
      payload: renderQuotaWarning(warning),
    });
    return { outboxId };
  }

  markQuestionDelivered(outboxId: number): void {
    this.assertEnabled();
    workspaces.markTelegramOutbox(outboxId, "SENT");
  }

  markQuestionDeliveryFailed(outboxId: number, error: string): void {
    this.assertEnabled();
    workspaces.markTelegramOutbox(outboxId, "FAILED", error);
  }

  async handleCallback(input: TaskControlCallbackInput): Promise<TaskControlReceipt> {
    this.assertRemoteActions();
    const prior = workspaces.taskControlReceiptForAction(input.ref);
    if (prior) return prior;
    const action = workspaces.taskControlAction(input.ref);
    if (!action) return this.reject(input, "action_not_found", "This action is no longer available.", null);
    if (action.bot_id !== input.botId) return this.reject(input, "wrong_bot", "This action belongs to another bot.", action.ref);
    if (action.chat_id !== input.chatId || action.topic_id !== (input.topicId ?? null)) return this.reject(input, "wrong_chat", "This action belongs to another chat or topic.", action.ref);
    if (action.message_id !== null && input.messageId !== undefined && action.message_id !== input.messageId) return this.reject(input, "wrong_message", "This action belongs to another message.", action.ref);
    if (Date.parse(action.expires_at) <= Date.now()) return this.reject(input, "action_expired", "This action expired. Review the current task state.", action.ref);
    const actor = workspaces.taskControlActorFor({ transport: this.config.transport, transportUserId: input.transportUserId, chatId: input.chatId, topicId: input.topicId ?? null });
    if (!actor || actor.enabled !== 1 || actor.id !== action.actor_id) return this.reject(input, "actor_not_enrolled", "This Telegram actor is not authorized for the task action.", action.ref);

    try {
      const result = action.action === "save_human_response"
        ? await saveHumanResponse(action.prompt_id, { content: input.content, expectedRevision: action.expected_revision })
        : await respondAndContinue(action.prompt_id, { content: input.content, expectedRevision: action.expected_revision, provider: action.provider, model: action.model });
      return workspaces.recordTaskControlReceipt({
        commandId: input.commandId,
        actionRef: action.ref,
        state: "APPLIED",
        responseId: result.responseId,
        started: result.started,
        runId: result.runId,
        message: result.error ?? (result.started ? "Answer saved and resume requested." : "Answer saved; task remains waiting."),
        errorCode: result.error ? "resume_failed" : null,
      });
    } catch (error) {
      const code = error instanceof WorkspaceError ? error.code : "internal_error";
      const message = error instanceof Error ? error.message : "Task-control action failed.";
      return this.reject(input, code, message, action.ref);
    }
  }

  private assertEnabled(): void {
    if (!this.config.enabled) throw new WorkspaceError(409, "task_control_disabled", "Telegram task control is disabled.");
  }

  private assertRemoteActions(): void {
    this.assertEnabled();
    if (!this.config.remoteActionsEnabled) throw new WorkspaceError(409, "remote_actions_disabled", "Remote task-control actions are disabled.");
  }

  private actorById(actorId: string) {
    const actor = workspaces.taskControlActorById(actorId);
    if (!actor || actor.enabled !== 1 || actor.transport !== this.config.transport) throw new WorkspaceError(403, "actor_not_enrolled", "Task-control actor is not enrolled.");
    return actor;
  }

  private createRef(): string {
    return `tc_${randomBytes(18).toString("base64url")}`;
  }

  private reject(input: TaskControlCallbackInput, code: string, message: string, actionRef: string | null): TaskControlReceipt {
    if (actionRef === null) {
      return {
        commandId: input.commandId,
        state: "REJECTED",
        action: "save_human_response",
        promptId: 0,
        message,
        responseId: null,
        started: false,
        runId: null,
        errorCode: code,
        createdAt: new Date().toISOString(),
      };
    }
    return workspaces.recordTaskControlReceipt({
      commandId: input.commandId,
      actionRef,
      state: "REJECTED",
      message,
      errorCode: code,
    });
  }
}

export const taskControl = new TaskControlService(() => ({
  enabled: settings.taskControl.enabled,
  notificationsEnabled: settings.taskControl.notificationsEnabled,
  remoteActionsEnabled: settings.taskControl.remoteActionsEnabled,
  transport: settings.taskControl.transport,
  botId: settings.taskControl.botId,
}));
