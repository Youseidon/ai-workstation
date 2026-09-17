import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { startTeamHarness, type TeamHarness, type TeamHarnessMember } from "../../src/env/teamHarness.ts";
import { eventually } from "../../src/drivers/state.ts";
import { createTeamFixture, pairTeamMember, registerTeamWorkspace, remoteRoster, TeamApiError, teamApi } from "../../src/teamFlows.ts";
import type { FakeUser, StoredMessage } from "../../src/fakes/telegramServer.ts";

test.describe.configure({ mode: "serial" });
test.setTimeout(15 * 60_000);

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

async function createTask(member: TeamHarnessMember, suffix: string): Promise<{ workspaceId: number; promptId: number; title: string }> {
  const listed = await teamApi<{ workspaces: Array<{ id: number; workDirectory: string }> }>(member, "GET", "/api/workspaces");
  const workspace = listed.workspaces.find(entry => entry.workDirectory === member.git.workspace)!;
  const { program } = await teamApi<{ program: { id: number } }>(member, "POST", `/api/workspaces/${workspace.id}/programs`, { name: `Release ${suffix}`, overview: "" });
  const { suite } = await teamApi<{ suite: { id: number } }>(member, "POST", `/api/programs/${program.id}/suites`, { name: "Team review", overview: "" });
  const title = `Choose ${suffix} release plan`;
  const { prompt } = await teamApi<{ prompt: { id: number } }>(member, "POST", `/api/suites/${suite.id}/prompts`, { title, content: "Pick the reversible release path." });
  return { workspaceId: workspace.id, promptId: prompt.id, title };
}

function durableCounts(member: TeamHarnessMember) {
  const count = (table: string) => member.app.query<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)[0]!.n;
  return {
    actions: count("task_control_action"),
    receipts: count("task_control_receipt"),
    responses: member.app.query<{ n: number }>("SELECT COUNT(*) n FROM prompt_remark WHERE kind='HUMAN_RESPONSE'")[0]!.n,
    runs: count("agent_run"),
    starts: count("workspace_start_intent"),
    actors: count("task_control_actor"),
    links: count("item_link"),
  };
}

async function sendGroupCase(args: {
  team: TeamHarness;
  sender: FakeUser;
  text: string;
  replyTo?: StoredMessage;
  expectedBotId?: number;
  expectedText?: RegExp;
}): Promise<StoredMessage | null> {
  const { team } = args;
  const sent = team.fakeTelegram.userSendsMessage(team.envA.bot, args.sender, team.groupChat, args.text, args.replyTo ? { replyToMessageId: args.replyTo.message_id } : {});
  for (const member of [team.envA, team.envB]) {
    await eventually(`${member.name} processes group message ${sent.message_id}`, async () => {
      const delivered = member.app.query<{ processedAt: string | null }>(
        "SELECT processed_at processedAt FROM telegram_inbox WHERE json_extract(payload_json,'$.kind')='message' AND json_extract(payload_json,'$.messageId')=?",
        String(sent.message_id),
      )[0];
      return delivered?.processedAt === null || delivered === undefined ? undefined : delivered;
    });
  }
  if (args.expectedBotId === undefined) {
    expect(team.fakeTelegram.transcript(team.groupChat.id).filter(message => message.message_id > sent.message_id && message.from.is_bot)).toHaveLength(0);
    return null;
  }
  return eventually(`one reply from bot ${args.expectedBotId}`, async () => {
    const replies = team.fakeTelegram.transcript(team.groupChat.id).filter(message => message.message_id > sent.message_id && message.from.is_bot);
    return replies.length === 1 && replies[0]!.from.id === args.expectedBotId && (args.expectedText?.test(replies[0]!.text) ?? true) ? replies[0] : undefined;
  });
}

