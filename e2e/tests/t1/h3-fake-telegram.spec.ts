import { expect, test } from "../../src/fixtures.ts";
import { FAKE_OPERATOR } from "../../src/env/orchestrator.ts";
import { FakePhone } from "../../src/drivers/phone.ts";
import { eventually, observeQuietPeriod, state } from "../../src/drivers/state.ts";
import { runSavedTask, waitForRunEnd } from "../../src/scenarios.ts";
import { outboxRows, pairThroughAgentsPage, telegramStatus, waitForTelegramState } from "../../src/telegramFlows.ts";

// Scenario IDs refer to docs/e2e-scenarios/h0-h4.md. Fake Telegram backend, fake agent on the live path.
test.use({ harnessOptions: { fakeProvider: "live", telegram: { backend: "fake" } } });
test.describe.configure({ mode: "serial" });

test("S-H3-12: before pairing, a wrong code or a stranger gets no reply and nothing is observed", async ({ harness }) => {
  const server = harness.telegramServer!;
  const bot = harness.telegramBot!;
  await waitForTelegramState("polling");
  const { pairing } = await state.post<{ pairing: { code: string } }>("/api/task-control/telegram/pairing");
  const stranger = new FakePhone(server, bot, { id: 5_550_999, firstName: "Stranger" }, { id: 5_550_999, type: "private" });
  await harness.phone!.send("/start wrongcode123");
  await stranger.send(`/start ${pairing.code}x`);
  await stranger.send("hello bot");
  await eventually("updates to be consumed", async () => server.pendingUpdateCount(bot.id) === 0);
  await eventually("inbox to be processed", async () => harness.query<{ n: number }>("SELECT COUNT(*) n FROM telegram_inbox WHERE processed_at IS NULL")[0]!.n === 0);
  expect((await telegramStatus()).pairing?.observed).toBeNull();
  expect((await harness.phone!.messages()).filter((message) => message.fromBot)).toEqual([]);
  expect((await stranger.messages()).filter((message) => message.fromBot)).toEqual([]);
  await state.delete("/api/task-control/telegram/pairing");
});

test("S-H3-11: the phone pairs through the real Agents page", async ({ harness, page, pageHealth }) => {
  await pairThroughAgentsPage(page, harness.phone!);
  const actors = (await telegramStatus()).actors;
  expect(actors).toHaveLength(1);
  expect(actors[0]).toMatchObject({ transportUserId: String(FAKE_OPERATOR.id), chatId: String(FAKE_OPERATOR.id) });
  expect(pageHealth.consoleErrors).toEqual([]);
});

test("S-H3-13: a blocked task produces exactly one question card in the phone transcript", async ({ harness }) => {
  const phone = harness.phone!;
  const before = await phone.cursor();
  const { task, runId } = await runSavedTask(harness, { title: "Choose the release name", scenarios: [{ behavior: "block-on-decision", reason: "Two names fit.", humanAction: "Pick Aurora or Borealis." }] });
  await waitForRunEnd(task, runId);
  const card = await phone.waitForBotMessage("the question card", (message) => message.text.startsWith("Task needs input: Choose the release name"), { afterId: before });
  expect(card.text).toContain("Reply to this message with your answer.");
  await observeQuietPeriod(6_000, "a second card for the same question revision (notify interval is 5s)");
  const cards = (await phone.messages()).filter((message) => message.fromBot && message.text.startsWith("Task needs input: Choose the release name"));
  expect(cards).toHaveLength(1);
  const rows = outboxRows(harness).filter((row) => row.payload_json.includes("personal_question"));
  expect(rows.filter((row) => row.state === "SENT")).toHaveLength(1);
  expect(rows[0]?.sent_message_id).toBe(String(card.id));
});

