import { expect } from "@playwright/test";
import type { PhoneMessage } from "../drivers/phone.ts";
import { eventually, observeQuietPeriod, state } from "../drivers/state.ts";
import { telegramStatus, waitForTelegramState } from "../telegramFlows.ts";
import type { L1Context } from "./l1.ts";
import { blockTask, executeRuns, isCardFor, humanResponses, inboxDrained, outboxFor, receipts, replyWithAnswer, tapAndReport, waitForPromptStatus } from "./l1Flows.ts";

/*
 * L3 slice F1 scenarios (docs/e2e-scenarios/l3-f1-f2.md): the outbox edit operation, driven through the
 * harness-only edit trigger (operator question 1) and observed on the phone, the Bot API calls and the
 * durable outbox. Written against PhoneDriver so T1 and T3 share the bodies where the table allows.
 */

let sequence = 0;
const label = (base: string) => `${base} ${++sequence}`;

interface OutboxRow {
  id: number;
  state: "QUEUED" | "SENT" | "FAILED";
  attempt_count: number;
  last_error: string | null;
  next_attempt_at: string | null;
  operation: "send" | "edit";
  target_outbox_id: number | null;
  payload_json: string;
}

export const outboxRow = (harness: L1Context["harness"], id: number) => harness.query<OutboxRow>("SELECT id,state,attempt_count,last_error,next_attempt_at,operation,target_outbox_id,payload_json FROM telegram_outbox WHERE id = ?", id)[0];
const editsOf = (harness: L1Context["harness"], target: number) => harness.query<OutboxRow>("SELECT id,state,attempt_count,last_error,next_attempt_at,operation,target_outbox_id,payload_json FROM telegram_outbox WHERE target_outbox_id = ? ORDER BY id", target);
const editCalls = (harness: L1Context["harness"], since = 0) => harness.telegramCalls().filter((call) => call.method === "editMessageText" && call.at >= since);
const sendCalls = (harness: L1Context["harness"], since = 0) => harness.telegramCalls().filter((call) => call.method === "sendMessage" && call.at >= since);

export async function queueText(phone: L1Context["phone"], text: string): Promise<number> {
  return (await state.post<{ outboxId: number }>("/api/task-control/telegram/harness/outbox", { chatId: phone.chatId, text })).outboxId;
}

export async function queueEdit(outboxId: number, payload: unknown): Promise<number> {
  return (await state.post<{ outboxId: number }>(`/api/task-control/telegram/harness/outbox/${outboxId}/edit`, { payload })).outboxId;
}

const text = (value: string) => ({ kind: "text", text: value });

/** Sends a plain message through the outbox and waits until the phone shows it and the row is SENT. */
async function sendBase({ harness, phone }: L1Context, content: string): Promise<{ outboxId: number; message: PhoneMessage }> {
  const before = await phone.cursor();
  const outboxId = await queueText(phone, content);
  const message = await phone.waitForBotMessage(`"${content}"`, (item) => item.text === content, { afterId: before, timeoutMs: 30_000 });
  await eventually(`outbox ${outboxId} to be SENT`, async () => outboxRow(harness, outboxId)?.state === "SENT");
  return { outboxId, message };
}

async function showsText(phone: L1Context["phone"], message: PhoneMessage, expected: string, timeoutMs = 30_000): Promise<PhoneMessage> {
  return eventually(`message ${message.id} to show "${expected}"`, async () => (await phone.messages()).find((item) => item.id === message.id && item.text === expected), timeoutMs);
}

/** Nothing queued or retrying. Failed rows left by earlier scenarios in the same environment are counted separately. */
const outboxClear = () => eventually("nothing queued or retrying in the outbox", async () => {
  const { outbox } = await telegramStatus();
  return outbox.queued + outbox.retrying === 0 ? true : undefined;
}, 60_000);

/** S-L3-F1-05: two edits change one message in place; no new message stacks. */
export async function editInPlace(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const base = label("Status v0");
  const { outboxId, message } = await sendBase(ctx, base);
  const startedAt = Date.now();
  const cursor = await phone.cursor();
  const first = await queueEdit(outboxId, text(`${base} v1`));
  await showsText(phone, message, `${base} v1`);
  await eventually("the first edit to be SENT", async () => outboxRow(harness, first)?.state === "SENT");
  const second = await queueEdit(outboxId, text(`${base} v2`));
  const edited = await showsText(phone, message, `${base} v2`);
  expect(edited.edited).toBe(true);
  await eventually("the second edit to be SENT", async () => outboxRow(harness, second)?.state === "SENT");
  expect(first).not.toBe(second);
  for (const id of [first, second]) expect(outboxRow(harness, id)).toMatchObject({ state: "SENT", attempt_count: 1, last_error: null, operation: "edit", target_outbox_id: outboxId });
  expect(editCalls(harness, startedAt)).toHaveLength(2);
  expect(sendCalls(harness, startedAt)).toHaveLength(0);
  expect((await phone.messages()).filter((item) => item.fromBot && item.id > cursor)).toEqual([]);
  await outboxClear();
}

