import assert from "node:assert/strict";
import test from "node:test";
import { TelegramAdapter } from "./integrations/telegram/adapter.ts";
import { FakeTelegramBotApi } from "./integrations/telegram/fakeBotApi.ts";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPipelineStationStarter } from "./pipelineScheduler.ts";
import { TaskControlService } from "./taskControl.ts";
import { workspaces } from "./workspaces.ts";

function service(botId: string) {
  return new TaskControlService({
    enabled: true,
    notificationsEnabled: true,
    remoteActionsEnabled: true,
    transport: "fake_telegram",
    botId,
  });
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "telegram-e2e-"));
  const workspace = workspaces.create({ name: dir, workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: "Task", content: "Use an owner-supplied list" }) as PromptRecord;
  const runId = `tg-run-${workspace.id}`;
  workspaces.beginAgentRun({ runId, workspaceId: workspace.id, promptId: prompt.id, provider: "claude", model: null, tokenHash: runId, expiresAt: new Date(Date.now() + 60000).toISOString(), role: "execute" });
  workspaces.finishAgentRun(runId, "done");
  workspaces.respondToBlockedPrompt(prompt.id, { content: "Prior answer" });
  const handoff = workspaces.createHandoff({ id: `tg-handoff-${workspace.id}`, workspaceId: workspace.id, promptId: prompt.id, sourceRunId: runId, provider: "claude", model: null });
  workspaces.updateHandoff(handoff.id, { state: "READY", recommendation: "WAIT_FOR_HUMAN", completedAt: new Date(Date.now() + 1000).toISOString() });
  return { workspace, suite, prompt, handoffId: handoff.id, cleanup() { workspaces.remove(workspace.id); rmSync(dir, { recursive: true, force: true }); } };
}

async function refreshQuestion(f: ReturnType<typeof fixture>): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 5));
  workspaces.updateHandoff(f.handoffId, { completedAt: new Date().toISOString() });
}

test("fake Telegram polling persists updates before advancing the offset and ignores duplicates", async () => {
  const botId = `fake-poll-${Date.now()}`;
  const api = new FakeTelegramBotApi();
  const adapter = new TelegramAdapter(botId, api);
  try {
    api.pushUpdate({ updateId: 10, payload: { message: "first" } });
    api.pushUpdate({ updateId: 11, payload: { message: "second" } });

    const first = await adapter.pollOnce();
    assert.equal(first.fetched, 2);
    assert.equal(first.saved, 2);
    assert.equal(first.nextOffset, 12);
    assert.equal(workspaces.telegramCursor(botId), 12);
    assert.deepEqual(workspaces.telegramInbox(botId).map(update => update.updateId), [10, 11]);

    workspaces.advanceTelegramCursor(botId, 10);
    const duplicate = await adapter.pollOnce();
    assert.equal(duplicate.fetched, 2);
    assert.equal(duplicate.saved, 0);
    assert.equal(workspaces.telegramCursor(botId), 12);
    assert.equal(workspaces.telegramInbox(botId).length, 2);
  } finally {
    workspaces.removeTelegramRecordsForBot(botId);
  }
});

test("fake Telegram outbox send failure is durable and retry can later mark sent", async () => {
  const botId = `fake-send-${Date.now()}`;
  const api = new FakeTelegramBotApi();
  const adapter = new TelegramAdapter(botId, api);
  try {
    const outboxId = workspaces.enqueueTelegramOutbox({
      botId,
      chatId: "chat-1",
      topicId: "topic-1",
      payload: { text: "question" },
    });

    api.failNextSend("fake timeout");
    assert.equal(await adapter.sendOutbox(outboxId), "FAILED");
    let row = workspaces.telegramOutbox().find(entry => entry.id === outboxId)!;
    assert.equal(row.state, "FAILED");
    assert.equal(row.attemptCount, 1);
    assert.equal(row.lastError, "fake timeout");

    assert.equal(await adapter.sendOutbox(outboxId), "SENT");
    row = workspaces.telegramOutbox().find(entry => entry.id === outboxId)!;
    assert.equal(row.state, "SENT");
    assert.equal(row.attemptCount, 2);
    assert.equal(api.sent.length, 1);
  } finally {
    workspaces.removeTelegramRecordsForBot(botId);
  }
});

