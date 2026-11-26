import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { UserIdentity } from "@hydra/shared";
import type { RemoteOverview } from "../../../src/contracts/remote.ts";
import { openIdentityStore } from "../../../src/repositories/identities.ts";
import type { BotApi, ReplyMarkup, TelegramMessage, TelegramUpdate } from "../../../src/services/telegram/botApi.ts";
import { createTelegramBot } from "../../../src/services/telegram/telegramBot.ts";

const TOKEN = "123456:abcdefghijklmnopqrstuvwxyz0123456789";
const quiet = { info() {}, warn() {}, error() {} };

interface Sent { chatId: number; text: string; markup?: ReplyMarkup; messageId: number }

function fakeTelegram() {
  const sent: Sent[] = [];
  const edits: Sent[] = [];
  const callbacks: Array<{ id: string; text?: string }> = [];
  let queue: TelegramUpdate[] = [];
  let wake: (() => void) | null = null;
  let nextUpdate = 1;
  let nextMessage = 100;
  const api: BotApi = {
    getMe: async () => ({ id: 123456, is_bot: true, first_name: "Hydra", username: "hydra_test_bot" }),
    async getUpdates(offset, _timeout, signal) {
      while (!signal.aborted) {
        const ready = queue.filter(update => update.update_id >= offset);
        if (ready.length > 0) { queue = []; return ready; }
        await new Promise<void>(resolve => { wake = resolve; signal.addEventListener("abort", () => resolve(), { once: true }); });
      }
      throw new Error("aborted");
    },
    async sendMessage(chatId, text, markup) {
      const message = { chatId, text, ...(markup ? { markup } : {}), messageId: nextMessage++ };
      sent.push(message);
      return { message_id: message.messageId, chat: { id: chatId, type: "private" } } satisfies TelegramMessage;
    },
    async editMessageText(chatId, messageId, text, markup) { edits.push({ chatId, text, ...(markup ? { markup } : {}), messageId }); },
    async answerCallbackQuery(id, text) { callbacks.push({ id, ...(text ? { text } : {}) }); },
    async setMyCommands() {},
    async deleteWebhook() {},
  };
  const push = (update: Omit<TelegramUpdate, "update_id">) => { queue.push({ update_id: nextUpdate++, ...update }); wake?.(); };
  return {
    api, sent, edits, callbacks,
    text(fromId: number, text: string, replyTo?: number) {
      push({ message: { message_id: nextMessage++, from: { id: fromId, is_bot: false, first_name: "T", username: `user${fromId}` }, chat: { id: fromId, type: "private" }, text, ...(replyTo ? { reply_to_message: { message_id: replyTo, chat: { id: fromId, type: "private" } } } : {}) } });
    },
    tap(fromId: number, data: string, messageId = 1, chatType = "private") {
      push({ callback_query: { id: `cb${nextUpdate}`, from: { id: fromId, is_bot: false, first_name: "T" }, data, message: { message_id: messageId, chat: { id: fromId, type: chatType } } } });
    },
  };
}

