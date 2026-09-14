import { expect, test } from "../../src/fixtures.ts";
import { FAKE_OPERATOR } from "../../src/env/orchestrator.ts";
import { eventually, observeQuietPeriod, state } from "../../src/drivers/state.ts";
import { blockedTaskCard, pairThroughAgentsPage, telegramStatus, waitForTelegramState } from "../../src/telegramFlows.ts";
import { inboxDrained } from "../../src/scenarios/l1Flows.ts";

// S-H6-21 and S-H6-22 on the fake backend: the bot starts with an earlier run's cards and pending updates.
test.use({ harnessOptions: { fakeProvider: "live", telegram: { backend: "fake", leftoversFromEarlierRun: true } } });
test.describe.configure({ mode: "serial" });

test("S-H6-21 (fake): updates an earlier run left pending act on nothing, and pairing then works normally", { annotation: { type: "covers", description: "4.2-real, 11-flaky, H6" } }, async ({ harness, page }) => {
  const server = harness.telegramServer!;
  const bot = harness.telegramBot!;
  const leftovers = server.transcript(FAKE_OPERATOR.id);
  expect(leftovers.filter((message) => message.from.is_bot)).toHaveLength(2);
  await waitForTelegramState("polling");
  expect(server.pendingUpdateCount(bot.id)).toBe(0);
  const { pairing } = await state.post<{ pairing: { code: string } }>("/api/task-control/telegram/pairing");
  await observeQuietPeriod(3_000, "a stale /start being observed or answered");
  expect((await telegramStatus()).pairing?.observed).toBeNull();
  expect(harness.query<{ n: number }>("SELECT COUNT(*) n FROM telegram_inbox")[0]!.n).toBe(0);
  expect(server.transcript(FAKE_OPERATOR.id)).toHaveLength(leftovers.length);
  expect((await harness.phone!.messages()).filter((message) => message.fromBot)).toEqual([]);
  expect(harness.query<{ n: number }>("SELECT COUNT(*) n FROM task_control_actor")[0]!.n).toBe(0);
  await state.delete("/api/task-control/telegram/pairing");
  expect(pairing.code).not.toBe("oldpairingcode1234");

  await pairThroughAgentsPage(page, harness.phone!);
  expect((await telegramStatus()).actors).toHaveLength(1);
  const { task, card } = await blockedTaskCard(harness, harness.phone!, "First card after leftovers");
  expect(card.text).toContain("Reply to this message with your answer.");
  expect((await state.prompt(task)).status).toBe("BLOCKED");
});

test("S-H6-22 (fake): tapping or replying to an earlier run's card in this run records nothing and starts nothing", { annotation: { type: "covers", description: "4.2-real, 11-flaky" } }, async ({ harness }) => {
  const server = harness.telegramServer!;
  const bot = harness.telegramBot!;
  const [oldQuestion, oldAnswer] = server.transcript(FAKE_OPERATOR.id).filter((message) => message.from.is_bot);
  const receiptsBefore = harness.query<{ n: number }>("SELECT COUNT(*) n FROM task_control_receipt WHERE state = 'APPLIED'")[0]!.n;
  const tap = server.userTapsButton(bot, FAKE_OPERATOR, { id: FAKE_OPERATOR.id, type: "private" }, oldAnswer!.message_id, oldAnswer!.reply_markup!.inline_keyboard[0]![1]!.callback_data!);
  server.userSendsMessage(bot, FAKE_OPERATOR, { id: FAKE_OPERATOR.id, type: "private" }, "Old reply again", { replyToMessageId: oldQuestion!.message_id });
  await eventually("the stale tap to be answered", async () => server.callbackAnswer(tap));
  await inboxDrained(harness);
  expect(server.callbackAnswer(tap)!.text).toMatch(/^Not applied/);
  expect(harness.query<{ n: number }>("SELECT COUNT(*) n FROM task_control_receipt WHERE state = 'APPLIED'")[0]!.n).toBe(receiptsBefore);
  const sessions = await state.get<{ sessions: Array<{ role: string }> } | Array<{ role: string }>>("/api/sessions");
  expect((Array.isArray(sessions) ? sessions : sessions.sessions).filter((session) => session.role === "execute")).toHaveLength(1);
  expect((await harness.phone!.messages()).filter((message) => message.fromBot && message.buttons.length > 0)).toEqual([]);
});
