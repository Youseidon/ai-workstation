import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { TelegramAdapter } from "./integrations/telegram/adapter.ts";
import { TelegramApiError, type TelegramBotApi, type TelegramEditRequest, type TelegramSendRequest } from "./integrations/telegram/botApi.ts";
import { FakeTelegramBotApi } from "./integrations/telegram/fakeBotApi.ts";
import { HttpTelegramBotApi } from "./integrations/telegram/httpBotApi.ts";
import { workspaces } from "./workspaces.ts";

// Scenario IDs refer to docs/e2e-scenarios/l3-f1-f2.md (slice F1, RTC-21): the outbox edit operation.

const serverDir = resolve(import.meta.dirname, "..");
const TOKEN = `8123456789:${randomBytes(27).toString("base64url")}`;

function httpApi(respond: (method: string, body: Record<string, unknown>) => Response | Promise<Response>) {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  const api = new HttpTelegramBotApi({
    token: { reveal: () => TOKEN } as never,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = url.split("/").at(-1)!;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, method, body });
      return respond(method, body);
    }) as typeof fetch,
    contentForRef: () => "Aurora",
    requestTimeoutMs: 200,
  });
  return { api, calls };
}

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const card = (text: string) => ({ kind: "text", text });
const question = { kind: "personal_question", title: "Name", execution: "blocked", decision: "awaiting_response", question: "Which?", actions: [{ ref: "tc_AAAAAAAAAAAAAAAAAAAAAAAA", action: "save_human_response" }] };

/** A controllable Bot API: every call records its arguments and waits for the test to answer it. */
class HeldApi implements TelegramBotApi {
  readonly sends: TelegramSendRequest[] = [];
  readonly edits: TelegramEditRequest[] = [];
  private pending: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  private nextId = 100;
  autoAnswer = true;

  async getUpdates(): Promise<never[]> {
    return [];
  }

  sendMessage(request: TelegramSendRequest): Promise<{ messageId: string }> {
    this.sends.push(request);
    return Promise.resolve({ messageId: String(this.nextId++) });
  }

  editMessageText(request: TelegramEditRequest): Promise<{ modified: boolean }> {
    this.edits.push(request);
    if (this.autoAnswer) return Promise.resolve({ modified: true });
    return new Promise((resolve, reject) => this.pending.push({ resolve: resolve as (value: unknown) => void, reject }));
  }

  release(outcome: { modified: boolean } | Error): void {
    const next = this.pending.shift();
    assert.ok(next, "no edit is in flight");
    if (outcome instanceof Error) next.reject(outcome);
    else next.resolve(outcome);
  }
}

function withBot(fn: (botId: string) => Promise<void> | void): () => Promise<void> {
  return async () => {
    const botId = `f1-${randomBytes(6).toString("hex")}`;
    try {
      await fn(botId);
    } finally {
      workspaces.removeTelegramRecordsForBot(botId);
    }
  };
}

const row = (id: number) => workspaces.telegramOutboxRow(id)!;
const edits = (botId: string) => workspaces.telegramOutbox().filter((entry) => entry.botId === botId && workspaces.telegramOutboxRow(entry.id)!.operation === "edit");

async function deliverDue(adapter: TelegramAdapter, botId: string): Promise<void> {
  for (const due of workspaces.dueTelegramOutbox(botId, new Date(Date.now() + 10 * 60_000))) await adapter.deliverOutbox(due.id);
}

