import { expect, test } from "@playwright/test";
import { startTeamHarness, type TeamHarness, type TeamHarnessMember } from "../../src/env/teamHarness.ts";
import { eventually, observeQuietPeriod } from "../../src/drivers/state.ts";
import { createTeamFixture, pairTeamMember, registerTeamWorkspace, remoteRoster, teamApi } from "../../src/teamFlows.ts";
import type { StoredMessage } from "../../src/fakes/telegramServer.ts";

test.describe.configure({ mode: "serial" });
test.setTimeout(15 * 60_000);

const THREAD_ACTION_TTL_MS = 15_000;

async function joinFixture(team: TeamHarness): Promise<void> {
  await pairTeamMember(team, team.envA);
  await pairTeamMember(team, team.envB);
  await registerTeamWorkspace(team.envA);
  await registerTeamWorkspace(team.envB);
  const { joinCode } = await createTeamFixture(team);
  await teamApi(team.envB, "POST", "/api/task-control/team/join", { code: joinCode });
  await teamApi(team.envB, "POST", "/api/task-control/team/join/confirm", {});
  await Promise.all([
    teamApi(team.envA, "POST", "/api/task-control/team/refresh", {}),
    teamApi(team.envB, "POST", "/api/task-control/team/refresh", {}),
  ]);
}

async function createTask(member: TeamHarnessMember, suffix: string): Promise<{ promptId: number; title: string }> {
  const listed = await teamApi<{ workspaces: Array<{ id: number; workDirectory: string }> }>(member, "GET", "/api/workspaces");
  const workspace = listed.workspaces.find(entry => entry.workDirectory === member.git.workspace)!;
  const { program } = await teamApi<{ program: { id: number } }>(member, "POST", `/api/workspaces/${workspace.id}/programs`, { name: `Owner program ${suffix}`, overview: "" });
  const { suite } = await teamApi<{ suite: { id: number } }>(member, "POST", `/api/programs/${program.id}/suites`, { name: "Private owner work", overview: "" });
  const title = `Owner-only ${suffix} from /home/jd/private/${suffix}.md`;
  const { prompt } = await teamApi<{ prompt: { id: number } }>(member, "POST", `/api/suites/${suite.id}/prompts`, { title, content: `Private question for ${suffix}; quota 91%.` });
  return { promptId: prompt.id, title };
}

function button(card: StoredMessage, label: string): string {
  return card.reply_markup!.inline_keyboard.flat().find(entry => entry.text === label)!.callback_data!;
}

