import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { startTeamHarness, type TeamHarness, type TeamHarnessMember } from "../../src/env/teamHarness.ts";
import { eventually } from "../../src/drivers/state.ts";
import { createTeamFixture, pairTeamMember, registerTeamWorkspace, teamApi } from "../../src/teamFlows.ts";
import type { StoredMessage } from "../../src/fakes/telegramServer.ts";

/*
 * C4 (docs/telegram-task-control/team-gap-register.md).
 *
 * H07 closed M-4's rule 4.5 by jd's ruling 7 of 2026-09-22: `/close` is refused
 * while a handover is live, so an owner cannot destroy a receiver's unreturned
 * work. That guard's entire proof was the server tier - `grep -rn handover_live
 * e2e/` was empty - and three times on this track a green server suite has been
 * consistent with a broken user surface. This file is the end-to-end half: the
 * guard driven through the surface a person actually uses, in the group chat,
 * by the owner, on a real live handover between two workstations.
 *
 * What it drives, on one booted pair of workstations:
 *
 * - one item handed over for real, closed three times while the handover is
 *   live - once while the offer is open, once while the receiver holds it, and
 *   once while returned work sits unapplied, which are the two situations jd's
 *   ruling names plus the open call H07 read into it;
 * - a second item with no handover at all, closed through the same `/close`,
 *   the same card and the same tap. That is the control: without it the three
 *   refusals above would be equally consistent with a close path that had
 *   simply stopped working.
 *
 * Both `/close` paths are asserted as they actually behave. H07 recorded a
 * deliberate limit: the text command still mints its card and refuses on the
 * tap rather than before the card, because refusing earlier meant turning two
 * handlers async, and H07 chose one unbypassable guard over two that can
 * diverge. That is a design decision, so the rows below assert it rather than
 * asserting the tidier behaviour.
 *
 * Not asserted here, and recorded rather than implied:
 *
 * - The whole `CONTROL_STATES` table. Every state's verdict, including the
 *   excluded `LOCAL`, `PREPARING`, `COMPLETED`, `CANCELLED` and `WITHDRAWN`,
 *   is covered at the server tier in `taskControl.test.ts`; driving fourteen
 *   states through two live workstations would restate that at a hundred times
 *   the cost. What only this tier can show is that the guard is reached at all
 *   from a person's tap, and that is what is here.
 * - `/close` typed by somebody who is not the owner, and `/close` on a thread
 *   that is already closed. Both are refused before the guard, neither is a
 *   handover question, and `tm3-grants.spec.ts` already drives the second.
 */

test.setTimeout(15 * 60_000);

const HANDOVER_ON = { "team.enabled": true, "team.handoverEnabled": true };
const PROVIDER = "grok";
/** The states in which an executor holds the item (`LIVE_HANDOVER_STATES`, minus the two that name no person). */
const HELD_STATES = ["CLAIMED", "STARTING", "RUNNING", "WAITING_INPUT", "PAUSED", "STOP_REQUESTED"];

/*
 * The fixture helpers below are tm4-handover.spec.ts's, unchanged. They are
 * copied rather than imported because that spec exports nothing, and lifting
 * them into a shared module would edit the one spec that proves the handover
 * itself - a change outside this task's card.
 */

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
  const { program } = await teamApi<{ program: { id: number } }>(member, "POST", `/api/workspaces/${workspace.id}/programs`, { name: `Close guard program ${suffix}`, overview: "" });
  const { suite } = await teamApi<{ suite: { id: number } }>(member, "POST", `/api/programs/${program.id}/suites`, { name: "Close guard", overview: "" });
  const { prompt } = await teamApi<{ prompt: { id: number } }>(member, "POST", `/api/suites/${suite.id}/prompts`, { title: `Close guard task ${suffix}`, content: "Finish the release colour work." });
  return { workspaceId: workspace.id, promptId: prompt.id };
}

