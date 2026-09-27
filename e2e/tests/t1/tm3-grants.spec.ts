import { expect, test } from "@playwright/test";
import { startTeamHarness, type TeamHarness, type TeamHarnessMember } from "../../src/env/teamHarness.ts";
import { eventually, observeQuietPeriod } from "../../src/drivers/state.ts";
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

/** Sends a read-only view command into the item thread and returns the owner bot's reply. */
async function viewReply(
  team: TeamHarness,
  item: Awaited<ReturnType<typeof blockedItem>>,
  command: string,
  prefix: string,
  user = team.envA.user,
): Promise<StoredMessage> {
  const sent = team.fakeTelegram.userSendsMessage(team.envA.bot, user, team.groupChat, command, { replyToMessageId: item.anchor.message_id });
  return eventually(`${command} reply`, async () => item.group().find(message =>
    message.message_id > sent.message_id && message.from.id === team.envA.bot.id && message.text.startsWith(prefix)));
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

    // TM-T1-4 requires that /access and /help show only current capabilities.
    const helpBefore = await viewReply(team, item, "/help", "Item commands", team.envB.user);
    expect(helpBefore.text).toContain("/task");
    expect(helpBefore.text).not.toContain("/answer");
    expect(helpBefore.text).not.toContain("/resume");
    expect(helpBefore.text).not.toContain("/context");
    const accessBefore = await viewReply(team, item, "/access", "Item access", team.envB.user);
    expect(accessBefore.text).toContain("read only");

    await grant(team, item.access, "answer");
    await grant(team, item.access, "resume");
    expect(item.access.text).toContain("answer, resume");

    const helpAfter = await viewReply(team, item, "/help", "Item commands", team.envB.user);
    expect(helpAfter.text).toContain("/answer");
    expect(helpAfter.text).toContain("/resume");
    expect(helpAfter.text).not.toContain("/context");
    expect(helpAfter.text).not.toContain("/grant");
    const accessAfter = await viewReply(team, item, "/access", "Item access", team.envB.user);
    expect(accessAfter.text).toContain("answer, resume");
    // The owner needs no grant, so their help lists the owner-only commands too.
    const ownerHelp = await viewReply(team, item, "/help", "Item commands");
    expect(ownerHelp.text).toContain("/grant");
    expect(ownerHelp.text).toContain("/close");
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

test("TM-T0-2 closed thread: a closed item grants nothing and accepts no command", {
  annotation: { type: "covers", description: "T19, TM-T0-2 closed thread state, B17, B14" },
}, async () => {
  const team = await startTeamHarness({ envA: { fakeProvider: "live" } });
  try {
    await joinFixture(team);
    const item = await blockedItem(team, "closed");
    await grant(team, item.access, "answer");

    // Minted before the close and deliberately left untapped, so the tap below
    // exercises the closed state rather than duplicate-delivery replay.
    const staleSent = team.fakeTelegram.userSendsMessage(team.envA.bot, team.envA.user, team.groupChat, "/grant resume", { replyToMessageId: item.anchor.message_id });
    const staleCard = await eventually("stale grant card", async () => item.group().find(message =>
      message.message_id > staleSent.message_id && message.from.id === team.envA.bot.id
      && message.reply_markup?.inline_keyboard.flat().some(entry => entry.text === "Grant")));

    const closeSent = team.fakeTelegram.userSendsMessage(team.envA.bot, team.envA.user, team.groupChat, "/close", { replyToMessageId: item.anchor.message_id });
    const closeCard = await eventually("close card", async () => item.group().find(message =>
      message.message_id > closeSent.message_id && message.from.id === team.envA.bot.id
      && message.reply_markup?.inline_keyboard.flat().some(entry => entry.text === "Close thread")));
    expect(await tap(team, closeCard, "Close thread")).toContain("closed");
    await eventually("grants ended by the close", async () =>
      team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM item_grant WHERE item_id=? AND revoked_at IS NULL", item.itemId)[0]!.n === 0);

    // The close is an end state. The access message it refreshes carries no
    // buttons afterwards (B14 armed three fresh grants there), and any card that
    // was already in the group is inert, whatever its expiry says.
    await eventually("closed access message drops its buttons", async () =>
      (item.access.reply_markup?.inline_keyboard.flat().length ?? 0) === 0);
    // The card that was already in the group is inert, whatever its expiry says.
    expect(await tap(team, staleCard, "Grant")).toMatch(/closed/i);
    expect(team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM item_grant WHERE item_id=? AND revoked_at IS NULL", item.itemId)[0]!.n).toBe(0);

    const afterClose = item.group().at(-1)?.message_id ?? 0;
    team.fakeTelegram.userSendsMessage(team.envA.bot, team.envA.user, team.groupChat, "/grant resume", { replyToMessageId: item.anchor.message_id });
    await eventually("grant refused on a closed thread", async () => item.group().find(message =>
      message.message_id > afterClose && message.from.id === team.envA.bot.id && /closed/i.test(message.text)));
    expect(item.group().some(message => message.message_id > afterClose
      && message.reply_markup?.inline_keyboard.flat().some(entry => entry.text === "Grant"))).toBe(false);
    expect(team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM item_grant WHERE item_id=? AND revoked_at IS NULL", item.itemId)[0]!.n).toBe(0);

    const beforeAnswer = item.group().at(-1)?.message_id ?? 0;
    team.fakeTelegram.userSendsMessage(team.envA.bot, team.envB.user, team.groupChat, "/answer Use blue", { replyToMessageId: item.anchor.message_id });
    await eventually("teammate command refused on a closed thread", async () => item.group().find(message =>
      message.message_id > beforeAnswer && message.from.id === team.envA.bot.id && /closed/i.test(message.text)));
    expect(item.group().some(message => message.message_id > beforeAnswer
      && message.reply_markup?.inline_keyboard.flat().some(entry => entry.text === "Save answer"))).toBe(false);

    // Nothing was written to the task by any of it.
    expect(team.envA.app.query<{ status: string }>("SELECT status FROM prompt WHERE id=?", item.task.promptId)[0]?.status).toBe("BLOCKED");
    // And the closure is durable, not just an absence of grants.
    expect(team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM item_link WHERE item_id=? AND closed_at IS NOT NULL", item.itemId)[0]!.n).toBe(1);
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


/*
 * M-15. The test above proves a closed thread refuses every *granted* command.
 * This one is about the four commands that need no grant, which took the other
 * branch of `handleTeamItemMessage` and were never tested at all: they answered a
 * closed thread exactly as they answer a live one, so a teammate could not tell a
 * dead thread from a live one. jd ruled on 2026-09-27: answer, say it is closed,
 * and write the thread row to CLOSED too.
 */
test("M-15 (T1): a closed item thread answers every read-only command and says it is closed", {
  annotation: { type: "covers", description: "M-15" },
}, async () => {
  const team = await startTeamHarness({ envA: { fakeProvider: "live" } });
  try {
    await joinFixture(team);
    const item = await blockedItem(team, "m15-closed");

    /*
     * Matched on the reply-to rather than on a text prefix, so one helper covers
     * all four commands. `/task` renders the anchor card, which begins with a
     * breadcrumb and not with the item title, so prefix matching silently never
     * finds it - a first run of this row spent its whole wait proving that.
     */
    /*
     * Each command is matched by its own output as well as by the reply-to, not by
     * the reply-to alone: a run of this row matched a `/task` card as the answer to
     * `/status` and reported a missing closed notice on a message that had one. A
     * matcher that cannot tell the four views apart cannot assert about them.
     */
    const COMMANDS = [
      ["/task", "Task: "],
      ["/status", "Item status"],
      ["/access", "Item access"],
      ["/help", "Item commands"],
    ] as const;
    const reply = async (command: string, own: string) => {
      const sent = team.fakeTelegram.userSendsMessage(team.envA.bot, team.envA.user, team.groupChat, command, { replyToMessageId: item.anchor.message_id });
      return eventually(`${command} reply`, async () => item.group().find(message =>
        message.message_id > sent.message_id && message.from.id === team.envA.bot.id
        && message.reply_to_message?.message_id === item.anchor.message_id
        && message.text.includes(own)));
    };
    // The marker: `/task`'s goes in the anchor card's footer hint, the other three
    // carry the sentence as a line of their own.
    const marker = (command: string) => command === "/task" ? "Thread closed" : "This item thread is closed.";

    // Before the close: the same four commands answer without the notice, so the
    // assertion below is about the close and not about the text always being there.
    for (const [command, own] of COMMANDS) {
      const before = await reply(command, own);
      expect(before.text, `${command} answers before the close`).toContain(item.tag);
      expect(before.text, `${command} does not claim a live thread is closed`).not.toContain(marker(command));
    }

    const closeSent = team.fakeTelegram.userSendsMessage(team.envA.bot, team.envA.user, team.groupChat, "/close", { replyToMessageId: item.anchor.message_id });
    const closeCard = await eventually("close card", async () => item.group().find(message =>
      message.message_id > closeSent.message_id && message.from.id === team.envA.bot.id
      && message.reply_markup?.inline_keyboard.flat().some(entry => entry.text === "Close thread")));
    expect(await tap(team, closeCard, "Close thread")).toContain("closed");
    await eventually("the link recorded closed", async () =>
      team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM item_link WHERE item_id=? AND closed_at IS NOT NULL", item.itemId)[0]!.n === 1);

    /*
     * Each command still answers - jd's ruling is that reading closed history is
     * defensible - and each answer now says the thread is closed. `/task` renders
     * the anchor card, whose marker is in the footer hint; the other three carry
     * the sentence as a line.
     */
    for (const [command, own] of COMMANDS) {
      const after = await reply(command, own);
      expect(after.text, `${command} still answers on a closed thread`).toContain(item.tag);
      expect(after.text, `${command} says the thread is closed`).toContain(marker(command));
    }

    // The record half of jd's ruling. Nothing routes on this column - every reader
    // filters ANCHOR_GONE or keys on PIN_PENDING - so it is asserted directly
    // rather than through a behaviour it does not drive.
    await eventually("the thread row says CLOSED", async () =>
      team.envA.app.query<{ state: string }>(
        "SELECT state FROM telegram_thread WHERE subject_kind='item' AND subject_id=?", item.itemId,
      )[0]?.state === "CLOSED");
  } finally {
    await team.dispose();
  }
});

/*
 * M-11. A closed-but-blocked item kept its pinned anchor forever. Completion
 * retires and unpins its anchor; a close did neither, because `syncTeamItem`
 * returns for a closed link and `finishCompletedTeamItems` only ever reaches a
 * DONE or SKIPPED prompt.
 *
 * jd ruled on 2026-09-27: retire and unpin, **after P-B2**. The sequencing is the
 * substance - the pin was kept for routability, and a closed thread that says so
 * is what makes the pin unnecessary. So this row also asserts the thread is still
 * reachable afterwards, because retiring it the way completion does would have
 * made a reply route nowhere.
 */
test("M-11 (T1): closing an item retires its anchor into a final card and unpins it, and the thread stays reachable", {
  annotation: { type: "covers", description: "M-11" },
}, async () => {
  const team = await startTeamHarness({ envA: { fakeProvider: "live" } });
  try {
    await joinFixture(team);
    const item = await blockedItem(team, "m11-unpin");
    const calls = (method: string) => team.fakeTelegram.calls.filter(call => call.method === method && call.botId === team.envA.bot.id);

    await eventually("the anchor to be pinned once", async () =>
      calls("pinChatMessage").length === 1 && team.fakeTelegram.pinnedMessageId(team.groupChat.id) === item.anchor.message_id);
    expect(calls("unpinChatMessage"), "an open item's anchor is not unpinned").toHaveLength(0);
    const editsBeforeClose = item.anchor.history.length;

    const closeSent = team.fakeTelegram.userSendsMessage(team.envA.bot, team.envA.user, team.groupChat, "/close", { replyToMessageId: item.anchor.message_id });
    const closeCard = await eventually("close card", async () => item.group().find(message =>
      message.message_id > closeSent.message_id && message.from.id === team.envA.bot.id
      && message.reply_markup?.inline_keyboard.flat().some(entry => entry.text === "Close thread")));
    expect(await tap(team, closeCard, "Close thread")).toContain("closed");

    // The final card: the same pinned message, edited in place, now saying it is
    // closed. Not a new message - the group keeps one anchor per item.
    await eventually("the anchor edited into its final closed card", async () =>
      item.anchor.history.length > editsBeforeClose && item.anchor.text.includes("Thread closed"));
    await eventually("the anchor unpinned exactly once", async () => calls("unpinChatMessage").length === 1);
    expect(team.fakeTelegram.pinnedMessageId(team.groupChat.id), "nothing is left pinned for this item").not.toBe(item.anchor.message_id);

    // Attempted once, never looped: the measured baseline this replaces was an
    // anchor that churned once an hour for eleven hours while open.
    await observeQuietPeriod(3_000, "a second unpin or a further anchor edit");
    expect(calls("unpinChatMessage"), "the unpin is attempted once and never retried").toHaveLength(1);
    const settledEdits = item.anchor.history.length;
    await observeQuietPeriod(3_000, "the retired anchor being edited again");
    expect(item.anchor.history.length, "and the retired card is not edited again").toBe(settledEdits);

    /*
     * The half that makes this safe rather than merely tidy. Retiring the way
     * completion does writes ANCHOR_GONE and clears the thread's pointer, and
     * `telegramItemThreadForMessage` resolves neither - so a bare reply would get
     * silence instead of M-15's answer. The thread is CLOSED, not ANCHOR_GONE.
     */
    expect(team.envA.app.query<{ state: string }>(
      "SELECT state FROM telegram_thread WHERE subject_kind='item' AND subject_id=?", item.itemId,
    )[0]?.state).toBe("CLOSED");
    const statusSent = team.fakeTelegram.userSendsMessage(team.envA.bot, team.envA.user, team.groupChat, "/status", { replyToMessageId: item.anchor.message_id });
    const statusReply = await eventually("a reply into the unpinned thread still answers", async () => item.group().find(message =>
      message.message_id > statusSent.message_id && message.from.id === team.envA.bot.id
      && message.reply_to_message?.message_id === item.anchor.message_id && message.text.includes("Item status")));
    expect(statusReply.text, "and still says the thread is closed").toContain("This item thread is closed.");
  } finally {
    await team.dispose();
  }
});