async function requestThread(team: TeamHarness, promptId: number, duplicateDelivery = false) {
  const groupBefore = team.fakeTelegram.transcript(team.groupChat.id).at(-1)?.message_id ?? 0;
  const privateBefore = team.fakeTelegram.transcript(team.envA.privateChat.id).at(-1)?.message_id ?? 0;
  if (duplicateDelivery) team.fakeTelegram.duplicateNextDelivery();
  team.fakeTelegram.userSendsMessage(team.envA.bot, team.envB.user, team.groupChat, `/discuss @${team.envA.bot.username} ${promptId}`);
  const request = await eventually("one requester-bot card", async () => {
    const messages = team.fakeTelegram.transcript(team.groupChat.id).filter(message => message.message_id > groupBefore && message.from.is_bot && message.text.startsWith("Thread requested"));
    return messages.length === 1 && messages[0]!.from.id === team.envB.bot.id && messages[0]!.text.includes("Thread requested") ? messages[0] : undefined;
  });
  if (duplicateDelivery) {
    await observeQuietPeriod(2_000, "a duplicate requester-bot card");
    expect(team.fakeTelegram.transcript(team.groupChat.id).filter(message => message.message_id > groupBefore && message.from.is_bot && message.text.startsWith("Thread requested"))).toHaveLength(1);
  }
  const confirmation = await eventually("one owner-private confirmation card", async () => {
    const cards = team.fakeTelegram.transcript(team.envA.privateChat.id).filter(message => message.message_id > privateBefore && message.from.id === team.envA.bot.id && message.text.startsWith("Team thread request"));
    return cards.length === 1 && cards[0]!.reply_markup?.inline_keyboard.flat().length === 2 ? cards[0] : undefined;
  });
  const tag = request.text.match(/#item_[a-f0-9]{24}/)![0];
  return { request, confirmation, itemId: `awi1_${tag.slice("#item_".length)}`, tag };
}

function promptShareCounts(member: TeamHarnessMember, promptId: number) {
  return {
    links: member.app.query<{ n: number }>("SELECT COUNT(*) n FROM item_link WHERE prompt_id=?", promptId)[0]!.n,
    threads: member.app.query<{ n: number }>("SELECT COUNT(*) n FROM telegram_thread WHERE subject_kind='item' AND subject_id IN (SELECT item_id FROM item_link WHERE prompt_id=?)", promptId)[0]!.n,
    applied: member.app.query<{ n: number }>(`SELECT COUNT(*) n FROM task_control_receipt r JOIN task_control_action a ON a.ref=r.action_ref
      JOIN telegram_action_content c ON c.action_ref=a.ref WHERE a.prompt_id=? AND r.state='APPLIED' AND json_extract(c.content,'$.kind')='team_thread_request_action'`, promptId)[0]!.n,
  };
}

test("TM-T1-7: cross-owner thread requests share only after owner confirmation", {
  annotation: { type: "covers", description: "T15, D17, D19, TM-T1-7" },
}, async () => {
  const team = await startTeamHarness({ envA: { serverEnv: { AGENT_CONSOLE_HARNESS_ACTION_TTL_MS: String(THREAD_ACTION_TTL_MS) } } });
  try {
    await joinFixture(team);
    const valid = await createTask(team.envA, "valid");
    const declinedTask = await createTask(team.envA, "declined");
    const staleTask = await createTask(team.envA, "stale");
    const expiredTask = await createTask(team.envA, "expired");
    const remoteBefore = remoteRoster(team).head;
    const group = () => team.fakeTelegram.transcript(team.groupChat.id);
    const ownerPinsBefore = team.fakeTelegram.calls.filter(call => call.method === "pinChatMessage" && call.botId === team.envA.bot.id).length;

    const opened = await requestThread(team, valid.promptId, true);
    expect(opened.request.text).not.toContain(valid.title);
    expect(opened.request.text).not.toMatch(/\/home\/|quota|question|answer|credential|token/i);
    expect(promptShareCounts(team.envA, valid.promptId)).toEqual({ links: 0, threads: 0, applied: 0 });
    expect(remoteRoster(team).head).toBe(remoteBefore);
    expect(group().filter(message => message.from.id === team.envA.bot.id && message.text.includes(opened.tag))).toHaveLength(0);
    expect(team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM task_control_action WHERE prompt_id=?", valid.promptId)[0]!.n).toBe(2);

    const confirm = button(opened.confirmation, "Confirm thread");
    const wrongTap = team.fakeTelegram.userTapsButton(team.envA.bot, team.envB.user, team.envA.privateChat, opened.confirmation.message_id, confirm);
    await eventually("wrong-user confirmation refusal", async () => team.fakeTelegram.callbackAnswer(wrongTap)?.text.includes("Not applied") || undefined);
    expect(promptShareCounts(team.envA, valid.promptId).links).toBe(0);
    expect(group().filter(message => message.from.id === team.envA.bot.id && message.text.includes(opened.tag))).toHaveLength(0);

    const ownerTap = team.fakeTelegram.userTapsButton(team.envA.bot, team.envA.user, team.envA.privateChat, opened.confirmation.message_id, confirm);
    await eventually("owner confirmation applied", async () => team.fakeTelegram.callbackAnswer(ownerTap)?.text.includes("Team thread confirmed") || undefined);
    const anchor = await eventually("one owner anchor after confirmation", async () => {
      const anchors = group().filter(message => message.from.id === team.envA.bot.id && message.text.includes(opened.tag) && message.reply_to_message === undefined);
      return anchors.length === 1 ? anchors[0] : undefined;
    });
    await eventually("owner anchor pinned once", async () => team.fakeTelegram.pinnedMessageId(team.groupChat.id) === anchor.message_id);
    expect(anchor.text).not.toMatch(/\/home\/|quota|credential|token/i);
    expect(promptShareCounts(team.envA, valid.promptId)).toEqual({ links: 1, threads: 1, applied: 1 });
    expect(team.envB.app.query<{ n: number }>("SELECT COUNT(*) n FROM item_link")[0]!.n).toBe(0);
    expect(remoteRoster(team).head).toBe(remoteBefore);

    const duplicateTap = team.fakeTelegram.userTapsButton(team.envA.bot, team.envA.user, team.envA.privateChat, opened.confirmation.message_id, confirm);
    await eventually("duplicate confirmation replay", async () => team.fakeTelegram.callbackAnswer(duplicateTap)?.text === "Already applied." || undefined);
    expect(group().filter(message => message.from.id === team.envA.bot.id && message.text.includes(opened.tag) && message.reply_to_message === undefined)).toHaveLength(1);
    expect(promptShareCounts(team.envA, valid.promptId)).toEqual({ links: 1, threads: 1, applied: 1 });

    const declined = await requestThread(team, declinedTask.promptId);
    const declineTap = team.fakeTelegram.userTapsButton(team.envA.bot, team.envA.user, team.envA.privateChat, declined.confirmation.message_id, button(declined.confirmation, "Decline"));
    await eventually("decline applied", async () => team.fakeTelegram.callbackAnswer(declineTap)?.text.includes("declined") || undefined);
    expect(promptShareCounts(team.envA, declinedTask.promptId)).toEqual({ links: 0, threads: 0, applied: 1 });
    expect(group().filter(message => message.from.id === team.envA.bot.id && message.text.includes(declined.tag))).toHaveLength(0);

    const stale = await requestThread(team, staleTask.promptId);
    await teamApi(team.envA, "PATCH", `/api/prompts/${staleTask.promptId}`, { content: "Owner changed this task before deciding." });
    const staleTap = team.fakeTelegram.userTapsButton(team.envA.bot, team.envA.user, team.envA.privateChat, stale.confirmation.message_id, button(stale.confirmation, "Confirm thread"));
    await eventually("stale confirmation refused", async () => team.fakeTelegram.callbackAnswer(staleTap)?.text.includes("Not applied") || undefined);
    expect(promptShareCounts(team.envA, staleTask.promptId).links).toBe(0);
    expect(group().filter(message => message.from.id === team.envA.bot.id && message.text.includes(stale.tag))).toHaveLength(0);

    const expired = await requestThread(team, expiredTask.promptId);
    await new Promise(resolve => setTimeout(resolve, THREAD_ACTION_TTL_MS + 100));
    const expiredTap = team.fakeTelegram.userTapsButton(team.envA.bot, team.envA.user, team.envA.privateChat, expired.confirmation.message_id, button(expired.confirmation, "Confirm thread"));
    await eventually("expired confirmation refused", async () => team.fakeTelegram.callbackAnswer(expiredTap)?.text.includes("expired") || undefined);
    expect(promptShareCounts(team.envA, expiredTask.promptId).links).toBe(0);
    expect(group().filter(message => message.from.id === team.envA.bot.id && message.text.includes(expired.tag))).toHaveLength(0);
    expect(team.fakeTelegram.calls.filter(call => call.method === "pinChatMessage" && call.botId === team.envA.bot.id)).toHaveLength(ownerPinsBefore + 1);
    expect(remoteRoster(team).head).toBe(remoteBefore);
  } finally {
    await team.dispose();
  }
});
