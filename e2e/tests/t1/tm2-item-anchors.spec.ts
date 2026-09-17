import { expect, test } from "@playwright/test";
import { startTeamHarness, type TeamHarness, type TeamHarnessMember } from "../../src/env/teamHarness.ts";
import { eventually } from "../../src/drivers/state.ts";
import { createTeamFixture, pairTeamMember, registerTeamWorkspace, remoteRoster, teamApi } from "../../src/teamFlows.ts";

test.describe.configure({ mode: "serial" });
test.setTimeout(10 * 60_000);

async function joinFixture(team: TeamHarness): Promise<void> {
  await pairTeamMember(team, team.envA);
  await pairTeamMember(team, team.envB);
  await registerTeamWorkspace(team.envA);
  await registerTeamWorkspace(team.envB);
  const { joinCode } = await createTeamFixture(team);
  await teamApi(team.envB, "POST", "/api/task-control/team/join", { code: joinCode });
  await teamApi(team.envB, "POST", "/api/task-control/team/join/confirm", {});
  await teamApi(team.envA, "POST", "/api/task-control/team/refresh", {});
}

async function createTask(member: TeamHarnessMember): Promise<{ workspaceId: number; promptId: number }> {
  const listed = await teamApi<{ workspaces: Array<{ id: number; workDirectory: string }> }>(member, "GET", "/api/workspaces");
  const workspace = listed.workspaces.find(entry => entry.workDirectory === member.git.workspace)!;
  const { program } = await teamApi<{ program: { id: number } }>(member, "POST", `/api/workspaces/${workspace.id}/programs`, { name: "Release", overview: "" });
  const { suite } = await teamApi<{ suite: { id: number } }>(member, "POST", `/api/programs/${program.id}/suites`, { name: "Team review", overview: "" });
  const { prompt } = await teamApi<{ prompt: { id: number } }>(member, "POST", `/api/suites/${suite.id}/prompts`, {
    title: "Choose release plan from /home/jd/private/release.md",
    content: "Pick the reversible release path.",
  });
  return { workspaceId: workspace.id, promptId: prompt.id };
}

function durableReadOnlyCounts(member: TeamHarnessMember) {
  const count = (table: string) => member.app.query<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)[0]!.n;
  return {
    actions: count("task_control_action"),
    receipts: count("task_control_receipt"),
    responses: member.app.query<{ n: number }>("SELECT COUNT(*) n FROM prompt_remark WHERE kind='HUMAN_RESPONSE'")[0]!.n,
    runs: count("agent_run"),
    starts: count("workspace_start_intent"),
  };
}