/** S-L3-F1-06: edits of a question card and an answer card; replies still map to the card and actions apply once. */
export async function editCardsKeepReplyMapping(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const name = label("Pick the edited colour");
  const { task, card } = await blockTask(harness, phone, { title: name, later: [{ behavior: "consume-answer", expectInContext: "Green" }] });
  const questionRow = outboxFor(harness, task).find((row) => row.payload_json.includes("personal_question") && row.sent_message_id !== null)!;
  // Cards render from the task summary (slice A), so an edit changes the summary it carries.
  const payload = JSON.parse(questionRow.payload_json) as { summary: { ifYouWait: string } };
  const withWait = (suffix: string) => ({ ...payload, summary: { ...payload.summary, ifYouWait: `${payload.summary.ifYouWait} ${suffix}` } });
  await queueEdit(questionRow.id, withWait("(edited)"));
  const editedCard = await eventually("the question card to be edited", async () => (await phone.messages()).find((item) => item.id === card.id && item.edited && item.text.includes("(edited)")));
  expect(editedCard.buttons).toEqual(card.buttons);
  expect(receipts(harness, task)).toEqual([]);

  const answerCard = await replyWithAnswer(phone, editedCard, "Green");
  const answerRow = outboxFor(harness, task).filter((row) => row.payload_json.includes("save_human_response") && row.sent_message_id !== null).at(-1)!;
  const decoy = await replyWithAnswer(phone, editedCard, "Green");
  await queueEdit(answerRow.id, text("This answer card was replaced."));
  const stripped = await eventually("the answer card to lose its buttons", async () => (await phone.messages()).find((item) => item.id === answerCard.id && item.text === "This answer card was replaced."));
  expect(stripped.buttons).toEqual([]);
  expect(receipts(harness, task)).toEqual([]);
  expect(await humanResponses(task)).toEqual([]);

  await tapAndReport(phone, decoy, "Answer and resume", /^Done: Answer saved and resume requested\./);
  await waitForPromptStatus(task, "DONE");
  expect(receipts(harness, task).filter((receipt) => receipt.state === "APPLIED")).toHaveLength(1);
  expect(await executeRuns(task)).toHaveLength(2);
  await queueEdit(questionRow.id, withWait("(edited after applying)"));
  await eventually("the late edit to be delivered", async () => (await phone.messages()).some((item) => item.id === card.id && item.text.includes("edited after applying")));
  expect(receipts(harness, task).filter((receipt) => receipt.state === "APPLIED")).toHaveLength(1);
  expect(await humanResponses(task)).toEqual(["Green"]);
}

/** S-L3-F1-07 (fake): three edits queued during an outage are delivered as one, carrying the last. */
export async function coalescedBurst(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const server = harness.telegramServer!;
  const base = label("Burst v0");
  const { outboxId, message } = await sendBase(ctx, base);
  server.setOutage("refuse");
  await eventually("the transport to back off", async () => ((await telegramStatus()).state === "backoff" ? true : undefined), 30_000);
  for (const suffix of ["A", "B", "C"]) await queueEdit(outboxId, text(`${base} ${suffix}`));
  expect(editsOf(harness, outboxId)).toHaveLength(1);
  const callsBefore = server.calls.length;
  server.setOutage(null);
  await waitForTelegramState("polling", 60_000);
  await showsText(phone, message, `${base} C`);
  await outboxClear();
  const edits = server.calls.slice(callsBefore).filter((call) => call.method === "editMessageText");
  expect(edits.map((call) => call.body.text)).toEqual([`${base} C`]);
  expect(server.transcript(Number(phone.chatId)).find((item) => item.message_id === message.id)!.history).toEqual([base, `${base} C`]);
}

