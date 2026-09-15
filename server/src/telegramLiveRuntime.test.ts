import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { config } from "./config.ts";
import { BotToken } from "./integrations/telegram/credentials.ts";
import { HttpTelegramBotApi } from "./integrations/telegram/httpBotApi.ts";
import { TelegramLiveRuntime, type TelegramRuntimeSettings } from "./integrations/telegram/runtime.ts";
import { setPipelineStationStarter } from "./pipelineScheduler.ts";
import { renderPersonalQuestion } from "./taskControlRenderer.ts";
import { workspaces } from "./workspaces.ts";

/* -------------------------------------------------------------------------- */
/* A stub Bot API: real HTTP client, fake api.telegram.org behind fetch        */
/* -------------------------------------------------------------------------- */

type Scripted = { status: number; body: Record<string, unknown> } | Error;
type User = { id: number; first_name: string; username?: string };
type RecordedMessage = { chatId: string; topicId: number | null; text: string; buttons: Array<{ text: string; data: string }>; messageId: number };

class StubTelegram {
  readonly rawToken: string;
  readonly calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  readonly messages: RecordedMessage[] = [];
  readonly answered: Array<{ id: string; text: string }> = [];
  private updates: Array<Record<string, unknown>> = [];
  private nextUpdateId = 1;
  private nextMessageId = 500;
  private nextCallbackId = 1;
  private readonly scripts = new Map<string, Scripted[]>();
  private wake: Array<() => void> = [];
  /** Runs after a sendMessage is recorded and before its response returns, as when Telegram shows the message first. */
  holdSendResponse: ((message: RecordedMessage) => Promise<void>) | null = null;

  constructor(readonly botUserId: number) {
    this.rawToken = `${botUserId}:${randomBytes(27).toString("base64url")}`;
  }

  script(method: string, ...responses: Scripted[]): void {
    this.scripts.set(method, [...(this.scripts.get(method) ?? []), ...responses]);
  }

  private push(update: Record<string, unknown>): void {
    this.updates.push({ update_id: this.nextUpdateId++, ...update });
    for (const resolve of this.wake.splice(0)) resolve();
  }

