import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { TaskControlService } from "./taskControl.ts";
import { parseTeamItemGrantedCommand, renderTeamItemAccessMessage, renderTeamItemActionCard } from "./teamItemViews.ts";
import { formatTelegramMessage } from "./integrations/telegram/liveFormat.ts";
import { workspaces } from "./workspaces.ts";

test("T19 parses grant commands and renders access and action cards", () => {
  assert.deepEqual(parseTeamItemGrantedCommand("/grant all", "owner_bot"), { command: "grant", capabilities: ["context", "answer", "resume"] });
  assert.deepEqual(parseTeamItemGrantedCommand("/revoke answer", "owner_bot"), { command: "revoke", capabilities: ["answer"] });
  assert.deepEqual(parseTeamItemGrantedCommand("/answer Use blue", "owner_bot"), { command: "answer", answer: "Use blue" });
  assert.deepEqual(parseTeamItemGrantedCommand("/resume@owner_bot", "owner_bot"), { command: "resume" });
  assert.equal(parseTeamItemGrantedCommand("/grant provider", "owner_bot"), null);
  assert.equal(parseTeamItemGrantedCommand("/resume@other_bot", "owner_bot"), "other_bot");

  const access = renderTeamItemAccessMessage({
    itemId: "awi1_000000000000000000000000",
    ownerLabel: "jd-laptop",
    teammateLabel: "yousef-desktop",
    capabilities: ["answer"],
    actions: [{ ref: "grant-resume", action: "grant", capability: "resume" }, { ref: "revoke-answer", action: "revoke", capability: "answer" }],
  });
  const formattedAccess = formatTelegramMessage(access, () => null);
  assert.match(formattedAccess.text, /yousef-desktop: answer/);
  assert.deepEqual(formattedAccess.replyMarkup?.inline_keyboard.flat().map(button => button.text), ["Grant resume", "Revoke answer"]);

  const card = formatTelegramMessage(renderTeamItemActionCard({
    itemId: "awi1_000000000000000000000000",
    title: "Answer item question",
    detail: "Use blue",
    allowance: "Uses jd's claude allowance.",
    actions: [{ ref: "save", action: "save_human_response" }, { ref: "resume", action: "answer_and_resume" }],
  }), () => null);
  assert.match(card.text, /Uses jd's claude allowance/);
  assert.deepEqual(card.replyMarkup?.inline_keyboard.flat().map(button => button.text), ["Save answer", "Answer and resume"]);
});

test("T19 owner-bound grants apply once and revocation rejects an already-open teammate card", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm3-grant-actions-"));
  const workspace = workspaces.create({ name: directory, workDirectory: directory });
  const botId = `telegram-grants-${workspace.id}`;
  try {
    const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
    const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
    const prompt = workspaces.createChild("prompt", suite.id, { title: "Owner item", content: "Choose a colour" }) as PromptRecord;
    const item = workspaces.createItemLink({ promptId: prompt.id, role: "requester", epoch: 1 });
    const roster = {
      version: 1,
      teamId: `team-${workspace.id}`,
      groupChatId: `group-${workspace.id}`,
      remoteUrl: "local",
      members: [
        { personId: "jd", telegramUserId: "101", botId, botUsername: "owner_bot", workstationId: botId, workstationLabel: "jd-laptop" },
        { personId: "yousef", telegramUserId: "202", botId: "telegram-yousef", botUsername: "yousef_bot", workstationId: "ws-yousef", workstationLabel: "yousef-desktop" },
      ],
      usedInviteIds: [], commandIds: [], updatedAt: new Date().toISOString(),
    };
    workspaces.upsertTeamRoster({ teamId: roster.teamId, groupChatId: roster.groupChatId, remoteUrl: roster.remoteUrl, revision: "r1", record: roster });
    const owner = workspaces.upsertTeamGroupActor({ id: `owner-${workspace.id}`, transport: "fake_telegram", transportUserId: "101", chatId: roster.groupChatId, label: "jd" });
    const teammate = workspaces.upsertTeamGroupActor({ id: `teammate-${workspace.id}`, transport: "fake_telegram", transportUserId: "202", chatId: roster.groupChatId, label: "Yousef" });
    const revision = workspaces.humanInputState(prompt.id).revision;
    workspaces.createTaskControlAction({
      ref: `grant-${workspace.id}`, action: "grant", promptId: prompt.id, actorId: owner.id, chatId: roster.groupChatId, botId,
      messageId: "grant-card", expectedRevision: revision, expiresAt: "2099-01-01T00:00:00.000Z", subjectKind: "item", itemId: item.itemId,
      payload: { personId: "yousef", capabilities: ["answer"] },
    });
    const control = new TaskControlService({ enabled: true, teamEnabled: true, notificationsEnabled: true, remoteActionsEnabled: true, transport: "fake_telegram", botId });
    const grant = await control.handleCallback({ ref: `grant-${workspace.id}`, transportUserId: "101", chatId: roster.groupChatId, botId, messageId: "grant-card", commandId: "grant-command" });
    assert.equal(grant.state, "APPLIED");
    assert.equal(workspaces.hasItemCapability(item.itemId, "yousef", "answer"), true);
    const duplicate = await control.handleCallback({ ref: `grant-${workspace.id}`, transportUserId: "101", chatId: roster.groupChatId, botId, messageId: "grant-card", commandId: "grant-duplicate" });
    assert.equal(duplicate.commandId, grant.commandId);

    workspaces.createTaskControlAction({
      ref: `answer-${workspace.id}`, action: "save_human_response", promptId: prompt.id, actorId: teammate.id, chatId: roster.groupChatId, botId,
      messageId: "answer-card", expectedRevision: revision, expiresAt: "2099-01-01T00:00:00.000Z", subjectKind: "item", itemId: item.itemId,
      payload: { personId: "yousef", capabilities: [] },
    });
    workspaces.revokeItemCapability({ itemId: item.itemId, personId: "yousef", capability: "answer", commandId: "revoke-command" });
    const rejected = await control.handleCallback({ ref: `answer-${workspace.id}`, transportUserId: "202", chatId: roster.groupChatId, botId, messageId: "answer-card", commandId: "late-answer", content: "Blue" });
    assert.equal(rejected.errorCode, "grant_required");
    assert.equal(workspaces.promptActivity(prompt.id).remarks.some(remark => remark.kind === "HUMAN_RESPONSE"), false);

    workspaces.grantItemCapability({ itemId: item.itemId, personId: "yousef", capability: "resume", commandId: "resume-grant" });
    assert.equal(workspaces.revokePersonItemGrants({ personId: "yousef", commandId: "removed" }), 1);
    workspaces.disableTaskControlActor(teammate.id);
    assert.equal(workspaces.hasItemCapability(item.itemId, "yousef", "resume"), false);
    assert.equal(workspaces.taskControlTeamActorFor({ transport: "fake_telegram", transportUserId: "202", chatId: roster.groupChatId })?.enabled, 0);
  } finally {
    workspaces.removeTelegramRecordsForBot(botId);
    workspaces.removeTaskControlActor(`owner-${workspace.id}`);
    workspaces.removeTaskControlActor(`teammate-${workspace.id}`);
    workspaces.remove(workspace.id);
    rmSync(directory, { recursive: true, force: true });
  }
});
