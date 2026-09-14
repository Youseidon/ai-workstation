import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { inspect } from "node:util";
import { telegramRetryDelayMs } from "./integrations/telegram/adapter.ts";
import { TelegramApiError, redactBotToken } from "./integrations/telegram/botApi.ts";
import { BotToken, TELEGRAM_TOKEN_ENV, takeTelegramCredential } from "./integrations/telegram/credentials.ts";
import { HttpTelegramBotApi, normalizeTelegramUpdate } from "./integrations/telegram/httpBotApi.ts";
import { formatTelegramMessage } from "./integrations/telegram/liveFormat.ts";

const rawToken = `7000000001:${randomBytes(27).toString("base64url")}`;
const token = BotToken.parse(rawToken)!;

type FetchCall = { url: string; body: Record<string, unknown> };

function stubFetch(respond: (call: FetchCall, init: RequestInit) => Promise<Response> | Response) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> };
    calls.push(call);
    return respond(call, init ?? {});
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function assertNoToken(value: unknown, label: string): void {
  const text = typeof value === "string" ? value : `${inspect(value, { depth: 8 })}\n${JSON.stringify(value)}`;
  assert.equal(text.includes(rawToken), false, `${label} leaked the token`);
  assert.equal(text.includes(rawToken.split(":")[1]!), false, `${label} leaked the token secret`);
}

async function rejection(promise: Promise<unknown>): Promise<TelegramApiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof TelegramApiError, `expected TelegramApiError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to reject");
}

test("bot token cannot leak through string, JSON or inspect, and leaves the environment", () => {
  assert.equal(String(token), "[redacted-token]");
  assertNoToken(token, "BotToken");
  assertNoToken({ nested: { token } }, "object holding BotToken");
  assert.equal(token.botId, "7000000001");
  assert.equal(token.reveal(), rawToken);

  const env: NodeJS.ProcessEnv = { [TELEGRAM_TOKEN_ENV]: ` ${rawToken} `, OTHER: "kept" };
  const credential = takeTelegramCredential(env);
  assert.equal(credential.token?.reveal(), rawToken);
  assert.equal(TELEGRAM_TOKEN_ENV in env, false, "token must be removed so spawned agents never inherit it");
  assert.equal(env.OTHER, "kept");

  const malformedEnv: NodeJS.ProcessEnv = { [TELEGRAM_TOKEN_ENV]: "not-a-token-secret-value" };
  const malformed = takeTelegramCredential(malformedEnv);
  assert.equal(malformed.token, null);
  assert.match(malformed.problem ?? "", /not a Bot API token/);
  assert.equal(malformed.problem?.includes("not-a-token-secret-value"), false);
  assert.deepEqual(takeTelegramCredential({}), { token: null, problem: null });

  assert.equal(redactBotToken(`GET https://api.telegram.org/bot${rawToken}/getMe`), "GET https://api.telegram.org/bot[redacted-token]/getMe");
});