  send(from: User, chat: { id: number; type: string }, text: string, replyTo?: number, topic?: number): void {
    this.push({ message: { message_id: this.nextMessageId++, from: { ...from, is_bot: false }, chat, date: 1, text, ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo, chat, date: 1 } }), ...(topic === undefined ? {} : { message_thread_id: topic, is_topic_message: true }) } });
  }

  tap(from: User, message: RecordedMessage, buttonText: string): void {
    const button = message.buttons.find(entry => entry.text === buttonText);
    assert.ok(button, `button ${buttonText} is not on message ${message.messageId}`);
    const chatType = Number(message.chatId) < 0 ? "supergroup" : "private";
    this.push({ callback_query: { id: `cbq-${this.nextCallbackId++}`, from: { ...from, is_bot: false }, message: { message_id: message.messageId, chat: { id: Number(message.chatId), type: chatType }, date: 1, ...(message.topicId === null ? {} : { message_thread_id: message.topicId, is_topic_message: true }) }, chat_instance: "i", data: button.data } });
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const match = /\/bot([^/]+)\/(\w+)$/.exec(String(input));
    assert.ok(match, `unexpected URL shape`);
    const method = match[2]!;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    this.calls.push({ method, body });
    if (match[1] !== this.rawToken) return json(401, { ok: false, error_code: 401, description: "Unauthorized" });
    const scripted = this.scripts.get(method)?.shift();
    if (scripted instanceof Error) throw scripted;
    if (scripted) return json(scripted.status, scripted.body);
    switch (method) {
      case "getMe":
        return json(200, { ok: true, result: { id: this.botUserId, is_bot: true, first_name: "L1", username: "l1_stub_bot" } });
      case "getUpdates": {
        const offset = Number(body.offset);
        const signal = init?.signal;
        // Behave like a long poll: hold the request until updates arrive or it is aborted.
        while (!this.updates.some(update => Number(update.update_id) >= offset)) {
          if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
          await new Promise<void>(resolve => {
            this.wake.push(resolve);
            signal?.addEventListener("abort", () => resolve(), { once: true });
            setTimeout(resolve, 200);
          });
        }
        return json(200, { ok: true, result: this.updates.filter(update => Number(update.update_id) >= offset) });
      }
      case "sendMessage": {
        const markup = body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined;
        const message = { chatId: String(body.chat_id), topicId: typeof body.message_thread_id === "number" ? body.message_thread_id : null, text: String(body.text), buttons: (markup?.inline_keyboard ?? []).flat().map(button => ({ text: button.text, data: button.callback_data })), messageId: this.nextMessageId++ };
        this.messages.push(message);
        const hold = this.holdSendResponse;
        if (hold !== null) await hold(message);
        return json(200, { ok: true, result: { message_id: message.messageId, chat: { id: Number(body.chat_id) }, date: 1, text: body.text } });
      }
      case "answerCallbackQuery":
        this.answered.push({ id: String(body.callback_query_id), text: String(body.text) });
        return json(200, { ok: true, result: true });
      default:
        return json(404, { ok: false, error_code: 404, description: "Not Found" });
    }
  }) as typeof fetch;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function waitFor<T>(probe: () => T | null | undefined | false, label: string, timeoutMs = 4000): Promise<T> {
  // performance.now, not Date.now: one test freezes the wall clock.
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (performance.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function harness(options: { settings?: Partial<TelegramRuntimeSettings>; token?: "stub" | "none"; now?: () => number } = {}) {
  const stub = new StubTelegram(7_000_000_000 + Math.floor(Math.random() * 1_000_000));
  const settings: TelegramRuntimeSettings = { enabled: true, notificationsEnabled: true, remoteActionsEnabled: true, transport: "telegram", ...options.settings };
  const logs: string[] = [];
  const sleeps: number[] = [];
  const log = (level: string) => (message: string, extra?: unknown) => { logs.push(`${level} ${message} ${extra === undefined ? "" : String(extra)}`); };
  const runtime = new TelegramLiveRuntime({
    settings: () => settings,
    credential: { token: options.token === "none" ? null : BotToken.parse(stub.rawToken), problem: null },
    createApi: (token, contentForRef) => new HttpTelegramBotApi({ token, contentForRef, fetch: stub.fetch }),
    // Record the requested backoff but do not actually wait for it.
    sleep: (ms, signal) => {
      sleeps.push(ms);
      return new Promise(resolve => {
        const timer = setTimeout(resolve, Math.min(ms, 5));
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    },
    now: options.now,
    logger: { info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") },
    deliverIntervalMs: 5,
    notifyIntervalMs: 0,
    sendSpacingMs: 0,
  });
  const botId = `telegram-${stub.botUserId}`;
  return {
    stub, settings, logs, sleeps, runtime, botId,
    async cleanup() {
      await runtime.stop();
      for (const actor of workspaces.taskControlActors("telegram")) workspaces.removeTaskControlActor(actor.id);
      workspaces.removeTelegramRecordsForBot(botId);
    },
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "telegram-live-"));
  const workspace = workspaces.create({ name: dir, workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
  const title = `Import owner list ${workspace.id}`;
  const prompt = workspaces.createChild("prompt", suite.id, { title, content: "Use an owner-supplied list" }) as PromptRecord;
  const runId = `tg-live-run-${workspace.id}`;
  workspaces.beginAgentRun({ runId, workspaceId: workspace.id, promptId: prompt.id, provider: "claude", model: null, tokenHash: runId, expiresAt: new Date(Date.now() + 60000).toISOString(), role: "execute" });
  workspaces.finishAgentRun(runId, "done");
  workspaces.respondToBlockedPrompt(prompt.id, { content: "Prior answer" });
  const handoff = workspaces.createHandoff({ id: `tg-live-handoff-${workspace.id}`, workspaceId: workspace.id, promptId: prompt.id, sourceRunId: runId, provider: "claude", model: null });
  return {
    workspace, suite, prompt, title,
    async askQuestion() {
      // The question must postdate the prior answer to count as pending.
      await new Promise(resolve => setTimeout(resolve, 5));
      workspaces.updateHandoff(handoff.id, { state: "READY", recommendation: "WAIT_FOR_HUMAN", completedAt: new Date().toISOString() });
    },
    cleanup() { workspaces.remove(workspace.id); rmSync(dir, { recursive: true, force: true }); },
  };
}

const operator: User = { id: 424242, first_name: "Operator", username: "op" };
const stranger: User = { id: 999001, first_name: "Stranger" };
const operatorChat = { id: operator.id, type: "private" };

async function pair(h: ReturnType<typeof harness>): Promise<string> {
  const pairing = h.runtime.startPairing();
  assert.equal(pairing.deepLink, `https://t.me/l1_stub_bot?start=${pairing.code}`);
  h.stub.send(operator, operatorChat, `/start ${pairing.code}`);
  const observed = await waitFor(() => h.runtime.status().pairing?.observed, "pairing observation");
  assert.deepEqual({ ...observed, observedAt: "x" }, { transportUserId: String(operator.id), chatId: String(operator.id), label: "Operator", username: "op", observedAt: "x" });
  const actor = h.runtime.confirmPairing(pairing.code);
  await waitFor(() => h.stub.messages.find(message => message.text.startsWith("Paired")), "paired notice");
  return actor.id;
}

/* -------------------------------------------------------------------------- */

test("a task blocked by its own agent shows the blocker on the phone, not a generic prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "telegram-blocked-"));
  const workspace = workspaces.create({ name: dir, workDirectory: dir });
  try {
    const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
    const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
    const prompt = workspaces.createChild("prompt", suite.id, { title: "Blocked task", content: "Do the thing" }) as PromptRecord;
    const runId = `tg-blocked-run-${workspace.id}`;
    workspaces.beginAgentRun({ runId, workspaceId: workspace.id, promptId: prompt.id, provider: "claude", model: null, tokenHash: runId, expiresAt: new Date(Date.now() + 60000).toISOString(), role: "execute" });
    workspaces.finishAgentRun(runId, "done");
    assert.equal(workspaces.promptActivity(prompt.id).item.prompt.status, "BLOCKED");

    const rendered = renderPersonalQuestion(prompt.id, []);
    assert.match(rendered.question, /without posting the required DONE or BLOCKED status/);
  } finally {
    workspaces.remove(workspace.id);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unconfigured install polls nothing: disabled, fake transport and missing token make no network call", async () => {
  const cases: Array<{ settings: Partial<TelegramRuntimeSettings>; token: "stub" | "none"; state: string }> = [
    { settings: { enabled: false }, token: "stub", state: "disabled" },
    { settings: { transport: "fake_telegram" }, token: "stub", state: "disabled" },
    { settings: {}, token: "none", state: "missing_token" },
  ];
  for (const entry of cases) {
    const h = harness({ settings: entry.settings, token: entry.token });
    try {
      await h.runtime.reconcile();
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(h.stub.calls.length, 0, `no Bot API calls for ${JSON.stringify(entry)}`);
      assert.equal(h.runtime.status().state, entry.state);
      assert.throws(() => h.runtime.startPairing(), /not connected/);
    } finally {
      await h.cleanup();
    }
  }
});

test("server start/stop: settings switch the live transport on and off, and stop aborts the long poll promptly", async () => {
  const h = harness({ settings: { enabled: false } });
  try {
    await h.runtime.reconcile();
    assert.equal(h.stub.calls.length, 0);

    h.settings.enabled = true;
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling" && h.stub.calls.some(call => call.method === "getUpdates"), "polling");
    const status = h.runtime.status();
    assert.deepEqual(status.bot, { id: String(h.stub.botUserId), username: "l1_stub_bot" });
    assert.equal(status.tokenConfigured, true);

    const started = Date.now();
    h.settings.transport = "fake_telegram";
    await h.runtime.reconcile();
    assert.ok(Date.now() - started < 1000, "an in-flight 25s long poll must be aborted, not awaited");
    assert.equal(h.runtime.status().state, "disabled");
    const callsAfterStop = h.stub.calls.length;
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(h.stub.calls.length, callsAfterStop, "no Bot API calls after stopping");
  } finally {
    await h.cleanup();
  }
});

test("live E2E over the stubbed Bot API: pair, post a question, reply, Save answer, then resume once", async () => {
  const h = harness();
  const f = fixture();
  let starts = 0;
  try {
    workspaces.addPipelineStep(f.prompt.id, { provider: "claude" });
    const suiteRun = workspaces.createPipelineRun({ id: `tg-live-suite-${f.workspace.id}`, suiteId: f.suite.id, workspaceId: f.workspace.id, playProvider: "claude", playModel: null });
    workspaces.updatePipelineRun(suiteRun.id, { state: "WAITING_HUMAN", currentPromptId: f.prompt.id });
    setPipelineStationStarter(async () => {
      starts++;
      const runId = `tg-live-resumed-${f.workspace.id}`;
      workspaces.beginAgentRun({ runId, workspaceId: f.workspace.id, promptId: f.prompt.id, provider: "claude", model: null, tokenHash: "test", expiresAt: new Date().toISOString() });
      return { runId };
    });

    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");

    // A wrong pairing code gets no reply; a group chat is refused.
    const pairingCode = h.runtime.startPairing().code;
    h.stub.send(stranger, { id: stranger.id, type: "private" }, "/start pair_guess_000000000000");
    h.stub.send(stranger, { id: -100123, type: "group" }, `/start ${pairingCode}`);
    await waitFor(() => h.stub.messages.find(message => message.chatId === "-100123"), "group refusal");
    assert.equal(h.runtime.status().pairing?.observed, null);
    assert.equal(h.stub.messages.some(message => message.chatId === String(stranger.id)), false);
    h.runtime.cancelPairing();
    const actorId = await pair(h);
    assert.deepEqual(h.runtime.status().actors.map(actor => actor.id), [actorId]);

    // The waiting task is posted once, asking for a reply rather than showing buttons.
    await f.askQuestion();
    const question = await waitFor(() => h.stub.messages.find(message => message.text.includes(f.title)), "question card");
    assert.equal(question.chatId, String(operator.id));
    assert.deepEqual(question.buttons, []);
    assert.match(question.text, /Reply to this message with your answer/);

    // Unenrolled users are ignored; ordinary messages are not instructions.
    h.stub.send(stranger, { id: stranger.id, type: "private" }, "do it", question.messageId);
    h.stub.send(operator, operatorChat, "just chatting");
    await waitFor(() => h.stub.messages.find(message => message.text.startsWith("To answer a task")), "help notice");
    assert.equal(h.stub.messages.some(message => message.chatId === String(stranger.id)), false);

    h.stub.send(operator, operatorChat, "Use directory.example", question.messageId);
    const answerCard = await waitFor(() => h.stub.messages.find(message => message.buttons.some(button => button.text === "Save answer")), "answer card");
    assert.match(answerCard.text, /Your answer:\nUse directory\.example/);

    // A stranger tapping the operator's button is rejected and the task is untouched.
    h.stub.tap(stranger, answerCard, "Save answer");
    await waitFor(() => h.stub.answered.find(entry => /Not applied/.test(entry.text)), "stranger rejection");
    assert.equal(workspaces.humanInputState(f.prompt.id).savedResponseId, null);

    h.stub.tap(operator, answerCard, "Save answer");
    await waitFor(() => h.stub.messages.find(message => message.text === "Done: Answer saved; task remains waiting."), "save receipt");
    assert.notEqual(workspaces.humanInputState(f.prompt.id).savedResponseId, null);
    assert.equal(starts, 0, "Save answer must not restart work");

    // The saved-answer revision is posted with a single resume button.
    const resumeCard = await waitFor(() => h.stub.messages.find(message => message.buttons.some(button => button.text === "Resume with saved answer")), "resume card");
    assert.match(resumeCard.text, /Saved answer:\nUse directory\.example/);
    h.stub.tap(operator, resumeCard, "Resume with saved answer");
    await waitFor(() => h.stub.messages.find(message => message.text === "Done: Answer saved and resume requested."), "resume receipt");
    h.stub.tap(operator, resumeCard, "Resume with saved answer");
    await waitFor(() => h.stub.answered.filter(entry => entry.text === "Already applied.").length === 1, "duplicate tap receipt");
    assert.equal(starts, 1, "a duplicate tap must not start a second run");

    // No token in logs, status DTO, outbox/inbox or anywhere in the database.
    const dump = new Database(join(config.repoRoot, ".agent-console/console.sqlite"), { readonly: true });
    try {
      const tables = dump.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
      const text = tables.map(table => JSON.stringify(dump.prepare(`SELECT * FROM "${table.name}"`).all())).join("\n");
      assert.ok(text.includes("Use directory.example"), "sanity: the dump covers task-control data");
      assert.equal(text.includes(h.stub.rawToken), false, "database leaked the token");
    } finally {
      dump.close();
    }
    assert.equal(JSON.stringify(h.runtime.status()).includes(h.stub.rawToken), false, "status leaked the token");
    assert.equal(h.logs.join("\n").includes(h.stub.rawToken), false, "logs leaked the token");
  } finally {
    setPipelineStationStarter(null);
    await h.cleanup();
    f.cleanup();
  }
});

test("taps processed after an outage are rejected as expired and the current question is reissued", async () => {
  let clock = Date.now();
  const h = harness({ now: () => clock });
  const f = fixture();
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    await pair(h);
    await f.askQuestion();
    const question = await waitFor(() => h.stub.messages.find(message => message.text.includes(f.title)), "question card");
    h.stub.send(operator, operatorChat, "Use directory.example", question.messageId);
    const answerCard = await waitFor(() => h.stub.messages.find(message => message.buttons.length > 0), "answer card");

    // Workstation goes offline; the operator taps; it comes back 20 minutes later.
    await h.runtime.stop();
    h.stub.tap(operator, answerCard, "Answer and resume");
    clock += 20 * 60_000;
    const realNow = Date.now;
    Date.now = () => clock; // TaskControlService checks expiry against wall time.
    try {
      await h.runtime.reconcile();
      await waitFor(() => h.stub.messages.find(message => message.text.startsWith("Not applied: This action expired")), "expiry receipt");
      const reissued = await waitFor(() => h.stub.messages.filter(message => message.text.includes(f.title)).length >= 3 && h.stub.messages.at(-1), "reissued question");
      assert.match(reissued.text, /Reply to this message with your answer/);
    } finally {
      Date.now = realNow;
    }
    assert.equal(workspaces.humanInputState(f.prompt.id).savedResponseId, null, "an expired tap changes nothing");
  } finally {
    await h.cleanup();
    f.cleanup();
  }
});

test("polling backs off on 429 and network failure without leaking the token, then reconnects from the durable offset", async () => {
  const h = harness();
  try {
    h.stub.script("getUpdates",
      { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } } },
      new TypeError(`fetch failed: https://api.telegram.org/bot${h.stub.rawToken}/getUpdates`, { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) }),
    );
    await h.runtime.reconcile();
    await waitFor(() => h.sleeps.includes(3000), "server-specified 429 backoff");
    await waitFor(() => h.runtime.status().lastError?.includes("network failure"), "network failure status");
    const failed = h.runtime.status();
    assert.equal(failed.state, "backoff");
    assert.notEqual(failed.nextRetryAt, null);

    h.stub.send(operator, operatorChat, "hello before pairing");
    h.stub.send(operator, operatorChat, "second");
    await waitFor(() => h.runtime.status().state === "polling" && workspaces.telegramCursor(h.botId) === 3, "recovered polling and advanced cursor");
    assert.deepEqual(workspaces.telegramInbox(h.botId).map(update => update.updateId), [1, 2]);
    assert.equal(h.runtime.status().lastError, null);

    // A restart resumes from the persisted offset instead of refetching.
    await h.runtime.stop();
    const before = h.stub.calls.length;
    await h.runtime.reconcile();
    const poll = await waitFor(() => h.stub.calls.slice(before).find(call => call.method === "getUpdates"), "poll after restart");
    assert.equal(poll.body.offset, 3);

    const everything = h.logs.join("\n") + JSON.stringify(h.runtime.status());
    assert.ok(h.logs.some(line => line.includes("ENOTFOUND")), "sanity: the failure was logged");
    assert.equal(everything.includes(h.stub.rawToken), false, "logs or status leaked the token");
  } finally {
    await h.cleanup();
  }
});

test("outbox retries honour Telegram retry_after, survive network failure, and do not retry permanent rejections", async () => {
  let clock = Date.now();
  const h = harness({ now: () => clock });
  try {
    h.stub.script("sendMessage",
      { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 30", parameters: { retry_after: 30 } } },
      new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }),
    );
    const retried = workspaces.enqueueTelegramOutbox({ botId: h.botId, chatId: "424242", payload: { kind: "text", text: "retry me" } });
    const queuedBehind = workspaces.enqueueTelegramOutbox({ botId: h.botId, chatId: "424242", payload: { kind: "text", text: "queued behind" } });
    await h.runtime.reconcile();

    const limited = await waitFor(() => workspaces.telegramOutbox().find(row => row.id === retried && row.state === "FAILED"), "rate-limited send");
    assert.match(limited.lastError ?? "", /429/);
    const due = workspaces.dueTelegramOutbox(h.botId, new Date(clock + 29_000));
    assert.equal(due.some(row => row.id === retried), false, "not retried before retry_after");
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(h.stub.calls.filter(call => call.method === "sendMessage").length, 1, "sending pauses for the whole bot while rate limited");
    assert.equal(workspaces.telegramOutbox().find(row => row.id === queuedBehind)!.state, "QUEUED");

    clock += 31_000;
    await waitFor(() => workspaces.telegramOutbox().find(row => row.id === retried && row.attemptCount === 2), "network failure attempt");
    assert.match(workspaces.telegramOutbox().find(row => row.id === retried)!.lastError ?? "", /ECONNRESET/);
    clock += 61_000;
    const sent = await waitFor(() => workspaces.telegramOutbox().find(row => row.id === retried && row.state === "SENT"), "eventual delivery");
    assert.equal(sent.attemptCount, 3);
    assert.equal(h.stub.messages.filter(message => message.text === "retry me").length, 1);
    await waitFor(() => workspaces.telegramOutbox().find(row => row.id === queuedBehind && row.state === "SENT"), "queued message delivered after the pause");

    h.stub.script("sendMessage", { status: 403, body: { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" } });
    const blocked = workspaces.enqueueTelegramOutbox({ botId: h.botId, chatId: "424243", payload: { kind: "text", text: "blocked" } });
    await waitFor(() => workspaces.telegramOutbox().find(row => row.id === blocked && row.state === "FAILED"), "permanent failure");
    clock += 24 * 60 * 60_000;
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(workspaces.telegramOutbox().find(row => row.id === blocked)!.attemptCount, 1, "a permanent rejection is not retried");
    assert.deepEqual(h.runtime.status().outbox, { queued: 0, retrying: 0, failed: 1 });
  } finally {
    await h.cleanup();
  }
});

test("a rejected bot token stops polling with a clear status instead of hammering Telegram", async () => {
  const h = harness();
  try {
    h.stub.script("getMe", { status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } });
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "auth_failed", "auth failure");
    assert.ok(h.sleeps.includes(5 * 60_000), "retries only after five minutes");
    assert.match(h.runtime.status().reason, /TELEGRAM_BOT_TOKEN/);
  } finally {
    await h.cleanup();
  }
});

test("remote actions disabled: a live tap is answered with a rejection, marked processed, and changes nothing", async () => {
  const h = harness();
  const f = fixture();
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    await pair(h);
    await f.askQuestion();
    const question = await waitFor(() => h.stub.messages.find(message => message.text.includes(f.title)), "question card");
    h.stub.send(operator, operatorChat, "Use directory.example", question.messageId);
    const answerCard = await waitFor(() => h.stub.messages.find(message => message.buttons.length > 0), "answer card");

    h.settings.remoteActionsEnabled = false;
    h.stub.tap(operator, answerCard, "Save answer");
    await waitFor(() => h.stub.answered.find(entry => entry.text === "Not applied: Remote task-control actions are disabled."), "disabled rejection");
    await waitFor(() => workspaces.pendingTelegramInbox(h.botId).length === 0, "inbox drained");
    assert.equal(workspaces.humanInputState(f.prompt.id).savedResponseId, null);
  } finally {
    await h.cleanup();
    f.cleanup();
  }
});

test("a reply to a superseded question card is refused, never rebound to the new question", async () => {
  const h = harness();
  const f = fixture();
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    await pair(h);
    await f.askQuestion();
    const first = await waitFor(() => h.stub.messages.find(message => message.text.includes(f.title)), "first question card");
    // The question changes (a newer handoff question), so the first card is superseded.
    await f.askQuestion();
    await waitFor(() => h.stub.messages.filter(message => message.text.includes(f.title)).length >= 2, "second question card");
    const sentBefore = h.stub.messages.length;
    h.stub.send(operator, operatorChat, "Answer written for the old question", first.messageId);
    await waitFor(() => h.stub.messages.find(message => message.text.startsWith("Not recorded: that question has changed")), "changed-question notice");
    assert.equal(h.stub.messages.slice(sentBefore).some(message => message.buttons.length > 0), false, "no answer card for the old reply");
    assert.equal(workspaces.humanInputState(f.prompt.id).savedResponseId, null);
  } finally {
    await h.cleanup();
    f.cleanup();
  }
});

