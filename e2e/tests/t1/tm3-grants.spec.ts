import { expect, test } from "@playwright/test";
import { startTeamHarness, type TeamHarness, type TeamHarnessMember } from "../../src/env/teamHarness.ts";
import { eventually } from "../../src/drivers/state.ts";
import { createTeamFixture, pairTeamMember, registerTeamWorkspace, remoteRoster, replaceRemoteRoster, teamApi } from "../../src/teamFlows.ts";
import type { StoredMessage } from "../../src/fakes/telegramServer.ts";

test.describe.configure({ mode: "serial" });
test.setTimeout(15 * 60_000);

const ACTION_TTL_MS = 15_000;

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

async function createTask(member: TeamHarnessMember, suffix: string): Promise<{ workspaceId: number; promptId: number }> {
  const listed = await teamApi<{ workspaces: Array<{ id: number; workDirectory: string }> }>(member, "GET", "/api/workspaces");
  const workspace = listed.workspaces.find(entry => entry.workDirectory === member.git.workspace)!;
  const { program } = await teamApi<{ program: { id: number } }>(member, "POST", `/api/workspaces/${workspace.id}/programs`, { name: `Grant program ${suffix}`, overview: "" });
  const { suite } = await teamApi<{ suite: { id: number } }>(member, "POST", `/api/programs/${program.id}/suites`, { name: "Grant review", overview: "" });
  const { prompt } = await teamApi<{ prompt: { id: number } }>(member, "POST", `/api/suites/${suite.id}/prompts`, { title: `Grant task ${suffix}`, content: "Wait for the release colour." });
  return { workspaceId: workspace.id, promptId: prompt.id };
}