/** S-L3-F1-09 (fake): edits of different messages never coalesce with each other or with sends. */
export async function editsStayPerMessage(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const server = harness.telegramServer!;
  const m1 = await sendBase(ctx, label("M1"));
  const m2 = await sendBase(ctx, label("M2"));
  server.setOutage("refuse");
  await eventually("the transport to back off", async () => ((await telegramStatus()).state === "backoff" ? true : undefined), 30_000);
  const before = await phone.cursor();
  const callsBefore = server.calls.length;
  await queueEdit(m1.outboxId, text(`${m1.message.text} a`));
  await queueEdit(m2.outboxId, text(`${m2.message.text} a`));
  await queueEdit(m1.outboxId, text(`${m1.message.text} b`));
  const fresh = label("S");
  await queueText(phone, fresh);
  await queueEdit(m1.outboxId, text(`${m1.message.text} c`));
  server.setOutage(null);
  await waitForTelegramState("polling", 60_000);
  await showsText(phone, m1.message, `${m1.message.text} c`);
  await showsText(phone, m2.message, `${m2.message.text} a`);
  await phone.waitForBotMessage("the new send", (item) => item.text === fresh, { afterId: before });
  await outboxClear();
  const calls = server.calls.slice(callsBefore);
  expect(calls.filter((call) => call.method === "editMessageText").map((call) => call.body.text).sort()).toEqual([`${m1.message.text} c`, `${m2.message.text} a`].sort());
  expect(calls.filter((call) => call.method === "sendMessage" && call.body.text === fresh)).toHaveLength(1);
}

/** S-L3-F1-10: an edit identical to what Telegram shows is "not modified" and counts as delivered. */
export async function unmodifiedEditIsSuccess(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const base = label("Unchanged");
  const { outboxId, message } = await sendBase(ctx, base);
  const startedAt = Date.now();
  const edit = await queueEdit(outboxId, text(base));
  await eventually("the unchanged edit to be SENT", async () => outboxRow(harness, edit)?.state === "SENT");
  await observeQuietPeriod(3_000, "a retry of an unmodified edit");
  expect(outboxRow(harness, edit)).toMatchObject({ state: "SENT", attempt_count: 1, last_error: null, next_attempt_at: null });
  expect(editCalls(harness, startedAt)).toHaveLength(1);
  const status = await telegramStatus();
  expect(status.state).toBe("polling");
  expect(status.lastError).toBeNull();
  expect((await phone.messages()).filter((item) => item.text === base)).toEqual([expect.objectContaining({ id: message.id })]);
}

/** S-L3-F1-11 (fake): an applied edit whose response was lost is retried, answered not modified, and applied once. */
export async function lostEditResponse(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const server = harness.telegramServer!;
  const base = label("Lost response");
  const { outboxId, message } = await sendBase(ctx, base);
  server.dropNextResponse("editMessageText");
  const callsBefore = server.calls.length;
  const edit = await queueEdit(outboxId, text(`${base} edited`));
  await eventually("the edit to end SENT", async () => outboxRow(harness, edit)?.state === "SENT", 60_000);
  expect(server.transcript(Number(phone.chatId)).find((item) => item.message_id === message.id)!.history).toEqual([base, `${base} edited`]);
  const calls = server.calls.slice(callsBefore);
  expect(calls.filter((call) => call.method === "editMessageText").length).toBeLessThanOrEqual(2);
  expect(calls.filter((call) => call.method === "sendMessage" && String(call.body.text).includes("edited"))).toEqual([]);
  await outboxClear();
}

