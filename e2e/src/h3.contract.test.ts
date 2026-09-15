import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { FakePhone } from "./drivers/phone.ts";
import { FakeTelegramServer, type FakeBot } from "./fakes/telegramServer.ts";

// Scenario IDs refer to docs/e2e-scenarios/h0-h4.md. The server's real Bot API client against the fake.

type Api = {
  getMe(): Promise<{ id: string; username: string | null }>;
  getUpdates(offset: number, options?: { signal?: AbortSignal }): Promise<Array<{ updateId: number; payload: Record<string, unknown> }>>;
  sendMessage(request: { chatId: string; topicId: string | null; payload: unknown }): Promise<{ messageId: string }>;
  answerCallbackQuery(id: string, text: string): Promise<void>;
};

async function clientFor(baseUrl: string, token: string, pollTimeoutSeconds = 1): Promise<Api> {
  const modulePath: string = new URL("../../server/src/integrations/telegram/httpBotApi.ts", import.meta.url).pathname;
  const { HttpTelegramBotApi } = (await import(modulePath)) as { HttpTelegramBotApi: new (options: unknown) => Api };
  // Only reveal() is used by the client; importing BotToken would load the repository config.
  return new HttpTelegramBotApi({ token: { reveal: () => token }, baseUrl, pollTimeoutSeconds, requestTimeoutMs: 3000, contentForRef: () => "Aurora" });
}

async function withServer(fn: (server: FakeTelegramServer, bot: FakeBot, api: Api) => Promise<void>): Promise<void> {
  const server = new FakeTelegramServer();
  await server.listen();
  const bot: FakeBot = { id: 700_111_222, username: "contract_bot", token: `700111222:${randomBytes(27).toString("base64url")}` };
  server.addBot(bot);
  try {
    await fn(server, bot, await clientFor(server.url, bot.token));
  } finally {
    await server.close();
  }
}

const user = { id: 42, firstName: "Jo", lastName: "Doe", username: "jodoe" };
const chat = { id: 42, type: "private" as const };

test("S-H3-03: getMe, sendMessage, message and callback updates parse through the real client", async () => {
  await withServer(async (server, bot, api) => {
    assert.deepEqual(await api.getMe(), { id: String(bot.id), username: "contract_bot" });
    server.registerChat(chat);
    const sent = await api.sendMessage({ chatId: "42", topicId: null, payload: { kind: "personal_question", title: "Name", execution: "blocked", decision: "awaiting_response", question: "Which?", actions: [{ ref: "tc_abc", action: "save_human_response" }] } });
    assert.match(sent.messageId, /^\d+$/);
    const card = server.transcript(42).at(-1)!;
    assert.equal(card.reply_markup?.inline_keyboard[0]?.[0]?.text, "Save answer");

    const phone = new FakePhone(server, bot, user, chat);
    await phone.send("Aurora", { replyTo: { id: Number(sent.messageId), text: "", buttons: [], fromBot: true, edited: false, replyToId: null, topicId: null, entities: [] } });
    const tapId = server.userTapsButton(bot, user, chat, Number(sent.messageId), "tc_abc");
    const updates = await api.getUpdates(0);
    assert.equal(updates.length, 2);
    assert.deepEqual(updates[0]!.payload, { kind: "message", transportUserId: "42", chatId: "42", chatType: "private", topicId: null, messageId: String(Number(sent.messageId) + 1), replyToMessageId: sent.messageId, text: "Aurora", label: "Jo Doe", username: "jodoe" });
    assert.deepEqual(updates[1]!.payload, { kind: "callback", ref: "tc_abc", transportUserId: "42", chatId: "42", topicId: null, messageId: sent.messageId, commandId: `tg-callback-${tapId}`, callbackQueryId: tapId });
    await api.answerCallbackQuery(tapId, "Saved.");
    assert.equal(server.callbackAnswer(tapId)?.text, "Saved.");
  });
});

