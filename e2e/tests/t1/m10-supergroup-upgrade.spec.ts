import { expect, test } from "@playwright/test";
import { startTeamHarness, type TeamHarness, type TeamHarnessMember } from "../../src/env/teamHarness.ts";
import { eventually, observeQuietPeriod } from "../../src/drivers/state.ts";
import { createTeamFixture, pairTeamMember, registerTeamWorkspace, teamApi } from "../../src/teamFlows.ts";

/*
 * M-10 (docs/telegram-task-control/team-gap-register.md), which is F05's
 * criterion 3: "a harness case that upgrades a group mid-test and shows the next
 * anchor delivered to the new chat id with no manual repair."
 *
 * It has never existed, and the reason was the harness rather than the product.
 * B8's repair is driven by the Bot API answering 400 with
 * `parameters.migrate_to_chat_id`, and `e2e/src/fakes/telegramServer.ts` dropped
 * `parameters` from every error envelope it sent - so the failure could not be
 * expressed here at all. The server tier covers the repair in
 * `telegramSupergroupMigration.test.ts` against the server's own in-process fake;
 * what had no coverage was the whole loop, through real HTTP, with a real
 * database and a real delivery pass.
 *
 * So this row needed `FakeTelegramServer.upgradeChatToSupergroup`, added with it.
 * The upgrade is held as chat state rather than scripted as one failure, because
 * the refusal is permanent: an old chat id never works again, and a case that
 * only failed the next call would let the product look repaired when it had
 * merely run out of injected failures.
 *
 * The team group starts as a basic `group` here, which is the one place that
 * matters and the reason `groupChatType` exists. No product code reads the type.
 *
 * Named `M-10 (T1)` for its gap id, deliberately. Two invented `TM-T1-*` ids have
 * already been retired on this track for asserting rows that no scenario table
 * holds, and a third is not being minted.
 *
 * What it does NOT assert, recorded rather than implied:
 *
 * - The roster republish to the shared repository. `migrateTeamChat` moves the
 *   local rows first and republishes after, and it deliberately treats an
 *   unreachable repository as a delay rather than a failed repair. That ordering
 *   is the server tier's to pin; this row is about the anchor reaching the new id.
 * - Any second upgrade, or an upgrade racing a second delivery pass. One upgrade,
 *   one repair.
 */

test.setTimeout(15 * 60_000);

const OLD_CHAT = -100_555_000_333;
/** Where Telegram moves it. A different id, which is the whole point. */
const NEW_CHAT = -100_555_000_999;

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

async function blockedTask(team: TeamHarness, member: TeamHarnessMember, suffix: string): Promise<number> {
  const listed = await teamApi<{ workspaces: Array<{ id: number; workDirectory: string }> }>(member, "GET", "/api/workspaces");
  const workspace = listed.workspaces.find(entry => entry.workDirectory === member.git.workspace)!;
  const { program } = await teamApi<{ program: { id: number } }>(member, "POST", `/api/workspaces/${workspace.id}/programs`, { name: `Upgrade program ${suffix}`, overview: "" });
  const { suite } = await teamApi<{ suite: { id: number } }>(member, "POST", `/api/programs/${program.id}/suites`, { name: "Upgrade", overview: "" });
  const { prompt } = await teamApi<{ prompt: { id: number } }>(member, "POST", `/api/suites/${suite.id}/prompts`, { title: `WI_UP_${suffix}`, content: "Choose the release colour." });
  member.app.fakeProvider.queue({ behavior: "block-on-decision", reason: "The release colour needs a person.", humanAction: "Choose blue or green." });
  await startRun(member, { workspaceId: workspace.id, promptId: prompt.id });
  return prompt.id;
}

/*
 * The run is started over the same WebSocket the UI uses, which is how every
 * other Team row does it. A first draft posted to a REST route and swallowed the
 * failure with a `.catch`, so a wrong route would have surfaced as a two-minute
 * timeout on "the task to block" instead of naming itself.
 */
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