test("S-L1-33 (T0): a reply polled before the card's sendMessage response still answers that card", async () => {
  const h = harness();
  const f = fixture();
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    await pair(h);
    h.stub.holdSendResponse = async (message) => {
      if (!message.text.includes(f.title)) return;
      h.stub.holdSendResponse = null;
      // The phone already shows the card: the reply is polled while this response is still on its way.
      const cursor = workspaces.telegramCursor(h.botId);
      h.stub.send(operator, operatorChat, "Use the March list", message.messageId);
      await waitFor(() => workspaces.telegramCursor(h.botId) > cursor, "the reply to be polled");
      // Give the poll loop time to hand the saved reply to the runtime before this response returns.
      await new Promise(resolve => setTimeout(resolve, 100));
    };
    await f.askQuestion();
    const answerCard = await waitFor(() => h.stub.messages.find(message => message.buttons.length > 0 && message.text.includes("Use the March list")), "answer card");
    assert.ok(answerCard);
    assert.equal(h.stub.messages.some(message => message.text.startsWith("That message is not a task question")), false);
  } finally {
    await h.cleanup();
    f.cleanup();
  }
});

test("unpairing ends the chat's outstanding buttons, and pairing again does not revive them", async () => {
  const h = harness();
  const f = fixture();
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    const actorId = await pair(h);
    await f.askQuestion();
    const question = await waitFor(() => h.stub.messages.find(message => message.text.includes(f.title)), "question card");
    h.stub.send(operator, operatorChat, "Keep the old list", question.messageId);
    const answerCard = await waitFor(() => h.stub.messages.find(message => message.buttons.some(button => button.text === "Save answer")), "answer card");
    h.runtime.removeActor(actorId);
    await waitFor(() => h.stub.messages.find(message => message.text.startsWith("This chat was unpaired")), "unpaired notice");
    await pair(h);
    h.stub.tap(operator, answerCard, "Save answer");
    await waitFor(() => h.stub.answered.find(entry => /^Not applied/.test(entry.text)), "rejection of the pre-unpair button");
    assert.equal(workspaces.humanInputState(f.prompt.id).savedResponseId, null, "a button issued before unpairing changes nothing");
  } finally {
    await h.cleanup();
    f.cleanup();
  }
});