test("getUpdates long-polls for 25 seconds from the durable offset and keeps only task-related fields", async () => {
  const { calls, fetchImpl } = stubFetch(() => json(200, {
    ok: true,
    result: [
      { update_id: 41, callback_query: { id: "cbq-1", from: { id: 501, first_name: "Jo", language_code: "en" }, message: { message_id: 77, chat: { id: 501, type: "private", first_name: "Jo" }, date: 1, text: "card" }, chat_instance: "x", data: "tc_ref" } },
      { update_id: 42, message: { message_id: 78, from: { id: 501, is_bot: false, first_name: "Jo", last_name: "Doe", username: "jodoe" }, chat: { id: 501, type: "private" }, date: 2, text: "Use the list", reply_to_message: { message_id: 77, chat: { id: 501, type: "private" }, date: 1 } } },
      { update_id: 43, edited_message: { message_id: 78 } },
      { update_id: 44, message: { message_id: 79, from: { id: 501, is_bot: false }, chat: { id: 501, type: "private" }, date: 3, photo: [] } },
    ],
  }));
  const api = new HttpTelegramBotApi({ token, fetch: fetchImpl });
  const updates = await api.getUpdates(41);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `https://api.telegram.org/bot${rawToken}/getUpdates`);
  assert.deepEqual(calls[0]!.body, { offset: 41, timeout: 25, allowed_updates: ["message", "callback_query"] });
  assert.deepEqual(updates, [
    { updateId: 41, payload: { kind: "callback", ref: "tc_ref", transportUserId: "501", chatId: "501", topicId: null, messageId: "77", commandId: "tg-callback-cbq-1", callbackQueryId: "cbq-1" } },
    { updateId: 42, payload: { kind: "message", transportUserId: "501", chatId: "501", chatType: "private", topicId: null, messageId: "78", replyToMessageId: "77", text: "Use the list", label: "Jo Doe", username: "jodoe" } },
    { updateId: 43, payload: { kind: "unsupported", type: "edited_message" } },
    { updateId: 44, payload: { kind: "unsupported", type: "message" } },
  ]);
  assert.equal(normalizeTelegramUpdate({ nope: true }), null);
});

test("Bot API errors are classified with server-specified backoff and never carry the token", async () => {
  const cases: Array<[number, Record<string, unknown>, TelegramApiError["kind"], number | null]> = [
    [429, { ok: false, error_code: 429, description: `Too Many Requests: retry after 7 (bot${rawToken})`, parameters: { retry_after: 7 } }, "rate_limited", 7000],
    [401, { ok: false, error_code: 401, description: "Unauthorized" }, "unauthorized", null],
    [404, { ok: false, error_code: 404, description: "Not Found" }, "unauthorized", null],
    [409, { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" }, "conflict", null],
    [502, { ok: false, error_code: 502, description: "Bad Gateway" }, "transient", null],
    [403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, "rejected", null],
  ];
  for (const [status, body, kind, retryAfterMs] of cases) {
    const { fetchImpl } = stubFetch(() => json(status, body));
    const error = await rejection(new HttpTelegramBotApi({ token, fetch: fetchImpl }).getUpdates(0));
    assert.equal(error.kind, kind, `status ${status}`);
    assert.equal(error.retryAfterMs, retryAfterMs);
    assertNoToken(error, `HTTP ${status} error`);
    assertNoToken(error.stack, `HTTP ${status} stack`);
  }
  const html = stubFetch(() => new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }));
  assert.equal((await rejection(new HttpTelegramBotApi({ token, fetch: html.fetchImpl }).getMe())).kind, "transient");
});

test("network failures are rethrown sanitized, without the raw error or its cause", async () => {
  const { fetchImpl } = stubFetch(call => {
    const cause = Object.assign(new Error(`connect ECONNREFUSED for ${call.url}`), { code: "ECONNREFUSED" });
    throw new TypeError(`fetch failed: ${call.url}`, { cause });
  });
  const error = await rejection(new HttpTelegramBotApi({ token, fetch: fetchImpl }).sendMessage({ chatId: "1", topicId: null, payload: { kind: "text", text: "hi" } }));
  assert.equal(error.kind, "transient");
  assert.match(error.message, /network failure/);
  assert.match(error.message, /ECONNREFUSED/);
  assert.equal((error as { cause?: unknown }).cause, undefined);
  assertNoToken(error, "network error");
  assertNoToken(error.stack, "network error stack");
  assertNoToken(inspect(error, { showHidden: true, depth: 8 }), "inspected network error");

  // AbortSignal.timeout does not hold the event loop open; the server's listener
  // does in production, so this test holds it for the hanging requests below.
  const keepAlive = setInterval(() => undefined, 1000);
  const hanging = stubFetch((_call, init) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException(`aborted ${rawToken}`, "AbortError")));
  }));
  const timedOut = await rejection(new HttpTelegramBotApi({ token, fetch: hanging.fetchImpl, requestTimeoutMs: 20 }).getMe());
  assert.match(timedOut.message, /timed out/);
  assertNoToken(timedOut, "timeout error");

  const controller = new AbortController();
  const pending = new HttpTelegramBotApi({ token, fetch: hanging.fetchImpl }).getUpdates(0, { signal: controller.signal });
  controller.abort();
  assert.match((await rejection(pending)).message, /cancelled/);
  clearInterval(keepAlive);
});

