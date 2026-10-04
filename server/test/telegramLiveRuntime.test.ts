import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { config } from "../src/config.ts";
import { settings as appSettings } from "../src/settings.ts";
import { BotToken } from "../src/integrations/telegram/credentials.ts";
import { HttpTelegramBotApi } from "../src/integrations/telegram/httpBotApi.ts";
import { filePairedChatStore, type PairedChatStore } from "../src/integrations/telegram/pairedChats.ts";
import { TelegramLiveRuntime, type TelegramRuntimeSettings } from "../src/integrations/telegram/runtime.ts";
import { runDefinitionOfDoneCommands } from "../src/definitionOfDone.ts";
import { setPipelineStationStarter } from "../src/pipelineScheduler.ts";
import { renderPersonalQuestion } from "../src/taskControlRenderer.ts";
import { itemTag } from "../src/teamItems.ts";
import { BareGitTeamRosterRemote, decodeJoinCode, joinTeam, newTeamRoster, publishRoster, type TeamRoster } from "../src/teamRoster.ts";
import { defaultWorkstationLabel, taskTagFor } from "../src/telegramSummary.ts";
import { itemSubject, taskSubject, WORKSTATION_SUBJECT, WorkspaceError, workspaces } from "../src/workspaces.ts";

/* -------------------------------------------------------------------------- */
/* A stub Bot API: real HTTP client, fake api.telegram.org behind fetch        */
/* -------------------------------------------------------------------------- */

type Scripted = { status: number; body: Record<string, unknown> } | Error;
type User = { id: number; first_name: string; username?: string };
type RecordedMessage = { chatId: string; topicId: number | null; text: string; buttons: Array<{ text: string; data: string }>; messageId: number; replyToMessageId: number | null; edits: number };

class StubTelegram {
  readonly rawToken: string;
  readonly calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  readonly messages: RecordedMessage[] = [];
  readonly answered: Array<{ id: string; text: string }> = [];
  readonly pinned: Array<{ chatId: string; messageId: number }> = [];
  private updates: Array<Record<string, unknown>> = [];
  private nextUpdateId = 1;
  private nextMessageId = 500;
  private nextCallbackId = 1;
  private readonly scripts = new Map<string, Scripted[]>();
  private readonly upgraded = new Map<string, string>();
  private readonly refused = new Map<string, string>();
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

  /**
   * Telegram upgraded this basic group to a supergroup (B8): the old chat id now
   * answers every call with the 400 that names the new one, and the supergroup
   * receives the `migrate_from_chat_id` service message.
   */
  upgradeToSupergroup(fromChatId: string, toChatId: string): void {
    this.upgraded.set(fromChatId, toChatId);
  }

  /**
   * This chat refuses everything, for good: the bot was removed, or the group was
   * deleted. Unlike `script`, it never runs out, which is what a producer with no
   * bound runs into (B9).
   */
  refuseChat(chatId: string, description: string): void {
    this.refused.set(chatId, description);
  }