test("S-H3-04: error envelopes drive every client error kind without leaking the token", async () => {
  await withServer(async (server, bot, api) => {
    const cases: Array<[number, string, number | null]> = [[400, "rejected", null], [403, "rejected", null], [401, "unauthorized", null], [404, "unauthorized", null], [409, "conflict", null], [500, "transient", null], [502, "transient", null], [429, "rate_limited", 7000]];
    for (const [code, kind, retryAfterMs] of cases) {
      server.failNext("getMe", code, { description: `problem at /bot${bot.token}/getMe`, ...(code === 429 ? { retryAfter: 7 } : {}) });
      const error = await api.getMe().then(() => null, (caught: { kind: string; message: string; retryAfterMs: number | null }) => caught);
      assert.ok(error, `code ${code} should reject`);
      assert.equal(error.kind, kind, `code ${code}`);
      if (retryAfterMs !== null) assert.equal(error.retryAfterMs, retryAfterMs);
      assert.ok(!error.message.includes(bot.token), `code ${code} leaked the token`);
    }
    const unknown = await clientFor(server.url, `700111222:${"x".repeat(35)}`);
    const unauthorized = await unknown.getMe().then(() => null, (caught: { kind: string }) => caught);
    assert.equal(unauthorized?.kind, "unauthorized");
  });
});

test("S-H3-07: long polling holds until an update arrives or the window ends, and honours the offset", async () => {
  await withServer(async (server, bot, api) => {
    const started = Date.now();
    assert.deepEqual(await api.getUpdates(0), []);
    assert.ok(Date.now() - started >= 900, "an empty poll waits for the window");
    const phone = new FakePhone(server, bot, user, chat);
    const held = api.getUpdates(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await phone.send("hello");
    const early = Date.now();
    const [first] = await held;
    assert.ok(Date.now() - early < 500, "a held poll returns as soon as the update arrives");
    assert.deepEqual(await api.getUpdates(first!.updateId + 1), []);
    assert.equal(server.pendingUpdateCount(bot.id), 0, "updates below the offset are confirmed and dropped");
  });
});

test("S-H3-07: a second poller terminates the first with 409, as Telegram does", async () => {
  await withServer(async (_server, bot, api) => {
    const other = await clientFor(_server.url, bot.token, 2);
    const first = other.getUpdates(0).then(() => null, (error: { kind: string }) => error.kind);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await api.getUpdates(0);
    assert.equal(await first, "conflict");
  });
});

test("S-H3-14: edits change the same message; unchanged content is 'message is not modified'", async () => {
  await withServer(async (server, bot) => {
    server.registerChat(chat);
    const call = async (method: string, body: Record<string, unknown>) => (await fetch(`${server.url}/bot${bot.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<{ ok: boolean; result?: { message_id: number; text: string }; description?: string; error_code?: number }>;
    const sent = await call("sendMessage", { chat_id: 42, text: "first" });
    const edited = await call("editMessageText", { chat_id: 42, message_id: sent.result!.message_id, text: "second" });
    assert.equal(edited.result?.message_id, sent.result?.message_id);
    assert.deepEqual(server.transcript(42).map((message) => message.history), [["first", "second"]]);
    const same = await call("editMessageText", { chat_id: 42, message_id: sent.result!.message_id, text: "second" });
    assert.equal(same.error_code, 400);
    assert.match(same.description ?? "", /^Bad Request: message is not modified/);
    const missing = await call("editMessageText", { chat_id: 42, message_id: 9999, text: "x" });
    assert.match(missing.description ?? "", /message to edit not found/);
  });
});

test("S-H3-15: the fake's shapes match the Bot API shapes the server's own client tests record", async () => {
  // telegramBotApi.test.ts stubs these real Bot API result shapes; the fake must produce the same keys.
  await withServer(async (server, bot) => {
    server.registerChat(chat);
    const phone = new FakePhone(server, bot, user, chat);
    await phone.send("hi");
    const response = (await (await fetch(`${server.url}/bot${bot.token}/getUpdates`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offset: 0, timeout: 0 }) })).json()) as { ok: boolean; result: Array<Record<string, Record<string, unknown>>> };
    assert.equal(response.ok, true);
    const message = response.result[0]!.message!;
    for (const key of ["message_id", "from", "chat", "date", "text"]) assert.ok(key in message, `message.${key}`);
    assert.deepEqual(Object.keys(message.from as object).sort(), ["first_name", "id", "is_bot", "last_name", "username"]);
    assert.equal((message.chat as { type: string }).type, "private");
    assert.equal(typeof response.result[0]!.update_id, "number");
  });
});