const overview: RemoteOverview = {
  runs: [{ runId: "run-1", title: "Build the parser", workspaceName: "Demo", provider: "claude", model: null, role: "execute", elapsedMs: 120_000 }],
  pipelines: [{ id: 3, name: "Release", workspaceName: "Demo", state: "PLAYING", waitReason: null, currentSuite: "Core", current: { promptId: 9, key: "P1", title: "Parser", status: "IN_PROGRESS" }, next: { promptId: 10, key: "P2", title: "Printer", status: "TODO" }, done: 1, total: 4 }],
  gates: [{ promptId: 11, key: "P3", title: "Choose a license", workspaceName: "Demo", question: "MIT or Apache-2.0?", since: null }],
};

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "hydra-telegram-bot-"));
  const identities = openIdentityStore(join(dir, "identities.sqlite"));
  const telegram = fakeTelegram();
  const calls: Array<{ user: string; method: string; path: string; body?: Record<string, unknown> }> = [];
  const runtime = {
    async call(user: UserIdentity, method: "GET" | "POST", path: string, body?: Record<string, unknown>) {
      calls.push({ user: user.username, method, path, ...(body ? { body } : {}) });
      if (path === "/api/remote/overview") return { status: 200, body: overview };
      if (path === "/api/runs/run-1/interrupt") return { status: 200, body: { interrupted: true, pipelinePaused: true } };
      if (path === "/api/pipelines/3/pause") return { status: 409, body: { error: { code: "pipeline_not_playing", message: "Pause requires a playing pipeline" } } };
      return { status: 201, body: {} };
    },
  };
  const bot = createTelegramBot({ identities, runtime, log: quiet, createApi: () => telegram.api, pollSeconds: 0, chatGapMs: 0 });
  await bot.configure(TOKEN);
  const alice = await identities.register({ username: "alice", password: "original password" });
  const settle = async (check: () => boolean, label: string) => {
    for (let attempt = 0; attempt < 200 && !check(); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(check(), `timed out waiting for ${label}`);
  };
  const buttons = (message: Sent | undefined) => message?.markup && "inline_keyboard" in message.markup ? message.markup.inline_keyboard.flat() : [];
  return {
    identities, telegram, calls, bot, alice: alice.user, settle, buttons,
    async close() { await bot.stop(); identities.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("strangers get nothing, a link code connects one chat, and notify-only chats see no controls", async () => {
  const t = await setup();
  try {
    assert.equal(t.bot.status()?.username, "hydra_test_bot");
    t.telegram.text(555, "/status");
    t.telegram.tap(555, "v:status");
    await t.settle(() => t.telegram.callbacks.length === 1, "stranger callback");
    assert.equal(t.telegram.sent.length, 0, "an unlinked sender is never answered");
    assert.equal(t.calls.length, 0);

    t.telegram.text(42, "/start AAAAAAAAAAAAAAAAAAAAAAAA");
    await t.settle(() => t.telegram.sent.length === 1, "expired link reply");
    assert.match(t.telegram.sent[0]!.text, /expired/);

    const code = t.identities.createTelegramLinkCode(t.alice.id);
    assert.equal(t.bot.linkUrl(code.code), `https://t.me/hydra_test_bot?start=${code.code}`);
    t.telegram.text(42, `/start ${code.code}`);
    await t.settle(() => t.identities.telegramLink(t.alice.id) !== null && t.telegram.sent.length === 3, "link");
    assert.match(t.telegram.sent[1]!.text, /Connected to Hydra account <b>alice<\/b>/);
    assert.equal(t.identities.auditLog(t.alice.id)[0]?.action, "linked");

    t.telegram.text(42, "/status");
    await t.settle(() => t.telegram.sent.length === 4, "status");
    const status = t.telegram.sent[3]!;
    assert.match(status.text, /Build the parser/);
    assert.match(status.text, /Release/);
    assert.match(status.text, /1 question waiting/);
    assert.equal(t.buttons(status).some(button => button.text.startsWith("⏹")), false, "notify-only has no stop buttons");
    assert.deepEqual(t.calls.map(call => `${call.user} ${call.path}`), ["alice /api/remote/overview"]);

    t.telegram.tap(42, "v:pipes", 77);
    await t.settle(() => t.telegram.edits.length === 1, "refresh in place");
    assert.equal(t.telegram.edits[0]!.messageId, 77);
    assert.match(t.telegram.edits[0]!.text, /next: P2 · Printer/);

    t.telegram.tap(42, "v:status", 78, "group");
    await t.settle(() => t.telegram.callbacks.length === 3, "group callback");
    assert.equal(t.telegram.edits.length, 1);
  } finally { await t.close(); }
});

test("control actions need a confirmation tap, run as the linked account and are audited", async () => {
  const t = await setup();
  try {
    t.identities.claimTelegramLink(t.identities.createTelegramLinkCode(t.alice.id).code, { telegramUserId: 42, chatId: 42, telegramUsername: "alice_tg" });
    t.identities.setTelegramAccess(t.alice.id, "control");
    t.telegram.text(42, "/status");
    await t.settle(() => t.telegram.sent.length === 1, "status");
    const stop = t.buttons(t.telegram.sent[0]).find(button => button.text.startsWith("⏹ Stop"));
    assert.ok(stop);
    assert.match(stop.callback_data, /^x:[A-Za-z0-9_-]{12}$/);
    assert.ok(stop.callback_data.length <= 64);

    t.telegram.tap(99, stop.callback_data.replace("x:", "c:"));
    await t.settle(() => t.telegram.callbacks.length === 1, "stranger tap");
    assert.equal(t.calls.some(call => call.path.includes("interrupt")), false, "another Telegram user cannot press alice's button");

    t.telegram.tap(42, stop.callback_data);
    await t.settle(() => t.telegram.sent.length === 2, "confirmation");
    assert.match(t.telegram.sent[1]!.text, /Stop the agent working on <b>Build the parser<\/b>\?/);
    assert.equal(t.calls.some(call => call.path.includes("interrupt")), false, "the first tap only asks");
    const confirm = t.buttons(t.telegram.sent[1]).find(button => button.text.includes("Confirm"));
    assert.ok(confirm);
    t.telegram.tap(42, confirm.callback_data, t.telegram.sent[1]!.messageId);
    await t.settle(() => t.telegram.edits.length === 1, "result");
    assert.deepEqual(t.calls.at(-1), { user: "alice", method: "POST", path: "/api/runs/run-1/interrupt", body: {} });
    assert.match(t.telegram.edits[0]!.text, /Stopped\. Its pipeline is paused\./);
    assert.equal(t.identities.auditLog(t.alice.id)[0]?.detail, "stopped agent: Build the parser");

    t.telegram.tap(42, confirm.callback_data);
    await t.settle(() => t.telegram.callbacks.at(-1)?.text?.includes("expired") === true, "reused button");
    assert.equal(t.calls.filter(call => call.path.includes("interrupt")).length, 1, "a confirmation works once");

    t.telegram.text(42, "/pipelines");
    await t.settle(() => t.telegram.sent.length === 3, "pipelines");
    const pause = t.buttons(t.telegram.sent[2]).find(button => button.text.startsWith("⏸ Pause"));
    assert.ok(pause);
    t.telegram.tap(42, pause.callback_data);
    await t.settle(() => t.telegram.sent.length === 4, "pause confirmation");
    t.telegram.tap(42, pause.callback_data.replace("x:", "c:"), t.telegram.sent[3]!.messageId);
    await t.settle(() => t.telegram.edits.length === 2, "pause refused");
    assert.match(t.telegram.edits[1]!.text, /Pause requires a playing pipeline/);
    assert.equal(t.identities.auditLog(t.alice.id)[0]?.action, "pause_failed");

    t.telegram.text(42, "/pipelines");
    await t.settle(() => t.telegram.sent.length === 5, "fresh pipelines");
    const fresh = t.buttons(t.telegram.sent[4]).find(button => button.text.startsWith("⏸ Pause"));
    assert.ok(fresh);
    t.identities.setTelegramAccess(t.alice.id, "notify");
    t.telegram.tap(42, fresh.callback_data.replace("x:", "c:"));
    await t.settle(() => t.telegram.callbacks.at(-1)?.text === "This chat has notifications only.", "downgraded tap");
    assert.equal(t.calls.filter(call => call.path.includes("pause")).length, 1, "lowering access disables buttons already sent");
  } finally { await t.close(); }
});

test("a gate notice can be answered by replying to it, after confirming the text", async () => {
  const t = await setup();
  try {
    t.identities.claimTelegramLink(t.identities.createTelegramLinkCode(t.alice.id).code, { telegramUserId: 42, chatId: 42, telegramUsername: null });
    t.identities.setTelegramAccess(t.alice.id, "control");
    const gate = overview.gates[0]!;
    t.bot.notify(t.alice, { kind: "gate", gate });
    await t.settle(() => t.telegram.sent.length === 1, "gate notice");
    const notice = t.telegram.sent[0]!;
    assert.match(notice.text, /MIT or Apache-2\.0\?/);
    t.telegram.text(42, "Apache-2.0, <please>", notice.messageId);
    await t.settle(() => t.telegram.sent.length === 2, "answer confirmation");
    assert.match(t.telegram.sent[1]!.text, /Apache-2\.0, &lt;please&gt;/, "agent and user text is escaped");
    assert.equal(t.calls.length, 0);
    const send = t.buttons(t.telegram.sent[1]).find(button => button.text.includes("Send"));
    assert.ok(send);
    t.telegram.tap(42, send.callback_data, t.telegram.sent[1]!.messageId);
    await t.settle(() => t.calls.length === 1, "answer posted");
    assert.deepEqual(t.calls[0], { user: "alice", method: "POST", path: "/api/prompts/11/human-response", body: { content: "Apache-2.0, <please>" } });

    const answer = t.buttons(notice).find(button => button.text.includes("Answer"));
    assert.ok(answer);
    t.telegram.tap(42, answer.callback_data);
    await t.settle(() => t.telegram.sent.length === 3, "compose prompt");
    assert.deepEqual(t.telegram.sent[2]!.markup, { force_reply: true, input_field_placeholder: "Your answer" });
    t.telegram.text(42, "/cancel");
    await t.settle(() => t.telegram.sent.length === 4, "cancel");
    t.telegram.text(42, "MIT");
    await t.settle(() => t.telegram.sent.length === 5, "plain text after cancel");
    assert.match(t.telegram.sent[4]!.text, /\/status/, "text with no question to answer gets the help text");

    t.bot.notify({ id: "someone-else", username: "x", ownsLegacyData: false }, { kind: "run_failed", runId: "r", title: "t", workspaceName: "w", provider: "codex", detail: null });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(t.telegram.sent.length, 5, "an account without a chat gets no notice");
  } finally { await t.close(); }
});

test("outside the live console the bot is saved but never polls Telegram", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hydra-telegram-sandbox-"));
  const identities = openIdentityStore(join(dir, "identities.sqlite"));
  const telegram = fakeTelegram();
  let polled = false;
  const api = { ...telegram.api, getUpdates: async () => { polled = true; return []; } };
  const bot = createTelegramBot({ identities, runtime: { call: async () => ({ status: 500, body: null }) }, log: quiet, createApi: () => api, pollSeconds: 0, chatGapMs: 0, enabled: false });
  try {
    const view = await bot.configure(TOKEN);
    assert.equal(view?.status, "stopped");
    assert.match(view?.error ?? "", /live console/);
    assert.equal(identities.telegramBot()?.username, "hydra_test_bot");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(polled, false);
    assert.equal(await bot.sendToChat(42, "hello"), false);
  } finally { await bot.stop(); identities.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("removing the bot stops polling and revokes links", async () => {
  const t = await setup();
  try {
    t.identities.claimTelegramLink(t.identities.createTelegramLinkCode(t.alice.id).code, { telegramUserId: 42, chatId: 42, telegramUsername: null });
    assert.equal(await t.bot.configure(null), null);
    assert.equal(t.bot.status(), null);
    assert.equal(t.identities.telegramLink(t.alice.id), null);
    assert.equal(await t.bot.sendToUser(t.alice.id, "hello"), false);
  } finally { await t.close(); }
});
