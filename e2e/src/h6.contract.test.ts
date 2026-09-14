import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sanitizeRecording, shapeDifferences, shapeOf } from "./contracts/telegramShape.ts";
import { FakePhone, TAP_ANSWER_WAIT_MS, type PhoneMessage } from "./drivers/phone.ts";
import { observationDifferences, runPhoneContract, type Observation } from "./drivers/phoneContract.ts";
import { sweep } from "./env/sweep.ts";
import { TelegramRouteProxy } from "./env/telegramRouteProxy.ts";
import { FakeTelegramServer, type FakeBot } from "./fakes/telegramServer.ts";

// Scenario IDs refer to docs/e2e-scenarios/h6.md. T0 rows: the route proxy, the fake side of the driver rows, contract fixtures.

type Api = {
  getMe(): Promise<{ id: string; username: string | null }>;
  getUpdates(offset: number, options?: { signal?: AbortSignal }): Promise<Array<{ updateId: number; payload: Record<string, unknown> }>>;
  sendMessage(request: { chatId: string; topicId: string | null; payload: unknown }): Promise<{ messageId: string }>;
};

async function clientFor(baseUrl: string, token: string, options: { pollTimeoutSeconds?: number; requestTimeoutMs?: number } = {}): Promise<Api> {
  const modulePath: string = new URL("../../server/src/integrations/telegram/httpBotApi.ts", import.meta.url).pathname;
  const { HttpTelegramBotApi } = (await import(modulePath)) as { HttpTelegramBotApi: new (options: unknown) => Api };
  return new HttpTelegramBotApi({ token: { reveal: () => token }, baseUrl, pollTimeoutSeconds: options.pollTimeoutSeconds ?? 1, requestTimeoutMs: options.requestTimeoutMs ?? 3000, contentForRef: () => null });
}

const user = { id: 42, firstName: "Jo" };
const chat = { id: 42, type: "private" as const };
const newBot = (): FakeBot => ({ id: 700_222_333, username: "proxy_bot", token: `700222333:${randomBytes(27).toString("base64url")}` });