function startRun(member: TeamHarnessMember, task: { workspaceId: number; promptId: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${member.app.serverUrl.replace(/^http/, "ws")}/ws`);
    const timeout = setTimeout(() => { socket.close(); reject(new Error("run did not start")); }, 20_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ kind: "run", provider: "grok", workspaceId: task.workspaceId, promptId: task.promptId, model: null })));
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data)) as { kind?: string; runId?: string; source?: { promptId?: number }; event?: { type?: string; payload?: { message?: string } } };
      if (message.kind === "run_started" && message.source?.promptId === task.promptId && message.runId) {
        clearTimeout(timeout); socket.close(); resolve(message.runId);
      } else if (message.kind === "event" && message.event?.type === "error") {
        clearTimeout(timeout); socket.close(); reject(new Error(message.event.payload?.message ?? "run failed"));
      }
    });
    socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("run socket failed")); });
  });
}

function button(message: StoredMessage, label: string): string {
  return message.reply_markup!.inline_keyboard.flat().find(entry => entry.text === label)!.callback_data!;
}

async function tap(team: TeamHarness, message: StoredMessage, label: string, user = team.envA.user): Promise<string> {
  const callbackId = team.fakeTelegram.userTapsButton(team.envA.bot, user, team.groupChat, message.message_id, button(message, label));
  return eventually(`${label} callback result`, async () => team.fakeTelegram.callbackAnswer(callbackId)?.text);
}

async function blockedItem(team: TeamHarness, suffix: string, resumed = false) {
  const task = await createTask(team.envA, suffix);
  team.envA.app.fakeProvider.queue(
    { behavior: "block-on-decision", reason: "The release colour needs a person.", humanAction: "Choose blue or green." },
    ...(resumed ? [{ behavior: "consume-answer" as const, expectInContext: "Use blue" }] : []),
  );
  await startRun(team.envA, task);
  await eventually("owner task blocked", async () => team.envA.app.query<{ status: string }>("SELECT status FROM prompt WHERE id=?", task.promptId)[0]?.status === "BLOCKED");
  const opened = await teamApi<{ item: { itemId: string } }>(team.envA, "POST", "/api/task-control/team/items", { promptId: task.promptId });
  const tag = `#item_${opened.item.itemId.slice(5)}`;
  const group = () => team.fakeTelegram.transcript(team.groupChat.id);
  const anchor = await eventually("owner item anchor", async () => group().find(message => message.from.id === team.envA.bot.id && message.text.includes(tag) && message.reply_to_message === undefined));
  const access = await eventually("one item access message", async () => group().find(message => message.from.id === team.envA.bot.id && message.text.startsWith("Item access") && message.text.includes(tag)));
  return { task, itemId: opened.item.itemId, tag, anchor, access, group };
}

async function grant(team: TeamHarness, access: StoredMessage, capability: "answer" | "resume"): Promise<void> {
  const edits = access.history.length;
  await eventually(`${capability} grant button`, async () => access.reply_markup?.inline_keyboard.flat().some(entry => entry.text === `Grant ${capability}`));
  expect(await tap(team, access, `Grant ${capability}`)).toContain("Granted");
  await eventually(`${capability} access edit`, async () => access.history.length > edits && access.reply_markup?.inline_keyboard.flat().some(entry => entry.text === `Revoke ${capability}`));
}

async function revoke(team: TeamHarness, access: StoredMessage, capability: "answer" | "resume"): Promise<void> {
  const edits = access.history.length;
  await eventually(`${capability} revoke button`, async () => access.reply_markup?.inline_keyboard.flat().some(entry => entry.text === `Revoke ${capability}`));
  expect(await tap(team, access, `Revoke ${capability}`)).toContain("Revoked");
  await eventually(`${capability} revoke edit`, async () => access.history.length > edits && access.reply_markup?.inline_keyboard.flat().some(entry => entry.text === `Grant ${capability}`));
}

async function grantFromCommand(team: TeamHarness, item: Awaited<ReturnType<typeof blockedItem>>, capability: "answer" | "resume"): Promise<void> {
  const edits = item.access.history.length;
  const sent = team.fakeTelegram.userSendsMessage(team.envA.bot, team.envA.user, team.groupChat, `/grant ${capability}`, { replyToMessageId: item.anchor.message_id });
  const card = await eventually(`${capability} command grant card`, async () => item.group().find(message => message.message_id > sent.message_id && message.from.id === team.envA.bot.id && message.text.includes(`Grant ${capability}`) && message.reply_markup?.inline_keyboard.flat().some(entry => entry.text === "Grant")));
  expect(await tap(team, card, "Grant")).toContain("Granted");
  await eventually(`${capability} command grant edit`, async () => item.access.history.length > edits && item.access.reply_markup?.inline_keyboard.flat().some(entry => entry.text === `Revoke ${capability}`));
}

test("TM-T1-4: owner grants answer and resume and teammate starts exactly one owner run", {
  annotation: { type: "covers", description: "T19, TM-T1-4, D11, D19" },
}, async () => {
  const team = await startTeamHarness({ envA: { fakeProvider: "live" } });
  try {
    await joinFixture(team);
    const item = await blockedItem(team, "happy", true);
    const beforeRefusal = item.group().at(-1)?.message_id ?? 0;
    team.fakeTelegram.userSendsMessage(team.envA.bot, team.envB.user, team.groupChat, "/resume", { replyToMessageId: item.anchor.message_id });
    await eventually("ungranted resume refusal", async () => item.group().find(message => message.message_id > beforeRefusal && message.from.id === team.envA.bot.id && message.text.includes("grant resume")));

    await grant(team, item.access, "answer");
    await grant(team, item.access, "resume");
    expect(item.access.text).toContain("answer, resume");
    const answerSent = team.fakeTelegram.userSendsMessage(team.envA.bot, team.envB.user, team.groupChat, "/answer Use blue", { replyToMessageId: item.anchor.message_id });
    const card = await eventually("teammate answer card", async () => item.group().find(message => message.message_id > answerSent.message_id && message.from.id === team.envA.bot.id && message.text.includes("Use blue") && message.reply_markup?.inline_keyboard.flat().some(entry => entry.text === "Answer and resume")));
    expect(card.text).toMatch(/Uses Team A's grok allowance/);
    expect(await tap(team, card, "Answer and resume", team.envB.user)).toContain("Answer saved");
    await eventually("resumed owner task done", async () => team.envA.app.query<{ status: string }>("SELECT status FROM prompt WHERE id=?", item.task.promptId)[0]?.status === "DONE", 60_000);
    const ownerRuns = team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM agent_run WHERE prompt_id=?", item.task.promptId)[0]!.n;
    const teammateRuns = team.envB.app.query<{ n: number }>("SELECT COUNT(*) n FROM agent_run")[0]!.n;
    expect(ownerRuns).toBe(2);
    expect(teammateRuns).toBe(0);
    expect(team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM task_control_receipt r JOIN task_control_action a ON a.ref=r.action_ref WHERE a.prompt_id=? AND r.state='APPLIED' AND r.started=1", item.task.promptId)[0]!.n).toBe(1);
  } finally {
    await team.dispose();
  }
});

test("TM-T1-5: revoke and expiry reject open cards and teammate removal ends authority", {
  annotation: { type: "covers", description: "T19, TM-T1-5, tap-time grants, offline expiry" },
}, async () => {
  const team = await startTeamHarness({ envA: { fakeProvider: "live", serverEnv: { AGENT_CONSOLE_HARNESS_ACTION_TTL_MS: String(ACTION_TTL_MS) } } });
  try {
    await joinFixture(team);
    const item = await blockedItem(team, "revoke-expire");
    await grant(team, item.access, "answer");
    await grant(team, item.access, "resume");
    const sent = team.fakeTelegram.userSendsMessage(team.envA.bot, team.envB.user, team.groupChat, "/answer Use blue", { replyToMessageId: item.anchor.message_id });
    const answerCard = await eventually("open teammate answer card", async () => item.group().find(message => message.message_id > sent.message_id && message.from.id === team.envA.bot.id && message.text.includes("Use blue") && message.reply_markup?.inline_keyboard.flat().some(entry => entry.text === "Answer and resume")));
    await revoke(team, item.access, "resume");
    const runsBefore = team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM agent_run WHERE prompt_id=?", item.task.promptId)[0]!.n;
    expect(await tap(team, answerCard, "Answer and resume", team.envB.user)).toContain("grant resume");
    expect(team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM agent_run WHERE prompt_id=?", item.task.promptId)[0]!.n).toBe(runsBefore);
    expect(await tap(team, answerCard, "Save answer", team.envB.user)).toContain("Answer saved");
    await grantFromCommand(team, item, "resume");

    const resumeSent = team.fakeTelegram.userSendsMessage(team.envA.bot, team.envB.user, team.groupChat, "/resume", { replyToMessageId: item.anchor.message_id });
    const resumeCard = await eventually("open teammate resume card", async () => item.group().find(message => message.message_id > resumeSent.message_id && message.from.id === team.envA.bot.id && message.text.includes("Resume with the saved answer") && message.reply_markup?.inline_keyboard.flat().some(entry => entry.text === "Resume with saved answer")));
    await team.envA.app.stopServer();
    await new Promise(resolve => setTimeout(resolve, ACTION_TTL_MS + 250));
    const expiredCallback = team.fakeTelegram.userTapsButton(team.envA.bot, team.envB.user, team.groupChat, resumeCard.message_id, button(resumeCard, "Resume with saved answer"));
    await team.envA.app.startServer();
    await eventually("expired offline tap rejected", async () => team.fakeTelegram.callbackAnswer(expiredCallback)?.text.includes("expired") || undefined, 30_000);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(item.group().some(message => message.from.id === team.envA.bot.id && message.text.startsWith("Item action renewed") && message.message_id > resumeCard.message_id)).toBe(false);
    expect(team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM agent_run WHERE prompt_id=?", item.task.promptId)[0]!.n).toBe(runsBefore);

    const retrySent = team.fakeTelegram.userSendsMessage(team.envA.bot, team.envB.user, team.groupChat, "/resume", { replyToMessageId: item.anchor.message_id });
    const retriggeredCard = await eventually("teammate retriggers expired action", async () => item.group().find(message => message.message_id > retrySent.message_id && message.from.id === team.envA.bot.id && message.text.includes("Resume with the saved answer") && message.reply_markup?.inline_keyboard.flat().some(entry => entry.text === "Resume with saved answer")));

    const remote = remoteRoster(team);
    const removedPerson = remote.roster.members.find(member => member.telegramUserId === String(team.envB.user.id))!;
    replaceRemoteRoster(team, remote.head, { ...remote.roster, members: remote.roster.members.filter(member => member.telegramUserId !== String(team.envB.user.id)), updatedAt: new Date().toISOString() });
    await teamApi(team.envA, "POST", "/api/task-control/team/refresh", {});
    expect(team.envA.app.query<{ enabled: number }>("SELECT enabled FROM task_control_actor WHERE transport_user_id=? AND topic_id='__team_group__'", removedPerson.telegramUserId)[0]?.enabled).toBe(0);
    expect(team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM item_grant WHERE person_id=? AND revoked_at IS NULL", removedPerson.personId)[0]!.n).toBe(0);
    expect(retriggeredCard.reply_markup?.inline_keyboard.flat().some(entry => entry.text === "Resume with saved answer")).toBe(true);
    expect(team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM agent_run WHERE prompt_id=?", item.task.promptId)[0]!.n).toBe(runsBefore);
  } finally {
    await team.dispose();
  }
});
