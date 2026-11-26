import assert from "node:assert/strict";
import test from "node:test";
import type { PipelineRecord, PipelineRun } from "@hydra/shared";
import type { RemoteGate } from "../../../src/contracts/remote.ts";
import { createBotApi, isBotToken, TelegramApiError } from "../../../src/services/telegram/botApi.ts";
import { escapeHtml, gatesMessage, noticeMessage, pipelinesMessage } from "../../../src/services/telegram/messages.ts";
import { diffNotices } from "../../../src/services/telegram/notifier.ts";

const run = (id: string, state: PipelineRun["state"], extra: Partial<PipelineRun> = {}): PipelineRun => ({
  id, pipelineId: 1, workspaceId: 1, state, currentSuiteId: null, currentSuiteRunId: null, playProvider: null, playModel: null,
  startedAt: "2026-11-26T00:00:00Z", endedAt: null, stopReason: null, waitReason: null, ...extra,
});
const pipeline = (active: PipelineRun | null, latest: PipelineRun | null = active): PipelineRecord => ({
  id: 1, workspaceId: 1, workspaceName: "Demo", name: "Release", description: "", autoReassign: false,
  createdAt: "", updatedAt: "", stages: [], active, latest,
});
const gate = (promptId: number, workspaceName = "Demo"): RemoteGate => ({ promptId, key: null, title: `Gate ${promptId}`, workspaceName, question: "Which one?", since: null });

test("the first poll is a silent baseline; later polls announce only changes", () => {
  const first = diffNotices(null, [pipeline(run("a", "WAITING_HUMAN"))], [gate(1)]);
  assert.deepEqual(first.notices, [], "a restart does not re-announce what already existed");
  const same = diffNotices(first.marks, [pipeline(run("a", "WAITING_HUMAN"))], [gate(1)]);
  assert.deepEqual(same.notices, []);
  const gateOnly = diffNotices(same.marks, [pipeline(run("a", "WAITING_HUMAN"))], [gate(1), gate(2)]);
  assert.deepEqual(gateOnly.notices.map(notice => notice.kind), ["gate"]);
});

test("a parked rail is announced once, unless a new gate in its workspace already explains it", () => {
  const playing = diffNotices(null, [pipeline(run("a", "PLAYING"))], []);
  const parked = diffNotices(playing.marks, [pipeline(run("a", "WAITING_HUMAN", { waitReason: "execution:budget_exhausted" }))], []);
  assert.deepEqual(parked.notices, [{ kind: "pipeline_waiting", pipelineId: 1, name: "Release", workspaceName: "Demo", reason: "execution:budget_exhausted" }]);
  const explained = diffNotices(playing.marks, [pipeline(run("a", "WAITING_HUMAN"))], [gate(5)]);
  assert.deepEqual(explained.notices.map(notice => notice.kind), ["gate"]);
  const elsewhere = diffNotices(playing.marks, [pipeline(run("a", "WAITING_HUMAN"))], [gate(5, "Other")]);
  assert.deepEqual(elsewhere.notices.map(notice => notice.kind), ["gate", "pipeline_waiting"]);
});

test("a finished, stopped or interrupted run is announced from the pipeline's latest run", () => {
  const playing = diffNotices(null, [pipeline(run("a", "PLAYING"))], []);
  for (const state of ["COMPLETE", "STOPPED", "INTERRUPTED"] as const) {
    const ended = diffNotices(playing.marks, [pipeline(null, run("a", state, { stopReason: state === "COMPLETE" ? null : "operator" }))], []);
    assert.deepEqual(ended.notices.map(notice => notice.kind === "pipeline_ended" ? notice.state : notice.kind), [state]);
  }
  const replaced = diffNotices(playing.marks, [pipeline(run("b", "PLAYING"), run("b", "PLAYING"))], []);
  assert.deepEqual(replaced.notices, [], "a run that vanished without a terminal record says nothing");
});

test("chat text escapes everything agents and users wrote, and controls follow access", () => {
  assert.equal(escapeHtml(`<b>&"</b>`), "&lt;b&gt;&amp;\"&lt;/b&gt;");
  const hostile = { ...gate(1), title: "<script>", question: "<a href='x'>click</a>" };
  const token = () => "x:AAAAAAAAAAAA";
  const control = noticeMessage({ kind: "gate", gate: hostile }, "control", token);
  assert.doesNotMatch(control.text, /<script>|<a /);
  assert.ok(control.markup && "inline_keyboard" in control.markup);
  const notify = noticeMessage({ kind: "gate", gate: hostile }, "notify", token);
  assert.equal(notify.markup, undefined, "notify-only notices carry no Answer button");
  assert.match(notify.text, /Answer it in Hydra/);
  const listed = gatesMessage([gate(1)], "notify", token);
  assert.ok(listed.markup && "inline_keyboard" in listed.markup);
  assert.equal(listed.markup.inline_keyboard.flat().some(button => button.text.startsWith("✍️")), false);
  const many = pipelinesMessage({ runs: [], gates: [], pipelines: Array.from({ length: 40 }, (_, index) => ({ id: index, name: `Pipeline ${"x".repeat(200)} ${index}`, workspaceName: "Demo", state: null, waitReason: null, currentSuite: null, current: null, next: null, done: 0, total: 3 })) }, "control", token);
  assert.ok(many.text.length <= 4096, "messages stay under Telegram's limit");
  assert.ok(many.markup && "inline_keyboard" in many.markup && many.markup.inline_keyboard.flat().every(button => button.text.length <= 40));
});

test("the bot API client rejects malformed tokens and never echoes the token in errors", async () => {
  assert.equal(isBotToken("123456:abcdefghijklmnopqrstuvwxyz0123456789"), true);
  assert.equal(isBotToken("123456:short"), false);
  assert.equal(isBotToken("../../etc:abcdefghijklmnopqrstuvwxyz0123456789"), false);
  assert.throws(() => createBotApi("not a token"), TelegramApiError);
  const token = "123456:abcdefghijklmnopqrstuvwxyz0123456789";
  const urls: string[] = [];
  const unreachable = createBotApi(token, (async (url: string | URL | Request) => { urls.push(String(url)); throw new Error(`connect ECONNREFUSED ${String(url)}`); }) as typeof fetch);
  await assert.rejects(unreachable.getMe(), (error: Error) => error instanceof TelegramApiError && error.status === 0 && !error.message.includes(token));
  assert.equal(urls[0], `https://api.telegram.org/bot${token}/getMe`);
  const echoing = createBotApi(token, (async () => new Response(JSON.stringify({ ok: false, description: `Unauthorized for ${token}`, parameters: { retry_after: 3 } }), { status: 401 })) as typeof fetch);
  await assert.rejects(echoing.getMe(), (error: Error) => error instanceof TelegramApiError && error.status === 401 && !error.message.includes(token) && error.retryAfterSeconds === 3);
  const unchanged = createBotApi(token, (async () => new Response(JSON.stringify({ ok: false, description: "Bad Request: message is not modified" }), { status: 400 })) as typeof fetch);
  await unchanged.editMessageText(1, 2, "same");
});
