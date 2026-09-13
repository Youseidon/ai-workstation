import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { setPipelineStationStarter } from "./pipelineScheduler.ts";
import { TaskControlService } from "./taskControl.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

function service(botId = `fake-bot-${Date.now()}-${Math.random()}`) {
  return new TaskControlService({
    enabled: true,
    notificationsEnabled: true,
    remoteActionsEnabled: true,
    transport: "fake_telegram",
    botId,
  });
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "task-control-"));
  const workspace = workspaces.create({ name: dir, workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: "Task", content: "Use an owner-supplied list" }) as PromptRecord;
  const runId = `tc-run-${workspace.id}`;
  workspaces.beginAgentRun({ runId, workspaceId: workspace.id, promptId: prompt.id, provider: "claude", model: null, tokenHash: runId, expiresAt: new Date(Date.now() + 60000).toISOString(), role: "execute" });
  workspaces.finishAgentRun(runId, "done");
  workspaces.respondToBlockedPrompt(prompt.id, { content: "Prior answer" });
  const handoff = workspaces.createHandoff({ id: `tc-handoff-${workspace.id}`, workspaceId: workspace.id, promptId: prompt.id, sourceRunId: runId, provider: "claude", model: null });
  workspaces.updateHandoff(handoff.id, { state: "READY", recommendation: "WAIT_FOR_HUMAN", completedAt: new Date(Date.now() + 1000).toISOString() });
  return { workspace, suite, prompt, handoffId: handoff.id, cleanup() { workspaces.remove(workspace.id); rmSync(dir, { recursive: true, force: true }); } };
}

async function refreshQuestion(f: ReturnType<typeof fixture>): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 5));
  workspaces.updateHandoff(f.handoffId, { completedAt: new Date().toISOString() });
}

test("task-control capability is disabled by default with production gates visible", () => {
  const capability = new TaskControlService({
    enabled: false,
    notificationsEnabled: false,
    remoteActionsEnabled: false,
    transport: "fake_telegram",
    botId: "fake-bot",
  }).capability();
  assert.equal(capability.enabled, false);
  assert.equal(capability.transport, "disabled");
  assert.equal(capability.gates.length, 4);
  assert(capability.gates.every(gate => gate.status === "blocked"));
});

test("task-control capability follows its dynamic settings source while production gates stay blocked", () => {
  let enabled = false;
  const control = new TaskControlService(() => ({
    enabled,
    notificationsEnabled: enabled,
    remoteActionsEnabled: false,
    transport: "fake_telegram",
    botId: "test-fake-bot",
  }));
  assert.equal(control.capability().enabled, false);
  enabled = true;
  const capability = control.capability();
  assert.equal(capability.enabled, true);
  assert.equal(capability.notificationsEnabled, true);
  assert.equal(capability.remoteActionsEnabled, false);
  assert.equal(capability.transport, "fake_telegram");
  assert.equal(capability.status, "blocked");
  assert(capability.gates.every(gate => gate.status === "blocked"));
});

test("fake Telegram saves an answer, reissues current actions, and resumes once", async () => {
  const f = fixture();
  let starts = 0;
  const botId = `fake-bot-save-${f.workspace.id}`;
  let actorId: string | null = null;
  try {
    workspaces.addPipelineStep(f.prompt.id, { provider: "claude" });
    const suiteRun = workspaces.createPipelineRun({ id: `tc-suite-${f.workspace.id}`, suiteId: f.suite.id, workspaceId: f.workspace.id, playProvider: "claude", playModel: null });
    workspaces.updatePipelineRun(suiteRun.id, { state: "WAITING_HUMAN", currentPromptId: f.prompt.id });
    setPipelineStationStarter(async () => {
      starts++;
      const runId = `tc-resume-${f.workspace.id}`;
      workspaces.beginAgentRun({ runId, workspaceId: f.workspace.id, promptId: f.prompt.id, provider: "claude", model: null, tokenHash: "test", expiresAt: new Date().toISOString() });
      return { runId };
    });
    const control = service(botId);
    const actor = control.enrollFakeActor({ transportUserId: "101", chatId: "9001", topicId: "7", label: "Owner" });
    actorId = actor.id;
    await refreshQuestion(f);
    const first = control.postPersonalQuestion(f.prompt.id, actor.id, { provider: "claude" });
    assert.equal(workspaces.telegramOutbox().at(-1)?.state, "QUEUED");
    const save = first.actions.find(action => action.action === "save_human_response")!;
    const saved = await control.handleCallback({ ref: save.ref, transportUserId: "101", chatId: "9001", topicId: "7", botId, messageId: `question-${f.prompt.id}`, commandId: "cmd-save", content: "Use directory.example" });
    assert.equal(saved.state, "APPLIED");
    assert.equal(saved.started, false);
    assert.equal(workspaces.humanInputState(f.prompt.id).savedResponseId, saved.responseId);

    await refreshQuestion(f);
    const second = control.postPersonalQuestion(f.prompt.id, actor.id, { provider: "claude" });
    const resume = second.actions.find(action => action.action === "answer_and_resume")!;
    const applied = await control.handleCallback({ ref: resume.ref, transportUserId: "101", chatId: "9001", topicId: "7", botId, messageId: `question-${f.prompt.id}`, commandId: "cmd-resume", content: "Use directory.example" });
    assert.equal(applied.state, "APPLIED", applied.message);
    assert.equal(applied.started, true);
    const duplicate = await control.handleCallback({ ref: resume.ref, transportUserId: "101", chatId: "9001", topicId: "7", botId, messageId: `question-${f.prompt.id}`, commandId: "cmd-resume-duplicate", content: "Use directory.example" });
    assert.equal(duplicate.commandId, applied.commandId);
    assert.equal(duplicate.runId, applied.runId);
    assert.equal(starts, 1);
  } finally { setPipelineStationStarter(null); if (actorId !== null) workspaces.removeTaskControlActor(actorId); workspaces.removeTelegramRecordsForBot(botId); f.cleanup(); }
});