async function withProxy(fn: (context: { server: FakeTelegramServer; bot: FakeBot; proxy: TelegramRouteProxy; api: Api; logFile: string }) => Promise<void>): Promise<void> {
  const server = new FakeTelegramServer();
  await server.listen();
  const bot = newBot();
  server.addBot(bot);
  server.registerChat(chat);
  const dir = mkdtempSync(join(tmpdir(), "h6-proxy-"));
  const logFile = join(dir, "telegram-proxy.log");
  const proxy = new TelegramRouteProxy(server.url, logFile);
  await proxy.listen();
  try {
    await fn({ server, bot, proxy, api: await clientFor(proxy.url, bot.token), logFile });
  } finally {
    await proxy.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Recorded {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A loopback upstream that records requests and answers from a script, so bytes can be compared exactly. */
async function recordingUpstream(answer: (url: string) => { status: number; body: string; delayMs?: number }): Promise<{ url: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const reply = answer(req.url ?? "");
      setTimeout(() => {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(reply.body);
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

async function raw(url: string, path: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/* --------------------------------- proxy --------------------------------- */

test("S-H6-11: the proxy passes method, path, content type, body, status and bytes through unchanged", async () => {
  const token = `700222333:${randomBytes(27).toString("base64url")}`;
  const answers: Record<string, { status: number; body: string }> = {
    getMe: { status: 200, body: '{"ok":true,"result":{"id":700222333,"is_bot":true,"first_name":"b","username":"proxy_bot"}}' },
    sendMessage: { status: 200, body: '{"ok":true,"result":{"message_id":7,"text":"hi \\u00e9","reply_markup":{"inline_keyboard":[[{"text":"Save answer","callback_data":"tc_x"}]]}}}' },
    editMessageText: { status: 400, body: '{"ok":false,"error_code":400,"description":"Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message"}' },
    answerCallbackQuery: { status: 200, body: '{"ok":true,"result":true}' },
    setMyCommands: { status: 200, body: '{"ok":true,"result":true}' },
    wrongToken: { status: 401, body: '{"ok":false,"error_code":401,"description":"Unauthorized"}' },
  };
  const upstream = await recordingUpstream((url) => (url.includes("AAAA") ? answers.wrongToken! : answers[url.split("/").at(-1)!]!));
  const proxy = new TelegramRouteProxy(upstream.url);
  await proxy.listen();
  try {
    const cases: Array<[string, string]> = [
      [`/bot${token}/getMe`, "{}"],
      [`/bot${token}/sendMessage`, JSON.stringify({ chat_id: "42", text: "hi é", reply_markup: { inline_keyboard: [[{ text: "Save answer", callback_data: "tc_x" }]] } })],
      [`/bot${token}/editMessageText`, JSON.stringify({ chat_id: "42", message_id: 7, text: "hi é" })],
      [`/bot${token}/answerCallbackQuery`, JSON.stringify({ callback_query_id: "1", text: "Saved." })],
      [`/bot${token}/setMyCommands`, JSON.stringify({ commands: [{ command: "help", description: "Help" }] })],
      [`/bot700222333:${"A".repeat(35)}/getMe`, "{}"],
    ];
    for (const [path, body] of cases) {
      const direct = await raw(upstream.url, path, body);
      const viaProxy = await raw(proxy.url, path, body);
      assert.deepEqual(viaProxy, direct, path.replace(token, "<token>"));
      const [sentDirect, sentProxied] = upstream.requests.slice(-2);
      assert.equal(sentProxied!.method, sentDirect!.method);
      assert.equal(sentProxied!.url, sentDirect!.url);
      assert.equal(sentProxied!.headers["content-type"], sentDirect!.headers["content-type"]);
      assert.equal(sentProxied!.body, sentDirect!.body);
    }
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("S-H6-11/12: the real client works through the proxy, including a held long poll and error envelopes", async () => {
  await withProxy(async ({ server, bot, proxy, api }) => {
    assert.deepEqual(await api.getMe(), { id: String(bot.id), username: "proxy_bot" });
    const held = api.getUpdates(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await new FakePhone(server, bot, user, chat).send("through the proxy");
    const [update] = await held;
    assert.equal(update?.payload.text, "through the proxy");
    server.failNext("getMe", 429, { retryAfter: 3 });
    const limited = await api.getMe().then(() => null, (error: { kind: string; retryAfterMs: number | null }) => error);
    assert.equal(limited?.kind, "rate_limited");
    assert.equal(limited?.retryAfterMs, 3000);
    assert.deepEqual(proxy.calls.map((call) => [call.method, call.outcome]), [["getMe", 200], ["getUpdates", 200], ["getMe", 429]]);
    assert.equal(proxy.calls[1]!.body.timeout, 1);
  });
});

test("S-H6-12: an upstream that holds a request for 30 seconds is still answered through the proxy", { timeout: 60_000 }, async () => {
  const upstream = await recordingUpstream(() => ({ status: 200, body: '{"ok":true,"result":[]}', delayMs: 30_000 }));
  const proxy = new TelegramRouteProxy(upstream.url);
  await proxy.listen();
  try {
    const started = Date.now();
    const answer = await raw(proxy.url, `/bot700222333:${"B".repeat(35)}/getUpdates`, '{"timeout":25}');
    assert.deepEqual(answer, { status: 200, body: '{"ok":true,"result":[]}' });
    assert.ok(Date.now() - started >= 29_500);
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("S-H6-13: a refuse cut resets the held long poll and refuses new calls without reaching upstream", async () => {
  await withProxy(async ({ server, bot, proxy, api }) => {
    const slow = await clientFor(proxy.url, bot.token, { pollTimeoutSeconds: 5 });
    const held = slow.getUpdates(0).then(() => "answered", (error: { kind: string }) => error.kind);
    await new Promise((resolve) => setTimeout(resolve, 200));
    proxy.cutRoute("refuse");
    assert.equal(await held, "transient");
    const upstreamCalls = server.calls.length;
    assert.equal(await api.getMe().then(() => "answered", (error: { kind: string }) => error.kind), "transient");
    assert.equal(server.calls.length, upstreamCalls, "nothing reached upstream while cut");
    proxy.restoreRoute();
    assert.deepEqual(await api.getMe(), { id: String(bot.id), username: "proxy_bot" });
  });
});

test("S-H6-13: a hang cut never answers and never forwards, so the client's own timeout fires", async () => {
  await withProxy(async ({ server, bot, proxy }) => {
    const api = await clientFor(proxy.url, bot.token, { requestTimeoutMs: 800 });
    proxy.cutRoute("hang");
    const upstreamCalls = server.calls.length;
    const started = Date.now();
    assert.equal(await api.getMe().then(() => "answered", (error: { kind: string }) => error.kind), "transient");
    assert.ok(Date.now() - started >= 700, "the call waited for the client timeout");
    await api.sendMessage({ chatId: "42", topicId: null, payload: { kind: "text", text: "never forwarded" } }).catch(() => undefined);
    assert.equal(server.calls.length, upstreamCalls, "upstream recorded zero calls during the hang");
    assert.deepEqual(server.transcript(42), [], "no message was sent upstream");
  });
});

test("S-H6-13: the phone side is unaffected by a cut: updates queue upstream and arrive after restore", async () => {
  await withProxy(async ({ server, bot, proxy, api }) => {
    proxy.cutRoute("refuse");
    await new FakePhone(server, bot, user, chat).send("sent while the workstation is cut off");
    assert.equal(await api.getUpdates(0).then(() => "answered", (error: { kind: string }) => error.kind), "transient");
    assert.equal(server.pendingUpdateCount(bot.id), 1, "the update waits upstream while the route is cut");
    proxy.restoreRoute();
    const updates = await api.getUpdates(0);
    assert.equal(updates[0]?.payload.text, "sent while the workstation is cut off");
  });
});

test("S-H6-14: restore closes held connections, is a no-op without a cut, and close works with a cut active", async () => {
  await withProxy(async ({ bot, proxy }) => {
    proxy.restoreRoute();
    assert.equal(proxy.state, "open");
    const api = await clientFor(proxy.url, bot.token, { requestTimeoutMs: 10_000 });
    proxy.cutRoute("hang");
    proxy.cutRoute("hang");
    const held = api.getMe().then(() => "answered", (error: { kind: string }) => error.kind);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const restoredAt = Date.now();
    proxy.restoreRoute();
    assert.equal(await held, "transient", "a held call is closed, not answered late");
    assert.ok(Date.now() - restoredAt < 2_000, "the held call ended promptly on restore");
    assert.equal(proxy.state, "open");
    assert.deepEqual(await api.getMe(), { id: String(bot.id), username: "proxy_bot" });
    proxy.cutRoute("refuse");
    proxy.cutRoute("hang");
    proxy.restoreRoute();
    assert.deepEqual(await api.getMe(), { id: String(bot.id), username: "proxy_bot" });
  });
  const upstream = await recordingUpstream(() => ({ status: 200, body: "{}" }));
  const proxy = new TelegramRouteProxy(upstream.url);
  await proxy.listen();
  const pending = raw(proxy.url, `/bot1:${"C".repeat(35)}/getMe`, "{}").catch(() => "reset");
  proxy.cutRoute("hang");
  const closedAt = Date.now();
  await proxy.close();
  assert.ok(Date.now() - closedAt < 2_000, "close with an active cut completes promptly");
  await pending;
  await upstream.close();
});

test("S-H6-15: the proxy listens on loopback only and forwards only Bot API paths to its one upstream", async () => {
  const upstream = await recordingUpstream(() => ({ status: 200, body: '{"ok":true,"result":true}' }));
  const elsewhere = await recordingUpstream(() => ({ status: 200, body: "elsewhere" }));
  const proxy = new TelegramRouteProxy(upstream.url);
  await proxy.listen();
  try {
    const port = new URL(proxy.url).port;
    const external = Object.values(networkInterfaces()).flat().find((address) => address && address.family === "IPv4" && !address.internal)?.address;
    if (external) {
      const refused = await new Promise<string>((resolve) => {
        const socket = connect(Number(port), external);
        socket.on("connect", () => { socket.destroy(); resolve("connected"); });
        socket.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
      });
      assert.equal(refused, "ECONNREFUSED");
    }
    const token = `1:${"D".repeat(35)}`;
    const absolute = await raw(proxy.url, "", "{}").catch(() => null);
    assert.equal(absolute?.status ?? 404, 404);
    const absoluteForm = await new Promise<number>((resolve) => {
      const socket = connect(Number(port), "127.0.0.1", () => socket.write(`POST ${elsewhere.url}/bot${token}/getMe HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\n{}`));
      socket.on("data", (data) => { resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(data.toString())?.[1] ?? 0)); socket.destroy(); });
    });
    assert.equal(absoluteForm, 404, "absolute-form request URLs are refused");
    assert.equal((await raw(proxy.url, "/etc/passwd", "{}")).status, 404);
    assert.equal((await raw(proxy.url, `/bot${token}/../../other`, "{}")).status, 404);
    const hostHeader = await raw(proxy.url, `/bot${token}/getMe`, "{}", { host: new URL(elsewhere.url).host });
    assert.equal(hostHeader.status, 200);
    assert.equal(elsewhere.requests.length, 0, "no request reached another host");
    assert.equal(upstream.requests.length, 1, "only the valid Bot API call reached the configured upstream");
    assert.equal(upstream.requests[0]!.headers.host, new URL(upstream.url).host);
  } finally {
    await proxy.close();
    await upstream.close();
    await elsewhere.close();
  }
  for (const bad of ["https://api.telegram.org.evil.example", "http://api.telegram.org", "https://example.com", "http://10.0.0.5:8080", "file:///etc/passwd", "https://api.telegram.org/bot1:x/", "https://user:pw@api.telegram.org"]) {
    assert.throws(() => new TelegramRouteProxy(bad), /upstream must be/, bad);
  }
  assert.doesNotThrow(() => new TelegramRouteProxy("https://api.telegram.org"));
});

test("S-H6-16: the proxy's records, log and error responses never contain the token, in any form", async () => {
  await withProxy(async ({ server, bot, proxy, api, logFile }) => {
    await api.getMe();
    await api.sendMessage({ chatId: "42", topicId: null, payload: { kind: "text", text: "hello" } }).catch(() => undefined);
    const rejected = await raw(proxy.url, `/bot${bot.token}/../x`, "{}");
    proxy.cutRoute("refuse");
    const refusedError = await api.getMe().then(() => "", (error: Error) => error.message);
    proxy.restoreRoute();
    await server.close();
    const unreachableError = await api.getMe().then(() => "", (error: Error) => error.message);
    const everything = [JSON.stringify(proxy.calls), readFileSync(logFile, "utf8"), rejected.body, refusedError, unreachableError].join("\n");
    assert.match(readFileSync(logFile, "utf8"), /getMe 200/);
    assert.equal(sweep([logFile], [{ label: "marker", value: bot.token }]).length, 0);
    for (const form of [bot.token, bot.token.split(":")[1]!, encodeURIComponent(bot.token)]) assert.ok(!everything.includes(form), "a form of the token leaked");
  });
});

/* ------------------------ driver rows, fake backend ------------------------ */

async function withFakePhone(fn: (context: { server: FakeTelegramServer; bot: FakeBot; phone: FakePhone; post: (method: string, body: Record<string, unknown>) => Promise<{ ok: boolean; result: { message_id: number } }> }) => Promise<void>): Promise<void> {
  const server = new FakeTelegramServer();
  await server.listen();
  const bot = newBot();
  server.addBot(bot);
  const phone = new FakePhone(server, bot, user, chat);
  const post = async (method: string, body: Record<string, unknown>) => (await fetch(`${server.url}/bot${bot.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Promise<{ ok: boolean; result: { message_id: number } }>;
  try {
    await fn({ server, bot, phone, post });
  } finally {
    await server.close();
  }
}

test("S-H6-04 (fake): a tap nobody answers resolves with no toast within the shared bound; the callback is still delivered once", { timeout: 60_000 }, async () => {
  await withFakePhone(async ({ server, bot, phone, post }) => {
    await post("sendMessage", { chat_id: 42, text: "card", reply_markup: { inline_keyboard: [[{ text: "Save answer", callback_data: "tc_offline" }]] } });
    const card = await phone.waitForBotMessage("the card", (message) => message.text === "card");
    const started = Date.now();
    assert.deepEqual(await phone.tap(card, "Save answer"), { toast: null });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= TAP_ANSWER_WAIT_MS - 200 && elapsed < TAP_ANSWER_WAIT_MS + 3_000, `tap took ${elapsed}ms`);
    assert.equal(server.pendingUpdateCount(bot.id), 1);
    const updates = await post("getUpdates", { offset: 0, timeout: 0 }) as unknown as { result: Array<{ callback_query?: { data: string } }> };
    assert.deepEqual(updates.result.map((update) => update.callback_query?.data), ["tc_offline"]);
  });
});

test("S-H6-06 (fake): afterId returns the oldest new match, never an older one; a wait that cannot succeed fails on time", async () => {
  await withFakePhone(async ({ phone, post }) => {
    await post("sendMessage", { chat_id: 42, text: "match old" });
    const cursor = await phone.cursor();
    await post("sendMessage", { chat_id: 42, text: "match A" });
    await post("sendMessage", { chat_id: 42, text: "match B" });
    const found = await phone.waitForBotMessage("a match", (message) => message.text.startsWith("match"), { afterId: cursor });
    assert.equal(found.text, "match A");
    const ids = (await phone.messages()).map((message) => message.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    const started = Date.now();
    await assert.rejects(() => phone.waitForBotMessage("nothing", () => false, { afterId: cursor, timeoutMs: 1_000 }), /^Error: phone: timed out after 1000ms waiting for nothing$/);
    assert.ok(Date.now() - started < 1_000 + 1_000);
  });
});

test("S-H6-07 (fake): messages() and waits see only this run's messages, not what the chat already held", async () => {
  await withFakePhone(async ({ server, bot, post }) => {
    await post("sendMessage", { chat_id: 42, text: "Task needs input: leftover card", reply_markup: { inline_keyboard: [[{ text: "Answer and resume", callback_data: "tc_old" }]] } });
    server.userSendsMessage(bot, user, chat, "/start old-code");
    const phone = new FakePhone(server, bot, user, chat);
    const cursor = await phone.cursor();
    assert.deepEqual(await phone.messages(), []);
    await assert.rejects(() => phone.waitForBotMessage("a leftover card", (message) => message.text.startsWith("Task needs input"), { timeoutMs: 500 }));
    await post("sendMessage", { chat_id: 42, text: "Task needs input: this run" });
    assert.deepEqual((await phone.messages()).map((message) => message.text), ["Task needs input: this run"]);
    assert.equal((await phone.messages()).filter((message) => message.fromBot && message.id > cursor).length, 1);
  });
});

/** Expected observations of the driver contract script; T3 compares real Telegram with the same list. */
async function fakeContract(phoneFor: (server: FakeTelegramServer, bot: FakeBot) => FakePhone = (server, bot) => new FakePhone(server, bot, user, chat)): Promise<Observation[]> {
  const server = new FakeTelegramServer();
  await server.listen();
  const bot = newBot();
  server.addBot(bot);
  try {
    return await runPhoneContract(phoneFor(server, bot), { baseUrl: server.url, token: bot.token, chatId: "42" }, randomBytes(4).toString("hex"));
  } finally {
    await server.close();
  }
}

test("S-H6-08 (fake): the driver contract script is deterministic on the fake and a broken fake fails naming the step", { timeout: 120_000 }, async () => {
  const first = await fakeContract();
  const second = await fakeContract();
  assert.deepEqual(observationDifferences(first, second), []);
  const byStep = Object.fromEntries(first.map((observation) => [observation.step, observation.value]));
  assert.deepEqual(byStep["tap answered by the bot"], { toast: "Saved.", data: "ct_save_<nonce>", cardText: "contract <nonce>: card" });
  assert.deepEqual(byStep["tap nobody answers"], { toast: null, callbacksDeliveredLater: 1 });
  assert.deepEqual(byStep["reply as the bot receives it"], { text: "contract <nonce>: *reply* <b>literal</b>", replyToText: "contract <nonce>: card" });
  assert.equal((byStep["edit without markup removes the buttons"] as { edited: boolean }).edited, true);

  class NeverEditedPhone extends FakePhone {
    override async messages(): Promise<PhoneMessage[]> {
      return (await super.messages()).map((message) => ({ ...message, edited: false }));
    }
    override async waitForBotMessage(description: string, predicate: (message: PhoneMessage) => boolean, options?: { afterId?: number; timeoutMs?: number }): Promise<PhoneMessage> {
      return { ...(await super.waitForBotMessage(description, predicate, options)), edited: false };
    }
  }
  const broken = await fakeContract((server, bot) => new NeverEditedPhone(server, bot, user, chat));
  const differences = observationDifferences(first, broken);
  assert.ok(differences.some((line) => line.startsWith("edit that keeps one button:")), differences.join("\n"));
});

/* --------------------------- contract fixtures ---------------------------- */

test("S-H6-29: sanitizing a recording replaces identities everywhere with typed placeholders and refuses leftovers", () => {
  const operator = { id: 918_273_645, is_bot: false, first_name: "Junie", last_name: "Q", username: "junie_q", language_code: "en" };
  const bot = { id: 8_123_456_789, is_bot: true, first_name: "Harness", username: "harness_test_bot" };
  const token = `8123456789:${"E".repeat(35)}`;
  const raw = {
    getMe: { ok: true, result: bot },
    update: { update_id: 55_501, message: { message_id: 12, from: operator, chat: { id: 918_273_645, type: "private", first_name: "Junie", username: "junie_q" }, date: 1_757_900_000, text: "Paired with this workstation, Junie (@junie_q, 918273645)" } },
    error: { ok: false, error_code: 400, description: "Bad Request: chat 918273645 of junie_q not found" },
  };
  const fixture = sanitizeRecording(raw, [token, "918273645", "8123456789", "Junie", "junie_q", "harness_test_bot"]) as typeof raw;
  const text = JSON.stringify(fixture);
  for (const value of ["918273645", "8123456789", "Junie", "junie_q", "harness_test_bot"]) assert.ok(!text.includes(value), `${value} survived`);
  assert.equal(typeof fixture.update.message.from.id, "number");
  assert.equal(fixture.update.message.from.id, fixture.update.message.chat.id, "the same identity maps to the same placeholder");
  assert.equal(typeof fixture.update.message.date, "number");
  assert.equal(fixture.update.message.from.is_bot, false);
  assert.ok(fixture.update.message.text.startsWith("Paired with this workstation, "));
  assert.deepEqual(Object.keys(fixture.update.message.from), Object.keys(operator));
  assert.equal(sweep([], [{ label: "token", value: token }]).length, 0);

  const planted = { ...raw, extra: { ok: true, result: { note: `phone +44 7700 900123 and ${token}` } } };
  assert.throws(() => sanitizeRecording(planted, [token, "+44 7700 900123"]), /nothing was written/);
});

test("S-H6-30: the fake answers like the real recording for every recorded step", async (t) => {
  const differences = (real: unknown, fake: unknown, omittable: string[] = []) => shapeDifferences(shapeOf(real), shapeOf(fake), new Set(omittable));
  // The comparer itself: a renamed field and a wrong type are named by JSON path.
  const reference = { ok: true, result: { message_id: 1, chat: { id: 2, type: "private" }, text: "x" } };
  assert.deepEqual(differences(reference, { ok: true, result: { message_id: 1, chat: { id: 2, kind: "private" }, text: "x" } }), ["$.result.chat.kind: the fake sends a field real Telegram does not", "$.result.chat.type: real Telegram sends it, the fake does not"]);
  assert.deepEqual(differences(reference, { ok: true, result: { message_id: "1", chat: { id: 2, type: "private" }, text: "x" } }), ["$.result.message_id: real is number, fake is string"]);

  const { replayOnFake } = await import("./contracts/replayOnFake.ts");
  const fake = await replayOnFake();
  const recorder = readFileSync(new URL("../scripts/record-telegram-contracts.ts", import.meta.url), "utf8");
  const recorderSteps = [...recorder.matchAll(/call\("([A-Za-z.]+)"|steps\["([A-Za-z.]+)"\]/g)].map((match) => match[1] ?? match[2]!).sort();
  assert.deepEqual(Object.keys(fake).sort(), [...new Set(recorderSteps)], "the fake replays exactly the recorder's steps");
  for (const step of ["update.messageReply", "update.messagePlain", "update.callbackQuery"]) assert.ok(fake[step]?.body, `${step} produced an update`);

  const fixturePath = new URL("../contracts/telegram-bot-api.json", import.meta.url).pathname;
  if (!existsSync(fixturePath)) {
    t.skip("blocked on setup: no real recording yet; run npm run e2e:live:record-contracts after docs/e2e-live-setup.md (S-H6-28)");
    return;
  }
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { steps: Record<string, { status: number; body: { ok: boolean; error_code?: number; description?: string } }> };
  const problems: string[] = [];
  for (const [step, real] of Object.entries(fixture.steps)) {
    const mine = fake[step];
    if (!mine) {
      problems.push(`${step}: not replayed on the fake`);
      continue;
    }
    if (mine.status !== real.status) problems.push(`${step}: real status ${real.status}, fake ${mine.status}`);
    if (!real.body.ok && real.body.description?.split(":").slice(0, 2).join(":") !== (mine.body as { description?: string }).description?.split(":").slice(0, 2).join(":")) problems.push(`${step}: real description "${real.body.description}", fake "${(mine.body as { description?: string }).description}"`);
    problems.push(...differences(real.body, mine.body, mine.omittable).map((line) => `${step} ${line}`));
  }
  assert.deepEqual(problems, []);
});