  /** The service message Telegram posts in the supergroup that replaced the group. */
  sendMigrationNotice(fromChatId: string, toChatId: string): void {
    this.push({ message: { message_id: this.nextMessageId++, chat: { id: Number(toChatId), type: "supergroup" }, from: { id: 777, first_name: "Telegram", is_bot: false }, date: 1, migrate_from_chat_id: Number(fromChatId) } });
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
    const refusal = body.chat_id === undefined ? undefined : this.refused.get(String(body.chat_id));
    if (refusal !== undefined) return json(400, { ok: false, error_code: 400, description: refusal });
    const migrateTo = body.chat_id === undefined ? undefined : this.upgraded.get(String(body.chat_id));
    if (migrateTo !== undefined) {
      return json(400, { ok: false, error_code: 400, description: "Bad Request: group chat was upgraded to a supergroup chat", parameters: { migrate_to_chat_id: Number(migrateTo) } });
    }
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
        const message = { chatId: String(body.chat_id), topicId: typeof body.message_thread_id === "number" ? body.message_thread_id : null, text: String(body.text), buttons: (markup?.inline_keyboard ?? []).flat().map(button => ({ text: button.text, data: button.callback_data })), messageId: this.nextMessageId++, replyToMessageId: typeof body.reply_to_message_id === "number" ? body.reply_to_message_id : null, edits: 0 };
        this.messages.push(message);
        const hold = this.holdSendResponse;
        if (hold !== null) await hold(message);
        return json(200, { ok: true, result: { message_id: message.messageId, chat: { id: Number(body.chat_id) }, date: 1, text: body.text } });
      }
      case "answerCallbackQuery":
        this.answered.push({ id: String(body.callback_query_id), text: String(body.text) });
        return json(200, { ok: true, result: true });
      case "editMessageText": {
        const target = this.messages.find(message => message.messageId === Number(body.message_id) && message.chatId === String(body.chat_id));
        if (!target) return json(400, { ok: false, error_code: 400, description: "Bad Request: message to edit not found" });
        if (target.text === String(body.text)) return json(400, { ok: false, error_code: 400, description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message" });
        target.text = String(body.text);
        target.edits += 1;
        return json(200, { ok: true, result: { message_id: target.messageId, chat: { id: Number(body.chat_id) }, date: 1, text: body.text } });
      }
      case "pinChatMessage":
        this.pinned.push({ chatId: String(body.chat_id), messageId: Number(body.message_id) });
        return json(200, { ok: true, result: true });
      case "getChatMember":
        return json(200, { ok: true, result: { status: "administrator", can_pin_messages: true, can_invite_users: true } });
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

function harness(options: {
  settings?: Partial<TelegramRuntimeSettings>;
  token?: "stub" | "none";
  now?: () => number;
  persistCredential?: (token: BotToken) => void;
  pairedChats?: PairedChatStore;
  /** The same bot across two harnesses is the same install started twice. */
  botUserId?: number;
} = {}) {
  const stub = new StubTelegram(options.botUserId ?? 7_000_000_000 + Math.floor(Math.random() * 1_000_000));
  const settings: TelegramRuntimeSettings = { enabled: true, teamEnabled: true, handoverEnabled: false, notificationsEnabled: true, remoteActionsEnabled: true, transport: "telegram", ...options.settings };
  const logs: string[] = [];
  const sleeps: number[] = [];
  const persisted: string[] = [];
  const log = (level: string) => (message: string, extra?: unknown) => { logs.push(`${level} ${message} ${extra === undefined ? "" : String(extra)}`); };
  const runtime = new TelegramLiveRuntime({
    settings: () => settings,
    credential: { token: options.token === "none" ? null : BotToken.parse(stub.rawToken), problem: null },
    createApi: (token, contentForRef) => new HttpTelegramBotApi({ token, contentForRef, fetch: stub.fetch }),
    persistCredential: options.persistCredential ?? (token => { persisted.push(token.reveal()); }),
    ...(options.pairedChats === undefined ? {} : { pairedChats: options.pairedChats }),
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
    stub, settings, logs, sleeps, persisted, runtime, botId,
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
  // Upstream's end-of-run ladder records UNREPORTED, not BLOCKED, when a run ends
  // without posting a status, so the block this fixture answers is posted explicitly.
  workspaces.updateAgentStatus(runId, {
    requestId: `blocked-${runId}`, expectedStatus: "IN_PROGRESS", status: "BLOCKED",
    reason: "The owner must supply the trade directory.",
    verificationSummary: "Supply the owner's trade directory.",
  });
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

test("a run that ended without posting a status shows that reason on the phone, not a generic prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "telegram-blocked-"));
  const workspace = workspaces.create({ name: dir, workDirectory: dir });
  try {
    const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
    const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
    const prompt = workspaces.createChild("prompt", suite.id, { title: "Blocked task", content: "Do the thing" }) as PromptRecord;
    const runId = `tg-blocked-run-${workspace.id}`;
    workspaces.beginAgentRun({ runId, workspaceId: workspace.id, promptId: prompt.id, provider: "claude", model: null, tokenHash: runId, expiresAt: new Date(Date.now() + 60000).toISOString(), role: "execute" });
    workspaces.finishAgentRun(runId, "done");
    // UNREPORTED, not BLOCKED: upstream stopped treating "the run said nothing" as a
    // verdict on the work. The point of this test is unchanged - the phone shows the
    // real reason rather than a bland prompt.
    assert.equal(workspaces.promptActivity(prompt.id).item.prompt.status, "UNREPORTED");

    const rendered = renderPersonalQuestion(prompt.id, []);
    assert.match(rendered.question, /without posting a status/);
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

test("a token configured from the UI is validated, persisted and connected without a restart", async () => {
  const h = harness({ token: "none" });
  try {
    assert.equal(h.runtime.status().state, "missing_token");
    await h.runtime.configureToken(`  ${h.stub.rawToken}  `);
    await waitFor(() => h.runtime.status().state === "polling", "configured bot polling");
    assert.deepEqual(h.persisted, [h.stub.rawToken]);
    assert.deepEqual(h.runtime.status().bot, { id: String(h.stub.botUserId), username: "l1_stub_bot" });
    assert.equal(h.runtime.status().tokenConfigured, true);
  } finally {
    await h.cleanup();
  }
});

test("a rejected UI token neither persists nor replaces the missing-token state", async () => {
  const h = harness({ token: "none" });
  try {
    h.stub.script("getMe", { status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } });
    await assert.rejects(
      h.runtime.configureToken(h.stub.rawToken),
      (error: unknown) => error instanceof WorkspaceError && error.code === "telegram_token_rejected",
    );
    assert.deepEqual(h.persisted, []);
    assert.equal(h.runtime.status().state, "missing_token");
    assert.equal(h.runtime.status().tokenConfigured, false);
  } finally {
    await h.cleanup();
  }
});

test("a credential write failure leaves the existing bot connected and hides local paths", async () => {
  const h = harness({
    persistCredential: () => { throw new Error("write failed at /private/operator/path"); },
  });
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "existing bot polling");

    await assert.rejects(
      h.runtime.configureToken(h.stub.rawToken),
      (error: unknown) => error instanceof WorkspaceError
        && error.code === "telegram_credential_write_failed"
        && !error.message.includes("/private/operator/path"),
    );

    assert.equal(h.runtime.status().state, "polling");
    assert.equal(h.runtime.status().tokenConfigured, true);
  } finally {
    await h.cleanup();
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
    // The rail as the app builds one: a suite run is a stage of a named
    // pipeline run, and the parked station is a step of that pipeline. A
    // free-standing suite run has no enabled steps, so nothing is ever ready to
    // resume onto.
    const flowchart = workspaces.createPipeline({ workspaceId: f.workspace.id, name: `Flowchart ${f.workspace.id}`, suiteIds: [f.suite.id] });
    workspaces.addNamedPipelineStep(flowchart.id, f.prompt.id, { provider: "claude" });
    const namedRun = workspaces.createNamedPipelineRun({ id: `tg-live-named-${f.workspace.id}`, pipelineId: flowchart.id, workspaceId: f.workspace.id, playProvider: "claude", playModel: null });
    const suiteRun = workspaces.createPipelineRun({ id: `tg-live-suite-${f.workspace.id}`, suiteId: f.suite.id, workspaceId: f.workspace.id, playProvider: "claude", playModel: null, pipelineRunId: namedRun.id });
    workspaces.updatePipelineRun(suiteRun.id, { state: "WAITING_HUMAN", currentPromptId: f.prompt.id });
    workspaces.updateNamedPipelineRun(namedRun.id, { state: "WAITING_HUMAN", currentSuiteId: f.suite.id, currentSuiteRunId: suiteRun.id });
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
    await waitFor(() => h.stub.messages.find(message => message.text.startsWith("Done: Answer saved; task remains waiting.")), "save receipt");
    assert.notEqual(workspaces.humanInputState(f.prompt.id).savedResponseId, null);
    assert.equal(starts, 0, "Save answer must not restart work");

    // The saved-answer revision is posted with a single resume button.
    const resumeCard = await waitFor(() => h.stub.messages.find(message => message.buttons.some(button => button.text === "Resume with saved answer")), "resume card");
    assert.match(resumeCard.text, /Saved answer:\nUse directory\.example/);
    h.stub.tap(operator, resumeCard, "Resume with saved answer");
    await waitFor(() => h.stub.messages.find(message => message.text.startsWith("Done: Answer saved and resume requested.")), "resume receipt");
    h.stub.tap(operator, resumeCard, "Resume with saved answer");
    await waitFor(() => h.stub.answered.filter(entry => entry.text === "Already applied.").length === 1, "duplicate tap receipt");
    assert.equal(starts, 1, "a duplicate tap must not start a second run");

    // No token in logs, status DTO, outbox/inbox or anywhere in the database.
    const dump = new Database(workspaces.databasePath, { readonly: true });
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

/**
 * A station its pipeline stopped on without the agent asking anything.
 *
 * The item is where a failing `## Verify` command leaves it, NEEDS_REVIEW, which
 * is also where it sits between two automatic retries. What tells the two apart
 * is the pipeline run, so the run's state is the fixture's argument.
 */
async function stuckFixture(run: { state: "PLAYING" | "WAITING_HUMAN" | "STOPPED" | "INTERRUPTED"; waitReason?: string; stopReason?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "telegram-stuck-"));
  const workspace = workspaces.create({ name: dir, workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
  const title = `Assess the vendor sample ${workspace.id}`;
  const prompt = workspaces.createChild("prompt", suite.id, { title, content: "Assess it.\n\n## Verify\n\n```sh\nexit 1\n```\n" }) as PromptRecord;
  const runId = `tg-stuck-run-${workspace.id}`;
  workspaces.beginAgentRun({ runId, workspaceId: workspace.id, promptId: prompt.id, provider: "claude", model: null, tokenHash: runId, expiresAt: new Date(Date.now() + 60000).toISOString(), role: "execute" });
  workspaces.finishAgentRun(runId, "done");
  await runDefinitionOfDoneCommands(prompt.id, null);
  workspaces.completePrompt(prompt.id, "SYSTEM", { verificationSummary: "done" });
  assert.equal(workspaces.promptActivity(prompt.id).item.prompt.status, "NEEDS_REVIEW");

  const flowchart = workspaces.createPipeline({ workspaceId: workspace.id, name: `Flowchart ${workspace.id}`, suiteIds: [suite.id] });
  workspaces.addNamedPipelineStep(flowchart.id, prompt.id, { provider: "claude" });
  const namedRun = workspaces.createNamedPipelineRun({ id: `tg-stuck-named-${workspace.id}`, pipelineId: flowchart.id, workspaceId: workspace.id, playProvider: "claude", playModel: null });
  const suiteRun = workspaces.createPipelineRun({ id: `tg-stuck-suite-${workspace.id}`, suiteId: suite.id, workspaceId: workspace.id, playProvider: "claude", playModel: null, pipelineRunId: namedRun.id });
  const endedAt = run.state === "STOPPED" || run.state === "INTERRUPTED" ? new Date().toISOString() : null;
  workspaces.updatePipelineRun(suiteRun.id, { state: run.state, currentPromptId: prompt.id, waitReason: run.waitReason ?? null, stopReason: run.stopReason ?? null, endedAt });
  workspaces.updateNamedPipelineRun(namedRun.id, { state: run.state, currentSuiteId: suite.id, currentSuiteRunId: suiteRun.id, stopReason: run.stopReason ?? null, endedAt });
  return {
    workspace, suite, prompt, title, suiteRun,
    cleanup() { workspaces.remove(workspace.id); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("a pipeline that gave up on a station reaches the phone, and the reply resumes it", async () => {
  // The stop that was silent: four continuations ran out on a failing Verify
  // command, the pipeline parked, and the item was never BLOCKED, so no card.
  const h = harness();
  const f = await stuckFixture({ state: "WAITING_HUMAN", waitReason: "continuations_exhausted" });
  let starts = 0;
  try {
    setPipelineStationStarter(async () => {
      starts++;
      const runId = `tg-stuck-resumed-${f.workspace.id}`;
      workspaces.beginAgentRun({ runId, workspaceId: f.workspace.id, promptId: f.prompt.id, provider: "claude", model: null, tokenHash: "test", expiresAt: new Date().toISOString() });
      return { runId };
    });
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    await pair(h);

    const card = await waitFor(() => h.stub.messages.find(message => message.text.includes(f.title)), "card for the parked station");
    assert.match(card.text, /definition of done was not satisfied/i, "the card says why the station stopped");
    assert.match(card.text, /Reply to this message with your answer/);

    h.stub.send(operator, operatorChat, "The check is wrong, skip it and finish", card.messageId);
    const answerCard = await waitFor(() => h.stub.messages.find(message => message.buttons.some(button => button.text === "Answer and resume")), "answer card");
    h.stub.tap(operator, answerCard, "Answer and resume");
    await waitFor(() => h.stub.messages.find(message => message.text.startsWith("Done: Answer saved and resume requested.")), "resume receipt");
    assert.equal(starts, 1, "the station restarted once");
    assert.equal(workspaces.pipelineById(f.suiteRun.id)?.state, "PLAYING");
    assert.equal(workspaces.promptActivity(f.prompt.id).remarks.some(remark => remark.kind === "HUMAN_RESPONSE" && remark.content === "The check is wrong, skip it and finish"), true, "the reply is on the item for the next run to read");
  } finally {
    setPipelineStationStarter(null);
    await h.cleanup();
    f.cleanup();
  }
});

test("a station the pipeline gave up on still reaches the phone after the server is restarted", async () => {
  // What a restart does to a parked run: it is no longer WAITING_HUMAN but
  // INTERRUPTED by `server_restart`, with the reason it was parked still on it.
  // The boot-time resume cannot move it, because the station is not ready, so it
  // is exactly as stuck as before and the operator is still the only way out.
  const h = harness();
  const f = await stuckFixture({ state: "WAITING_HUMAN", waitReason: "continuations_exhausted" });
  let starts = 0;
  try {
    workspaces.interruptPipelinesOnRestart();
    const restarted = workspaces.pipelineById(f.suiteRun.id);
    assert.deepEqual([restarted?.state, restarted?.stopReason, restarted?.waitReason], ["INTERRUPTED", "server_restart", "continuations_exhausted"]);

    setPipelineStationStarter(async () => {
      starts++;
      const runId = `tg-stuck-restarted-${f.workspace.id}`;
      workspaces.beginAgentRun({ runId, workspaceId: f.workspace.id, promptId: f.prompt.id, provider: "claude", model: null, tokenHash: "test", expiresAt: new Date().toISOString() });
      return { runId };
    });
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    await pair(h);

    const card = await waitFor(() => h.stub.messages.find(message => message.text.includes(f.title)), "card for the station parked before the restart");
    h.stub.send(operator, operatorChat, "Carry on without that check", card.messageId);
    const answerCard = await waitFor(() => h.stub.messages.find(message => message.buttons.some(button => button.text === "Answer and resume")), "answer card");
    h.stub.tap(operator, answerCard, "Answer and resume");
    await waitFor(() => h.stub.messages.find(message => message.text.startsWith("Done: Answer saved and resume requested.")), "resume receipt");
    assert.equal(starts, 1, "the station restarted once");
    assert.equal(workspaces.pipelineById(f.suiteRun.id)?.state, "PLAYING", "the same run carries on");
  } finally {
    setPipelineStationStarter(null);
    await h.cleanup();
    f.cleanup();
  }
});

test("a pipeline that could not start a station reaches the phone, and the reply plays it again", async () => {
  const h = harness();
  const f = await stuckFixture({ state: "STOPPED", stopReason: "unexpected_status:IN_PROGRESS" });
  let starts = 0;
  try {
    setPipelineStationStarter(async () => {
      starts++;
      const runId = `tg-stuck-replayed-${f.workspace.id}`;
      workspaces.beginAgentRun({ runId, workspaceId: f.workspace.id, promptId: f.prompt.id, provider: "claude", model: null, tokenHash: "test", expiresAt: new Date().toISOString() });
      return { runId };
    });
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    await pair(h);

    const card = await waitFor(() => h.stub.messages.find(message => message.text.includes(f.title)), "card for the stopped station");
    h.stub.send(operator, operatorChat, "Run it again", card.messageId);
    const answerCard = await waitFor(() => h.stub.messages.find(message => message.buttons.some(button => button.text === "Answer and resume")), "answer card");
    h.stub.tap(operator, answerCard, "Answer and resume");
    await waitFor(() => h.stub.messages.find(message => message.text.startsWith("Done: Answer saved and resume requested.")), "resume receipt");
    assert.equal(starts, 1, "the station started once");
  } finally {
    setPipelineStationStarter(null);
    await h.cleanup();
    f.cleanup();
  }
});

test("only a station nobody but the operator can move counts as waiting on them", async () => {
  const cases: Array<{ run: Parameters<typeof stuckFixture>[0]; waiting: boolean }> = [
    { run: { state: "WAITING_HUMAN", waitReason: "continuations_exhausted" }, waiting: true },
    { run: { state: "WAITING_HUMAN", waitReason: "station_rule_wait" }, waiting: true },
    { run: { state: "WAITING_HUMAN", waitReason: "no_provider_available" }, waiting: true },
    { run: { state: "STOPPED", stopReason: "start_failed" }, waiting: true },
    { run: { state: "STOPPED", stopReason: "no_provider" }, waiting: true },
    { run: { state: "STOPPED", stopReason: "unexpected_status:IN_PROGRESS" }, waiting: true },
    // A restart relabels a parked run; it is no less stuck for that.
    { run: { state: "INTERRUPTED", stopReason: "server_restart", waitReason: "continuations_exhausted" }, waiting: true },
    // A run the restart caught mid-flight is the boot-time resume's to pick up.
    { run: { state: "INTERRUPTED", stopReason: "server_restart" }, waiting: false },
    // Between two automatic retries the item is NEEDS_REVIEW too, and a card
    // there would ask the operator about work that is about to carry on.
    { run: { state: "PLAYING" }, waiting: false },
    // A reviewer is still deciding; it settles by itself.
    { run: { state: "WAITING_HUMAN", waitReason: "review_running" }, waiting: false },
    // Stops the operator or a station rule asked for.
    { run: { state: "STOPPED", stopReason: "operator_stop" }, waiting: false },
    { run: { state: "STOPPED", stopReason: "on_done_stop" }, waiting: false },
  ];
  for (const { run, waiting } of cases) {
    const f = await stuckFixture(run);
    const label = `${run.state} ${run.waitReason ?? run.stopReason ?? ""}`.trim();
    try {
      assert.equal(workspaces.promptsAwaitingResponse().some(prompt => prompt.id === f.prompt.id), waiting, label);
      if (!waiting) {
        assert.throws(
          () => workspaces.respondToBlockedPrompt(f.prompt.id, { content: "an answer nobody asked for" }),
          (error: unknown) => error instanceof WorkspaceError && error.code === "prompt_not_blocked",
          `${label}: an answer is still refused`,
        );
      }
    } finally {
      f.cleanup();
    }
  }
});

test("a station stopped with no remark to quote gets a sentence for its own reason", () => {
  // A station that could not be started has run nothing, so nothing left a
  // remark; the card must still say more than "needs your input".
  const dir = mkdtempSync(join(tmpdir(), "telegram-stuck-"));
  const workspace = workspaces.create({ name: dir, workDirectory: dir });
  try {
    const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
    const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
    const prompt = workspaces.createChild("prompt", suite.id, { title: `Never started ${workspace.id}`, content: "Do it." }) as PromptRecord;
    const suiteRun = workspaces.createPipelineRun({ id: `tg-stuck-bare-${workspace.id}`, suiteId: suite.id, workspaceId: workspace.id, playProvider: "claude", playModel: null });
    workspaces.updatePipelineRun(suiteRun.id, { state: "STOPPED", currentPromptId: prompt.id, stopReason: "start_failed", endedAt: new Date().toISOString() });
    assert.equal(workspaces.pipelineStuckOn(prompt.id), "start_failed");
    assert.match(renderPersonalQuestion(prompt.id, []).question, /could not be started\. Reply to try again\./);
    workspaces.updatePipelineRun(suiteRun.id, { state: "WAITING_HUMAN", waitReason: "no_provider_available", stopReason: null, endedAt: null });
    assert.match(renderPersonalQuestion(prompt.id, []).question, /No provider could run this task/);
  } finally {
    workspaces.remove(workspace.id);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a start with nobody paired opens a pairing, and a chat paired once is put back on a database that never saw it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "telegram-paired-"));
  const store = filePairedChatStore(join(dir, "telegram-paired-chats.json"));
  const botUserId = 7_100_000_000 + Math.floor(Math.random() * 1_000_000);
  assert.deepEqual(workspaces.taskControlActors("telegram"), [], "sanity: no chat is paired before this test");
  try {
    // First start: nobody to talk to, so the server asks, on the screen that started it.
    const first = harness({ pairedChats: store, botUserId });
    try {
      await first.runtime.reconcile();
      const opened = await waitFor(() => first.runtime.status().pairing, "a pairing opened at start");
      assert.equal(opened.deepLink, `https://t.me/l1_stub_bot?start=${opened.code}`);
      assert.equal(first.logs.some(line => line.startsWith("warn ") && line.includes(opened.deepLink!)), true, "the link is in the server log");
      first.stub.send(operator, operatorChat, `/start ${opened.code}`);
      await waitFor(() => first.runtime.status().pairing?.observed, "pairing observation");
      first.runtime.confirmPairing(opened.code);
      assert.deepEqual(store.read(), { botId: first.botId, chats: [{ transportUserId: String(operator.id), chatId: String(operator.id), topicId: null, label: "Operator" }] });
      assert.equal(statSync(join(dir, "telegram-paired-chats.json")).mode & 0o777, 0o600, "the file is readable by its owner only");
    } finally {
      // Deletes the actor rows without unpairing: what a new database looks like.
      await first.cleanup();
    }
    assert.deepEqual(workspaces.taskControlActors("telegram"), []);

    // Second start of the same bot: the chat is back and is told so.
    const second = harness({ pairedChats: store, botUserId });
    try {
      await second.runtime.reconcile();
      const hello = await waitFor(() => second.stub.messages.find(message => message.text.startsWith("This workstation has started")), "the started message");
      assert.equal(hello.chatId, String(operator.id));
      assert.equal(second.runtime.status().pairing, null, "no pairing is opened when a chat is connected");
      const [actor] = second.runtime.status().actors;
      assert.equal(actor?.chatId, String(operator.id));

      // Unpairing is remembered too, or the next start would undo it.
      second.runtime.removeActor(actor!.id);
      assert.deepEqual(store.read(), { botId: second.botId, chats: [] });
    } finally {
      await second.cleanup();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a paired-chat file that cannot be written does not fail the pairing", async () => {
  assert.deepEqual(workspaces.taskControlActors("telegram"), [], "sanity: no chat is paired before this test");
  const h = harness({ pairedChats: { read: () => null, write: () => { throw new Error("disk full"); } } });
  try {
    await h.runtime.reconcile();
    const opened = await waitFor(() => h.runtime.status().pairing, "a pairing opened at start");
    h.stub.send(operator, operatorChat, `/start ${opened.code}`);
    await waitFor(() => h.runtime.status().pairing?.observed, "pairing observation");
    h.runtime.confirmPairing(opened.code);
    assert.equal(h.runtime.status().actors.length, 1, "the chat is paired all the same");
    assert.equal(h.logs.some(line => line.startsWith("warn ") && line.includes("could not save the paired chats: disk full")), true);
  } finally {
    await h.cleanup();
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
    assert.match(h.runtime.status().reason, /Telegram setup screen/);
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

test("S-L1-33 (T0): a tap polled before the answer card's sendMessage response still applies to that card", async () => {
  const h = harness();
  const f = fixture();
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    await pair(h);
    await f.askQuestion();
    const card = await waitFor(() => h.stub.messages.find(message => message.text.includes(f.title)), "question card");
    h.stub.holdSendResponse = async (message) => {
      if (!message.buttons.some(button => button.text === "Save answer")) return;
      h.stub.holdSendResponse = null;
      // The answer card's buttons are not bound to its message id until this response returns.
      const cursor = workspaces.telegramCursor(h.botId);
      h.stub.tap(operator, message, "Save answer");
      await waitFor(() => workspaces.telegramCursor(h.botId) > cursor, "the tap to be polled");
      await new Promise(resolve => setTimeout(resolve, 100));
    };
    h.stub.send(operator, operatorChat, "Use the April list", card.messageId);
    await waitFor(() => h.stub.messages.find(message => /^(Done|Not applied): /.test(message.text)), "tap result");
    assert.deepEqual(h.stub.messages.filter(message => /^(Done|Not applied): /.test(message.text)).map(message => message.text.split("\n")[0]), ["Done: Answer saved; task remains waiting."]);
    assert.notEqual(workspaces.humanInputState(f.prompt.id).savedResponseId, null);
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
  const { normalizeTelegramUpdate } = await import("../src/integrations/telegram/httpBotApi.ts");
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

/* ------------------------------ L3 C1: threads ----------------------------- */

test("S-L3-C1-01 (T0): one thread per subject, resolved to the chat with no topic, recorded on every message it sends", () => {
  const botId = `telegram-threads-${Date.now()}`;
  try {
    const first = workspaces.telegramThreadFor({ botId, chatId: "4242", subject: taskSubject(77) });
    const again = workspaces.telegramThreadFor({ botId, chatId: "4242", subject: taskSubject(77) });
    const workstation = workspaces.telegramThreadFor({ botId, chatId: "4242", subject: WORKSTATION_SUBJECT });
    const otherChat = workspaces.telegramThreadFor({ botId, chatId: "4343", subject: taskSubject(77) });
    assert.equal(again.id, first.id, "the same subject always resolves to the same thread");
    assert.notEqual(workstation.id, first.id);
    assert.notEqual(otherChat.id, first.id, "a subject is scoped to its chat");
    // Topics are unavailable to this bot, so every subject resolves to the paired chat itself.
    assert.deepEqual(workspaces.telegramThreads(botId).map(thread => thread.topicId), [null, null, null]);
    assert.deepEqual(workspaces.telegramThreads(botId).map(thread => thread.state), ["ACTIVE", "ACTIVE", "ACTIVE"]);

    const withSubject = workspaces.enqueueTelegramOutbox({ botId, chatId: "4242", payload: { kind: "text", text: "about the task" }, subject: taskSubject(77) });
    // A row queued without a subject is still queued and sent: the L1 rows keep working.
    const without = workspaces.enqueueTelegramOutbox({ botId, chatId: "4242", payload: { kind: "text", text: "no subject" } });
    assert.equal(workspaces.telegramOutboxRow(withSubject)?.replyToMessageId, null, "no anchor yet, so nothing to reply to");
    assert.equal(workspaces.telegramOutboxRow(without)?.state, "QUEUED");
    assert.deepEqual(workspaces.dueTelegramOutbox(botId, new Date()).map(row => row.id), [withSubject, without]);
  } finally {
    workspaces.removeTelegramRecordsForBot(botId);
  }
});

test("S-L3-C1-02/03 (T0): every message about a task carries its tag and replies to the task's anchor card", async () => {
  const h = harness();
  const f = fixture();
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    await pair(h);
    await f.askQuestion();
    const card = await waitFor(() => h.stub.messages.find(message => message.text.includes(f.title)), "question card");
    const tag = taskTagFor(f.prompt.id)!;
    assert.equal(card.text.split("\n")[0], tag, "A2 renders the tag as the card header; C1 reuses that function");
    assert.equal(card.replyToMessageId, null, "the anchor itself replies to nothing");

    // The card is the task's anchor, and nothing about the task stacks outside its thread.
    const thread = workspaces.telegramThreads(h.botId).find(entry => entry.subjectKind === "task" && entry.subjectId === String(f.prompt.id))!;
    assert.equal(workspaces.telegramOutboxRow(thread.statusMessageId!)?.payload && true, true);

    h.stub.send(operator, operatorChat, "Use the list", card.messageId);
    const answerCard = await waitFor(() => h.stub.messages.find(message => message.buttons.some(button => button.text === "Save answer")), "answer card");
    assert.equal(answerCard.replyToMessageId, card.messageId, "a later card quotes the anchor");
    h.stub.tap(operator, answerCard, "Save answer");
    const result = await waitFor(() => h.stub.messages.find(message => message.text.startsWith("Done:")), "tap result");
    assert.equal(result.text, `Done: Answer saved; task remains waiting.\n${tag}`);
    assert.equal(result.replyToMessageId, card.messageId);
    assert.equal(result.edits, 0, "the record of what was decided is its own message, never an edit of the anchor");
    assert.equal(card.edits, 0, "the anchor is never overwritten by a later message");

    // A message that is not about a task carries no tag and is not addressed to the task's anchor.
    h.stub.send(operator, operatorChat, "just chatting");
    const help = await waitFor(() => h.stub.messages.find(message => message.text.startsWith("To answer a task")), "help view");
    assert.equal(help.text.includes(tag), false);
    assert.equal(help.replyToMessageId, null);
  } finally {
    await h.cleanup();
    f.cleanup();
  }
});

test("S-L3-C1-04 (T0): the control panel is pinned once, edited in place, and registered again after the operator deletes it", async () => {
  const h = harness();
  const f = fixture();
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    await pair(h);
    assert.equal(h.runtime.status().topics.available, false, "the panel says topics are not available for this bot");

    h.stub.send(operator, operatorChat, "/status");
    const panel = await waitFor(() => h.stub.messages.find(message => message.text.startsWith("Status ·")), "control panel");
    await waitFor(() => h.stub.pinned.length === 1 && h.stub.pinned[0]!.messageId === panel.messageId, "the panel pinned once");

    // A later /status keeps that one panel current in place; the pin is never repeated.
    await f.askQuestion();
    await waitFor(() => h.stub.messages.find(message => message.text.includes(f.title)), "question card");
    h.stub.send(operator, operatorChat, "/status");
    await waitFor(() => panel.edits === 1, "the pinned panel edited in place");
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(h.stub.pinned.length, 1, "editing rather than resending is what avoids pin churn");

    // The operator deletes the panel: its edit fails once, is not retried, and the next /status registers a new one.
    const botThread = () => workspaces.telegramThreads(h.botId).find(thread => thread.subjectKind === "workstation")!;
    assert.equal(botThread().statusMessageId !== null, true);
    h.stub.script("editMessageText", { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: message to edit not found" } });
    h.stub.send(operator, operatorChat, "/status");
    const failed = await waitFor(() => workspaces.telegramOutbox().find(row => row.botId === h.botId && row.state === "FAILED" && row.lastError?.includes("message to edit not found")), "failed edit");
    assert.equal(failed.attemptCount, 1, "F1 records a deleted target failed without retry");
    await waitFor(() => botThread().state === "ANCHOR_GONE", "the registry gives up on the deleted anchor");

    h.stub.send(operator, operatorChat, "/status");
    await waitFor(() => h.stub.pinned.length === 2, "the new panel pinned once");
    const replacement = h.stub.messages.filter(message => message.text.startsWith("Status ·")).at(-1)!;
    assert.equal(h.stub.pinned[1]!.messageId, replacement.messageId);
    assert.notEqual(replacement.messageId, panel.messageId);
    assert.equal(botThread().state, "ACTIVE");
    assert.equal(h.runtime.status().state, "polling", "a refused edit is not an outage");
  } finally {
    await h.cleanup();
    f.cleanup();
  }
});

test("S-L3-C1-04 (T0): a pin Telegram refuses is attempted once and never holds up the message", async () => {
  const h = harness();
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    await pair(h);
    h.stub.script("pinChatMessage", { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: not enough rights to pin a message" } });
    h.stub.send(operator, operatorChat, "/status");
    const panel = await waitFor(() => h.stub.messages.find(message => message.text.startsWith("Status ·")), "control panel");
    await waitFor(() => workspaces.telegramThreads(h.botId).find(thread => thread.subjectKind === "workstation")?.state === "ACTIVE", "the pin attempted");
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(h.stub.calls.filter(call => call.method === "pinChatMessage").length, 1, "a refused pin is never retried");
    assert.equal(h.stub.pinned.length, 0);
    assert.equal(panel.text.startsWith("Status ·"), true, "the panel itself stands");
    assert.equal(workspaces.telegramOutbox().some(row => row.botId === h.botId && row.state === "FAILED"), false, "the message did not fail with the pin");
    assert.equal(h.runtime.status().state, "polling");
  } finally {
    await h.cleanup();
  }
});

test("TM-T1-1a (T0 part): team creation observes the group command, verifies rights, confirms locally and writes the roster", async () => {
  const h = harness();
  const remote = mkdtempSync(join(tmpdir(), "team-create-remote-"));
  const cache = join(config.repoRoot, ".agent-console", "team");
  try {
    execFileSync("git", ["init", "--bare", "-q", remote]);
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    await pair(h);
    const pending = h.runtime.startTeamCreate(remote);
    h.stub.send(operator, { id: -1001, type: "supergroup" }, `/team ${pending.code}`);
    await waitFor(() => h.runtime.teamCreateStatus()?.observed === true, "team group observation");
    const result = await h.runtime.confirmTeamCreate();
    assert.match(result.teamId, /^awt1_/);
    assert.match(result.joinCode, /^awj1\./);
    assert.equal(workspaces.teamRoster(result.teamId)?.groupChatId, "-1001");
    assert.equal(workspaces.taskControlActorFor({ transport: "telegram", transportUserId: String(operator.id), chatId: "-1001", topicId: "__team_group__" })?.enabled, 1);
  } finally {
    await h.cleanup();
    rmSync(remote, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* B1: a created team's join code cannot be recovered.                          */
/* -------------------------------------------------------------------------- */

/** Creates a team the way the panel does, and hands back what creation returned once. */
async function createdTeam(h: ReturnType<typeof harness>, groupChatId: string, remoteDirectory: string) {
  await h.runtime.reconcile();
  await waitFor(() => h.runtime.status().state === "polling", "polling");
  await pair(h);
  const pending = h.runtime.startTeamCreate(remoteDirectory);
  h.stub.send(operator, { id: Number(groupChatId), type: "supergroup" }, `/team ${pending.code}`);
  await waitFor(() => h.runtime.teamCreateStatus()?.observed === true, "team group observation");
  return h.runtime.confirmTeamCreate();
}

test("B1 (T0): a created team whose join code was lost issues a fresh one, and the fresh code joins", async () => {
  const h = harness();
  const remote = mkdtempSync(join(tmpdir(), "team-reissue-remote-"));
  const cache = join(config.repoRoot, ".agent-console", "team");
  try {
    execFileSync("git", ["init", "--bare", "-q", remote]);
    const created = await createdTeam(h, "-1003", remote);
    // Creation returns the code once and nothing persists it, which is B1: the
    // panel held it in React state and a page reload dropped it.
    const lost = decodeJoinCode(created.joinCode);

    // What the reloaded panel can still see, and what it used to try instead.
    assert.equal(h.runtime.teamCreateStatus(), null, "a reload has no pending create left to read the code from");
    const second = h.runtime.startTeamCreate(remote);
    h.stub.send(operator, { id: -1003, type: "supergroup" }, `/team ${second.code}`);
    await waitFor(() => h.runtime.teamCreateStatus()?.observed === true, "second team group observation");
    /*
     * CHANGED by P-B3, same card clause as the message assertion below: the one
     * `roster_conflict` code covered several situations and named none of them.
     *
     * This asserted `roster_conflict` here. The refusal is unchanged and still
     * required - B1's point is that creating again is not the remedy, reissuing the
     * code is - but the reason is no longer a conflict. This workstation already
     * holds this team, which is a different fact from "the roster moved under you",
     * and M-14's whole complaint was that one code stood for both. `team_already_held`
     * says it, and its message names Refresh team and Reissue join code.
     *
     * The distinction is load-bearing rather than cosmetic: the case where the
     * workstation does **not** hold the team locally is M-14's recovery, and it now
     * adopts instead of refusing. Same call, same inputs; only the local record
     * differs.
     */
    await assert.rejects(
      h.runtime.confirmTeamCreate(),
      (error: unknown) => error instanceof WorkspaceError && error.status === 409 && error.code === "team_already_held"
        && /Reissue join code/.test(error.message),
      "creating the team again is refused, because this workstation already holds that team",
    );
    h.runtime.cancelTeamCreate();

    const before = workspaces.teamRoster(created.teamId)!;
    const reissued = await h.runtime.reissueTeamJoinCode();
    const fresh = decodeJoinCode(reissued.joinCode);
    assert.equal(reissued.teamId, created.teamId);
    assert.equal(fresh.teamId, lost.teamId);
    assert.equal(fresh.groupChatId, lost.groupChatId);
    assert.equal(fresh.remoteUrl, lost.remoteUrl);
    assert.notEqual(fresh.inviteId, lost.inviteId, "a reissue mints a fresh invite id");
    // A join code carries no credential (T09), and the reissued one is no exception.
    const payload = JSON.parse(Buffer.from(reissued.joinCode.slice("awj1.".length), "base64url").toString("utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), ["expiresAt", "groupChatId", "inviteId", "remoteUrl", "teamId", "version"]);
    assert.doesNotMatch(reissued.joinCode, /:[A-Za-z0-9_-]{30,}/, "no bot token shape reaches the code");

    const after = workspaces.teamRoster(created.teamId)!;
    const record = after.record as TeamRoster;
    assert.notEqual(after.revision, before.revision, "the reissue published the roster by compare-and-swap");
    assert.equal(record.commandIds.filter(id => id.startsWith("reissue_")).length, 1, "the reissue is recorded as one roster command");
    assert.deepEqual(record.members, (before.record as TeamRoster).members, "a reissue changes nobody's membership");
    assert.deepEqual(record.usedInviteIds, [], "a reissue consumes no invite id");

    // The fresh code is usable: the real join path takes it and spends it.
    const joined = await joinTeam(
      new BareGitTeamRosterRemote(remote),
      reissued.joinCode,
      { personId: "808", telegramUserId: "808", botId: "telegram-teammate-808", botUsername: "teammate_stub_bot", workstationId: "teammate-workstation", workstationLabel: "teammate-workstation" },
      `join_${randomBytes(9).toString("base64url")}`,
    );
    assert.equal(joined.roster.members.length, 2, "the reissued code admitted the teammate");
    assert.deepEqual(joined.roster.usedInviteIds, [fresh.inviteId]);
  } finally {
    await h.cleanup();
    rmSync(remote, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test("B1 (T0): a reissue over a roster that moved is refused as roster_conflict, and works once the panel refreshes", async () => {
  const h = harness();
  const remote = mkdtempSync(join(tmpdir(), "team-reissue-conflict-"));
  const cache = join(config.repoRoot, ".agent-console", "team");
  try {
    execFileSync("git", ["init", "--bare", "-q", remote]);
    const created = await createdTeam(h, "-1004", remote);

    // The other workstation publishes while this panel still holds the older revision.
    const bare = new BareGitTeamRosterRemote(remote);
    const current = (await bare.read())!;
    const competing: TeamRoster = { ...current.roster, commandIds: [...current.roster.commandIds, "other_workstation"], updatedAt: new Date().toISOString() };
    assert.notEqual(await bare.compareAndSwap(current.revision, competing), "conflict", "the other workstation published first");

    await assert.rejects(
      h.runtime.reissueTeamJoinCode(),
      (error: unknown) => error instanceof WorkspaceError
        && error.status === 409
        && error.code === "roster_conflict"
        /*
         * CHANGED by P-B3, which the card authorises: "split `roster_conflict`,
         * which covers at least two distinct causes - a genuine remote divergence,
         * and a stale **local** mirror - so the message names which one".
         *
         * This asserted the old message verbatim, `"Team roster changed; review it
         * before trying again."`. That sentence was the defect M-14 recorded: it
         * was the only thing a wiped workstation was told, it named neither cause,
         * and it advised reviewing a roster that workstation had no surface for.
         * This case is the genuine divergence, so the message must now name that
         * and name what clears it.
         */
        && /Another member published the team roster/.test(error.message)
        && /Refresh team/.test(error.message),
      "a reissue does not overwrite a roster it has not seen",
    );
    const held = (await bare.read())!;
    assert.deepEqual(held.roster.commandIds, competing.commandIds, "the refused reissue published nothing");
    assert.equal(held.revision, (await bare.read())!.revision);

    // The conflict is recoverable, which is the half B1 lacked: refresh, then reissue.
    await h.runtime.refreshTeam();
    const recovered = await h.runtime.reissueTeamJoinCode();
    assert.match(recovered.joinCode, /^awj1\./);
    assert.equal(decodeJoinCode(recovered.joinCode).teamId, created.teamId);
    const settled = (await bare.read())!;
    assert.equal((settled.roster.commandIds.filter(id => id.startsWith("reissue_"))).length, 1);
    assert.equal(workspaces.teamRoster(created.teamId)?.revision, settled.revision, "the local cache holds the revision it just published");
  } finally {
    await h.cleanup();
    rmSync(remote, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

test("TM-T1-gate (T0): Team stays disabled independently while personal Telegram remains available", async () => {
  const h = harness();
  const refused = (error: unknown) => error instanceof WorkspaceError
    && error.status === 403
    && error.code === "team_disabled"
    && error.message === "Enable Team in Agents settings before using Team features.";
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "personal Telegram polling");
    const pending = h.runtime.startTeamCreate("unused");
    h.settings.teamEnabled = false;
    h.stub.send(operator, { id: -1002, type: "supergroup" }, `/team ${pending.code}`);
    await waitFor(
      () => h.stub.messages.find(message => message.text === "Enable Team in Agents settings before using Team features."),
      "disabled Team command refusal",
    );
    assert.equal(h.runtime.status().state, "polling");
    assert.doesNotThrow(() => h.runtime.startPairing());

    assert.throws(() => h.runtime.teamStatus(), refused);
    assert.throws(() => h.runtime.teamCreateStatus(), refused);
    assert.throws(() => h.runtime.startTeamCreate("unused"), refused);
    assert.throws(() => h.runtime.cancelTeamCreate(), refused);
    assert.throws(() => h.runtime.startTeamJoin("unused"), refused);
    await assert.rejects(h.runtime.refreshTeam(), refused);
    await assert.rejects(h.runtime.confirmTeamCreate(), refused);
    await assert.rejects(h.runtime.confirmTeamJoin(), refused);
    await assert.rejects(h.runtime.reissueTeamJoinCode(), refused);
  } finally {
    await h.cleanup();
  }
});

test("T15 requester bot posts one sanitized cross-owner thread request card", async () => {
  const h = harness();
  const teamId = `team-thread-request-${h.stub.botUserId}`;
  const groupChatId = "-1001500";
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    await pair(h);
    const roster = {
      version: 1 as const,
      teamId,
      groupChatId,
      remoteUrl: "https://example.invalid/team.git",
      members: [
        { personId: String(operator.id), telegramUserId: String(operator.id), botId: h.botId, botUsername: "l1_stub_bot", workstationId: h.botId, workstationLabel: "requester-workstation" },
        { personId: "303", telegramUserId: "303", botId: "telegram-owner", botUsername: "owner_stub_bot", workstationId: "owner-workstation", workstationLabel: "owner-workstation" },
      ],
      usedInviteIds: [],
      commandIds: [],
      updatedAt: new Date().toISOString(),
    };
    workspaces.upsertTeamRoster({ teamId, groupChatId, remoteUrl: roster.remoteUrl, revision: "request-revision", record: roster });
    workspaces.upsertTeamGroupActor({ id: `${teamId}-requester`, transport: "telegram", transportUserId: String(operator.id), chatId: groupChatId, label: "requester-workstation" });

    h.stub.send(operator, { id: Number(groupChatId), type: "supergroup" }, "/discuss @owner_stub_bot 42");
    const request = await waitFor(() => h.stub.messages.find(message => message.chatId === groupChatId && message.text.startsWith("Thread requested")), "Team thread request card");
    assert.match(request.text, /#item_[a-f0-9]{24}/);
    assert.doesNotMatch(request.text, /\/home\/|quota|question|answer|credential|token/i);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(h.stub.messages.filter(message => message.chatId === groupChatId && message.text.startsWith("Thread requested")).length, 1);
  } finally {
    await h.cleanup();
  }
});

test("B7 (T0): the owner opens a Team item on an awaiting task, and a finished task is refused instead of half-opened", async () => {
  const h = harness();
  const teamId = `team-open-item-${h.stub.botUserId}`;
  const groupChatId = "-1001600";
  const dir = mkdtempSync(join(tmpdir(), "team-open-item-"));
  const workspace = workspaces.create({ name: dir, workDirectory: dir });
  try {
    const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
    const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
    const awaiting = workspaces.createChild("prompt", suite.id, { title: "Choose a colour", content: "Red or blue" }) as PromptRecord;
    const finished = workspaces.createChild("prompt", suite.id, { title: "Ship the release", content: "Ship it" }) as PromptRecord;

    // The awaiting task is blocked on a question, exactly as its own agent would leave it.
    const blockRun = `open-item-block-${workspace.id}`;
    workspaces.beginAgentRun({ runId: blockRun, workspaceId: workspace.id, promptId: awaiting.id, provider: "grok", model: null, tokenHash: blockRun, expiresAt: new Date(Date.now() + 60_000).toISOString(), role: "execute" });
    workspaces.updateAgentStatus(blockRun, { requestId: `${blockRun}-status`, expectedStatus: "IN_PROGRESS", status: "BLOCKED", reason: "The brand guide allows red or blue.", verificationSummary: "Pick red or blue." });
    workspaces.finishAgentRun(blockRun, "done");
    assert.equal(workspaces.promptOutcome(awaiting.id).status, "BLOCKED");

    // The finished task completed before anyone thought to discuss it: B7's pilot case.
    const doneRun = `open-item-done-${workspace.id}`;
    workspaces.beginAgentRun({ runId: doneRun, workspaceId: workspace.id, promptId: finished.id, provider: "grok", model: null, tokenHash: doneRun, expiresAt: new Date(Date.now() + 60_000).toISOString(), role: "execute" });
    workspaces.updateAgentStatus(doneRun, { requestId: `${doneRun}-status`, expectedStatus: "IN_PROGRESS", status: "DONE", reason: "Released", verificationSummary: "Shipped" });
    workspaces.finishAgentRun(doneRun, "done");
    assert.equal(workspaces.promptOutcome(finished.id).status, "DONE");

    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    await pair(h);
    const roster = {
      version: 1 as const,
      teamId,
      groupChatId,
      remoteUrl: "https://example.invalid/team.git",
      members: [
        { personId: String(operator.id), telegramUserId: String(operator.id), botId: h.botId, botUsername: "l1_stub_bot", workstationId: h.botId, workstationLabel: "owner-workstation" },
        { personId: "404", telegramUserId: "404", botId: "telegram-teammate", botUsername: "teammate_stub_bot", workstationId: "teammate-workstation", workstationLabel: "teammate-workstation" },
      ],
      usedInviteIds: [],
      commandIds: [],
      updatedAt: new Date().toISOString(),
    };
    workspaces.upsertTeamRoster({ teamId, groupChatId, remoteUrl: roster.remoteUrl, revision: "open-item-revision", record: roster });
    workspaces.upsertTeamGroupActor({ id: `${teamId}-owner`, transport: "telegram", transportUserId: String(operator.id), chatId: groupChatId, label: "owner-workstation" });

    // Success path: the owner's own control opens the thread and the anchor really reaches the group.
    const opened = h.runtime.openTeamItem(awaiting.id);
    assert.match(opened.itemId, /^awi1_[a-f0-9]{24}$/);
    const anchor = await waitFor(() => h.stub.messages.find(message => message.chatId === groupChatId && message.text.includes(itemTag(opened.itemId))), "Team item anchor");
    assert.doesNotMatch(anchor.text, /\/home\/|token|credential/i);
    assert.notEqual(workspaces.telegramThreadFor({ botId: h.botId, chatId: groupChatId, subject: itemSubject(opened.itemId) }).statusMessageId, null, "the opened item has an anchor");

    // B7: a finished prompt must be refused, not turned into an anchorless link row.
    assert.throws(
      () => h.runtime.openTeamItem(finished.id),
      (error: unknown) => error instanceof WorkspaceError && error.status === 409 && error.code === "prompt_already_complete",
      "opening a Team item on a finished task must be refused",
    );
    assert.deepEqual(workspaces.itemLinksForPrompt(finished.id), [], "a refused open leaves no item_link row behind");
    await new Promise(resolve => setTimeout(resolve, 25));
    const strayItems = h.stub.messages.filter(message => message.chatId === groupChatId && /#item_[a-f0-9]{24}/.test(message.text) && !message.text.includes(itemTag(opened.itemId)));
    assert.deepEqual(strayItems.map(message => message.text), [], "a refused open posts nothing about a second item");
  } finally {
    await h.cleanup();
    workspaces.remove(workspace.id);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B5 (T0): creation records the configured workstation label, and Team views name the workstation and the person apart", async () => {
  const h = harness();
  const remote = mkdtempSync(join(tmpdir(), "team-label-remote-"));
  const dir = mkdtempSync(join(tmpdir(), "team-label-"));
  const cache = join(config.repoRoot, ".agent-console", "team");
  const workspace = workspaces.create({ name: dir, workDirectory: dir });
  const groupChatId = "-1001700";
  try {
    execFileSync("git", ["init", "--bare", "-q", remote]);
    const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
    const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
    const created = await createdTeam(h, groupChatId, remote);

    // The paired account's Telegram display name is "Operator". The machine's own
    // name is TASK_CONTROL_WORKSTATION_LABEL, which is what the personal card puts
    // in its breadcrumb. B5: the roster stored the first where the second belongs,
    // so every Team card disagreed with every personal card about the same machine.
    const configured = appSettings.taskControl.workstationLabel || defaultWorkstationLabel();
    assert.notEqual(configured, operator.first_name, "the fixture only means anything while the two differ");
    const member = (workspaces.teamRoster(created.teamId)!.record as TeamRoster).members[0]!;
    assert.equal(member.workstationLabel, configured, "the roster holds the workstation's own label");
    assert.equal(member.personLabel, operator.first_name, "and the person's Telegram name beside it");

    // What the group actually reads. The breadcrumb is a workstation slot; the
    // anchor footer and `/access` name people; `/status` names the workstation.
    const prompt = blockedPrompt(workspace.id, suite.id, "Choose a colour");
    const opened = h.runtime.openTeamItem(prompt.id);
    const anchor = await waitFor(() => h.stub.messages.find(message => message.chatId === groupChatId && message.text.includes(itemTag(opened.itemId))), "Team item anchor");
    assert.ok(anchor.text.includes(`· ${configured} · `), "the breadcrumb names the workstation");
    assert.ok(anchor.text.includes(`Owner: ${operator.first_name}`), "the footer names the person who owns it");

    h.stub.send(operator, { id: Number(groupChatId), type: "supergroup" }, `/status ${opened.itemId}`);
    const status = await waitFor(() => h.stub.messages.find(message => message.chatId === groupChatId && message.text.startsWith("Item status")), "the item status view");
    assert.ok(status.text.includes(`Owner workstation: ${configured}`), "the workstation line names the workstation");
    assert.ok(!status.text.includes(operator.first_name), "and no Team view calls the person a workstation");

    h.stub.send(operator, { id: Number(groupChatId), type: "supergroup" }, `/access ${opened.itemId}`);
    const access = await waitFor(() => h.stub.messages.find(message => message.chatId === groupChatId && message.text.startsWith("Item access")), "the item access view");
    assert.ok(access.text.includes(`${operator.first_name}: owner`), "access is a list of people, so it names the person");
  } finally {
    await h.cleanup();
    workspaces.remove(workspace.id);
    rmSync(dir, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* B8: Telegram upgrades a basic group to a supergroup and the chat id changes. */
/* -------------------------------------------------------------------------- */

function blockedPrompt(workspaceId: number, suiteId: number, title: string): PromptRecord {
  const prompt = workspaces.createChild("prompt", suiteId, { title, content: "Red or blue" }) as PromptRecord;
  const runId = `supergroup-block-${prompt.id}`;
  workspaces.beginAgentRun({ runId, workspaceId, promptId: prompt.id, provider: "grok", model: null, tokenHash: runId, expiresAt: new Date(Date.now() + 60_000).toISOString(), role: "execute" });
  workspaces.updateAgentStatus(runId, { requestId: `${runId}-status`, expectedStatus: "IN_PROGRESS", status: "BLOCKED", reason: "The brand guide allows red or blue.", verificationSummary: "Pick red or blue." });
  workspaces.finishAgentRun(runId, "done");
  return prompt;
}

/** A joined team whose roster really lives in refs/aw/team of a bare repository. */
async function upgradeFixture(h: ReturnType<typeof harness>, groupChatId: string) {
  const dir = mkdtempSync(join(tmpdir(), "team-supergroup-"));
  const bare = mkdtempSync(join(tmpdir(), "team-supergroup-remote-"));
  execFileSync("git", ["init", "--bare", "-q", bare]);
  const workspace = workspaces.create({ name: dir, workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
  const teamId = `awt1_supergroup_${h.stub.botUserId}`;
  const remote = new BareGitTeamRosterRemote(bare);
  const published = await publishRoster(remote, null, newTeamRoster({
    teamId,
    groupChatId,
    remoteUrl: bare,
    members: [
      { personId: String(operator.id), telegramUserId: String(operator.id), botId: h.botId, botUsername: "l1_stub_bot", workstationId: h.botId, workstationLabel: "owner-workstation" },
      { personId: "404", telegramUserId: "404", botId: "telegram-teammate", botUsername: "teammate_stub_bot", workstationId: "teammate-workstation", workstationLabel: "teammate-workstation" },
    ],
  }), `create_${teamId}`);
  workspaces.upsertTeamGroupActor({ id: `${teamId}-owner`, transport: "telegram", transportUserId: String(operator.id), chatId: groupChatId, label: "owner-workstation" });
  return {
    teamId, bare, workspace, suite, published,
    prompt: (title: string) => blockedPrompt(workspace.id, suite.id, title),
    async remoteRoster() { return (await remote.read())?.roster ?? null; },
    cleanup() {
      workspaces.remove(workspace.id);
      rmSync(dir, { recursive: true, force: true });
      rmSync(bare, { recursive: true, force: true });
      rmSync(join(config.repoRoot, ".agent-console", "team"), { recursive: true, force: true });
    },
  };
}

/*
 * B8, the supergroup upgrade. These two cases are the T0 half and they are all
 * there is: F05's third acceptance criterion asked for a harness case that
 * upgrades a group mid-test, and there is none. The e2e fake cannot upgrade a
 * group at all, so the behaviour below has no T1 row and no end-to-end proof
 * that the repaired anchor reaches a phone.
 *
 * Both cases were once named TM-T1-8 and TM-T1-9, ids that exist in no scenario
 * table and no plan. An invented id in a test name reads as coverage, so they
 * carry the bug-log id the rest of the F track uses. The missing harness case is
 * recorded as a deviation in team-gap-register.md, entry M-10.
 */
test("B8 (T0): a group upgraded to a supergroup mid-run repairs itself and the next anchor reaches the new chat id", async () => {
  const h = harness();
  const fromChatId = "-41001";
  const toChatId = "-1002000041001";
  const team = await upgradeFixture(h, fromChatId);
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    await pair(h);

    // Before the upgrade the team works: the first item's anchor reaches the basic group.
    const first = h.runtime.openTeamItem(team.prompt("Choose a colour").id);
    await waitFor(() => h.stub.messages.find(message => message.chatId === fromChatId && message.text.includes(itemTag(first.itemId))), "the first anchor in the basic group");
    const beforeUpgrade = h.stub.messages.filter(message => message.chatId === fromChatId).length;

    // Granting an administrator right upgrades the group, and the chat id changes with it.
    h.stub.upgradeToSupergroup(fromChatId, toChatId);
    const second = h.runtime.openTeamItem(team.prompt("Pick a release date").id);

    const anchor = await waitFor(() => h.stub.messages.find(message => message.chatId === toChatId && message.text.includes(itemTag(second.itemId))), "the next anchor in the supergroup");
    assert.equal(anchor.chatId, toChatId, "the anchor was delivered to the supergroup with no manual repair");

    // Every place the old id lived moved with it, locally and on the shared ref.
    assert.equal(workspaces.teamRoster(team.teamId)?.groupChatId, toChatId, "the roster cache holds the supergroup id");
    assert.equal(((workspaces.teamRoster(team.teamId)?.record ?? {}) as { groupChatId?: string }).groupChatId, toChatId, "the cached record holds it too");
    assert.equal((await team.remoteRoster())?.groupChatId, toChatId, "refs/aw/team was republished by compare-and-swap");
    assert.equal(workspaces.taskControlActorFor({ transport: "telegram", transportUserId: String(operator.id), chatId: toChatId, topicId: "__team_group__" })?.enabled, 1, "the group actor moved");
    assert.equal(workspaces.taskControlActorFor({ transport: "telegram", transportUserId: String(operator.id), chatId: fromChatId, topicId: "__team_group__" }), null, "and left nothing behind at the old id");
    assert.notEqual(workspaces.telegramThreadFor({ botId: h.botId, chatId: toChatId, subject: itemSubject(first.itemId) }).statusMessageId, null, "the first item's thread kept its anchor through the move");
    assert.deepEqual(workspaces.telegramThreads(h.botId).filter(thread => thread.chatId === fromChatId), [], "no thread row still points at the old chat");

    // The old id is unusable from the upgrade on: nothing is ever sent there again.
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(h.stub.messages.filter(message => message.chatId === fromChatId).length, beforeUpgrade, "nothing was delivered to the old chat id after the upgrade");
  } finally {
    await h.cleanup();
    team.cleanup();
  }
});

test("B8 (T0): the migrate_from_chat_id service message repairs the team before anything else is processed", async () => {
  const h = harness();
  const fromChatId = "-41002";
  const toChatId = "-1002000041002";
  const team = await upgradeFixture(h, fromChatId);
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");
    await pair(h);

    const first = h.runtime.openTeamItem(team.prompt("Choose a colour").id);
    await waitFor(() => h.stub.messages.find(message => message.chatId === fromChatId && message.text.includes(itemTag(first.itemId))), "the first anchor in the basic group");

    // The upgrade is announced in the supergroup rather than discovered by a refused send.
    h.stub.upgradeToSupergroup(fromChatId, toChatId);
    h.stub.sendMigrationNotice(fromChatId, toChatId);

    await waitFor(() => workspaces.teamRoster(team.teamId)?.groupChatId === toChatId, "the roster to follow the service message");
    assert.equal((await team.remoteRoster())?.groupChatId, toChatId, "refs/aw/team was republished by compare-and-swap");
    assert.equal(workspaces.taskControlActorFor({ transport: "telegram", transportUserId: String(operator.id), chatId: toChatId, topicId: "__team_group__" })?.enabled, 1, "the group actor moved");
    assert.deepEqual(workspaces.telegramThreads(h.botId).filter(thread => thread.chatId === fromChatId), [], "no thread row still points at the old chat");

    // The next item is addressed to the supergroup from the start: no send is ever refused.
    const second = h.runtime.openTeamItem(team.prompt("Pick a release date").id);
    await waitFor(() => h.stub.messages.find(message => message.chatId === toChatId && message.text.includes(itemTag(second.itemId))), "the next anchor in the supergroup");
    assert.deepEqual(
      workspaces.telegramOutbox().filter(row => (row.lastError ?? "").includes("upgraded to a supergroup")).map(row => row.id),
      [],
      "the service message repaired the team before any send could be refused",
    );
  } finally {
    await h.cleanup();
    team.cleanup();
  }
});

/* -------------------------------------------------------------------------- */
/* F07: the anchor writes are bounded (B11 age churn, B9 the unbounded loop).  */
/* -------------------------------------------------------------------------- */

/**
 * Waits for the delivery loop to complete whole passes. Time is driven through the
 * runtime's injected clock, never by sleeping, so a coarser schedule is proved by
 * elapsed simulated time and by write counts rather than by a wall-clock wait.
 */
async function deliverPasses(h: ReturnType<typeof harness>, count = 2): Promise<void> {
  const ticks = () => h.sleeps.filter(ms => ms === 5).length;
  const start = ticks();
  await waitFor(() => ticks() >= start + count, "delivery passes");
}

/** Every outbox row this bot offered as the anchor of one item's thread. */
function anchorRows(botId: string, chatId: string, itemId: string) {
  return workspaces.telegramOutbox().filter(row =>
    row.botId === botId && row.chatId === chatId && typeof (row.payload as { text?: unknown }).text === "string"
    && String((row.payload as { text: string }).text).includes(itemTag(itemId)));
}

test("B11 (T0): an idle open item's anchor is not rewritten as it ages, and refreshes on a coarse schedule", async () => {
  let clock = Date.now();
  const h = harness({ now: () => clock });
  const chatId = "-41011";
  const team = await upgradeFixture(h, chatId);
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");

    clock = Date.now();
    const item = h.runtime.openTeamItem(team.prompt("Choose a colour").id);
    const anchor = await waitFor(() => h.stub.messages.find(message => message.chatId === chatId && message.text.includes(itemTag(item.itemId))), "the item anchor");
    assert.match(anchor.text, /blocked just now|blocked \d+ min ago/, "the anchor states the item's age");
    const editsAtPost = anchor.edits;

    // Forty minutes pass on the runtime's clock with nothing about the task changing:
    // no command, no grant, no status change. The pilot saw 38 consecutive edits
    // across exactly such a window (outbox rows 81 to 118, 13:54Z to 14:31Z).
    for (let minute = 1; minute <= 40; minute += 1) {
      clock += 60_000;
      await deliverPasses(h);
    }
    assert.equal(anchor.edits - editsAtPost, 0, "an idle item queues no editMessageText as it ages");

    // The age is not frozen either: once the item crosses its own hourly grid the
    // anchor restates it, once, and then settles again.
    clock += 21 * 60_000;
    await waitFor(() => anchor.edits === editsAtPost + 1, "one coarse age refresh");
    assert.match(anchor.text, /blocked 60 min ago/, "the refreshed anchor states the age it has");
    for (let minute = 1; minute <= 10; minute += 1) {
      clock += 60_000;
      await deliverPasses(h);
    }
    assert.equal(anchor.edits - editsAtPost, 1, "and the counter settles again until the next hour");
  } finally {
    await h.cleanup();
    team.cleanup();
  }
});

test("B9 (T0): an anchor that can never be delivered queues one row, then backs off, instead of a series", async () => {
  let clock = Date.now();
  const h = harness({ now: () => clock });
  const chatId = "-41009";
  const team = await upgradeFixture(h, chatId);
  try {
    // The group is gone: every send is refused, for good, and no retry can fix it.
    h.stub.refuseChat(chatId, "Bad Request: chat not found");
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");

    clock = Date.now();
    const item = h.runtime.openTeamItem(team.prompt("Choose a colour").id);
    await waitFor(() => anchorRows(h.botId, chatId, item.itemId).some(row => row.state === "FAILED"), "the refused anchor");

    // The pilot watched this window produce outbox rows 11 to 36, one every 2.5
    // seconds, all FAILED against the same chat, with no upper bound.
    for (let second = 1; second <= 59; second += 1) {
      clock += 1000;
      await deliverPasses(h);
    }
    assert.equal(anchorRows(h.botId, chatId, item.itemId).length, 1, "a failing anchor is offered once, not on every pass");

    // It is not abandoned either: the thread backs off and tries again, and the
    // wait doubles each time rather than staying at one pass.
    clock += 3_000;
    await waitFor(() => anchorRows(h.botId, chatId, item.itemId).length === 2, "the first backed-off retry");
    for (let second = 1; second <= 55; second += 1) {
      clock += 1000;
      await deliverPasses(h);
    }
    assert.equal(anchorRows(h.botId, chatId, item.itemId).length, 2, "the second wait is longer than the first");
    clock += 65_000;
    await waitFor(() => anchorRows(h.botId, chatId, item.itemId).length === 3, "the second backed-off retry");
  } finally {
    await h.cleanup();
    team.cleanup();
  }
});

/* -------------------------------------------------------------------------- */
/* F08: the anchor a completed item leaves behind in the group (B13).          */
/* -------------------------------------------------------------------------- */

/**
 * Drives the race that froze the pilot's card: the prompt reaches DONE while the
 * agent_run row that completed it still has no ended_at. That is the state the
 * anchor was rendered and retired in on 2026-09-19 (case 7, outbox 69), and once
 * the thread is ANCHOR_GONE nothing edits the message again.
 *
 * The ordering is written as explicit state changes, never as a wall-clock wait,
 * so what the test pins is which state the runtime saw, not how fast it ran.
 */
function completeLeavingTheRunOpen(workspaceId: number, promptId: number, expiresAtMs: number): string {
  workspaces.respondToBlockedPrompt(promptId, { content: "Recalculate the amounts from the owner list" });
  const runId = `b13-complete-${promptId}`;
  workspaces.beginAgentRun({ runId, workspaceId, promptId, provider: "claude", model: null, tokenHash: runId, expiresAt: new Date(expiresAtMs).toISOString(), role: "execute" });
  workspaces.updateAgentStatus(runId, { requestId: `${runId}-status`, expectedStatus: "IN_PROGRESS", status: "DONE", reason: "The owner chose to recalculate.", verificationSummary: "Recalculated the amounts and checked the totals." });
  const run = (workspaces.promptHistory(promptId).runs as Array<{ id: string; endedAt: string | null }>).find(entry => entry.id === runId);
  assert.equal(workspaces.promptOutcome(promptId).status, "DONE", "the prompt reads DONE");
  assert.equal(run?.endedAt, null, "and the run that completed it has no ended_at yet: the B13 race");
  return runId;
}

/** What the pilot's frozen card said that a completed item's record must never say. */
function contradictions(card: string): string[] {
  return [
    /Blocked on:/.test(card) ? "tells the reader the completed item is blocked on a decision" : "",
    /If you wait:/.test(card) ? "tells the reader nothing moves until they choose" : "",
    /\((?:running|starting)\)/.test(card) ? "shows the run still going" : "",
  ].filter(entry => entry !== "");
}

test("B13 (T0): the anchor a completed item leaves in the group reads as completed, not as blocked and running", async () => {
  let clock = Date.now();
  const h = harness({ now: () => clock });
  const chatId = "-41013";
  const team = await upgradeFixture(h, chatId);
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");

    clock = Date.now();
    const prompt = team.prompt("Choose whether amounts are recalculated");
    const item = h.runtime.openTeamItem(prompt.id);
    const anchor = await waitFor(() => h.stub.messages.find(message => message.chatId === chatId && message.text.includes(itemTag(item.itemId))), "the item anchor");
    assert.match(anchor.text, /Blocked on:/, "the open item's anchor states the blocker it is waiting on");

    const runId = completeLeavingTheRunOpen(team.workspace.id, prompt.id, clock + 60_000);
    await deliverPasses(h, 6);
    // Four seconds later the run row ends, as the pilot's did at 12:58:57.
    clock += 4_000;
    workspaces.finishAgentRun(runId, "done");
    const thread = () => workspaces.telegramThreadFor({ botId: h.botId, chatId, subject: itemSubject(item.itemId) });
    await waitFor(() => thread().state === "ANCHOR_GONE", "the retired anchor");
    await deliverPasses(h, 4);

    const frozen = anchor.text;
    assert.match(frozen, /Completed · /, "the message left in the group says the item is complete");
    assert.deepEqual(contradictions(frozen), [], `the completed item's permanent record contradicts itself:\n${frozen}`);
    assert.match(frozen, /\(done\)/, "and shows the run that completed it as finished");
  } finally {
    await h.cleanup();
    team.cleanup();
  }
});

test("B13 (T0): a completed item's anchor is not retired while the run that completed it is still open", async () => {
  let clock = Date.now();
  const h = harness({ now: () => clock });
  const chatId = "-41014";
  const team = await upgradeFixture(h, chatId);
  try {
    await h.runtime.reconcile();
    await waitFor(() => h.runtime.status().state === "polling", "polling");

    clock = Date.now();
    const prompt = team.prompt("Choose whether amounts are recalculated");
    const item = h.runtime.openTeamItem(prompt.id);
    const anchor = await waitFor(() => h.stub.messages.find(message => message.chatId === chatId && message.text.includes(itemTag(item.itemId))), "the item anchor");
    const thread = () => workspaces.telegramThreadFor({ botId: h.botId, chatId, subject: itemSubject(item.itemId) });

    const runId = completeLeavingTheRunOpen(team.workspace.id, prompt.id, clock + 60_000);
    await deliverPasses(h, 8);
    assert.notEqual(thread().state, "ANCHOR_GONE", "the anchor is still live while the run that completed it has not ended");
    assert.equal(h.stub.calls.filter(call => call.method === "unpinChatMessage").length, 0, "and nothing has unpinned it yet");
    assert.deepEqual(contradictions(anchor.text), [], `the anchor read during the race contradicts itself:\n${anchor.text}`);

    // Once the run has really ended, the record is final and the anchor retires.
    clock += 4_000;
    workspaces.finishAgentRun(runId, "done");
    await waitFor(() => thread().state === "ANCHOR_GONE", "the retired anchor");
  } finally {
    await h.cleanup();
    team.cleanup();
  }
});