/* ------------------------ L3 F2: topic-aware replies ----------------------- */
// Scenario IDs refer to docs/e2e-scenarios/l3-f1-f2.md. Topic-bound actors are created directly here
// (operator question 3): pairing cannot create one until C2 authorizes private-chat topics.

test("S-L3-F2-01 (T0): in a chat without topics every reply is sent without a thread id", async () => {
  const h = harness();
  const f = fixture();
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    await pair(h);
    await f.askQuestion();
    const question = await waitFor(() => h.stub.messages.find(message => message.text.includes(f.title)), "question card");
    h.stub.send(operator, operatorChat, "just chatting");
    h.stub.send(operator, operatorChat, "Use the list", question.messageId);
    const answerCard = await waitFor(() => h.stub.messages.find(message => message.buttons.some(button => button.text === "Save answer")), "answer card");
    h.stub.tap(operator, answerCard, "Save answer");
    await waitFor(() => h.stub.messages.find(message => message.text.startsWith("Done:")), "tap result");
    const sends = h.stub.calls.filter(call => call.method === "sendMessage");
    assert.ok(sends.length >= 5);
    assert.deepEqual(sends.filter(call => "message_thread_id" in call.body), []);
    assert.deepEqual(workspaces.telegramOutbox().filter(row => row.botId === h.botId && row.topicId !== null), []);
  } finally {
    await h.cleanup();
    f.cleanup();
  }
});