test("fake Telegram E2E posts a question, processes callbacks, and resumes once", async () => {
  const f = fixture();
  const botId = `fake-e2e-${f.workspace.id}`;
  const api = new FakeTelegramBotApi();
  const control = service(botId);
  const adapter = new TelegramAdapter(botId, api, control);
  let actorId: string | null = null;
  let starts = 0;
  try {
    workspaces.addPipelineStep(f.prompt.id, { provider: "claude" });
    const suiteRun = workspaces.createPipelineRun({ id: `tg-suite-${f.workspace.id}`, suiteId: f.suite.id, workspaceId: f.workspace.id, playProvider: "claude", playModel: null });
    workspaces.updatePipelineRun(suiteRun.id, { state: "WAITING_HUMAN", currentPromptId: f.prompt.id });
    setPipelineStationStarter(async () => {
      starts++;
      const runId = `tg-resumed-${f.workspace.id}`;
      workspaces.beginAgentRun({ runId, workspaceId: f.workspace.id, promptId: f.prompt.id, provider: "claude", model: null, tokenHash: "test", expiresAt: new Date().toISOString() });
      return { runId };
    });

    const pairing = control.createPairingChallenge({ chatId: "chat-e2e", topicId: "topic-e2e", label: "Owner" });
    const actor = control.confirmPairing({ challenge: pairing.challenge, transportUserId: "101", chatId: "chat-e2e", topicId: "topic-e2e" });
    actorId = actor.id;

    await refreshQuestion(f);
    const first = control.postPersonalQuestion(f.prompt.id, actor.id, { provider: "claude" });
    assert.equal(await adapter.sendOutbox(first.outboxId), "SENT");
    const save = first.actions.find(action => action.action === "save_human_response")!;
    api.pushUpdate({ updateId: 100, payload: { kind: "callback", ref: save.ref, transportUserId: "101", chatId: "chat-e2e", topicId: "topic-e2e", messageId: `question-${f.prompt.id}`, commandId: "e2e-save", content: "Use directory.example" } });
    assert.deepEqual(await adapter.pollOnce(), { fetched: 1, saved: 1, nextOffset: 101 });
    assert.deepEqual(await adapter.processPendingCallbacks(), { processed: 1, ignored: 0 });
    assert.notEqual(workspaces.humanInputState(f.prompt.id).savedResponseId, null);

    await refreshQuestion(f);
    const second = control.postPersonalQuestion(f.prompt.id, actor.id, { provider: "claude" });
    const resume = second.actions.find(action => action.action === "answer_and_resume")!;
    api.pushUpdate({ updateId: 101, payload: { kind: "callback", ref: resume.ref, transportUserId: "101", chatId: "chat-e2e", topicId: "topic-e2e", messageId: `question-${f.prompt.id}`, commandId: "e2e-resume", content: "Use directory.example" } });
    api.pushUpdate({ updateId: 102, payload: { kind: "callback", ref: resume.ref, transportUserId: "101", chatId: "chat-e2e", topicId: "topic-e2e", messageId: `question-${f.prompt.id}`, commandId: "e2e-resume-duplicate", content: "Use directory.example" } });
    assert.equal((await adapter.pollOnce()).saved, 2);
    assert.deepEqual(await adapter.processPendingCallbacks(), { processed: 2, ignored: 0 });
    assert.equal(starts, 1);
    assert.equal(workspaces.humanInputState(f.prompt.id).savedResponseId, null);
  } finally {
    setPipelineStationStarter(null);
    if (actorId !== null) workspaces.removeTaskControlActor(actorId);
    workspaces.removeTelegramRecordsForBot(botId);
    f.cleanup();
  }
});