test("TM-T1-3: broad group delivery produces one owner response and quiet non-owner drops", {
  annotation: { type: "covers", description: "T14, TM-T0-1, TM-T1-3, LT-1" },
}, async () => {
  const team = await startTeamHarness();
  try {
    await joinFixture(team);
    const taskA = await createTask(team.envA, "A");
    const taskB = await createTask(team.envB, "B");
    const itemA = (await teamApi<{ item: { itemId: string } }>(team.envA, "POST", "/api/task-control/team/items", { promptId: taskA.promptId })).item.itemId;
    const itemB = (await teamApi<{ item: { itemId: string } }>(team.envB, "POST", "/api/task-control/team/items", { promptId: taskB.promptId })).item.itemId;
    const tagA = `#item_${itemA.slice(5)}`;
    const tagB = `#item_${itemB.slice(5)}`;
    const group = () => team.fakeTelegram.transcript(team.groupChat.id);
    const anchorA = await eventually("A anchor", async () => group().find(message => message.from.id === team.envA.bot.id && message.text.includes(tagA) && message.reply_to_message === undefined));
    const anchorB = await eventually("B anchor", async () => group().find(message => message.from.id === team.envB.bot.id && message.text.includes(tagB) && message.reply_to_message === undefined));
    const beforeA = durableCounts(team.envA);
    const beforeB = durableCounts(team.envB);
    const remoteBefore = remoteRoster(team).head;

    for (const [anchor, owner, tag] of [[anchorA, team.envA, tagA], [anchorB, team.envB, tagB]] as const) {
      for (const sender of [team.envA.user, team.envB.user]) {
        for (const command of ["/task", "/status", "/access", "/help"] as const) {
          await sendGroupCase({ team, sender, text: command, replyTo: anchor, expectedBotId: owner.bot.id, expectedText: new RegExp(tag) });
        }
      }
    }

    await sendGroupCase({ team, sender: team.envA.user, text: `/task@${team.envB.bot.username}`, replyTo: anchorA });
    await sendGroupCase({ team, sender: team.envB.user, text: `/status@${team.envA.bot.username}`, replyTo: anchorB });

    const unknown = "awi1_cccccccccccccccccccccccc";
    await sendGroupCase({ team, sender: team.envA.user, text: `/task ${unknown}`, expectedBotId: team.envA.bot.id, expectedText: /^Item not found\./ });
    await sendGroupCase({ team, sender: team.envB.user, text: `/status #item_${unknown.slice(5)}`, expectedBotId: team.envB.bot.id, expectedText: /^Item not found\./ });

    await sendGroupCase({ team, sender: team.envA.user, text: "Could we discuss this?", replyTo: anchorA });
    await sendGroupCase({ team, sender: team.envB.user, text: "General team discussion" });

    const stranger: FakeUser = { id: 5_550_303, firstName: "Not rostered", username: "outsider" };
    team.fakeTelegram.addChatMember(team.groupChat, stranger);
    await sendGroupCase({ team, sender: stranger, text: "/task", replyTo: anchorA });
    await sendGroupCase({ team, sender: stranger, text: `/task ${unknown}` });
    await sendGroupCase({ team, sender: stranger, text: "Untrusted discussion", replyTo: anchorB });

    expect(durableCounts(team.envA)).toEqual(beforeA);
    expect(durableCounts(team.envB)).toEqual(beforeB);
    expect(remoteRoster(team).head).toBe(remoteBefore);
    expect(group().filter(message => message.from.is_bot && message.text.includes("That message is not a task question"))).toHaveLength(0);
    expect(group().filter(message => message.from.is_bot && message.text.startsWith("Item not found."))).toHaveLength(2);
  } finally {
    await team.dispose();
  }
});

