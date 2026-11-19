/**
 * `/btw`: talking to a run that is already working.
 *
 * Three ways a note reaches the agent, tried in this order:
 *
 * - **native**: the provider keeps an input channel open for the whole run
 *   (Claude's streaming input, Codex's app-server), so the note goes in mid-turn.
 * - **inbox**: every other provider runs headless with stdin closed. The note
 *   waits here and is handed over on the agent's next `agent-step` call, which
 *   the prompt tells it to make between major steps and before long commands.
 * - **resume**: the operator chose not to wait. The run is interrupted and its
 *   provider session continued with the note (see `pipelineScheduler`).
 *
 * The agent answers with `agent-step reply`, which never blocks the run.
 */

import type { NormalizedEvent, RunMessage } from "@agent-console/shared";
import { getAdapter } from "./adapters/registry.ts";
import { newId } from "./lib/ids.ts";
import { createLogger } from "./lib/logger.ts";
import { runHub } from "./runHub.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

const log = createLogger("btw");

export const RUN_MESSAGE_MAX_CHARS = 8000;

function emit(message: RunMessage): void {
  const live = runHub.get(message.runId);
  if (live === undefined) return;
  const base = { id: newId("evt"), runId: message.runId, provider: live.provider, model: live.model, timestamp: new Date().toISOString() };
  const event: NormalizedEvent = message.direction === "OPERATOR"
    ? { ...base, type: "operator_message", payload: { messageId: message.id, text: message.text, delivery: message.delivery, state: message.state } }
    : { ...base, type: "agent_message", payload: { messageId: message.id, text: message.text } };
  workspaces.recordAgentEvent(message.runId, event);
  runHub.event(message.runId, event);
}

function requireText(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new WorkspaceError(422, "validation_error", "Write a message first");
  const text = value.trim();
  if (text.length > RUN_MESSAGE_MAX_CHARS) throw new WorkspaceError(422, "validation_error", `Keep it under ${RUN_MESSAGE_MAX_CHARS} characters`);
  return text;
}

/**
 * Does this run's provider take a message mid-run? Asked of the adapter, not a
 * list here, so a provider that gains an input channel needs no change in this file.
 */
export function supportsLiveDelivery(runId: string): boolean {
  const live = runHub.get(runId);
  return live !== undefined && typeof getAdapter(live.provider).sendUserMessage === "function";
}

export type ResumeRequester = (runId: string, message: RunMessage) => Promise<void>;
let requestResume: ResumeRequester | null = null;
/** Installed by the scheduler, which owns stopping a run and continuing its session. */
export function setResumeRequester(requester: ResumeRequester | null): void { requestResume = requester; }

export async function sendBtw(runId: string, input: { text?: unknown; interrupt?: unknown }): Promise<RunMessage> {
  const text = requireText(input.text);
  const live = runHub.get(runId);
  if (live === undefined) throw new WorkspaceError(409, "run_not_active", "That agent is no longer running. Start a new run, or add the note as context for its step.");
  if (live.role !== "execute") throw new WorkspaceError(409, "btw_not_supported", "Only a working (execute) run can take a /btw message.");

  const adapter = getAdapter(live.provider);
  if (input.interrupt !== true && adapter.sendUserMessage !== undefined) {
    const message = workspaces.addRunMessage({ runId, direction: "OPERATOR", text, delivery: "native", state: "QUEUED" });
    emit(message);
    let delivered = false;
    try {
      delivered = await adapter.sendUserMessage(runId, `Message from the operator, sent while you are working:\n\n${text}`);
    } catch (error) {
      log.warn(`native btw failed run=${runId}; falling back to the inbox`, error);
    }
    const settled = delivered
      ? workspaces.settleRunMessage(message.id, "QUEUED", "DELIVERED", "native")
      : workspaces.settleRunMessage(message.id, "QUEUED", "QUEUED", "inbox");
    if (settled !== null) emit(settled);
    return settled ?? message;
  }

  if (input.interrupt === true) {
    if (requestResume === null) throw new WorkspaceError(409, "btw_interrupt_unavailable", "Interrupting a run to deliver a message is not available here.");
    const message = workspaces.addRunMessage({ runId, direction: "OPERATOR", text, delivery: "resume", state: "QUEUED" });
    emit(message);
    await requestResume(runId, message);
    return message;
  }

  const message = workspaces.addRunMessage({ runId, direction: "OPERATOR", text, delivery: "inbox", state: "QUEUED" });
  emit(message);
  return message;
}

/** Hands the agent every waiting note, and tells the operator each one landed. */
export function drainInbox(runId: string): RunMessage[] {
  const delivered = workspaces.drainRunInbox(runId);
  for (const message of delivered) emit(message);
  return delivered;
}

export function agentReply(runId: string, input: { text?: unknown }): RunMessage {
  const text = requireText(input.text);
  const message = workspaces.addRunMessage({ runId, direction: "AGENT", text, delivery: "inbox", state: "DELIVERED" });
  emit(message);
  return message;
}

/**
 * The run ended with notes the agent never picked up. Marked so the operator
 * sees they were not read, rather than "waiting" forever. Must run before the
 * run leaves the hub, or the state change has nowhere to be shown.
 */
export function supersedeUndelivered(runId: string): RunMessage[] {
  const settled: RunMessage[] = [];
  for (const message of workspaces.runMessages(runId)) {
    if (message.direction !== "OPERATOR" || message.state !== "QUEUED" || message.delivery === "resume") continue;
    const row = workspaces.settleRunMessage(message.id, "QUEUED", "SUPERSEDED");
    if (row !== null) { settled.push(row); emit(row); }
  }
  return settled;
}

/** Formats waiting notes for the shim to print ahead of whatever it was asked. */
export function inboxPayload(runId: string): Array<{ id: number; text: string; sentAt: string }> {
  return drainInbox(runId).map((message) => ({ id: message.id, text: message.text, sentAt: message.createdAt }));
}

runHub.onBeforeEnd((runId) => { supersedeUndelivered(runId); });