test("M-10 (T1): a mid-test supergroup upgrade moves the team group, and the next anchor lands on the new chat id unrepaired", {
  annotation: { type: "covers", description: "M-10, F05 criterion 3, B8" },
}, async () => {
  const team = await startTeamHarness({ groupChatType: "group", envA: { fakeProvider: "live" } });
  try {
    await joinFixture(team);
    expect(team.groupChat.id, "the team starts in a basic group").toBe(OLD_CHAT);

    /* ---------------- one item, delivered to the group before the upgrade ---------------- */

    const firstPrompt = await blockedTask(team, team.envA, "before");
    await eventually("the first task to block", async () =>
      team.envA.app.query<{ status: string }>("SELECT status FROM prompt WHERE id=?", firstPrompt)[0]?.status === "BLOCKED", 120_000);
    const first = await teamApi<{ item: { itemId: string } }>(team.envA, "POST", "/api/task-control/team/items", { promptId: firstPrompt });
    const firstTag = `#item_${first.item.itemId.slice(5)}`;
    await eventually("the first anchor in the old chat", async () =>
      team.fakeTelegram.transcript(OLD_CHAT).find(message => message.from.id === team.envA.bot.id && message.text.includes(firstTag)), 120_000);

    // Every local copy of the id says the old chat, which is what the repair has
    // to move. Read from the database rather than inferred.
    expect(team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM telegram_thread WHERE chat_id=?", String(OLD_CHAT))[0]!.n)
      .toBeGreaterThan(0);

    /* --------------------------------- the upgrade ---------------------------------- */

    // From here the old id is refused permanently, with the real Bot API's
    // envelope naming the new one. Nothing tells the product where the group went
    // except that refusal, which is the whole mechanism under test.
    const upgraded = team.fakeTelegram.upgradeChatToSupergroup(OLD_CHAT, NEW_CHAT);
    expect(upgraded.type, "Telegram upgrades it to a supergroup").toBe("supergroup");
    expect(upgraded.id).toBe(NEW_CHAT);

    /* ------------- a second item, whose anchor has nowhere to go but the new id ------------ */

    const secondPrompt = await blockedTask(team, team.envA, "after");
    await eventually("the second task to block", async () =>
      team.envA.app.query<{ status: string }>("SELECT status FROM prompt WHERE id=?", secondPrompt)[0]?.status === "BLOCKED", 120_000);
    const second = await teamApi<{ item: { itemId: string } }>(team.envA, "POST", "/api/task-control/team/items", { promptId: secondPrompt });
    const secondTag = `#item_${second.item.itemId.slice(5)}`;

    /*
     * The criterion, stated as F05 states it: the next anchor is delivered to the
     * new chat id, and nothing was repaired by hand. No test step moved an id, and
     * no operator action stands in for one.
     */
    /*
     * An anchor is a bot message carrying the item tag that replies to nothing -
     * the same identification every other Team row uses. It matters here: the
     * "Item access" message also carries the tag and replies to the anchor, so a
     * filter on the tag alone counts two messages for one item and reads as a
     * duplicate anchor. A first version of this row did exactly that and reported
     * `Expected: 1, Received: 2` against a product that was behaving correctly.
     */
    const anchorIn = (chatId: number) => team.fakeTelegram.transcript(chatId).filter(message =>
      message.from.id === team.envA.bot.id && message.text.includes(secondTag) && message.reply_to_message === undefined);
    const landed = await eventually("the next anchor delivered to the new chat id", async () => anchorIn(NEW_CHAT)[0], 180_000);
    expect(landed.chat.id, "delivered to the supergroup, not the old group").toBe(NEW_CHAT);

    // And it was not also delivered to the old id: a send that quietly succeeded
    // at the dead chat would be worse than one that failed.
    expect(team.fakeTelegram.transcript(OLD_CHAT).some(message => message.text.includes(secondTag)),
      "the dead chat id received nothing for the second item").toBe(false);

    /* ------------------------- the repair, in the local record ------------------------ */

    await eventually("every local copy of the chat id moved", async () =>
      team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM telegram_thread WHERE chat_id=?", String(OLD_CHAT))[0]!.n === 0, 120_000);
    expect(team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM telegram_thread WHERE chat_id=?", String(NEW_CHAT))[0]!.n,
      "the threads are on the new chat id").toBeGreaterThan(0);
    expect(team.envA.app.query<{ groupChatId: string }>("SELECT group_chat_id groupChatId FROM team_roster")[0]?.groupChatId,
      "and the cached roster names the new group").toBe(String(NEW_CHAT));

    // The repair happens once. A second delivery pass must not re-run it, which is
    // what a migration driven off a failing send could do on every pass.
    await observeQuietPeriod(6_000, "a second migration or a duplicate anchor");
    expect(anchorIn(NEW_CHAT).length, "exactly one anchor for the second item, so the repair did not re-enqueue").toBe(1);
    // And the access message that accompanies it went to the new chat too, rather
    // than being stranded at the dead id.
    expect(team.fakeTelegram.transcript(NEW_CHAT).some(message =>
      message.from.id === team.envA.bot.id && message.text.startsWith("Item access") && message.text.includes(secondTag)),
      "the item's access message also landed on the new chat id").toBe(true);
  } finally {
    await team.dispose();
  }
});
