import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { ProgramRecord, PromptRecord, QuotaWarning, SuiteRecord } from "@agent-console/shared";
import { setPipelineStationStarter } from "../src/pipelineScheduler.ts";
import { TaskControlService } from "../src/taskControl.ts";
import { mintItemId } from "../src/teamItems.ts";
import { CONTROL_STATES, isLiveHandoverState, type ControlRecord, type ControlState } from "../src/teamControlRecord.ts";
import { WorkspaceError, workspaces } from "../src/workspaces.ts";

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
  // Upstream's end-of-run ladder records UNREPORTED, not BLOCKED, when a run ends
  // without posting a status, so the block this fixture answers is posted
  // explicitly before the run is finished.
  workspaces.updateAgentStatus(runId, {
    requestId: `blocked-${runId}`, expectedStatus: "IN_PROGRESS", status: "BLOCKED",
    reason: "The owner must supply the trade directory.",
    verificationSummary: "Supply the owner's trade directory.",
  });
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
  assert.equal(capability.setup, "disabled");
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
  assert.equal(capability.setup, "fake_only");
  assert.equal(capability.status, "blocked");
  assert(capability.gates.every(gate => gate.status === "blocked"));
});

test("task-control capability exposes local Telegram setup state without secrets", () => {
  const fakeOnly = new TaskControlService({
    enabled: true,
    notificationsEnabled: true,
    remoteActionsEnabled: true,
    transport: "fake_telegram",
    botId: "local-fake-bot",
  }).capability();
  assert.equal(fakeOnly.setup, "fake_only");
  assert.equal(fakeOnly.transport, "fake_telegram");

  const telegramConfigured = new TaskControlService({
    enabled: true,
    notificationsEnabled: true,
    remoteActionsEnabled: true,
    transport: "telegram",
    botId: "local-telegram-bot",
  }).capability();
  assert.equal(telegramConfigured.setup, "telegram_configured");
  assert.equal(telegramConfigured.transport, "telegram");
  assert.equal(JSON.stringify(telegramConfigured).includes("token"), false);
  assert.equal(JSON.stringify(telegramConfigured).includes("chat"), false);
});

