import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { config } from "./config.ts";
import { TelegramAdapter } from "./integrations/telegram/adapter.ts";
import { FakeTelegramBotApi } from "./integrations/telegram/fakeBotApi.ts";
import { BareGitTeamRosterRemote, newTeamRoster, publishRoster, type TeamRoster } from "./teamRoster.ts";
import { normalizeTelegramUpdate } from "./integrations/telegram/httpBotApi.ts";
import { itemSubject, TEAM_GROUP_TOPIC_SENTINEL, WORKSTATION_SUBJECT, WorkspaceError, workspaces } from "./workspaces.ts";

/* -------------------------------------------------------------------------- */
/* B8: Telegram upgrades a basic group to a supergroup and its chat id changes. */
/* -------------------------------------------------------------------------- */

function textPayload(text: string): unknown {
  return { kind: "text", text };
}

function fixture(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `telegram-${label}-`));
  const workspace = workspaces.create({ name: dir, workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: "Choose a colour", content: "Red or blue" }) as PromptRecord;
  return {
    workspace, prompt,
    cleanup() { workspaces.remove(workspace.id); rmSync(dir, { recursive: true, force: true }); },
  };
}

function roster(teamId: string, groupChatId: string, botId: string, remoteUrl: string): TeamRoster {
  return newTeamRoster({
    teamId,
    groupChatId,
    remoteUrl,
    members: [
      { personId: "101", telegramUserId: "101", botId, botUsername: "owner_bot", workstationId: botId, workstationLabel: "owner-workstation" },
      { personId: "202", telegramUserId: "202", botId: `${botId}-teammate`, botUsername: "teammate_bot", workstationId: "teammate", workstationLabel: "teammate-workstation" },
    ],
  });
}

/** Every column in the schema that stores a Telegram chat id, checked against the schema rather than the bug log. */
function chatIdSightings(chatId: string): Record<string, number> {
  const db = new Database(join(config.repoRoot, ".agent-console/console.sqlite"), { readonly: true });
  try {
    const count = (sql: string) => (db.prepare(sql).get(chatId) as { n: number }).n;
    return {
      team_roster_group_chat_id: count("SELECT COUNT(*) n FROM team_roster WHERE group_chat_id=?"),
      team_roster_record_json: count("SELECT COUNT(*) n FROM team_roster WHERE json_extract(record_json,'$.groupChatId')=?"),
      task_control_actor: count("SELECT COUNT(*) n FROM task_control_actor WHERE chat_id=?"),
      task_control_action: count("SELECT COUNT(*) n FROM task_control_action WHERE chat_id=?"),
      telegram_thread: count("SELECT COUNT(*) n FROM telegram_thread WHERE chat_id=?"),
      telegram_outbox: count("SELECT COUNT(*) n FROM telegram_outbox WHERE chat_id=?"),
      telegram_inbox: count("SELECT COUNT(*) n FROM telegram_inbox WHERE processed_at IS NULL AND json_extract(payload_json,'$.chatId')=?"),
    };
  } finally {
    db.close();
  }
}

test("B8: a send refused because the group became a supergroup carries the new chat id, and the old id never works again", async () => {
  const botId = `fake-supergroup-${Date.now()}`;
  const api = new FakeTelegramBotApi();
  const adapter = new TelegramAdapter(botId, api);
  const fromChatId = "-40001";
  const toChatId = "-1002000000001";
  try {
    const outboxId = workspaces.enqueueTelegramOutbox({ botId, chatId: fromChatId, payload: textPayload("Anchor"), subject: WORKSTATION_SUBJECT });
    // Telegram upgrades the group the moment someone is granted administrator rights.
    api.upgradeChat(fromChatId, toChatId);

    const first = await adapter.deliverOutbox(outboxId);
    assert.equal(first.state, "FAILED");
    assert.match(
      workspaces.telegramOutbox().find(row => row.id === outboxId)?.lastError ?? "",
      /group chat was upgraded to a supergroup chat/,
      "the Bot API refusal reaches the row",
    );
    assert.equal(first.retryAt, null, "the old chat id is not worth retrying");
    assert.equal(
      first.migrateToChatId,
      toChatId,
      "B8: the delivery must carry parameters.migrate_to_chat_id, or nothing can repair the team",
    );

    // Without that id the same row fails identically for ever, which is what the pilot saw.
    const second = await adapter.deliverOutbox(outboxId);
    assert.equal(second.state, "FAILED");
    assert.deepEqual(api.sent, [], "nothing reaches Telegram while the old chat id stands");
  } finally {
    workspaces.removeTelegramRecordsForBot(botId);
  }
});

