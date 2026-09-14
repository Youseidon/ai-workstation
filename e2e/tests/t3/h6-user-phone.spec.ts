import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { FakePhone, TAP_ANSWER_WAIT_MS } from "../../src/drivers/phone.ts";
import { observationDifferences, runPhoneContract } from "../../src/drivers/phoneContract.ts";
import { TelegramUserPhone } from "../../src/drivers/telegramUserPhone.ts";
import { loadLiveConfig, type LiveConfig } from "../../src/env/liveConfig.ts";
import { preflightBot } from "../../src/env/telegramPreflight.ts";
import { TelegramRouteProxy } from "../../src/env/telegramRouteProxy.ts";
import { FakeTelegramServer } from "../../src/fakes/telegramServer.ts";

/*
 * TelegramUserPhone on real Telegram (docs/e2e-scenarios/h6.md S-H6-01 to S-H6-10). No harness server runs:
 * a bot probe plays the bot side through the route proxy, so nothing else polls the test bot.
 */

test.describe.configure({ mode: "serial" });

type Update = { update_id: number; message?: { message_id: number; text?: string; from: { id: number; is_bot: boolean }; chat: { id: number; type: string }; reply_to_message?: { message_id: number } }; callback_query?: { id: string; data?: string; from: { id: number }; message?: { message_id: number } } };

let config: LiveConfig;
let proxy: TelegramRouteProxy;
let phone: TelegramUserPhone;
let offset = 0;

