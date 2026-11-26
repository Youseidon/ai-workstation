import type { NormalizedEvent, RunMessage } from "@hydra/shared";
import { getAdapter } from "../../providers/registry.ts";
import { newId } from "../../utils/ids.ts";
import { createLogger } from "../../utils/logger.ts";
import { runHub } from "./runHub.ts";
import { WorkspaceError, workspaces } from "../../repositories/workspaces.ts";

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

export function supportsLiveDelivery(runId: string): boolean {
  const live = runHub.get(runId);
  return live !== undefined && typeof getAdapter(live.provider).sendUserMessage === "function";
}

export type ResumeRequester = (runId: string, message: RunMessage) => Promise<void>;
let requestResume: ResumeRequester | null = null;
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

export function supersedeUndelivered(runId: string): RunMessage[] {
  const settled: RunMessage[] = [];
  for (const message of workspaces.runMessages(runId)) {
    if (message.direction !== "OPERATOR" || message.state !== "QUEUED" || message.delivery === "resume") continue;
    const row = workspaces.settleRunMessage(message.id, "QUEUED", "SUPERSEDED");
    if (row !== null) { settled.push(row); emit(row); }
  }
  return settled;
}

export function inboxPayload(runId: string): Array<{ id: number; text: string; sentAt: string }> {
  return drainInbox(runId).map((message) => ({ id: message.id, text: message.text, sentAt: message.createdAt }));
}

runHub.onBeforeEnd((runId) => { supersedeUndelivered(runId); });