test("fake pairing is single-use, context-bound, and expires", async () => {
  const control = service("fake-bot-pairing");
  const pairing = control.createPairingChallenge({ chatId: "chat-a", topicId: "topic-a", label: "Owner" });
  assert.throws(
    () => control.confirmPairing({ challenge: pairing.challenge, transportUserId: "101", chatId: "chat-b", topicId: "topic-a" }),
    (error: unknown) => error instanceof WorkspaceError && error.code === "pairing_context_mismatch",
  );
  const actor = control.confirmPairing({ challenge: pairing.challenge, transportUserId: "101", chatId: "chat-a", topicId: "topic-a" });
  try {
    assert.match(actor.id, /fake_telegram-101-chat-a-topic-a/);
    assert.throws(
      () => control.confirmPairing({ challenge: pairing.challenge, transportUserId: "101", chatId: "chat-a", topicId: "topic-a" }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "pairing_consumed",
    );

    const expired = control.createPairingChallenge({ chatId: "chat-a", label: "Expired", ttlMs: -1 });
    assert.throws(
      () => control.confirmPairing({ challenge: expired.challenge, transportUserId: "202", chatId: "chat-a" }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "pairing_expired",
    );
  } finally {
    workspaces.removeTaskControlActor(actor.id);
    workspaces.removeTelegramRecordsForBot("fake-bot-pairing");
  }
});

test("fake Telegram saves an answer, reissues current actions, and resumes once", async () => {
  const f = fixture();
  let starts = 0;
  const botId = `fake-bot-save-${f.workspace.id}`;
  let actorId: string | null = null;
  try {
    // Upstream's flowchart steps hang off a named pipeline, so a suite run with
    // no named parent resolves no steps and completes instead of starting a
    // station. The parked run is parented and stepped, the way a played one is.
    const flowchart = workspaces.createPipeline({ workspaceId: f.workspace.id, name: `tc-flow-${f.workspace.id}`, suiteIds: [f.suite.id] });
    workspaces.addNamedPipelineStep(flowchart.id, f.prompt.id, { provider: "claude" });
    const namedRun = workspaces.createNamedPipelineRun({ id: `tc-named-${f.workspace.id}`, pipelineId: flowchart.id, workspaceId: f.workspace.id, playProvider: "claude", playModel: null });
    const suiteRun = workspaces.createPipelineRun({ id: `tc-suite-${f.workspace.id}`, suiteId: f.suite.id, workspaceId: f.workspace.id, playProvider: "claude", playModel: null, pipelineRunId: namedRun.id });
    workspaces.updatePipelineRun(suiteRun.id, { state: "WAITING_HUMAN", currentPromptId: f.prompt.id });
    workspaces.updateNamedPipelineRun(namedRun.id, { state: "WAITING_HUMAN", currentSuiteId: f.suite.id, currentSuiteRunId: suiteRun.id });
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

    const wrongBot = await control.handleCallback({ ref: save.ref, transportUserId: "101", chatId: "9001", botId: "other-bot", messageId: `question-${f.prompt.id}`, commandId: "cmd-wrong-bot", content: "Owner answer" });
    assert.equal(wrongBot.state, "REJECTED");
    assert.equal(wrongBot.errorCode, "wrong_bot");

    const wrongTopic = await control.handleCallback({ ref: save.ref, transportUserId: "101", chatId: "9001", topicId: "other-topic", botId, messageId: `question-${f.prompt.id}`, commandId: "cmd-wrong-topic", content: "Owner answer" });
    assert.equal(wrongTopic.state, "REJECTED");
    assert.equal(wrongTopic.errorCode, "wrong_chat");

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

test("fake question payload is sanitized for phone rendering", async () => {
  const f = fixture();
  const botId = `fake-bot-render-${f.workspace.id}`;
  let actorId: string | null = null;
  try {
    workspaces.updateChild("prompt", f.prompt.id, { title: "Inspect http://localhost:4000 and token=sk-ant-secretvalue" });
    const control = service(botId);
    const actor = control.enrollFakeActor({ transportUserId: "101", chatId: "9001", label: "Owner" });
    actorId = actor.id;
    await refreshQuestion(f);
    const card = control.postPersonalQuestion(f.prompt.id, actor.id, { provider: "claude" });
    const payload = workspaces.telegramOutbox().find(row => row.id === card.outboxId)?.payload as { title: string; question: string };
    assert.equal(payload.title.includes("localhost"), false);
    assert.equal(payload.title.includes("sk-ant-secretvalue"), false);
    assert.match(payload.title, /\[redacted\]/);
    assert.equal(JSON.stringify(payload).includes("sourceRunId"), false);
  } finally { if (actorId !== null) workspaces.removeTaskControlActor(actorId); workspaces.removeTelegramRecordsForBot(botId); f.cleanup(); }
});

test("fake Telegram quota warning is sanitized, outbox-only, and advisory", () => {
  const f = fixture();
  const botId = `fake-bot-quota-${f.workspace.id}`;
  const db = new Database(workspaces.databasePath);
  let actorId: string | null = null;
  try {
    const control = service(botId);
    const actor = control.enrollFakeActor({ transportUserId: "101", chatId: "9001", topicId: "quota", label: "Owner" });
    actorId = actor.id;
    const beforeOutbox = workspaces.telegramOutbox().filter(row => row.botId === botId).length;
    const beforeActions = (db.prepare("SELECT count(*) count FROM task_control_action WHERE bot_id=?").get(botId) as { count: number }).count;
    const beforePrompt = workspaces.promptActivity(f.prompt.id);
    const warning: QuotaWarning = {
      id: "quota_test",
      provider: "claude",
      windowKind: "session",
      windowIdentity: "claude:session:2026-09-13T10:00:00.000Z",
      remainingPercent: 5,
      usedPercent: 95,
      fetchedAt: "2026-09-13T09:00:00.000Z",
      freshness: "fresh",
      message: "Claude quota near token=sk-ant-secretvalue at http://localhost:4000/internal",
      choices: [
        { id: "continue", label: "Continue" },
        { id: "prepare_pause", label: "Prepare to pause" },
        { id: "review_takeover", label: "Review takeover" },
      ],
    };

    const queued = control.postQuotaWarning(actor.id, warning);
    const outbox = workspaces.telegramOutbox().find(row => row.id === queued.outboxId)!;
    assert.equal(workspaces.telegramOutbox().filter(row => row.botId === botId).length, beforeOutbox + 1);
    assert.equal(outbox.state, "QUEUED");
    assert.equal(outbox.botId, botId);
    assert.equal(outbox.chatId, "9001");
    assert.equal(outbox.topicId, "quota");
    assert.deepEqual(outbox.payload, {
      kind: "quota_warning",
      warningId: "quota_test",
      provider: "claude",
      window: "session",
      message: "Claude quota near [redacted] at [redacted]",
      choices: ["Continue", "Prepare to pause", "Review takeover"],
    });
    assert.equal((db.prepare("SELECT count(*) count FROM task_control_action WHERE bot_id=?").get(botId) as { count: number }).count, beforeActions);

    control.markQuestionDelivered(queued.outboxId);
    const delivered = workspaces.telegramOutbox().find(row => row.id === queued.outboxId)!;
    assert.equal(delivered.state, "SENT");
    assert.equal(delivered.attemptCount, 1);
    assert.equal(workspaces.humanInputState(f.prompt.id).savedResponseId, beforePrompt.humanInput.savedResponseId);
    const afterPrompt = workspaces.promptActivity(f.prompt.id);
    assert.equal(afterPrompt.item.prompt.status, beforePrompt.item.prompt.status);
    assert.equal(afterPrompt.item.operationalState, beforePrompt.item.operationalState);
    assert.equal(afterPrompt.sessions.length, beforePrompt.sessions.length);
    assert.equal(afterPrompt.remarks.length, beforePrompt.remarks.length);
  } finally {
    db.close();
    if (actorId !== null) workspaces.removeTaskControlActor(actorId);
    workspaces.removeTelegramRecordsForBot(botId);
    f.cleanup();
  }
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

test("capability reports a missing live token instead of 'Telegram configured'", async () => {
  const { withLiveTokenState } = await import("../src/taskControl.ts");
  const configured = { enabled: true, notificationsEnabled: true, remoteActionsEnabled: true, transport: "telegram" as const, status: "ready" as const, setup: "telegram_configured" as const, reason: "Local Telegram setup is configured and gated for personal task-control actions.", gates: [] };
  assert.deepEqual(withLiveTokenState(configured, true), configured);
  const missing = withLiveTokenState(configured, false);
  assert.equal(missing.setup, "telegram_missing_token");
  assert.match(missing.reason, /TELEGRAM_BOT_TOKEN/);
  const fake = { ...configured, transport: "fake_telegram" as const, setup: "fake_only" as const };
  assert.deepEqual(withLiveTokenState(fake, false), fake);
});

/*
 * H07, ruling 7 of 2026-09-22: `/close` is refused while a handover is live.
 *
 * The close path revokes every grant and ends the item, in that order, so a
 * guard placed any later than this one has already destroyed what it was meant
 * to protect. `teamResultApply.test.ts` walks the whole path with a real
 * control record; this covers the decision itself, state by state, and the two
 * entry points that reach it.
 */
test("H07: close_thread is refused in every live handover state and applies in every other one", async () => {
  const directory = mkdtempSync(join(tmpdir(), "h07-close-guard-"));
  const workspace = workspaces.create({ name: directory, workDirectory: directory });
  const botId = `telegram-h07-${workspace.id}`;
  const teamId = `team-h07-${workspace.id}`;
  const groupChatId = `group-h07-${workspace.id}`;
  try {
    const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
    const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
    const prompt = workspaces.createChild("prompt", suite.id, { title: "Owner item", content: "Finish the work" }) as PromptRecord;
    workspaces.upsertTeamRoster({
      teamId, groupChatId, remoteUrl: "local", revision: "r1",
      record: {
        version: 1, teamId, groupChatId, remoteUrl: "local", usedInviteIds: [], commandIds: [], updatedAt: new Date().toISOString(),
        members: [
          { personId: "jd", telegramUserId: "101", botId, botUsername: "owner_bot", workstationId: botId, workstationLabel: "jd-laptop", personLabel: "jd" },
          { personId: "yousef", telegramUserId: "202", botId: "telegram-yousef", botUsername: "yousef_bot", workstationId: "ws-yousef", workstationLabel: "yousef-desktop", personLabel: "yousef" },
        ],
      },
    });
    const owner = workspaces.upsertTeamGroupActor({ id: `h07-owner-${workspace.id}`, transport: "fake_telegram", transportUserId: "101", chatId: groupChatId, label: "jd" });

    const record = (state: ControlState, itemId: string): ControlRecord => ({
      version: 1, itemId, state, epoch: 1, requester: "jd",
      executor: state === "RETURNED" || state === "APPLYING" ? null : "yousef",
      branch: `aw/handover/${itemId}`, lastCommandId: null, offerDeadline: null, resultLabel: null,
      updatedAt: new Date().toISOString(),
    });

    /** One `/close` on a fresh item whose handover is in `state`, tapped. */
    const close = async (state: ControlState | null) => {
      const item = workspaces.createItemLink({ itemId: mintItemId(), promptId: prompt.id, role: "requester", epoch: 1 });
      const ref = `h07-close-${item.itemId}`;
      workspaces.grantItemCapability({ itemId: item.itemId, personId: "yousef", capability: "context", commandId: `${ref}-grant` });
      workspaces.createTaskControlAction({
        ref, action: "close_thread", promptId: prompt.id, actorId: owner.id, chatId: groupChatId, botId,
        messageId: "close-card", expectedRevision: workspaces.humanInputState(prompt.id).revision,
        expiresAt: "2099-01-01T00:00:00.000Z", subjectKind: "item", itemId: item.itemId,
      });
      const control = new TaskControlService({
        enabled: true, teamEnabled: true, handoverEnabled: true,
        notificationsEnabled: true, remoteActionsEnabled: true, transport: "fake_telegram", botId,
      });
      control.registerHandoverStateProbe(async itemId => (state === null ? null : record(state, itemId)));
      const receipt = await control.handleCallback({ ref, transportUserId: "101", chatId: groupChatId, botId, messageId: "close-card", commandId: `${ref}-command` });
      return {
        receipt,
        closed: workspaces.itemLink(item.itemId)!.closedAt !== null,
        granted: workspaces.hasItemCapability(item.itemId, "yousef", "context"),
      };
    };

    for (const state of CONTROL_STATES) {
      const outcome = await close(state);
      if (isLiveHandoverState(state)) {
        assert.equal(outcome.receipt.state, "REJECTED", `${state} is live, so the close is refused`);
        assert.equal(outcome.receipt.errorCode, "handover_live", `${state} refuses with its own code`);
        assert.match(outcome.receipt.message ?? "", /live handover/, `${state} says a handover is live`);
        assert.equal(outcome.closed, false, `${state} leaves the item open`);
        assert.equal(outcome.granted, true, `${state} revokes nothing: the guard stands before the revoke`);
      } else {
        assert.equal(outcome.receipt.state, "APPLIED", `${state} is not live, so the close still applies`);
        assert.equal(outcome.receipt.message, "Thread closed; grants ended.");
        assert.equal(outcome.closed, true, `${state} closes the item`);
        assert.equal(outcome.granted, false, `${state} ends the grants with it`);
      }
    }

    // An item that was never handed over has no record at all, and closes.
    const never = await close(null);
    assert.equal(never.receipt.state, "APPLIED", "an item with no control record closes as it always did");
    assert.equal(never.closed, true);

    // The states the ruling names, in the words the owner is given.
    const returned = await close("RETURNED");
    assert.match(returned.receipt.message ?? "", /Apply the returned work or cancel the handover first/);
    const claimed = await close("CLAIMED");
    assert.match(claimed.receipt.message ?? "", /yousef is holding .* \(CLAIMED\)/, "and a held item names who holds it");

    // A probe that cannot read the record refuses rather than closing: the
    // close never proceeds on a state nobody could check.
    const unreadable = workspaces.createItemLink({ itemId: mintItemId(), promptId: prompt.id, role: "requester", epoch: 1 });
    workspaces.createTaskControlAction({
      ref: `h07-unreadable-${unreadable.itemId}`, action: "close_thread", promptId: prompt.id, actorId: owner.id, chatId: groupChatId, botId,
      messageId: "close-card", expectedRevision: workspaces.humanInputState(prompt.id).revision,
      expiresAt: "2099-01-01T00:00:00.000Z", subjectKind: "item", itemId: unreadable.itemId,
    });
    const blind = new TaskControlService({
      enabled: true, teamEnabled: true, handoverEnabled: true,
      notificationsEnabled: true, remoteActionsEnabled: true, transport: "fake_telegram", botId,
    });
    blind.registerHandoverStateProbe(async () => { throw new WorkspaceError(502, "control_git_failed", "Git control record operation failed."); });
    const refused = await blind.handleCallback({ ref: `h07-unreadable-${unreadable.itemId}`, transportUserId: "101", chatId: groupChatId, botId, messageId: "close-card", commandId: "h07-unreadable-command" });
    assert.equal(refused.state, "REJECTED", "a record that cannot be read refuses the close");
    assert.equal(refused.errorCode, "control_git_failed");
    assert.equal(workspaces.itemLink(unreadable.itemId)!.closedAt, null, "and destroys nothing");
  } finally {
    const db = new Database(workspaces.databasePath);
    try { db.prepare("DELETE FROM team_roster WHERE team_id=?").run(teamId); } finally { db.close(); }
    workspaces.removeTelegramRecordsForBot(botId);
    workspaces.removeTaskControlActor(`h07-owner-${workspace.id}`);
    workspaces.remove(workspace.id);
    rmSync(directory, { recursive: true, force: true });
  }
});