test("S-H3-05: a 429 shows slow down, waits retry_after, then recovers", async ({ harness }) => {
  const server = harness.telegramServer!;
  server.failNext("getUpdates", 429, { retryAfter: 3, description: "Too Many Requests: retry after 3" });
  const backoff = await waitForTelegramState("backoff");
  expect(backoff.reason).toBe("Telegram asked this bot to slow down.");
  expect(backoff.lastError).toContain("(429)");
  const failedAt = server.calls.filter((call) => call.method === "getUpdates").at(-1)!.at;
  await waitForTelegramState("polling", 20_000);
  const next = server.calls.find((call) => call.method === "getUpdates" && call.at > failedAt)!;
  expect(next.at - failedAt).toBeGreaterThanOrEqual(2_900);
});

test("S-H3-06: 409 reports another poller; token-free errors throughout", async ({ harness }) => {
  harness.telegramServer!.failNext("getUpdates", 409);
  const conflict = await waitForTelegramState("backoff");
  expect(conflict.reason).toMatch(/Another process is polling this bot/);
  expect(conflict.lastError).not.toContain(harness.telegramBot!.token);
  await waitForTelegramState("polling", 40_000);
});

test("S-H3-09: a duplicated update delivery is applied once", async ({ harness }) => {
  const server = harness.telegramServer!;
  const phone = harness.phone!;
  const before = await phone.cursor();
  server.duplicateNextDelivery();
  await phone.send("just a message");
  const notices = await phone.waitForBotMessage("the reply-to-answer notice", (message) => message.text.startsWith("To answer a task, reply"), { afterId: before });
  await observeQuietPeriod(3_000, "a second notice from the duplicated update");
  expect((await phone.messages()).filter((message) => message.id > before && message.fromBot)).toEqual([notices]);
});

test("S-H3-08: after a restart the persisted offset is used and nothing is processed twice", async ({ harness }) => {
  const phone = harness.phone!;
  await phone.send("before restart");
  await eventually("update processed", async () => harness.query<{ n: number }>("SELECT COUNT(*) n FROM telegram_inbox WHERE processed_at IS NULL")[0]!.n === 0 && harness.telegramServer!.pendingUpdateCount(harness.telegramBot!.id) === 0);
  const inboxBefore = harness.query<{ n: number }>("SELECT COUNT(*) n FROM telegram_inbox")[0]!.n;
  const cursor = harness.query<{ next_update_id: number }>("SELECT next_update_id FROM telegram_poll_cursor")[0]!.next_update_id;
  await harness.restartServer();
  await waitForTelegramState("polling");
  const firstPoll = await eventually("first poll after restart", async () => harness.telegramServer!.calls.filter((call) => call.method === "getUpdates").at(-1));
  expect(firstPoll.body.offset).toBe(cursor);
  expect(harness.query<{ n: number }>("SELECT COUNT(*) n FROM telegram_inbox")[0]!.n).toBe(inboxBefore);
});

test("S-H3-10: an outage is retried and queued messages are delivered exactly once afterwards", async ({ harness }) => {
  const server = harness.telegramServer!;
  const phone = harness.phone!;
  server.setOutage("refuse");
  const down = await waitForTelegramState("backoff", 40_000);
  expect(down.reason).toBe("Telegram is unreachable; retrying.");
  const before = await phone.cursor();
  await state.delete(`/api/task-control/telegram/actors/${(await telegramStatus()).actors[0]!.id}`);
  expect(outboxRows(harness).filter((row) => row.state === "QUEUED" && row.payload_json.includes("unpaired"))).toHaveLength(1);
  server.setOutage(null);
  await waitForTelegramState("polling", 90_000);
  const notice = await phone.waitForBotMessage("the unpaired notice", (message) => message.text.startsWith("This chat was unpaired"), { afterId: before, timeoutMs: 90_000 });
  await observeQuietPeriod(3_000, "the queued notice being delivered twice");
  expect((await phone.messages()).filter((message) => message.fromBot && message.id > before)).toEqual([notice]);
});