async function bot<T = unknown>(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result: T; error_code?: number; description?: string }> {
  const response = await fetch(`${proxy.url}/bot${config.testBotToken}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.json() as Promise<{ ok: boolean; result: T; error_code?: number; description?: string }>;
}

/** Polls the probe until `predicate` has matched `count` updates or the window ends; confirms what it reads. */
async function updates(predicate: (update: Update) => boolean, count = 1, windowMs = 20_000): Promise<Update[]> {
  const found: Update[] = [];
  const deadline = Date.now() + windowMs;
  while (found.length < count && Date.now() < deadline) {
    const polled = await bot<Update[]>("getUpdates", { offset, timeout: 2, allowed_updates: ["message", "callback_query"] });
    for (const update of polled.result ?? []) {
      offset = update.update_id + 1;
      if (predicate(update)) found.push(update);
    }
  }
  return found;
}

const nonce = () => randomBytes(4).toString("hex");
const keyboard = (id: string) => ({ inline_keyboard: [[{ text: "Save answer", callback_data: `h6s_${id}` }, { text: "Answer and resume", callback_data: `h6r_${id}` }]] });

test.beforeAll(async () => {
  config = loadLiveConfig();
  await preflightBot({ baseUrl: "https://api.telegram.org", token: config.testBotToken, expectedBotId: config.testBotId, operatorChatId: config.operatorUserId, conflictProbeSeconds: 5 });
  proxy = new TelegramRouteProxy("https://api.telegram.org");
  await proxy.listen();
  phone = new TelegramUserPhone(config);
  await phone.connect();
});

test.afterAll(async () => {
  await phone?.disconnect().catch(() => undefined);
  await proxy?.close();
});

test("S-H6-01: send returns the phone message and the bot receives exactly that text from the operator in a private chat; empty text is refused", async () => {
  const text = `h6 send ${nonce()}`;
  const sent = await phone.send(text);
  expect(sent).toMatchObject({ text, fromBot: false, edited: false, replyToId: null });
  expect(phone.backend).toBe("real");
  expect(phone.userId).toBe(config.operatorUserId);
  const received = await updates((update) => update.message?.text === text);
  expect(received).toHaveLength(1);
  expect(received[0]!.message).toMatchObject({ from: { id: Number(config.operatorUserId), is_bot: false }, chat: { type: "private", id: Number(phone.chatId) } });
  await expect(phone.send("")).rejects.toThrow(/^phone: Telegram refused the message: MESSAGE_EMPTY/);
  expect(await updates((update) => Boolean(update.message), 1, 4_000)).toEqual([]);
});

test("S-H6-02: a reply carries the phone-side id on the phone and the bot-side id to the bot; replying to a missing message sends nothing", async () => {
  const id = nonce();
  const sent = await bot<{ message_id: number }>("sendMessage", { chat_id: config.operatorUserId, text: `h6 card ${id}` });
  const card = await phone.waitForBotMessage("the card", (message) => message.text === `h6 card ${id}`);
  const reply = await phone.send("Red", { replyTo: card });
  expect(reply.replyToId).toBe(card.id);
  const [update] = await updates((item) => item.message?.text === "Red" && item.message.reply_to_message !== undefined);
  expect(update!.message!.reply_to_message!.message_id).toBe(sent.result.message_id);
  await expect(phone.send("Blue", { replyTo: { ...card, id: card.id + 1_000_000 } })).rejects.toThrow(/cannot reply to message \d+: it is not in the chat/);
  expect(await updates((item) => item.message?.text === "Blue", 1, 4_000)).toEqual([]);
});

test("S-H6-03: a tap reaches the bot with the button's data and resolves with the bot's toast; a missing label lists the real ones", async () => {
  const id = nonce();
  const sent = await bot<{ message_id: number }>("sendMessage", { chat_id: config.operatorUserId, text: `h6 buttons ${id}`, reply_markup: keyboard(id) });
  const card = await phone.waitForBotMessage("the card", (message) => message.text === `h6 buttons ${id}`);
  const tapped = phone.tap(card, "Save answer");
  const [update] = await updates((item) => item.callback_query?.data === `h6s_${id}`);
  expect(update!.callback_query).toMatchObject({ from: { id: Number(config.operatorUserId) }, message: { message_id: sent.result.message_id } });
  expect((await bot("answerCallbackQuery", { callback_query_id: update!.callback_query!.id, text: "Saved." })).ok).toBe(true);
  expect(await tapped).toEqual({ toast: "Saved." });
  await expect(phone.tap(card, "Missing")).rejects.toThrow('has no button "Missing" (has: Save answer, Answer and resume)');
  expect(await updates((item) => Boolean(item.callback_query), 1, 4_000)).toEqual([]);
});

test("S-H6-04 (real): a tap nobody answers resolves with no toast within the shared bound and reaches the bot once later", async () => {
  const id = nonce();
  await bot("sendMessage", { chat_id: config.operatorUserId, text: `h6 offline ${id}`, reply_markup: keyboard(id) });
  const card = await phone.waitForBotMessage("the card", (message) => message.text === `h6 offline ${id}`);
  const started = Date.now();
  expect(await phone.tap(card, "Answer and resume")).toEqual({ toast: null });
  expect(Date.now() - started).toBeLessThan(TAP_ANSWER_WAIT_MS + 3_000);
  expect(await updates((item) => item.callback_query?.data === `h6r_${id}`, 2, 8_000)).toHaveLength(1);
});

test("S-H6-05: edits keep the phone-side id and show the latest text and buttons; an identical edit is 'message is not modified'", async () => {
  const id = nonce();
  const sent = await bot<{ message_id: number }>("sendMessage", { chat_id: config.operatorUserId, text: `h6 edit ${id}`, reply_markup: { inline_keyboard: [[{ text: "One", callback_data: "e1" }], [{ text: "Two", callback_data: "e2" }, { text: "Three", callback_data: "e3" }]] } });
  const original = await phone.waitForBotMessage("the card", (message) => message.text === `h6 edit ${id}`);
  await bot("editMessageText", { chat_id: config.operatorUserId, message_id: sent.result.message_id, text: `h6 edit ${id} v2`, reply_markup: { inline_keyboard: [[{ text: "One", callback_data: "e1" }], [{ text: "Three", callback_data: "e3" }]] } });
  const second = await phone.waitForBotMessage("the first edit", (message) => message.id === original.id && message.text.endsWith("v2"), { timeoutMs: 20_000 });
  expect(second).toMatchObject({ edited: true, buttons: ["One", "Three"] });
  await bot("editMessageReplyMarkup", { chat_id: config.operatorUserId, message_id: sent.result.message_id, reply_markup: { inline_keyboard: [[{ text: "Four", callback_data: "e4" }]] } });
  const third = await phone.waitForBotMessage("the markup edit", (message) => message.id === original.id && message.buttons.join() === "Four", { timeoutMs: 20_000 });
  expect(third.text).toBe(`h6 edit ${id} v2`);
  const same = await bot("editMessageText", { chat_id: config.operatorUserId, message_id: sent.result.message_id, text: `h6 edit ${id} v2`, reply_markup: { inline_keyboard: [[{ text: "Four", callback_data: "e4" }]] } });
  expect(same).toMatchObject({ ok: false, error_code: 400 });
  expect(same.description).toMatch(/^Bad Request: message is not modified/);
  expect((await phone.messages()).filter((message) => message.id === original.id)).toEqual([third]);
});

test("S-H6-06 (real): afterId returns the older of two new matches across an id gap; a hopeless wait fails on time", async () => {
  const id = nonce();
  const cursor = await phone.cursor();
  await bot("sendMessage", { chat_id: config.operatorUserId, text: `h6 gap A ${id}` });
  await phone.noteToSelf(`h6 id gap ${id}`);
  await bot("sendMessage", { chat_id: config.operatorUserId, text: `h6 gap B ${id}` });
  const found = await phone.waitForBotMessage("a gap message", (message) => message.text.startsWith("h6 gap") && message.text.endsWith(id), { afterId: cursor });
  expect(found.text).toBe(`h6 gap A ${id}`);
  const b = await phone.waitForBotMessage("message B", (message) => message.text === `h6 gap B ${id}`, { afterId: found.id });
  expect(b.id).toBeGreaterThan(found.id);
  const started = Date.now();
  await expect(phone.waitForBotMessage("nothing", () => false, { afterId: cursor, timeoutMs: 2_000 })).rejects.toThrow("phone: timed out after 2000ms waiting for nothing");
  expect(Date.now() - started).toBeLessThan(2_000 + 6_000);
});

test("S-H6-07 (real): a new driver on a chat full of earlier runs sees none of them", async () => {
  const leftover = `Task needs input: leftover ${nonce()}`;
  await bot("sendMessage", { chat_id: config.operatorUserId, text: leftover, reply_markup: keyboard("leftover") });
  await phone.waitForBotMessage("the leftover", (message) => message.text === leftover);
  const fresh = new TelegramUserPhone(config);
  await fresh.connect();
  try {
    expect(await fresh.messages()).toEqual([]);
    await expect(fresh.waitForBotMessage("a leftover card", (message) => message.text.startsWith("Task needs input"), { timeoutMs: 3_000 })).rejects.toThrow(/timed out/);
    const cursor = await fresh.cursor();
    expect((await fresh.messages()).filter((message) => message.fromBot && message.id > cursor)).toHaveLength(0);
  } finally {
    await fresh.disconnect();
  }
});

test("S-H6-08 (real): the driver contract script observes the same on real Telegram as on the fake", async () => {
  const server = new FakeTelegramServer();
  await server.listen();
  const fakeBot = { id: 700_666_777, username: "parity_bot", token: `700666777:${randomBytes(27).toString("base64url")}` };
  server.addBot(fakeBot);
  let expected;
  try {
    expected = await runPhoneContract(new FakePhone(server, fakeBot, { id: 42, firstName: "Jo" }, { id: 42, type: "private" }), { baseUrl: server.url, token: fakeBot.token, chatId: "42" }, nonce());
  } finally {
    await server.close();
  }
  const fresh = new TelegramUserPhone(config);
  await fresh.connect();
  try {
    const actual = await runPhoneContract(fresh, { baseUrl: proxy.url, token: config.testBotToken, chatId: config.operatorUserId }, nonce());
    expect(observationDifferences(expected, actual)).toEqual([]);
  } finally {
    await fresh.disconnect();
  }
});

test("S-H6-09: the real callback-answer window matches the fake's at 5s, 15s, 60s and 10 minutes", async () => {
  test.setTimeout(20 * 60_000);
  const fake = new FakeTelegramServer();
  const outcomes: Array<{ delaySeconds: number; real: string; fake: string }> = [];
  for (const delaySeconds of [5, 15, 60, 600]) {
    const id = nonce();
    await bot("sendMessage", { chat_id: config.operatorUserId, text: `h6 window ${delaySeconds}s ${id}`, reply_markup: keyboard(id) });
    const card = await phone.waitForBotMessage("the card", (message) => message.text === `h6 window ${delaySeconds}s ${id}`);
    const tapped = phone.tap(card, "Save answer");
    const [update] = await updates((item) => item.callback_query?.data === `h6s_${id}`);
    const tappedAt = Date.now();
    await tapped;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, delaySeconds * 1000 - (Date.now() - tappedAt))));
    const answer = await bot("answerCallbackQuery", { callback_query_id: update!.callback_query!.id, text: "Late." });
    outcomes.push({ delaySeconds, real: answer.ok ? "accepted" : (answer.description ?? "rejected"), fake: delaySeconds * 1000 <= fake.callbackAnswerWindowMs ? "accepted" : "Bad Request: query is too old and response timeout expired or query ID is invalid" });
  }
  test.info().annotations.push({ type: "callback window", description: JSON.stringify(outcomes) });
  expect(outcomes.map(({ delaySeconds, real, fake: modelled }) => `${delaySeconds}s real=${real} fake=${modelled}`)).toEqual(outcomes.map(({ delaySeconds, real }) => `${delaySeconds}s real=${real} fake=${real}`));
});

test("S-H6-10: after the connection drops, the next call reconnects without a new login and errors carry no secret", async () => {
  await phone.dropConnection();
  const text = `h6 reconnect ${nonce()}`;
  const sent = await phone.send(text);
  expect(sent.text).toBe(text);
  expect((await phone.messages()).some((message) => message.text === text)).toBe(true);
  const error = await phone.send("").then(() => "", (caught: Error) => caught.message);
  for (const secret of [config.userSession, config.apiHash, config.testBotToken]) expect(error.includes(secret)).toBe(false);
});