test("S-L3-F2-02/03 (T0): pairing refusals go to the topic the code was sent in, and General replies carry no thread id", async () => {
  const h = harness();
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    const forum = { id: -100777, type: "supergroup" };
    const code = h.runtime.startPairing().code;
    h.stub.send(operator, forum, `/start ${code}`, undefined, 11);
    const refusal = await waitFor(() => h.stub.messages.find(message => message.text.startsWith("Pair from a private chat")), "topic refusal");
    assert.equal(refusal.topicId, 11);
    h.stub.send(operator, forum, `/start ${code}`);
    await waitFor(() => h.stub.messages.filter(message => message.text.startsWith("Pair from a private chat")).length === 2, "General refusal");
    assert.equal(h.stub.messages.filter(message => message.text.startsWith("Pair from a private chat"))[1]!.topicId, null);
    assert.equal(h.runtime.status().pairing?.observed, null);
    assert.deepEqual(h.runtime.status().actors, []);
  } finally {
    await h.cleanup();
  }
});

test("S-L3-F2-04/06 (T0): a topic-bound actor gets every reply in its topic; a reply from another topic records nothing and sends nothing", async () => {
  const h = harness();
  const f = fixture();
  const forum = { id: -100888, type: "supergroup" };
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    workspaces.upsertTaskControlActor({ id: `telegram-${operator.id}-${forum.id}-7`, transport: "telegram", transportUserId: String(operator.id), chatId: String(forum.id), topicId: "7", label: "Operator" });
    await f.askQuestion();
    const question = await waitFor(() => h.stub.messages.find(message => message.text.includes(f.title)), "question card");
    assert.equal(question.topicId, 7);

    h.stub.send(operator, forum, "just chatting", undefined, 7);
    const hint = await waitFor(() => h.stub.messages.find(message => message.text.startsWith("To answer a task")), "hint");
    assert.equal(hint.topicId, 7);

    const before = h.stub.messages.length;
    h.stub.send(operator, forum, "From the wrong topic", question.messageId, 8);
    h.stub.send(operator, forum, "Use the list", question.messageId, 7);
    const answerCard = await waitFor(() => h.stub.messages.find(message => message.buttons.some(button => button.text === "Save answer")), "answer card");
    assert.equal(answerCard.topicId, 7);
    assert.match(answerCard.text, /Use the list/);
    assert.equal(h.stub.messages.slice(before).some(message => message.topicId !== 7), false, "nothing is sent outside topic 7");
    assert.equal(h.stub.messages.some(message => message.text.includes("From the wrong topic")), false);

    h.stub.tap(operator, answerCard, "Save answer");
    const result = await waitFor(() => h.stub.messages.find(message => message.text.startsWith("Done:")), "tap result");
    assert.equal(result.topicId, 7);
    assert.equal(workspaces.promptActivity(f.prompt.id).remarks.filter(remark => remark.kind === "HUMAN_RESPONSE" && remark.content === "Use the list").length, 1);
  } finally {
    await h.cleanup();
    f.cleanup();
  }
});