test("S-L3-F1-01: editMessageText sends the message id, text and buttons without parse_mode, and no markup when there are no buttons", async () => {
  const { api, calls } = httpApi(() => reply(200, { ok: true, result: { message_id: 456, text: "x" } }));
  assert.deepEqual(await api.editMessageText({ chatId: "123", messageId: "456", payload: question }), { modified: true });
  assert.deepEqual(await api.editMessageText({ chatId: "123", messageId: "456", payload: card("Only text") }), { modified: true });
  assert.equal(calls.length, 2);
  const [withButtons, textOnly] = calls;
  assert.match(withButtons!.url, /\/editMessageText$/);
  assert.equal(withButtons!.body.chat_id, "123");
  assert.equal(withButtons!.body.message_id, 456);
  assert.equal(withButtons!.body.parse_mode, undefined);
  assert.deepEqual(withButtons!.body.link_preview_options, { is_disabled: true });
  assert.ok(Array.isArray((withButtons!.body.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard));
  assert.equal(textOnly!.body.text, "Only text");
  assert.equal("reply_markup" in textOnly!.body, false);
  await assert.rejects(() => api.editMessageText({ chatId: "123", messageId: "", payload: card("x") }), (error: TelegramApiError) => error.kind === "rejected");
  assert.equal(calls.length, 2, "an edit without a sent message id makes no call");

  const fake = new FakeTelegramBotApi();
  const sent = await fake.sendMessage({ chatId: "1", topicId: null, payload: card("a") });
  assert.deepEqual(await fake.editMessageText({ chatId: "1", messageId: sent.messageId, payload: card("b") }), { modified: true });
  assert.deepEqual(await fake.editMessageText({ chatId: "1", messageId: sent.messageId, payload: card("b") }), { modified: false });
  await assert.rejects(() => fake.editMessageText({ chatId: "1", messageId: "never-sent", payload: card("c") }), /message to edit not found/);
});

test("S-L3-F1-02: edit responses are classified: not modified is success, permanent 4xx, rate limit, transient and unauthorized, never leaking the token", async () => {
  const cases: Array<[Response | Error, "success-unmodified" | TelegramApiError["kind"], number | null]> = [
    [reply(400, { ok: false, error_code: 400, description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same" }), "success-unmodified", null],
    [reply(400, { ok: false, error_code: 400, description: "Bad Request: message to edit not found" }), "rejected", null],
    [reply(400, { ok: false, error_code: 400, description: "Bad Request: message can't be edited" }), "rejected", null],
    [reply(400, { ok: false, error_code: 400, description: "Bad Request: message text is empty" }), "rejected", null],
    [reply(400, { ok: false, error_code: 400, description: "Bad Request: message is too long" }), "rejected", null],
    [reply(403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }), "rejected", null],
    [reply(429, { ok: false, error_code: 429, description: "Too Many Requests: retry after 7", parameters: { retry_after: 7 } }), "rate_limited", 7000],
    [reply(500, { ok: false, error_code: 500, description: "Internal Server Error" }), "transient", null],
    [reply(502, { ok: false, error_code: 502, description: "Bad Gateway" }), "transient", null],
    [new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/editMessageText`), "transient", null],
    [reply(401, { ok: false, error_code: 401, description: "Unauthorized" }), "unauthorized", null],
  ];
  for (const [response, expected, retryAfterMs] of cases) {
    const { api } = httpApi(() => {
      if (response instanceof Error) throw response;
      return response.clone();
    });
    const outcome = await api.editMessageText({ chatId: "123", messageId: "456", payload: card("x") }).then((value) => value, (error: unknown) => error);
    if (expected === "success-unmodified") {
      assert.deepEqual(outcome, { modified: false });
      continue;
    }
    assert.ok(outcome instanceof TelegramApiError, `expected ${expected}, got ${JSON.stringify(outcome)}`);
    assert.equal(outcome.kind, expected);
    assert.equal(outcome.retryable, expected === "transient" || expected === "rate_limited");
    if (retryAfterMs !== null) assert.equal(outcome.retryAfterMs, retryAfterMs);
    assert.match(outcome.message, /editMessageText/);
    assert.ok(!outcome.message.includes(TOKEN) && !outcome.message.includes(TOKEN.split(":")[1]!), "the token leaked");
  }
  const hung = new HttpTelegramBotApi({
    token: { reveal: () => TOKEN } as never,
    fetch: ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))) as typeof fetch,
    requestTimeoutMs: 200,
  });
  const api = hung;
  // AbortSignal.timeout does not keep the event loop alive on its own.
  const keepAlive = setTimeout(() => undefined, 5_000);
  const timedOut = await api.editMessageText({ chatId: "123", messageId: "456", payload: card("x") }).catch((error: TelegramApiError) => error);
  clearTimeout(keepAlive);
  assert.equal((timedOut as TelegramApiError).kind, "transient");
});

test("S-L3-F1-07 (T0): queued edits of one message coalesce to the latest", withBot(async (botId) => {
  const api = new HeldApi();
  const adapter = new TelegramAdapter(botId, api);
  const sendId = workspaces.enqueueTelegramOutbox({ botId, chatId: "chat-1", payload: card("original") });
  await deliverDue(adapter, botId);
  const first = workspaces.enqueueTelegramEdit({ botId, targetOutboxId: sendId, payload: card("A") });
  const second = workspaces.enqueueTelegramEdit({ botId, targetOutboxId: sendId, payload: card("B") });
  const third = workspaces.enqueueTelegramEdit({ botId, targetOutboxId: sendId, payload: card("C") });
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(edits(botId).length, 1);
  assert.deepEqual(workspaces.telegramOutboxCounts(botId), { queued: 1, retrying: 0, failed: 0 });
  await deliverDue(adapter, botId);
  assert.deepEqual(api.edits.map((edit) => [edit.messageId, (edit.payload as { text: string }).text]), [["100", "C"]]);
  assert.deepEqual(workspaces.telegramOutboxCounts(botId), { queued: 0, retrying: 0, failed: 0 });

  for (const text of ["D", "E", "F"]) workspaces.enqueueTelegramEdit({ botId, targetOutboxId: sendId, payload: card(text) });
  assert.equal(edits(botId).filter((entry) => entry.state === "QUEUED").length, 1, "a delivered edit is not reopened; one new queued edit carries F");
  await deliverDue(adapter, botId);
  assert.deepEqual(api.edits.map((edit) => (edit.payload as { text: string }).text), ["C", "F"]);
  assert.equal(api.sends.length, 1, "coalescing never turns an edit into a send");
}));

test("S-L3-F1-08 (T0): an edit queued while an older edit is in flight or retrying is still delivered last", withBot(async (botId) => {
  const api = new HeldApi();
  const adapter = new TelegramAdapter(botId, api);
  const sendId = workspaces.enqueueTelegramOutbox({ botId, chatId: "chat-1", payload: card("original") });
  await deliverDue(adapter, botId);
  api.autoAnswer = false;

  // Case 1: B is queued while A's call is in flight, then A's response arrives.
  const editId = workspaces.enqueueTelegramEdit({ botId, targetOutboxId: sendId, payload: card("A") });
  const inFlight = adapter.deliverOutbox(editId);
  await new Promise((resolveWait) => setImmediate(resolveWait));
  workspaces.enqueueTelegramEdit({ botId, targetOutboxId: sendId, payload: card("B") });
  api.release({ modified: true });
  await inFlight;
  assert.equal(row(editId).state, "QUEUED", "A's success does not mark B as sent");
  api.autoAnswer = true;
  await deliverDue(adapter, botId);
  assert.deepEqual(api.edits.map((edit) => (edit.payload as { text: string }).text), ["A", "B"]);
  assert.equal(row(editId).state, "SENT");

  // Case 2: A fails transiently, B is queued before the retry; the retry carries B.
  api.autoAnswer = false;
  const retryId = workspaces.enqueueTelegramEdit({ botId, targetOutboxId: sendId, payload: card("A2") });
  const failing = adapter.deliverOutbox(retryId);
  await new Promise((resolveWait) => setImmediate(resolveWait));
  api.release(new TelegramApiError("transient", "Telegram editMessageText network failure: ECONNRESET"));
  await failing;
  assert.equal(workspaces.telegramOutboxCounts(botId).retrying, 1);
  assert.equal(workspaces.enqueueTelegramEdit({ botId, targetOutboxId: sendId, payload: card("B2") }), retryId, "the retrying edit is replaced, not stacked");
  api.autoAnswer = true;
  await deliverDue(adapter, botId);
  assert.deepEqual(api.edits.slice(2).map((edit) => (edit.payload as { text: string }).text), ["A2", "B2"]);
  assert.deepEqual(workspaces.telegramOutboxCounts(botId), { queued: 0, retrying: 0, failed: 0 });

  // Case 3: B is queued after the sender picked the row but before it delivered it.
  const pickedId = workspaces.enqueueTelegramEdit({ botId, targetOutboxId: sendId, payload: card("A3") });
  const [picked] = workspaces.dueTelegramOutbox(botId, new Date());
  assert.equal(picked!.id, pickedId);
  workspaces.enqueueTelegramEdit({ botId, targetOutboxId: sendId, payload: card("B3") });
  await adapter.deliverOutbox(picked!.id);
  assert.equal((api.edits.at(-1)!.payload as { text: string }).text, "B3");
  assert.equal(row(pickedId).state, "SENT");
}));

test("S-L3-F1-13 (T0): permanent edit failures are recorded once, without retry, and do not stop later rows", withBot(async (botId) => {
  const descriptions = ["Bad Request: message can't be edited", "Forbidden: bot was blocked by the user", "Bad Request: chat not found", "Bad Request: message text is empty", "Bad Request: message is too long", "Bad Request: message to edit not found"];
  let next = 0;
  const fake = new FakeTelegramBotApi();
  const api: TelegramBotApi = {
    getUpdates: () => fake.getUpdates(0),
    sendMessage: (request) => fake.sendMessage(request),
    editMessageText: async () => {
      throw new TelegramApiError("rejected", `Telegram editMessageText failed (400): ${descriptions[next++]}`);
    },
  };
  const adapter = new TelegramAdapter(botId, api);
  for (const description of descriptions) {
    const sendId = workspaces.enqueueTelegramOutbox({ botId, chatId: "chat-1", payload: card(`base for ${description}`) });
    await deliverDue(adapter, botId);
    const editId = workspaces.enqueueTelegramEdit({ botId, targetOutboxId: sendId, payload: card("changed") });
    const later = workspaces.enqueueTelegramOutbox({ botId, chatId: "chat-1", payload: card(`after ${description}`) });
    await deliverDue(adapter, botId);
    await deliverDue(adapter, botId);
    const failed = workspaces.telegramOutbox().find((entry) => entry.id === editId)!;
    assert.equal(failed.state, "FAILED", description);
    assert.equal(failed.attemptCount, 1, `${description} is not retried`);
    assert.ok(failed.lastError?.includes(description.split(": ")[1]!));
    assert.ok(!failed.lastError?.includes(TOKEN));
    assert.equal(workspaces.telegramOutbox().find((entry) => entry.id === later)!.state, "SENT");
  }
  assert.equal(workspaces.telegramOutboxCounts(botId).retrying, 0);
}));

test("S-L3-F1-17 (T0): an edit waits for its send's message id and fails without a call when the send fails for good", withBot(async (botId) => {
  const api = new HeldApi();
  const adapter = new TelegramAdapter(botId, api);
  const sendId = workspaces.enqueueTelegramOutbox({ botId, chatId: "chat-1", payload: card("original") });
  const editId = workspaces.enqueueTelegramEdit({ botId, targetOutboxId: sendId, payload: card("latest") });
  assert.deepEqual(workspaces.dueTelegramOutbox(botId, new Date()).map((due) => due.id), [sendId], "the edit is not due before its send has a message id");
  workspaces.markTelegramOutbox(sendId, "FAILED", "Telegram sendMessage failed (429)", { nextAttemptAt: new Date(Date.now() + 60_000).toISOString() });
  assert.deepEqual(workspaces.dueTelegramOutbox(botId, new Date()).map((due) => due.id), [], "an edit behind a retrying send keeps waiting");
  assert.equal(row(editId).state, "QUEUED");
  await deliverDue(adapter, botId);
  assert.equal(api.edits.length, 0, "the send is delivered first");
  await deliverDue(adapter, botId);
  assert.deepEqual(api.edits.map((edit) => edit.messageId), ["100"], "the edit follows on the next cycle, with the real message id");

  const doomedSend = workspaces.enqueueTelegramOutbox({ botId, chatId: "chat-1", payload: card("never delivered") });
  const doomedEdit = workspaces.enqueueTelegramEdit({ botId, targetOutboxId: doomedSend, payload: card("never either") });
  workspaces.markTelegramOutbox(doomedSend, "FAILED", "Telegram sendMessage failed (400): Bad Request: chat not found");
  const editsBefore = api.edits.length;
  await deliverDue(adapter, botId);
  assert.equal(api.edits.length, editsBefore, "no editMessageText without a message id");
  assert.equal(row(doomedEdit).state, "FAILED");
  assert.deepEqual(workspaces.dueTelegramOutbox(botId, new Date(Date.now() + 3_600_000)), [], "nothing waits forever");
}));

test("S-L3-F1-20 (T0): an edit can only target a send this bot made; unpairing drops queued edits for that chat", withBot(async (botId) => {
  const otherBot = `${botId}-other`;
  try {
    const mine = workspaces.enqueueTelegramOutbox({ botId, chatId: "chat-a", payload: card("mine") });
    const theirs = workspaces.enqueueTelegramOutbox({ botId: otherBot, chatId: "chat-a", payload: card("theirs") });
    const editRow = workspaces.enqueueTelegramEdit({ botId, targetOutboxId: mine, payload: card("edit") });
    for (const target of [theirs, editRow, 99_999_999]) {
      assert.throws(() => workspaces.enqueueTelegramEdit({ botId, targetOutboxId: target, payload: card("forged") }), /not sent by this bot/);
    }
    const chatB = workspaces.enqueueTelegramOutbox({ botId, chatId: "chat-b", payload: card("b") });
    workspaces.enqueueTelegramEdit({ botId, targetOutboxId: chatB, payload: card("b edit") });
    assert.equal(workspaces.dropQueuedTelegramEdits(botId, "chat-a"), 1);
    assert.equal(edits(botId).length, 1, "only chat A's queued edit is dropped");
    assert.equal(workspaces.telegramOutboxRow(editRow), null);
  } finally {
    workspaces.removeTelegramRecordsForBot(otherBot);
  }
}));

test("S-L3-F1-20 (T0): the harness edit routes do not exist outside harness mode", async () => {
  const { handleWorkspaceApi } = await import("./workspaceApi.ts");
  assert.notEqual(process.env.AGENT_CONSOLE_HARNESS, "1");
  const server = createServer((req, res) => {
    void handleWorkspaceApi(req, res, new URL(req.url ?? "/", "http://127.0.0.1")).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const path of ["/api/task-control/telegram/harness/outbox", "/api/task-control/telegram/harness/outbox/1/edit"]) {
      const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: "1", text: "x", payload: { kind: "text", text: "x" } }) });
      assert.equal(response.status, 404, path);
    }
  } finally {
    server.close();
  }
});

test("S-L3-F1-04: migration 21 keeps every L1 outbox row as a send, unchanged, and runs once", () => {
  const root = mkdtempSync(join(tmpdir(), "f1-migration-"));
  try {
    mkdirSync(join(root, ".agent-console"), { recursive: true });
    const boot = () => spawnSync(process.execPath, ["--import", "tsx", "-e", "await import('./src/workspaces.ts')"], { cwd: serverDir, env: { PATH: process.env.PATH, HOME: root, AGENT_CONSOLE_REPO_ROOT: root }, encoding: "utf8", timeout: 60_000 });
    const first = boot();
    assert.equal(first.status, 0, first.stderr);
    const file = join(root, ".agent-console/console.sqlite");
    // Rebuild telegram_outbox exactly as migrations 16 and 20 left it, so the database is an L1 database at version 20.
    const database = new Database(file);
    database.exec(`
      DROP INDEX telegram_outbox_target_idx;
      CREATE TABLE telegram_outbox_v20 (
        id INTEGER PRIMARY KEY, bot_id TEXT NOT NULL, chat_id TEXT NOT NULL, topic_id TEXT, payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('QUEUED','SENT','FAILED')), attempt_count INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, next_attempt_at TEXT, sent_message_id TEXT
      );
      DROP TABLE telegram_outbox;
      ALTER TABLE telegram_outbox_v20 RENAME TO telegram_outbox;
      CREATE INDEX telegram_outbox_state_idx ON telegram_outbox(state, updated_at);
      CREATE INDEX telegram_outbox_sent_message_idx ON telegram_outbox(bot_id, chat_id, sent_message_id);
      DELETE FROM schema_migration WHERE version = 21;
      INSERT INTO telegram_outbox VALUES (1,'telegram-1','42',NULL,'{"kind":"text","text":"queued"}','QUEUED',0,NULL,'2026-09-14T01:00:00.000Z','2026-09-14T01:00:00.000Z',NULL,NULL);
      INSERT INTO telegram_outbox VALUES (2,'telegram-1','42',NULL,'{"kind":"personal_question","promptId":7}','SENT',1,NULL,'2026-09-14T01:00:01.000Z','2026-09-14T01:00:02.000Z',NULL,'311');
      INSERT INTO telegram_outbox VALUES (3,'telegram-1','42','9','{"kind":"text","text":"retrying"}','FAILED',2,'Telegram sendMessage failed (502)','2026-09-14T01:00:03.000Z','2026-09-14T01:00:04.000Z','2026-09-14T01:05:00.000Z',NULL);
      INSERT INTO telegram_outbox VALUES (4,'telegram-1','42',NULL,'{"kind":"text","text":"gone"}','FAILED',1,'Telegram sendMessage failed (400): Bad Request: chat not found','2026-09-14T01:00:05.000Z','2026-09-14T01:00:06.000Z',NULL,NULL);
    `);
    const before = database.prepare("SELECT * FROM telegram_outbox ORDER BY id").all();
    database.close();

    for (const run of [1, 2]) {
      const again = boot();
      assert.equal(again.status, 0, again.stderr);
      const migrated = new Database(file, { readonly: true });
      try {
        const rows = migrated.prepare("SELECT * FROM telegram_outbox ORDER BY id").all() as Array<Record<string, unknown>>;
        assert.deepEqual(rows.map(({ operation, target_outbox_id, payload_version, ...rest }) => { assert.equal(operation, "send"); assert.equal(target_outbox_id, null); assert.equal(payload_version, 0); return rest; }), before, `boot ${run}`);
        assert.deepEqual(migrated.prepare("SELECT version FROM schema_migration WHERE version IN (20,21) ORDER BY version").all(), [{ version: 20 }, { version: 21 }], "migration 21 is applied exactly once and 20 is untouched");
      } finally {
        migrated.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
