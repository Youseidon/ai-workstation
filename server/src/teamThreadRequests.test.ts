import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { TaskControlService } from "./taskControl.ts";
import { encodeTeamThreadRequestAction, parseTeamThreadRequest, teamThreadRequestIdentity, type TeamThreadRequestDecision } from "./teamThreadRequests.ts";
import { workspaces } from "./workspaces.ts";

test("T15 parses only unaddressed cross-owner discuss requests and derives stable opaque identities", () => {
  assert.deepEqual(parseTeamThreadRequest("/discuss @owner_bot 42"), { ownerBotUsername: "owner_bot", promptId: 42 });
  assert.deepEqual(parseTeamThreadRequest("/discuss @OWNER_BOT 42"), { ownerBotUsername: "owner_bot", promptId: 42 });
  for (const invalid of ["/discuss@requester_bot @owner_bot 42", "/discuss @owner_bot 0", "/discuss @owner_bot task", "/task @owner_bot 42"]) {
    assert.equal(parseTeamThreadRequest(invalid), null);
  }
  const input = { teamId: "team-secret-name", groupChatId: "-10042", messageId: "71", requesterTelegramUserId: "202", ownerBotId: "telegram-101", promptId: 42 };
  const first = teamThreadRequestIdentity(input);
  assert.deepEqual(teamThreadRequestIdentity(input), first);
  assert.match(first.requestId, /^ttr_[a-f0-9]{24}$/);
  assert.match(first.itemId, /^awi1_[a-f0-9]{24}$/);
  assert.equal(JSON.stringify(first).includes("team-secret-name"), false);
  assert.notDeepEqual(teamThreadRequestIdentity({ ...input, messageId: "72" }), first);
});

test("T15 owner-bound thread decisions are revision-checked, expiring and applied once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm2-thread-request-"));
  const botId = `telegram-thread-owner-${Date.now()}`;
  const ownerUserId = "101";
  const ownerChatId = "private-101";
  const workspace = workspaces.create({ name: "thread-owner", workDirectory: directory });
  const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: "Owner task", content: "Discuss safely" }) as PromptRecord;
  const owner = workspaces.upsertTaskControlActor({ id: `${botId}-owner`, transport: "fake_telegram", transportUserId: ownerUserId, chatId: ownerChatId, label: "Owner" });
  workspaces.upsertTaskControlActor({ id: `${botId}-wrong`, transport: "fake_telegram", transportUserId: "202", chatId: ownerChatId, label: "Wrong user" });
  const control = new TaskControlService({ enabled: true, teamEnabled: true, notificationsEnabled: true, remoteActionsEnabled: true, transport: "fake_telegram", botId });

  const issue = (messageId: string, decision: TeamThreadRequestDecision, expiresAt = new Date(Date.now() + 60_000).toISOString()) => {
    const identity = teamThreadRequestIdentity({ teamId: "team-1", groupChatId: "group-1", messageId, requesterTelegramUserId: "202", ownerBotId: botId, promptId: prompt.id });
    const ref = `tc_${messageId}_${decision}`;
    workspaces.createTaskControlAction({ ref, action: "save_human_response", promptId: prompt.id, actorId: owner.id, chatId: ownerChatId, botId, messageId: `card-${messageId}`, expectedRevision: workspaces.humanInputState(prompt.id).revision, expiresAt });
    workspaces.setTelegramActionContent(ref, encodeTeamThreadRequestAction({ kind: "team_thread_request_action", ...identity, decision, ownerBotId: botId, ownerTelegramUserId: ownerUserId, promptId: prompt.id }));
    return { ...identity, ref, messageId: `card-${messageId}` };
  };
  const tap = (issued: ReturnType<typeof issue>, commandId: string, transportUserId = ownerUserId) => control.handleCallback({ ref: issued.ref, transportUserId, chatId: ownerChatId, botId, messageId: issued.messageId, commandId });

  try {
    const wrongUser = issue("wrong-user", "confirm");
    assert.equal((await tap(wrongUser, "wrong-user-command", "202")).errorCode, "actor_not_enrolled");
    assert.equal(workspaces.itemLink(wrongUser.itemId), null, "a wrong user shares nothing");

    const expired = issue("expired", "confirm", new Date(Date.now() - 1_000).toISOString());
    assert.equal((await tap(expired, "expired-command")).errorCode, "action_expired");
    assert.equal(workspaces.itemLink(expired.itemId), null, "an expired action shares nothing");

    const stale = issue("stale", "confirm");
    workspaces.updateChild("prompt", prompt.id, { content: "Changed after the card was issued" });
    assert.equal((await tap(stale, "stale-command")).errorCode, "question_changed");
    assert.equal(workspaces.itemLink(stale.itemId), null, "a stale action shares nothing");

    const declinedConfirm = issue("declined", "confirm");
    const declined = issue("declined", "decline");
    assert.equal((await tap(declined, "decline-command")).state, "APPLIED");
    assert.equal((await tap(declinedConfirm, "confirm-after-decline")).errorCode, "request_already_decided");
    assert.equal(workspaces.itemLink(declined.itemId), null, "a declined request shares nothing");

    const confirmed = issue("confirmed", "confirm");
    const first = await tap(confirmed, "confirm-command");
    const duplicate = await tap(confirmed, "duplicate-command");
    assert.equal(first.state, "APPLIED");
    assert.equal(duplicate.commandId, first.commandId, "a duplicate tap returns the first applied receipt");
    assert.deepEqual(workspaces.itemLink(confirmed.itemId), { itemId: confirmed.itemId, promptId: prompt.id, role: "requester", epoch: 1, controlHead: null });
    assert.equal(workspaces.itemLinksForPrompt(prompt.id).filter(link => link.itemId === confirmed.itemId).length, 1);
    assert.equal(workspaces.teamThreadRequestAppliedReceipt(confirmed.requestId)?.commandId, "confirm-command");
  } finally {
    workspaces.removeTelegramRecordsForBot(botId);
    workspaces.remove(workspace.id);
    rmSync(directory, { recursive: true, force: true });
  }
});