test("B8: the rewrite moves every place the old team chat id lives, in one transaction", async () => {
  const botId = `rewrite-supergroup-${Date.now()}`;
  const teamId = `awt1_rewrite_${Date.now()}`;
  const fromChatId = "-40002";
  const toChatId = "-1002000000002";
  const f = fixture("rewrite");
  try {
    const record = roster(teamId, fromChatId, botId, "https://example.invalid/team.git");
    workspaces.upsertTeamRoster({ teamId, groupChatId: fromChatId, remoteUrl: record.remoteUrl, revision: "rev-1", record });
    const owner = workspaces.upsertTeamGroupActor({ id: `${teamId}-owner`, transport: "telegram", transportUserId: "101", chatId: fromChatId, label: "owner-workstation" });
    workspaces.upsertTeamGroupActor({ id: `${teamId}-teammate`, transport: "telegram", transportUserId: "202", chatId: fromChatId, label: "teammate-workstation" });
    const itemId = workspaces.createItemLink({ promptId: f.prompt.id, role: "requester", epoch: 1 }).itemId;
    const thread = workspaces.telegramThreadFor({ botId, chatId: fromChatId, subject: itemSubject(itemId) });
    const anchorId = workspaces.enqueueTelegramOutbox({ botId, chatId: fromChatId, payload: textPayload("Anchor"), subject: itemSubject(itemId), anchor: { pin: true } });
    workspaces.createTaskControlAction({
      ref: `tc_${teamId}`,
      action: "save_human_response",
      promptId: f.prompt.id,
      actorId: owner.id,
      chatId: fromChatId,
      topicId: TEAM_GROUP_TOPIC_SENTINEL,
      botId,
      expectedRevision: workspaces.humanInputState(f.prompt.id).revision,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    workspaces.saveTelegramUpdates(botId, [{ updateId: 1, payload: { kind: "message", transportUserId: "202", chatId: fromChatId, chatType: "group", topicId: null, messageId: "9", replyToMessageId: null, text: "/context", label: "Yousef", username: "yousef" } }]);

    assert.deepEqual(chatIdSightings(fromChatId), {
      team_roster_group_chat_id: 1, team_roster_record_json: 1, task_control_actor: 2,
      task_control_action: 1, telegram_thread: 1, telegram_outbox: 1, telegram_inbox: 1,
    }, "the fixture puts the old chat id in every column that stores one");

    const rewritten = workspaces.rewriteTeamChatId({ teamId, fromChatId, toChatId });

    assert.equal(rewritten.roster.groupChatId, toChatId);
    assert.deepEqual(chatIdSightings(fromChatId), {
      team_roster_group_chat_id: 0, team_roster_record_json: 0, task_control_actor: 0,
      task_control_action: 0, telegram_thread: 0, telegram_outbox: 0, telegram_inbox: 0,
    }, "nothing addresses the old chat id afterwards");
    assert.deepEqual(chatIdSightings(toChatId), {
      team_roster_group_chat_id: 1, team_roster_record_json: 1, task_control_actor: 2,
      task_control_action: 1, telegram_thread: 1, telegram_outbox: 1, telegram_inbox: 1,
    }, "every row moved to the supergroup, none was dropped");

    // The rows are the same rows: a rewrite that recreated them would lose the anchor.
    assert.equal(workspaces.telegramThreads(botId).find(entry => entry.id === thread.id)?.chatId, toChatId);
    assert.equal(workspaces.telegramThreadFor({ botId, chatId: toChatId, subject: itemSubject(itemId) }).statusMessageId, anchorId);
    assert.equal(workspaces.taskControlActorById(owner.id)?.chat_id, toChatId);
    assert.equal(workspaces.teamRoster(teamId)?.groupChatId, toChatId);

    // A migration signal for a chat this workstation is not on changes nothing.
    assert.throws(
      () => workspaces.rewriteTeamChatId({ teamId, fromChatId: "-40099", toChatId: "-1002000000009" }),
      (error: unknown) => error instanceof WorkspaceError && error.status === 409 && error.code === "chat_migration_mismatch",
    );
  } finally {
    workspaces.removeTelegramRecordsForBot(botId);
    for (const actor of workspaces.taskControlActors("telegram")) workspaces.removeTaskControlActor(actor.id);
    f.cleanup();
  }
});

test("B8: the migrated roster is republished by compare-and-swap, and a lost race is re-read rather than forced", async () => {
  const botId = `cas-supergroup-${Date.now()}`;
  const teamId = `awt1_cas_${Date.now()}`;
  const bare = mkdtempSync(join(tmpdir(), "team-supergroup-remote-"));
  const fromChatId = "-40003";
  const toChatId = "-1002000000003";
  try {
    execFileSync("git", ["init", "--bare", "-q", bare]);
    const remote = new BareGitTeamRosterRemote(bare);
    const published = await publishRoster(remote, null, roster(teamId, fromChatId, botId, bare), "create-1");
    workspaces.upsertTeamRoster({ teamId, groupChatId: fromChatId, remoteUrl: bare, revision: published.revision, record: published.roster });

    const moved = await publishRoster(remote, published.revision, { ...published.roster, groupChatId: toChatId }, "migrate-1");
    assert.equal(moved.roster.groupChatId, toChatId);
    assert.equal((await remote.read())?.roster.groupChatId, toChatId, "refs/aw/team carries the supergroup id");
    assert.equal(workspaces.teamRoster(teamId)?.groupChatId, toChatId, "the local cache follows the published roster");

    // The other workstation publishing first is a lost race: the stale expectation is
    // refused, and the answer is to re-read, never to force the old revision over it.
    await assert.rejects(
      publishRoster(remote, published.revision, { ...published.roster, groupChatId: "-1002000000099" }, "migrate-2"),
      (error: unknown) => error instanceof WorkspaceError && error.status === 409 && error.code === "roster_conflict",
    );
    assert.equal((await remote.read())?.roster.groupChatId, toChatId, "the lost race left the published roster alone");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("B8: both sides of the upgrade normalize to the same migration signal", () => {
  // Neither service message carries text, so both used to be dropped as unsupported.
  const supergroup = normalizeTelegramUpdate({
    update_id: 71,
    message: { message_id: 3, date: 1, chat: { id: -1002000000004, type: "supergroup" }, from: { id: 101, is_bot: false, first_name: "jd" }, migrate_from_chat_id: -40004 },
  });
  assert.deepEqual(supergroup, { updateId: 71, payload: { kind: "migration", fromChatId: "-40004", toChatId: "-1002000000004" } });

  const basicGroup = normalizeTelegramUpdate({
    update_id: 72,
    message: { message_id: 4, date: 1, chat: { id: -40004, type: "group" }, from: { id: 101, is_bot: false, first_name: "jd" }, migrate_to_chat_id: -1002000000004 },
  });
  assert.deepEqual(basicGroup, { updateId: 72, payload: { kind: "migration", fromChatId: "-40004", toChatId: "-1002000000004" } });
});