/** S-L3-F1-12: an edit of a message the operator deleted fails once, is never retried, and nothing reappears. */
export async function editOfDeletedMessage(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const base = label("Deleted later");
  const { outboxId, message } = await sendBase(ctx, base);
  await phone.deleteMessage(message);
  const failedBefore = (await telegramStatus()).outbox.failed;
  const startedAt = Date.now();
  const edit = await queueEdit(outboxId, text(`${base} edited`));
  const failed = await eventually("the edit to fail", async () => (outboxRow(harness, edit)?.state === "FAILED" ? outboxRow(harness, edit) : undefined), 30_000);
  expect(failed).toMatchObject({ attempt_count: 1, next_attempt_at: null });
  expect(failed!.last_error ?? "").toMatch(/message to edit not found|message can't be edited/);
  expect(failed!.last_error ?? "").not.toContain(harness.telegramToken().split(":")[1]!);
  await harness.restartServer();
  await waitForTelegramState("polling", 60_000);
  const after = await sendBase(ctx, label("After the deleted edit"));
  await observeQuietPeriod(3_000, "a retry of the failed edit");
  expect(outboxRow(harness, edit)!.attempt_count).toBe(1);
  expect(editCalls(harness, startedAt)).toHaveLength(1);
  expect((await phone.messages()).some((item) => item.text.includes(`${base} edited`))).toBe(false);
  const status = await telegramStatus();
  expect(status.state).toBe("polling");
  // Operator question 2 default: the spec's "recorded as failed without retry" shows as one failed row.
  expect(status.outbox.failed).toBe(failedBefore + 1);
  expect(after.message.text).toMatch(/^After the deleted edit/);
}

/** S-L3-F1-14 (fake): a 429 on an edit holds every call until retry_after, then the newest edit and the send go once. */
export async function rateLimitedEdit(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const server = harness.telegramServer!;
  const base = label("Rate limited");
  const { outboxId, message } = await sendBase(ctx, base);
  server.failNext("editMessageText", 429, { retryAfter: 3, description: "Too Many Requests: retry after 3" });
  const edit = await queueEdit(outboxId, text(`${base} A`));
  await eventually("the edit to be rate limited", async () => (outboxRow(harness, edit)?.state === "FAILED" ? true : undefined), 30_000);
  const limitedAt = server.calls.filter((call) => call.method === "editMessageText").at(-1)!.at;
  await queueEdit(outboxId, text(`${base} B`));
  await queueEdit(outboxId, text(`${base} C`));
  const fresh = label("After the limit");
  const before = await phone.cursor();
  await queueText(phone, fresh);
  expect((await telegramStatus()).outbox.retrying).toBe(1);
  await showsText(phone, message, `${base} C`);
  await phone.waitForBotMessage("the send after the limit", (item) => item.text === fresh, { afterId: before });
  const later = server.calls.filter((call) => call.at > limitedAt && (call.method === "editMessageText" || call.method === "sendMessage"));
  expect(later.every((call) => call.at >= limitedAt + 3_000)).toBe(true);
  expect(later.filter((call) => call.method === "editMessageText").map((call) => call.body.text)).toEqual([`${base} C`]);
  expect(later.filter((call) => call.method === "sendMessage" && call.body.text === fresh)).toHaveLength(1);
  await outboxClear();
}

/** S-L3-F1-15 (fake): during an outage or 5xx, edits and a new card wait; afterwards the latest edit and the card arrive once. */
export async function editsThroughFaults(ctx: L1Context, fault: "refuse" | "5xx"): Promise<void> {
  const { harness, phone } = ctx;
  const server = harness.telegramServer!;
  const base = label(`Fault ${fault}`);
  const { outboxId, message } = await sendBase(ctx, base);
  if (fault === "refuse") server.setOutage("refuse");
  else server.failNext("*", 500, { count: 6 });
  await queueEdit(outboxId, text(`${base} 1`));
  const name = label(`Card during ${fault}`);
  const before = await phone.cursor();
  const blocked = blockTask(harness, phone, { title: name });
  await eventually("the transport to back off", async () => {
    const status = await telegramStatus();
    return status.state === "backoff" ? status : undefined;
  }, 60_000);
  await queueEdit(outboxId, text(`${base} 2`));
  if (fault === "refuse") server.setOutage(null);
  const { card } = await blocked;
  await waitForTelegramState("polling", 90_000);
  await showsText(phone, message, `${base} 2`, 90_000);
  await outboxClear();
  expect((await phone.messages()).filter((item) => item.fromBot && item.id > before && isCardFor(item, name))).toEqual([card]);
  expect(harness.telegramCalls().filter((call) => call.method === "editMessageText" && String(call.body.text).startsWith(base)).map((call) => call.body.text).filter((value) => value === `${base} 1`).length).toBeLessThanOrEqual(1);
}

/** S-L3-F1-17 (fake): an edit queued before its send has a message id is never issued early; the latest content shows once. */
export async function editBeforeSend(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const server = harness.telegramServer!;
  server.setOutage("refuse");
  await eventually("the transport to back off", async () => ((await telegramStatus()).state === "backoff" ? true : undefined), 30_000);
  const base = label("Pending send");
  const before = await phone.cursor();
  const callsBefore = server.calls.length;
  const outboxId = await queueText(phone, base);
  const edit = await queueEdit(outboxId, text(`${base} latest`));
  expect(outboxRow(harness, edit)!.state).toBe("QUEUED");
  server.setOutage(null);
  await waitForTelegramState("polling", 60_000);
  const shown = await phone.waitForBotMessage("the pending send", (item) => item.text.startsWith(base), { afterId: before, timeoutMs: 60_000 });
  await showsText(phone, shown, `${base} latest`, 60_000);
  await outboxClear();
  const calls = server.calls.slice(callsBefore).filter((call) => call.method === "editMessageText" || (call.method === "sendMessage" && String(call.body.text).startsWith(base)));
  expect(calls.map((call) => call.method)).toEqual(["sendMessage", "editMessageText"]);
  expect(Number(calls[1]!.body.message_id)).toBe(shown.id);
  expect((await phone.messages()).filter((item) => item.text.startsWith(base))).toHaveLength(1);
}

/** S-L3-F1-18: queued and coalescible edits survive a restart and are delivered once with the newest content. */
export async function editsSurviveRestart(ctx: L1Context, coalesce: boolean): Promise<void> {
  const { harness, phone } = ctx;
  const base = label(`Restart ${coalesce ? "burst" : "single"}`);
  const { outboxId, message } = await sendBase(ctx, base);
  const started = Date.now();
  // With the route cut nothing is delivered, so the edits are durable queued rows when the server restarts.
  harness.network.cutTelegram("refuse");
  await eventually("the transport to back off", async () => ((await telegramStatus()).state === "backoff" ? true : undefined), 60_000);
  const suffixes = coalesce ? ["x", "y", "z"] : ["x"];
  for (const suffix of suffixes) await queueEdit(outboxId, text(`${base} ${suffix}`));
  await harness.restartServer();
  harness.network.restoreTelegram();
  await waitForTelegramState("polling", 120_000);
  await showsText(phone, message, `${base} ${suffixes.at(-1)}`, 60_000);
  await outboxClear();
  const delivered = harness.telegramCalls().filter((call) => call.at >= started && call.method === "editMessageText" && "outcome" in call && call.outcome === 200);
  expect(delivered.map((call) => call.body.text)).toEqual([`${base} ${suffixes.at(-1)}`]);
  expect(editsOf(harness, outboxId).filter((row) => row.state === "SENT")).toHaveLength(1);
}

/** S-L3-F1-20 (T1 part): unpairing drops queued edits to that chat, so no working buttons are restored there. */
export async function unpairDropsQueuedEdits(ctx: L1Context, repair: () => Promise<void>): Promise<void> {
  const { harness, phone } = ctx;
  const server = harness.telegramServer!;
  const base = label("Before unpairing");
  const { outboxId, message } = await sendBase(ctx, base);
  server.setOutage("refuse");
  await eventually("the transport to back off", async () => ((await telegramStatus()).state === "backoff" ? true : undefined), 30_000);
  await queueEdit(outboxId, { kind: "text", text: `${base} with buttons restored` });
  const actor = (await telegramStatus()).actors.find((item) => item.chatId === phone.chatId)!;
  await state.delete(`/api/task-control/telegram/actors/${actor.id}`);
  expect(editsOf(harness, outboxId)).toEqual([]);
  server.setOutage(null);
  await waitForTelegramState("polling", 60_000);
  await phone.waitForBotMessage("the unpaired notice", (item) => item.text.startsWith("This chat was unpaired"), { afterId: message.id, timeoutMs: 60_000 });
  await inboxDrained(harness);
  await observeQuietPeriod(3_000, "the dropped edit being delivered");
  expect((await phone.messages()).find((item) => item.id === message.id)!.text).toBe(base);
  await repair();
}

/** S-L3-F1-13 (fake): permanent edit rejections are recorded once, never retried, and never move the transport to backoff. */
export async function permanentEditFailures(ctx: L1Context): Promise<void> {
  const { harness } = ctx;
  const server = harness.telegramServer!;
  const cases: Array<[number, string]> = [[400, "Bad Request: message can't be edited"], [403, "Forbidden: bot was blocked by the user"], [400, "Bad Request: chat not found"], [400, "Bad Request: message is too long"]];
  for (const [code, description] of cases) {
    const base = label(`Permanent ${code}`);
    const { outboxId } = await sendBase(ctx, base);
    server.failNext("editMessageText", code, { description });
    const edit = await queueEdit(outboxId, text(`${base} edited`));
    const failed = await eventually(`the edit to fail with ${description}`, async () => (outboxRow(harness, edit)?.state === "FAILED" ? outboxRow(harness, edit) : undefined), 30_000);
    const later = await sendBase(ctx, label(`After ${code}`));
    await observeQuietPeriod(2_000, "a retry of a permanent failure");
    expect(outboxRow(harness, edit)).toMatchObject({ state: "FAILED", attempt_count: 1, next_attempt_at: null });
    expect(failed!.last_error ?? "").toContain(description.split(": ")[1]!);
    expect(failed!.last_error ?? "").not.toContain(harness.telegramToken().split(":")[1]!);
    expect(outboxRow(harness, later.outboxId)!.state).toBe("SENT");
    expect((await telegramStatus()).state).toBe("polling");
  }
}