test("sendMessage renders plain text, only shows buttons with a bound answer, and returns the Bot API message id", async () => {
  const { calls, fetchImpl } = stubFetch(call => json(200, { ok: true, result: { message_id: 900 + calls.length, chat: { id: Number(call.body.chat_id) } } }));
  const bound = new Map([["ref-save", "Use <b>directory</b>.example"], ["ref-resume", "Use <b>directory</b>.example"]]);
  const api = new HttpTelegramBotApi({ token, fetch: fetchImpl, contentForRef: ref => bound.get(ref) ?? null });
  const question = { kind: "personal_question", promptId: 3, title: "Import list", execution: "todo", decision: "awaiting_response", receipt: "waiting for action", question: "Which list?", actions: [{ ref: "ref-save", action: "save_human_response" }, { ref: "ref-resume", action: "answer_and_resume" }] };

  assert.deepEqual(await api.sendMessage({ chatId: "501", topicId: null, payload: question }), { messageId: "901" });
  const body = calls[0]!.body;
  assert.equal(calls[0]!.url, `https://api.telegram.org/bot${rawToken}/sendMessage`);
  assert.equal(body.chat_id, "501");
  assert.equal(body.parse_mode, undefined, "no markup parsing, so task text cannot inject formatting");
  assert.match(String(body.text), /Task needs input: Import list\nStatus: todo · awaiting response\n/);
  assert.match(String(body.text), /Your answer:\nUse <b>directory<\/b>\.example/);
  assert.deepEqual(body.reply_markup, { inline_keyboard: [[{ text: "Save answer", callback_data: "ref-save" }], [{ text: "Answer and resume", callback_data: "ref-resume" }]] });
  assert.equal(body.message_thread_id, undefined);

  await api.sendMessage({ chatId: "-100", topicId: "12", payload: { kind: "text", text: "hello" } });
  assert.equal(calls[1]!.body.message_thread_id, 12);
  assert.equal(calls[1]!.body.reply_markup, undefined);

  const unanswered = formatTelegramMessage(question, () => null);
  assert.equal(unanswered.replyMarkup, null);
  assert.match(unanswered.text, /Reply to this message with your answer\./);
  const saved = formatTelegramMessage(question, ref => ref === "ref-resume" ? "Saved text" : null);
  assert.deepEqual(saved.replyMarkup, { inline_keyboard: [[{ text: "Resume with saved answer", callback_data: "ref-resume" }]] });
  assert.throws(() => formatTelegramMessage({ kind: "mystery" }, () => null), (error: unknown) => error instanceof TelegramApiError && error.kind === "rejected");
});

test("send retry policy honours retry_after, backs off transient failures to at most a minute, and gives up on permanent ones", () => {
  assert.equal(telegramRetryDelayMs(new TelegramApiError("rate_limited", "slow down", 4000), 0), 4250);
  assert.equal(telegramRetryDelayMs(new TelegramApiError("rejected", "chat not found"), 0), null);
  assert.equal(telegramRetryDelayMs(new TelegramApiError("unauthorized", "bad token"), 0), null);
  assert.equal(telegramRetryDelayMs(new TelegramApiError("transient", "down"), 0, () => 1), 1000);
  assert.equal(telegramRetryDelayMs(new Error("fake timeout"), 3, () => 0), 4000);
  for (let attempt = 0; attempt < 40; attempt++) {
    const delay = telegramRetryDelayMs(new TelegramApiError("transient", "down"), attempt)!;
    assert.ok(delay >= 500 && delay <= 60_000, `attempt ${attempt} delay ${delay}`);
  }
});