function startRun(member: TeamHarnessMember, task: { workspaceId: number; promptId: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${member.app.serverUrl.replace(/^http/, "ws")}/ws`);
    const timeout = setTimeout(() => { socket.close(); reject(new Error("run did not start")); }, 20_000);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ kind: "run", provider: PROVIDER, workspaceId: task.workspaceId, promptId: task.promptId, model: null })));
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

function button(message: StoredMessage, label: string): string | undefined {
  return message.reply_markup?.inline_keyboard.flat().find(entry => entry.text === label)?.callback_data;
}

/** A tap, delivered to the bot that posted the card, by that workstation's own person. */
async function tap(team: TeamHarness, member: TeamHarnessMember, message: StoredMessage, label: string): Promise<string> {
  const data = button(message, label);
  expect(data, `${label} button on message ${message.message_id}`).toBeTruthy();
  const callbackId = team.fakeTelegram.userTapsButton(member.bot, member.user, team.groupChat, message.message_id, data!);
  return eventually(`${label} callback answer`, async () => team.fakeTelegram.callbackAnswer(callbackId)?.text, 60_000);
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

interface ControlSnapshot { state: string; epoch: number; executor: string | null }

/** The shared record itself, read straight out of the bare repository. */
function sharedRecord(itemId: string): ControlSnapshot {
  return JSON.parse(git(team.root, "--git-dir", team.bareRepository, "show", `refs/aw/items/${itemId}/control:state.json`)) as ControlSnapshot;
}

/**
 * The record as one workstation already knows it: its own private bare clone
 * under `.agent-console/handover/control.git`. This is the copy the close guard
 * reads (`knownHandoverRecord`, which never fetches), so it is the copy to wait
 * on before asserting which live state the refusal names.
 */
function mirrorRecord(member: TeamHarnessMember, itemId: string): ControlSnapshot | null {
  const result = spawnSync("git", [
    "--git-dir", join(member.app.root, ".agent-console", "handover", "control.git"),
    "show", `refs/aw/items/${itemId}/control:state.json`,
  ], { encoding: "utf8" });
  return result.status === 0 ? JSON.parse(result.stdout) as ControlSnapshot : null;
}

interface Item { task: { workspaceId: number; promptId: number }; itemId: string; tag: string; anchor: StoredMessage }

/** Env A's item: a blocked task with a pinned anchor, and uncommitted work to hand over. */
async function itemWithPendingWork(suffix: string): Promise<Item> {
  git(team.envA.git.workspace, "checkout", "-q", "-b", `work-${suffix}`);
  const task = await createTask(team.envA, suffix);
  team.envA.app.fakeProvider.queue({ behavior: "block-on-decision", reason: "The release colour needs a person.", humanAction: "Choose blue or green." });
  await startRun(team.envA, task);
  await eventually("owner task blocked", async () => team.envA.app.query<{ status: string }>("SELECT status FROM prompt WHERE id=?", task.promptId)[0]?.status === "BLOCKED");
  const opened = await teamApi<{ item: { itemId: string } }>(team.envA, "POST", "/api/task-control/team/items", { promptId: task.promptId });
  const tag = `#item_${opened.item.itemId.slice(5)}`;
  const anchor = await eventually("owner item anchor", async () => groupTranscript().find(message =>
    message.from.id === team.envA.bot.id && message.text.includes(tag) && message.reply_to_message === undefined));
  writeFileSync(join(team.envA.git.workspace, "notes.md"), "what is left: choose the release colour\n");
  return { task, itemId: opened.item.itemId, tag, anchor };
}

interface Preview { itemId: string; totalBytes: number; files: Array<{ path: string }> }

/** The requester's three route steps, exactly as the web control drives them. */
async function publishOffer(itemId: string): Promise<void> {
  await teamApi(team.envA, "POST", `/api/task-control/team/handover/${itemId}/begin`, {});
  const { preview } = await teamApi<{ preview: Preview }>(team.envA, "GET", `/api/task-control/team/handover/${itemId}/preview?provider=${PROVIDER}`);
  await teamApi(team.envA, "POST", `/api/task-control/team/handover/${itemId}/publish`, { confirmations: ["publish"], acknowledgedBytes: preview.totalBytes });
}

const groupTranscript = () => team.fakeTelegram.transcript(team.groupChat.id);

const cardFrom = (member: TeamHarnessMember, needle: string) =>
  groupTranscript().find(message => message.from.id === member.bot.id && message.text.includes(needle));

/* --------------------------- the close, as a person makes it -------------------------- */

interface CloseAttempt {
  /** The `/close` the owner typed, in the item's thread. */
  typed: StoredMessage;
  /**
   * Everything the owner's bot said **about this item** between the command and
   * the card it minted. Scoped to the item's own tag because the group chat is
   * shared: the first run of this file filtered on the bot alone and caught the
   * review card for another item's returned work, which is not a `/close` reply
   * at all.
   */
  betweenTypedAndCard: StoredMessage[];
  /** The card the text command minted. */
  card: StoredMessage;
  /** The toast the tap was answered with. */
  toast: string;
  /**
   * What the bot then put in the thread: `Done: …` or `Not applied: …`. Every
   * item message is filed in the item's own thread, so the tag is its last
   * line - observed, not assumed: the first run of this file asserted the
   * refusal without it and was corrected by what the product actually emitted.
   */
  reply: StoredMessage;
}

/**
 * One whole `/close`, both paths, driven the way the owner does it: the text
 * command typed as a reply to the item's anchor, then the tap on the card it
 * mints. Nothing here asserts the verdict - it is captured and asserted in the
 * rows below, so that a guard that stops refusing fails a named assertion
 * instead of timing out in a hook.
 */
async function closeFromTelegram(item: Item, what: string): Promise<CloseAttempt> {
  const typed = team.fakeTelegram.userSendsMessage(team.envA.bot, team.envA.user, team.groupChat, "/close", { replyToMessageId: item.anchor.message_id });
  const card = await eventually(`the close card ${what}`, async () => groupTranscript().find(message =>
    message.from.id === team.envA.bot.id && message.message_id > typed.message_id && message.text.startsWith("Close item thread")), 60_000);
  const betweenTypedAndCard = groupTranscript().filter(message =>
    message.from.id === team.envA.bot.id && message.text.includes(item.tag)
    && message.message_id > typed.message_id && message.message_id < card.message_id);
  const toast = await tap(team, team.envA, card, "Close thread");
  const reply = await eventually(`the reply to the close tap ${what}`, async () => groupTranscript().find(message =>
    message.from.id === team.envA.bot.id && message.message_id > card.message_id && /^(Done|Not applied):/.test(message.text)), 60_000);
  return { typed, betweenTypedAndCard, card, toast, reply };
}

/** Every close receipt the owner's workstation holds for one item. */
const closeReceipts = (itemId: string) => team.envA.app.query<{ state: string; errorCode: string | null; message: string }>(
  `SELECT r.state state, r.error_code errorCode, r.message message
     FROM task_control_receipt r JOIN task_control_action a ON a.ref = r.action_ref
    WHERE a.action = 'close_thread' AND a.item_id = ? ORDER BY r.rowid`, itemId);

const isClosed = (itemId: string) => team.envA.app.query<{ closedAt: string | null }>("SELECT closed_at closedAt FROM item_link WHERE item_id=?", itemId)[0]?.closedAt !== null;

/* ------------------------------------ the drive ----------------------------------- */

let team: TeamHarness;
let item: Item;
let offered: CloseAttempt;
let held: CloseAttempt | null = null;
let heldState: ControlSnapshot | null = null;
let returned: CloseAttempt | null = null;
let recordAfterRefusals: ControlSnapshot | null = null;
let quiet: Item;
let quietClose: CloseAttempt;

test.beforeAll(async () => {
  // A hook does not inherit the file's test timeout, and this one boots two
  // workstations and drives a whole handover through them.
  test.setTimeout(15 * 60_000);
  team = await startTeamHarness({
    envA: { fakeProvider: "live", settings: HANDOVER_ON },
    envB: { fakeProvider: "live", settings: HANDOVER_ON },
  });
  await joinFixture(team);

  /* ---- one item, really handed over, closed at each live stage ---- */
  item = await itemWithPendingWork("c4");
  team.envB.app.fakeProvider.queue({ behavior: "done", verificationSummary: "Chose blue and recorded it." });
  await publishOffer(item.itemId);
  await eventually("the owner's own copy of the open call", async () => mirrorRecord(team.envA, item.itemId)?.state === "OFFERED", 60_000);
  offered = await closeFromTelegram(item, "while the offer is open");

  /*
   * The two later stages need the item still open, because a thread this close
   * destroyed is refused before the guard is ever consulted and every later
   * assertion would then fail as a hook timeout rather than as a verdict. So
   * they are driven only while the guard is still holding, and the rows below
   * say plainly when the drive stopped. This is what keeps a broken guard
   * failing the first row by name instead of the whole file by timeout.
   */
  if (!isClosed(item.itemId)) {
    // The receiver accepts from their own bot's card, so the item is now held
    // by somebody else: jd's ruling's first situation.
    const offerCard = await eventually("env B's own offer card", async () => cardFrom(team.envB, "Handover offered"), 120_000);
    expect(await tap(team, team.envB, offerCard, "Accept and run")).toContain("Accepted");
    heldState = await eventually("the owner's own copy of the receiver's claim", async () => {
      const mirror = mirrorRecord(team.envA, item.itemId);
      return mirror !== null && mirror.executor !== null && mirror.state !== "OFFERED" ? mirror : undefined;
    }, 120_000);
    held = await closeFromTelegram(item, "while the receiver holds it");

    // The receiver returns the work, and nobody has applied it: the second
    // situation, and the one that loses somebody's work outright.
    const returnCard = await eventually("env B's Return work card", async () => cardFrom(team.envB, "Return work"), 240_000);
    expect(await tap(team, team.envB, returnCard, "Return work")).toContain("Returned");
    await eventually("the owner's own copy of the returned work", async () => mirrorRecord(team.envA, item.itemId)?.state === "RETURNED", 120_000);
    returned = await closeFromTelegram(item, "while returned work is unapplied");
    recordAfterRefusals = sharedRecord(item.itemId);
  }

  /* ---- the control: the same command on an item with no handover ---- */
  quiet = await itemWithPendingWork("c4-quiet");
  quietClose = await closeFromTelegram(quiet, "on an item with no handover");
});

test.afterAll(async () => {
  await team?.dispose();
});

/*
 * Deliberately not serial. The rows share one drive, but each asserts a
 * different thing the guard must do, and serial mode would skip the rest the
 * moment the first one failed - which is how the surfaces in C3 went on hiding
 * behind one another.
 */

test("C4 (T1): /close is refused while a live handover is offered, and the refusal names it", {
  annotation: { type: "covers", description: "C4" },
}, async () => {
  expect(offered.toast).toMatch(/^Not applied:/);
  // The refusal names the live handover and says what to do instead, which is
  // the whole reason it names it rather than only forbidding the close.
  expect(offered.reply.text).toBe(
    "Not applied: This item has a live handover, so it cannot be closed:"
    + ` ${item.itemId} is offered and any teammate can still accept it. Withdraw the offer first.\n${item.tag}`);
  // And nothing the close would have destroyed was touched.
  expect(isClosed(item.itemId), "a refused close leaves the item open").toBe(false);
});

test("C4 (T1): the /close text command mints its card and refuses on the tap, not before it", {
  annotation: { type: "covers", description: "C4" },
}, async () => {
  /*
   * H07's recorded limit, asserted as the design it is. The text command does
   * not refuse: it mints the same card it always mints, and the guard stands on
   * the tap, where every path converges. Refusing earlier would mean turning two
   * handlers async, and H07 chose one unbypassable guard over two that can
   * diverge. If this row ever goes red because the bot answered the text with a
   * refusal, that is a product change to take to jd, not a test to update.
   */
  expect(offered.betweenTypedAndCard.map(message => message.text),
    "the text command says nothing before its card, on either verdict").toEqual([]);
  expect(offered.card.text).toContain("Close this item thread and end every active grant.");
  expect(button(offered.card, "Close thread"), "the card offers the tap the guard stands on").toBeTruthy();
  // The refusal arrived after the card, in answer to the tap - both the toast
  // the tapper sees and the message left in the thread.
  expect(offered.reply.message_id).toBeGreaterThan(offered.card.message_id);
  expect(offered.reply.text).toMatch(/^Not applied: This item has a live handover/);
  // The same is true of the control close, which is applied rather than
  // refused: the text path mints a card there too and says nothing itself.
  expect(quietClose.betweenTypedAndCard.map(message => message.text)).toEqual([]);
  expect(quietClose.reply.message_id).toBeGreaterThan(quietClose.card.message_id);
});

test("C4 (T1): /close is refused while the receiver holds the item and while returned work is unapplied", {
  annotation: { type: "covers", description: "C4" },
}, async () => {
  expect(held, "the drive reached the receiver's claim").not.toBeNull();
  expect(returned, "the drive reached the returned work").not.toBeNull();

  // jd's first situation: a receiver holds the item. The refusal names who,
  // and which of the held states the record was in when the guard read it.
  expect(HELD_STATES).toContain(heldState!.state);
  expect(held!.toast).toMatch(/^Not applied:/);
  expect(held!.reply.text).toMatch(new RegExp(
    `^Not applied: This item has a live handover, so it cannot be closed: ${heldState!.executor} is holding ${item.itemId} \\((${HELD_STATES.join("|")})\\)\\. `
    + `Cancel the handover, or wait for the work to come back and apply it, first\\.\n${item.tag}$`));

  // jd's second situation, and the data-loss shape itself: the work is back and
  // unapplied, and a close here would revoke the grants and end the item, after
  // which H05's own refusal guarantees the work can never land.
  expect(returned!.toast).toMatch(/^Not applied:/);
  expect(returned!.reply.text).toBe(
    `Not applied: This item has a live handover, so it cannot be closed: work returned on ${item.itemId} has not been applied.`
    + ` Apply the returned work or cancel the handover first.\n${item.tag}`);

  // Three refused closes, three rejections with the guard's own code, and no
  // receipt that applied one.
  const receipts = closeReceipts(item.itemId);
  expect(receipts.length).toBe(3);
  expect(receipts.map(receipt => receipt.state)).toEqual(["REJECTED", "REJECTED", "REJECTED"]);
  expect(receipts.map(receipt => receipt.errorCode)).toEqual(["handover_live", "handover_live", "handover_live"]);

  // Nothing was destroyed and nothing was written: the item is open, and the
  // shared record is exactly where the receiver left it.
  expect(isClosed(item.itemId)).toBe(false);
  expect(recordAfterRefusals).toMatchObject({ state: "RETURNED", epoch: 1 });
  expect(team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM agent_run WHERE prompt_id=?", item.task.promptId)[0]!.n).toBe(1);
});

test("C4 (T1): the same /close closes an item that has no live handover", {
  annotation: { type: "covers", description: "C4" },
}, async () => {
  /*
   * The control. Without it the refusals above are equally consistent with a
   * close path that has simply stopped working, which is the mistake this track
   * keeps registering: a red that is read as proof of the thing it was pointed
   * at. Same command, same card, same tap, no handover, and it closes.
   */
  expect(mirrorRecord(team.envA, quiet.itemId), "the control item was never handed over").toBeNull();
  expect(quietClose.toast).toBe("Thread closed; grants ended.");
  expect(quietClose.reply.text).toBe(`Done: Thread closed; grants ended.\n${quiet.tag}`);
  expect(closeReceipts(quiet.itemId).map(receipt => receipt.state)).toEqual(["APPLIED"]);
  expect(isClosed(quiet.itemId), "an item with no live handover closes as it always did").toBe(true);
});