test("fake Telegram rejects wrong actor and stale question without mutating the task", async () => {
  const f = fixture();
  const botId = `fake-bot-reject-${f.workspace.id}`;
  let actorId: string | null = null;
  try {
    const control = service(botId);
    const actor = control.enrollFakeActor({ transportUserId: "101", chatId: "9001", topicId: null, label: "Owner" });
    actorId = actor.id;
    await refreshQuestion(f);
    const card = control.postPersonalQuestion(f.prompt.id, actor.id, { provider: "claude" });
    const save = card.actions.find(action => action.action === "save_human_response")!;
    const wrong = await control.handleCallback({ ref: save.ref, transportUserId: "202", chatId: "9001", botId, messageId: `question-${f.prompt.id}`, commandId: "cmd-wrong", content: "Wrong" });
    assert.equal(wrong.state, "REJECTED");
    assert.equal(wrong.errorCode, "actor_not_enrolled");
    assert.equal(workspaces.humanInputState(f.prompt.id).savedResponseId, null);

    workspaces.updateChild("prompt", f.prompt.id, { content: "Use a changed criterion" });
    const stale = await control.handleCallback({ ref: save.ref, transportUserId: "101", chatId: "9001", botId, messageId: `question-${f.prompt.id}`, commandId: "cmd-stale", content: "Owner answer" });
    assert.equal(stale.state, "REJECTED");
    assert.equal(stale.errorCode, "question_changed");
    assert.equal(workspaces.humanInputState(f.prompt.id).savedResponseId, null);
  } finally { if (actorId !== null) workspaces.removeTaskControlActor(actorId); workspaces.removeTelegramRecordsForBot(botId); f.cleanup(); }
});

test("fake outbox delivery records send failure without claiming action application", async () => {
  const f = fixture();
  const botId = `fake-bot-outbox-${f.workspace.id}`;
  let actorId: string | null = null;
  try {
    const control = service(botId);
    const actor = control.enrollFakeActor({ transportUserId: "101", chatId: "9001", label: "Owner" });
    actorId = actor.id;
    await refreshQuestion(f);
    const card = control.postPersonalQuestion(f.prompt.id, actor.id, { provider: "claude" });
    control.markQuestionDeliveryFailed(card.outboxId, "fake timeout");
    const outbox = workspaces.telegramOutbox().find(row => row.id === card.outboxId)!;
    assert.equal(outbox.state, "FAILED");
    assert.equal(outbox.attemptCount, 1);
    assert.match(outbox.lastError!, /fake timeout/);
    assert.equal(workspaces.humanInputState(f.prompt.id).savedResponseId, null);
  } finally { if (actorId !== null) workspaces.removeTaskControlActor(actorId); workspaces.removeTelegramRecordsForBot(botId); f.cleanup(); }
});

test("task-control rejects remote callbacks while controls are disabled", async () => {
  const disabled = new TaskControlService({
    enabled: true,
    notificationsEnabled: true,
    remoteActionsEnabled: false,
    transport: "fake_telegram",
    botId: "fake-bot",
  });
  await assert.rejects(
    disabled.handleCallback({ ref: "missing", transportUserId: "101", chatId: "9001", botId: "fake-bot", commandId: "cmd-disabled", content: "Nope" }),
    (error: unknown) => error instanceof WorkspaceError && error.code === "remote_actions_disabled",
  );
});