test("S-L3-F2-08 (T0): only true topic messages carry a topic id", async () => {
  const { normalizeTelegramUpdate } = await import("./integrations/telegram/httpBotApi.ts");
  const message = (extra: Record<string, unknown>) => normalizeTelegramUpdate({ update_id: 1, message: { message_id: 5, from: { id: 1, first_name: "A" }, chat: { id: -1001, type: "supergroup" }, text: "hi", ...extra } })!.payload as { topicId: string | null };
  assert.equal(message({ message_thread_id: 44 }).topicId, null, "a reply thread in a group without topics");
  assert.equal(message({ message_thread_id: 44, is_topic_message: true }).topicId, "44");
  assert.equal(message({}).topicId, null);
  const callback = normalizeTelegramUpdate({ update_id: 2, callback_query: { id: "q", from: { id: 1 }, data: "tc_x", message: { message_id: 5, chat: { id: -1001, type: "supergroup" }, message_thread_id: 9, is_topic_message: true } } })!.payload as { topicId: string | null };
  assert.equal(callback.topicId, "9");
});

test("S-L3-F2-09 (T0): a reply whose topic was closed or deleted is recorded failed once and never redirected", async () => {
  const h = harness();
  const forum = { id: -100999, type: "supergroup" };
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    workspaces.upsertTaskControlActor({ id: `telegram-${operator.id}-${forum.id}-5`, transport: "telegram", transportUserId: String(operator.id), chatId: String(forum.id), topicId: "5", label: "Operator" });
    for (const description of ["Bad Request: TOPIC_CLOSED", "Bad Request: message thread not found"]) {
      h.stub.script("sendMessage", { status: 400, body: { ok: false, error_code: 400, description } });
      const sendsBefore = h.stub.calls.filter(call => call.method === "sendMessage").length;
      h.stub.send(operator, forum, `hello ${description}`, undefined, 5);
      const failed = await waitFor(() => workspaces.telegramOutbox().find(row => row.botId === h.botId && row.state === "FAILED" && row.lastError?.includes(description.split(": ")[1]!)), "failed reply");
      await new Promise(resolve => setTimeout(resolve, 50));
      const sends = h.stub.calls.filter(call => call.method === "sendMessage").slice(sendsBefore);
      assert.equal(sends.length, 1, "one attempt, no redirect to General");
      assert.equal(sends[0]!.body.message_thread_id, 5);
      assert.equal(failed.attemptCount, 1);
      assert.equal(h.runtime.status().state, "polling");
    }
  } finally {
    await h.cleanup();
  }
});