function startRun(member: TeamHarnessMember, task: { workspaceId: number; promptId: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${member.app.serverUrl.replace(/^http/, "ws")}/ws`);
    const timeout = setTimeout(() => { socket.close(); reject(new Error(`run did not start on ${member.name}`)); }, 20_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ kind: "run", provider: "grok", workspaceId: task.workspaceId, promptId: task.promptId, model: null })));
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data)) as { kind?: string; runId?: string; source?: { promptId?: number }; event?: { type?: string; payload?: { message?: string } } };
      if (message.kind === "run_started" && message.source?.promptId === task.promptId && message.runId) {
        clearTimeout(timeout); socket.close(); resolve(message.runId);
      } else if (message.kind === "event" && message.event?.type === "error") {
        clearTimeout(timeout); socket.close(); reject(new Error(message.event.payload?.message ?? "run failed"));
      }
    });
    socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error(`run socket failed on ${member.name}`)); });
  });
}

async function personalAnswerAndResume(team: TeamHarness, member: TeamHarnessMember, suffix: string): Promise<void> {
  const task = await createTask(member, `private-${suffix}`);
  const answer = `private answer ${suffix}`;
  member.app.fakeProvider.queue(
    { behavior: "block-on-decision", reason: `Decision ${suffix}`, humanAction: `Choose ${suffix}` },
    { behavior: "consume-answer", expectInContext: answer },
  );
  await startRun(member, task);
  await eventually(`${member.name} prompt blocked`, async () => member.app.query<{ status: string }>("SELECT status FROM prompt WHERE id=?", task.promptId)[0]?.status === "BLOCKED");
  const transcript = () => team.fakeTelegram.transcript(member.privateChat.id);
  const question = await eventually(`${member.name} private question`, async () => transcript().find(message => message.from.id === member.bot.id && message.text.includes(`Task: ${task.title}`) && message.text.includes("Reply to this message")));
  const sent = team.fakeTelegram.userSendsMessage(member.bot, member.user, member.privateChat, answer, { replyToMessageId: question.message_id });
  const card = await eventually(`${member.name} private answer card`, async () => transcript().find(message => message.message_id > sent.message_id && message.from.id === member.bot.id && message.text.includes(answer) && message.reply_markup?.inline_keyboard.flat().some(button => button.text === "Answer and resume")));
  const callback = card.reply_markup!.inline_keyboard.flat().find(button => button.text === "Answer and resume")!.callback_data!;
  const callbackId = team.fakeTelegram.userTapsButton(member.bot, member.user, member.privateChat, card.message_id, callback);
  await eventually(`${member.name} applied private receipt`, async () => {
    const receipt = member.app.query<{ state: string; started: number }>("SELECT r.state,r.started FROM task_control_receipt r JOIN task_control_action a ON a.ref=r.action_ref WHERE a.prompt_id=?", task.promptId)[0];
    return receipt?.state === "APPLIED" && receipt.started === 1;
  });
  await eventually(`${member.name} callback answered`, async () => team.fakeTelegram.callbackAnswer(callbackId));
  await eventually(`${member.name} resumed task finished`, async () => member.app.query<{ status: string }>("SELECT status FROM prompt WHERE id=?", task.promptId)[0]?.status === "DONE", 60_000);
  expect(readFileSync(join(member.git.workspace, "README.md"), "utf8")).not.toContain(answer);
}

test("TM-T1-2: private question and resume flows stay isolated with Team off and on", {
  annotation: { type: "covers", description: "T14, TM-T1-2, personal Telegram regression" },
}, async () => {
  for (const teamEnabled of [false, true]) {
    const team = await startTeamHarness({
      envA: { fakeProvider: "live", settings: { "team.enabled": teamEnabled } },
      envB: { fakeProvider: "live", settings: { "team.enabled": teamEnabled } },
    });
    try {
      if (teamEnabled) await joinFixture(team);
      else {
        await pairTeamMember(team, team.envA);
        await pairTeamMember(team, team.envB);
        await registerTeamWorkspace(team.envA);
        await registerTeamWorkspace(team.envB);
        for (const member of [team.envA, team.envB]) {
          await expect(teamApi(member, "GET", "/api/task-control/team")).rejects.toMatchObject({ status: 403, code: "team_disabled" } satisfies Partial<TeamApiError>);
        }
      }

      await sendGroupCase({ team, sender: team.envA.user, text: "/status" });

      await Promise.all([
        personalAnswerAndResume(team, team.envA, teamEnabled ? "A-on" : "A-off"),
        personalAnswerAndResume(team, team.envB, teamEnabled ? "B-on" : "B-off"),
      ]);

      for (const [member, other] of [[team.envA, team.envB], [team.envB, team.envA]] as const) {
        const privateSenders = member.app.query<{ sender: string }>("SELECT DISTINCT json_extract(payload_json,'$.transportUserId') sender FROM telegram_inbox WHERE json_extract(payload_json,'$.chatType')='private'");
        expect(privateSenders).toEqual([{ sender: String(member.user.id) }]);
        expect(JSON.stringify(member.app.query("SELECT payload_json FROM telegram_inbox WHERE json_extract(payload_json,'$.chatType')='private'"))).not.toContain(String(other.user.id));
      }
      const groupText = team.fakeTelegram.transcript(team.groupChat.id).map(message => message.text).join("\n");
      expect(groupText).not.toContain("private answer");
      expect(groupText).not.toContain("Choose private");
    } finally {
      await team.dispose();
    }
  }
});
