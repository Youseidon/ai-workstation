import { expect } from "@playwright/test";
import { eventually } from "../drivers/state.ts";
import { openApp } from "../fixtures.ts";
import { telegramStatus } from "../telegramFlows.ts";
import type { L1Context } from "./l1.ts";
import { blockTask, executeRuns, humanResponses, receipts, replyWithAnswer, tapAndReport, waitForPromptStatus } from "./l1Flows.ts";
import { command } from "./l3B.ts";

/*
 * L3 slice C1 scenarios (docs/e2e-scenarios/l3-c1.md): the thread registry and a chat organised
 * without topics. Observed on the phone (tags, replies, the pinned panel and what is never edited),
 * in the Bot API calls and in the registry itself.
 */

let sequence = 0;
const label = (base: string) => `${base} ${++sequence}`;

interface ThreadRow {
  id: number;
  subject_kind: string;
  subject_id: string;
  topic_id: string | null;
  status_message_id: number | null;
  state: string;
}

const threads = (harness: L1Context["harness"], kind: string, subjectId?: string) =>
  harness.query<ThreadRow>(
    `SELECT id, subject_kind, subject_id, topic_id, status_message_id, state FROM telegram_thread WHERE subject_kind = ?${subjectId === undefined ? "" : " AND subject_id = ?"} ORDER BY id`,
    ...(subjectId === undefined ? [kind] : [kind, subjectId]),
  );

const sentMessageId = (harness: L1Context["harness"], outboxId: number) =>
  harness.query<{ sent: string | null }>("SELECT sent_message_id sent FROM telegram_outbox WHERE id = ?", outboxId)[0]?.sent ?? null;

/**
 * The bot and the user client number the same message differently on real Telegram: a Bot API
 * message id belongs to the bot's view of the chat, and the client's id to the account's. Only the
 * fake gives both the same number, so the registry is checked against the Bot API calls, which are
 * in the bot's space, while the phone's own assertions stay in the client's.
 */
const lastReplyTarget = (harness: L1Context["harness"]) => {
  const calls = harness.telegramCalls().filter((call) => call.method === "sendMessage" && call.body.reply_to_message_id !== undefined);
  return calls.length === 0 ? null : String(calls.at(-1)!.body.reply_to_message_id);
};

/** S-L3-C1-10: a task's messages carry its tag and reply to its card, and the card is never overwritten. */
export async function taskThreadOnThePhone(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const name = label("Pick the thread colour");
  const { task, card } = await blockTask(harness, phone, { title: name, later: [{ behavior: "consume-answer", expectInContext: "Red" }] });
  const tag = card.text.split("\n")[0]!;
  expect(tag).toMatch(/^#[A-Za-z0-9_]*[A-Za-z][A-Za-z0-9_]*$/);
  expect(tag).toContain(`_t${task.promptId}`);
  expect(card.replyToId).toBeNull();

  const answerCard = await replyWithAnswer(phone, card, "Red");
  expect(answerCard.replyToId).toBe(card.id);
  const { result } = await tapAndReport(phone, answerCard, "Answer and resume", /^Done: Answer saved and resume requested\./);
  expect(result.replyToId).toBe(card.id);
  expect(result.text.endsWith(`\n${tag}`)).toBe(true);
  // The record of what was decided is its own message: the anchor is never edited to carry it.
  const anchor = (await phone.messages()).find((message) => message.id === card.id)!;
  expect(anchor.edited).toBe(false);
  expect(anchor.text).toBe(card.text);

  const registry = threads(harness, "task", String(task.promptId));
  expect(registry).toHaveLength(1);
  expect(registry[0]!.topic_id).toBeNull();
  expect(registry[0]!.state).toBe("ACTIVE");
  const anchorSent = sentMessageId(harness, registry[0]!.status_message_id!);
  expect(anchorSent).not.toBeNull();
  // The registry's anchor is the message the replies were actually addressed to.
  expect(lastReplyTarget(harness)).toBe(anchorSent);

  // Everything behind the card is exactly S-L1-05.
  await waitForPromptStatus(task, "DONE");
  expect(await humanResponses(task)).toEqual(["Red"]);
  expect(await executeRuns(task)).toHaveLength(2);
  expect(receipts(harness, task).filter((receipt) => receipt.state === "APPLIED")).toHaveLength(1);
}

/** S-L3-C1-11: the workstation owns one control panel, pinned once and edited in place afterwards. */
export async function pinnedControlPanel(ctx: L1Context): Promise<void> {
  const { harness, phone, page } = ctx;
  const pins = () => harness.telegramCalls().filter((call) => call.method === "pinChatMessage");
  const panel = await command(ctx, "/status", /^Status · /);
  await eventually("the panel to be pinned", async () => (harness.telegramServer!.pinnedMessageId(Number(phone.chatId)) === panel.id ? true : undefined));
  expect(pins()).toHaveLength(1);
  const workstation = threads(harness, "workstation");
  expect(workstation).toHaveLength(1);
  expect(workstation[0]!.topic_id).toBeNull();
  expect(sentMessageId(harness, workstation[0]!.status_message_id!)).toBe(String(panel.id));

  await blockTask(harness, phone, { title: label("Panel counts this") });
  const reply = await command(ctx, "/status", /^Status · /);
  expect(reply.id).not.toBe(panel.id);
  const refreshed = await eventually("the pinned panel to show the new counts", async () => (await phone.messages()).find((message) => message.id === panel.id && message.edited && message.text === reply.text));
  expect(refreshed.id).toBe(panel.id);
  expect(pins()).toHaveLength(1);
  expect(harness.telegramServer!.pinnedMessageId(Number(phone.chatId))).toBe(panel.id);

  // The workstation says why the chat is organised this way rather than with topics.
  const status = await telegramStatus();
  expect(status.topics.available).toBe(false);
  await openApp(page, "/agents");
  await expect(page.getByText(status.topics.note, { exact: false })).toBeVisible();
}

/** S-L3-C1-12: a deleted panel fails its edit once, the registry gives up on it, and the next /status registers a new one. */
export async function panelRecovery(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const workstation = () => threads(harness, "workstation")[0]!;
  const panelId = Number(sentMessageId(harness, workstation().status_message_id!));
  const panel = (await phone.messages()).find((message) => message.id === panelId)!;
  await phone.deleteMessage(panel);

  await command(ctx, "/status", /^Status · /);
  const failed = await eventually("the edit of the deleted panel to fail", async () =>
    harness.query<{ attempt_count: number; next_attempt_at: string | null; last_error: string | null }>(
      "SELECT attempt_count, next_attempt_at, last_error FROM telegram_outbox WHERE operation = 'edit' AND state = 'FAILED' AND last_error LIKE '%not found%' ORDER BY id DESC LIMIT 1",
    )[0]);
  expect(failed.attempt_count).toBe(1);
  expect(failed.next_attempt_at).toBeNull();
  await eventually("the registry to mark the anchor gone", async () => (workstation().state === "ANCHOR_GONE" ? true : undefined));

  const replacement = await command(ctx, "/status", /^Status · /);
  await eventually("the new panel to be pinned", async () => (harness.telegramServer!.pinnedMessageId(Number(phone.chatId)) === replacement.id ? true : undefined));
  expect(workstation().state).toBe("ACTIVE");
  expect(sentMessageId(harness, workstation().status_message_id!)).toBe(String(replacement.id));
  // A message the operator deleted is not an outage.
  expect((await telegramStatus()).state).toBe("polling");
}
