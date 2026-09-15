import type { PhoneDriver, PhoneMessage } from "../drivers/phone.ts";
import type { FakeScenario } from "../drivers/fakeProvider.ts";
import type { HarnessEnvironment } from "../env/orchestrator.ts";
import { eventually, state, type SavedTask } from "../drivers/state.ts";
import { runSavedTask, waitForRunEnd } from "../scenarios.ts";

/* Phone and durable-state steps shared by the L1 scenarios on every backend. */

/**
 * Question, answer and saved-answer cards name their task on the line after the breadcrumb
 * (L3 slice A, user-flows section 2). The only locator the scenarios use for a card.
 */
export const isCardFor = (message: PhoneMessage, title: string): boolean => message.text.split("\n")[1] === `Task: ${title}`;
export const isTaskCard = (message: PhoneMessage): boolean => (message.text.split("\n")[1] ?? "").startsWith("Task: ");

export interface Receipt {
  command_id: string;
  action_ref: string;
  state: "APPLIED" | "REJECTED";
  started: number;
  run_id: string | null;
  message: string;
  error_code: string | null;
  action: string;
  prompt_id: number;
}

export function receipts(harness: HarnessEnvironment, task: SavedTask): Receipt[] {
  return harness.query<Receipt>(
    "SELECT r.command_id, r.action_ref, r.state, r.started, r.run_id, r.message, r.error_code, a.action, a.prompt_id FROM task_control_receipt r JOIN task_control_action a ON a.ref = r.action_ref WHERE a.prompt_id = ? ORDER BY r.created_at",
    task.promptId,
  );
}

export async function humanResponses(task: SavedTask): Promise<string[]> {
  return (await state.history(task)).remarks.filter((remark) => remark.kind === "HUMAN_RESPONSE").map((remark) => remark.content);
}

export async function executeRuns(task: SavedTask) {
  return (await state.sessionsFor(task)).filter((session) => session.role === "execute");
}

/** Blocks a task through the fake agent, queueing what later runs will do, and returns its question card. */
export async function blockTask(harness: HarnessEnvironment, phone: PhoneDriver, args: { title: string; blocker?: string; humanAction?: string; later?: FakeScenario[]; content?: string }) {
  const before = await phone.cursor();
  const { task, runId } = await runSavedTask(harness, {
    title: args.title,
    ...(args.content ? { content: args.content } : {}),
    scenarios: [{ behavior: "block-on-decision", reason: args.blocker ?? "Two options fit the brief.", humanAction: args.humanAction ?? "Choose one option." }, ...(args.later ?? [])],
  });
  await waitForRunEnd(task, runId);
  const card = await questionCard(phone, args.title, before);
  return { task, card, firstRunId: runId };
}

export function questionCard(phone: PhoneDriver, title: string, afterId: number, timeoutMs = 30_000): Promise<PhoneMessage> {
  return phone.waitForBotMessage(`the question card for "${title}"`, (message) => isCardFor(message, title), { afterId, timeoutMs });
}

/** Replies to a question card and waits for the answer card that binds that text to buttons. */
export async function replyWithAnswer(phone: PhoneDriver, card: PhoneMessage, answer: string, timeoutMs = 30_000): Promise<PhoneMessage> {
  const before = await phone.cursor();
  await phone.send(answer, { replyTo: card });
  return phone.waitForBotMessage(`the answer card for "${answer}"`, (message) => message.buttons.includes("Save answer") && message.text.includes(answer), { afterId: before, timeoutMs });
}

export async function tapAndReport(phone: PhoneDriver, message: PhoneMessage, button: string, resultPattern: RegExp, timeoutMs = 30_000) {
  const before = await phone.cursor();
  const { toast } = await phone.tap(message, button);
  const result = await phone.waitForBotMessage(`a result message matching ${resultPattern}`, (item) => resultPattern.test(item.text), { afterId: before, timeoutMs });
  return { toast, result, before };
}

export async function waitForPromptStatus(task: SavedTask, status: string, timeoutMs = 60_000) {
  return eventually(`prompt ${task.promptId} to be ${status}`, async () => ((await state.prompt(task)).status === status ? true : undefined), timeoutMs);
}

export async function waitForRuns(task: SavedTask, count: number, timeoutMs = 30_000) {
  return eventually(`${count} execute runs`, async () => {
    const runs = await executeRuns(task);
    return runs.length >= count ? runs : undefined;
  }, timeoutMs);
}

/** Waits until every stored update has been processed, so absence assertions are meaningful. */
export async function inboxDrained(harness: HarnessEnvironment) {
  await eventually("the Telegram inbox to drain", async () => harness.query<{ n: number }>("SELECT COUNT(*) n FROM telegram_inbox WHERE processed_at IS NULL")[0]!.n === 0);
}

export function outboxFor(harness: HarnessEnvironment, task: SavedTask) {
  return harness.query<{ id: number; state: string; chat_id: string; payload_json: string; sent_message_id: string | null }>(
    "SELECT id, state, chat_id, payload_json, sent_message_id FROM telegram_outbox WHERE json_extract(payload_json, '$.promptId') = ? ORDER BY id",
    task.promptId,
  );
}

export async function activityRevision(task: SavedTask): Promise<string> {
  return (await state.get<{ humanInput: { revision: string } }>(`/api/prompts/${task.promptId}/activity`)).humanInput.revision;
}