test("TM-T1-6: owner item anchor lifecycle, recovery and read-only Team views", {
  annotation: { type: "covers", description: "T13, TM-T1-6, TM-T1-3 owner path" },
}, async () => {
  const team = await startTeamHarness();
  try {
    await joinFixture(team);
    const task = await createTask(team.envA);
    const opened = await teamApi<{ item: { itemId: string } }>(team.envA, "POST", "/api/task-control/team/items", { promptId: task.promptId });
    const itemId = opened.item.itemId;
    const tag = `#item_${itemId.slice(5)}`;
    const group = () => team.fakeTelegram.transcript(team.groupChat.id);
    const calls = (method: string) => team.fakeTelegram.calls.filter(call => call.method === method && call.botId === team.envA.bot.id);

    const anchor = await eventually("one owner anchor", async () => {
      const matches = group().filter(message => message.from.id === team.envA.bot.id && message.text.includes(tag) && message.reply_to_message === undefined);
      return matches.length === 1 ? matches[0] : undefined;
    });
    await eventually("the owner anchor to be pinned once", async () => calls("pinChatMessage").length === 1 && team.fakeTelegram.pinnedMessageId(team.groupChat.id) === anchor.message_id);
    expect(anchor.reply_to_message).toBeUndefined();
    expect(anchor.text).toContain("Owner: Team A");
    expect(anchor.text).toContain("[local path]");
    expect(anchor.text).not.toMatch(/\/home\/|quota|token|credential/i);

    await teamApi(team.envA, "PATCH", `/api/prompts/${task.promptId}`, { title: "Choose the reversible release" });
    await eventually("the same anchor to be edited", async () => anchor.history.length === 2 && anchor.text.includes("Choose the reversible release"));
    expect(group().filter(message => message.from.id === team.envA.bot.id && message.text.includes(tag))).toHaveLength(1);
    expect(calls("pinChatMessage")).toHaveLength(1);

    const beforeViews = durableReadOnlyCounts(team.envA);
    const remoteBeforeViews = remoteRoster(team).head;
    for (const command of ["/task", "/status", "/access", "/help"] as const) {
      const beforeId = group().at(-1)?.message_id ?? 0;
      team.fakeTelegram.userSendsMessage(team.envA.bot, team.envB.user, team.groupChat, command, { replyToMessageId: anchor.message_id });
      const reply = await eventually(`${command} owner reply`, async () => group().find(message => message.message_id > beforeId && message.from.id === team.envA.bot.id && message.reply_to_message?.message_id === anchor.message_id));
      expect(reply.text).toContain(tag);
      expect(reply.text).not.toMatch(/\/home\/|quota|token|credential/i);
    }
    expect(durableReadOnlyCounts(team.envA)).toEqual(beforeViews);
    expect(remoteRoster(team).head).toBe(remoteBeforeViews);
    expect(group().filter(message => message.from.id === team.envB.bot.id && message.text.includes(tag))).toHaveLength(0);

    team.fakeTelegram.userDeletesMessage(team.groupChat.id, anchor.message_id);
    await teamApi(team.envA, "PATCH", `/api/prompts/${task.promptId}`, { title: "Choose the release after deletion" });
    const replacement = await eventually("one replacement after ANCHOR_GONE", async () => {
      const matches = group().filter(message => message.from.id === team.envA.bot.id && message.text.includes(tag) && message.reply_to_message === undefined && message.message_id !== anchor.message_id);
      return matches.length === 1 ? matches[0] : undefined;
    });
    await eventually("the replacement to be pinned once", async () => calls("pinChatMessage").length === 2 && team.fakeTelegram.pinnedMessageId(team.groupChat.id) === replacement.message_id);
    const thread = team.envA.app.query<{ status_message_id: number; state: string }>("SELECT status_message_id,state FROM telegram_thread WHERE subject_kind='item' AND subject_id=?", itemId)[0]!;
    expect(thread.state).toBe("ACTIVE");
    expect(thread.status_message_id).not.toBeNull();

    const beforeReplacementView = durableReadOnlyCounts(team.envA);
    const beforeReplacementReply = group().at(-1)?.message_id ?? 0;
    team.fakeTelegram.userSendsMessage(team.envA.bot, team.envA.user, team.groupChat, "/status", { replyToMessageId: replacement.message_id });
    await eventually("an item view replying to the replacement", async () => group().find(message => message.message_id > beforeReplacementReply && message.from.id === team.envA.bot.id && message.reply_to_message?.message_id === replacement.message_id && message.text.includes(tag)));
    expect(durableReadOnlyCounts(team.envA)).toEqual(beforeReplacementView);

    await teamApi(team.envA, "POST", `/api/task-control/team/harness/items/${itemId}/complete`, {});
    await eventually("completed anchor edit and one unpin", async () => replacement.text.includes("Completed") && calls("unpinChatMessage").length === 1);
    expect(team.fakeTelegram.pinnedMessageId(team.groupChat.id)).toBeUndefined();
    expect(calls("pinChatMessage")).toHaveLength(2);

    await teamApi(team.envA, "POST", `/api/task-control/team/harness/items/${itemId}/reopen`, {});
    const reopened = await eventually("a fresh reopened anchor", async () => group().find(message => message.from.id === team.envA.bot.id && message.text.includes(tag) && message.reply_to_message === undefined && ![anchor.message_id, replacement.message_id].includes(message.message_id)));
    await eventually("the reopened anchor to be pinned once", async () => calls("pinChatMessage").length === 3 && team.fakeTelegram.pinnedMessageId(team.groupChat.id) === reopened.message_id);
    expect(reopened.reply_to_message).toBeUndefined();
    expect(calls("unpinChatMessage")).toHaveLength(1);
    const replyTargets = group().filter(message => message.from.id === team.envA.bot.id && message.text.includes(tag) && message.reply_to_message !== undefined).map(message => message.reply_to_message!.message_id);
    expect(replyTargets).toEqual([anchor.message_id, anchor.message_id, anchor.message_id, anchor.message_id, replacement.message_id]);
  } finally {
    await team.dispose();
  }
});
