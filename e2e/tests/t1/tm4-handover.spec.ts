import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { startTeamHarness, type TeamHarness, type TeamHarnessMember } from "../../src/env/teamHarness.ts";
import { eventually, observeQuietPeriod } from "../../src/drivers/state.ts";
import { createTeamFixture, pairTeamMember, registerTeamWorkspace, teamApi } from "../../src/teamFlows.ts";
import type { StoredMessage } from "../../src/fakes/telegramServer.ts";

/*
 * TM-T1-H1, TM-T1-H2 and TM-T1-H3 (docs/e2e-scenarios/tm4.md).
 *
 * These three rows were written by H04 and H05 and marked `test.fixme`, for one
 * reason stated plainly at the time: handover had no user surface. There was no
 * `/api/task-control/team/handover/…` route, `telegramLiveRuntime` scheduled no
 * control-record read, `registerHandoverTapHandler` had no production caller,
 * and `formatTelegramMessage` had no case for any handover card, so a Playwright
 * harness had nothing to drive. H06 built that surface and these rows now run.
 *
 * What each row is for is unchanged: the halves that need two app roots, two
 * bots, two databases and one shared bare repository. Everything that does not
 * need two databases stays at the server tier, in `teamControlRecord.test.ts`,
 * `teamHandoverCapture.test.ts`, `teamHandoverRun.test.ts`,
 * `teamResultApply.test.ts` and `teamHandoverSurface.test.ts`.
 *
 * Coverage is recorded honestly in each row's own comment: what it asserts, and
 * which of the numbered points from the original `fixme` bodies it does not.
 */

test.describe.configure({ mode: "serial" });
test.setTimeout(15 * 60_000);

const HANDOVER_ON = { "team.enabled": true, "team.handoverEnabled": true };
const PROVIDER = "grok";

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
  const { program } = await teamApi<{ program: { id: number } }>(member, "POST", `/api/workspaces/${workspace.id}/programs`, { name: `Handover program ${suffix}`, overview: "" });
  const { suite } = await teamApi<{ suite: { id: number } }>(member, "POST", `/api/programs/${program.id}/suites`, { name: "Handover", overview: "" });
  const { prompt } = await teamApi<{ prompt: { id: number } }>(member, "POST", `/api/suites/${suite.id}/prompts`, { title: `Handover task ${suffix}`, content: "Finish the release colour work." });
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

/**
 * A tap, delivered to the bot that posted the card. Which bot matters here more
 * than anywhere else in the suite: the receiver's Accept card is posted by env
 * B's own bot and its tap must reach env B, not env A.
 */
async function tap(team: TeamHarness, member: TeamHarnessMember, message: StoredMessage, label: string, user = member.user): Promise<string> {
  const data = button(message, label);
  expect(data, `${label} button on message ${message.message_id}`).toBeTruthy();
  const callbackId = team.fakeTelegram.userTapsButton(member.bot, user, team.groupChat, message.message_id, data!);
  return eventually(`${label} callback answer`, async () => team.fakeTelegram.callbackAnswer(callbackId)?.text, 60_000);
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/** Env A's item: a blocked task with a pinned anchor, and uncommitted work to hand over. */
async function itemWithPendingWork(team: TeamHarness, suffix: string) {
  // The harness clone sits on `main`, and this product never merges or pushes a
  // protected product branch automatically, so a requester who means to apply a
  // result works on their own branch. The refusal itself is asserted in H3.
  git(team.envA.git.workspace, "checkout", "-q", "-b", `work-${suffix}`);
  const task = await createTask(team.envA, suffix);
  team.envA.app.fakeProvider.queue({ behavior: "block-on-decision", reason: "The release colour needs a person.", humanAction: "Choose blue or green." });
  await startRun(team.envA, task);
  await eventually("owner task blocked", async () => team.envA.app.query<{ status: string }>("SELECT status FROM prompt WHERE id=?", task.promptId)[0]?.status === "BLOCKED");
  const opened = await teamApi<{ item: { itemId: string } }>(team.envA, "POST", "/api/task-control/team/items", { promptId: task.promptId });
  const tag = `#item_${opened.item.itemId.slice(5)}`;
  const group = () => team.fakeTelegram.transcript(team.groupChat.id);
  const anchor = await eventually("owner item anchor", async () => group().find(message => message.from.id === team.envA.bot.id && message.text.includes(tag) && message.reply_to_message === undefined));
  // The work that is actually handed over: uncommitted, so the package has to
  // carry it rather than the branch already having it.
  writeFileSync(join(team.envA.git.workspace, "notes.md"), "what is left: choose the release colour\n");
  return { task, itemId: opened.item.itemId, tag, anchor, group };
}

interface Preview { itemId: string; totalBytes: number; files: Array<{ path: string }>; flagged: unknown[] }
interface Offer { itemId: string; branch: string; epoch: number; receiver: null; snapshotCommit: string; startDeadline: string }

/** The requester's three route steps, exactly as the web control drives them. */
async function publishOffer(team: TeamHarness, itemId: string): Promise<{ preview: Preview; offer: Offer }> {
  await teamApi(team.envA, "POST", `/api/task-control/team/handover/${itemId}/begin`, {});
  const { preview } = await teamApi<{ preview: Preview }>(team.envA, "GET", `/api/task-control/team/handover/${itemId}/preview?provider=${PROVIDER}`);
  const { offer } = await teamApi<{ offer: Offer }>(team.envA, "POST", `/api/task-control/team/handover/${itemId}/publish`, {
    confirmations: ["publish"],
    acknowledgedBytes: preview.totalBytes,
  });
  return { preview, offer };
}

const cardFrom = (team: TeamHarness, member: TeamHarnessMember, needle: string, after = 0) =>
  team.fakeTelegram.transcript(team.groupChat.id).find(message =>
    message.from.id === member.bot.id && message.message_id > after && message.text.includes(needle));

test("TM-T1-H1: the offer crosses two workstations and the receiver runs it", {
  annotation: { type: "covers", description: "TM-T1-H1, C1, RTC-11, RTC-12" },
}, async () => {
  /*
   * Asserted here: the requester's routes publish an open call; env B discovers
   * it on its own shared-record read without reading env A's messages; the
   * Accept card is posted by ENV B'S OWN BOT; the run happens on env B and not
   * on env A; the Return work card and the review card each come from the right
   * bot; the result is applied exactly once; and no credential appears in the
   * transcript.
   *
   * Not asserted here, and recorded rather than implied: the quota-warning card
   * trigger and `/handover` on the anchor (this build's trigger is the web
   * control and its routes, so there is no second trigger to compare against),
   * the mid-run requirement question with env A stopped (the fake agent has no
   * way to raise one mid-run), and F07's anchor-edit bounding, which
   * l3-f1-edits.spec.ts owns.
   */
  const team = await startTeamHarness({
    envA: { fakeProvider: "live", settings: HANDOVER_ON },
    envB: { fakeProvider: "live", settings: HANDOVER_ON },
  });
  try {
    await joinFixture(team);
    const item = await itemWithPendingWork(team, "h1");
    // Env B finishes the work it accepts, under its own provider login.
    team.envB.app.fakeProvider.queue({ behavior: "done", verificationSummary: "Chose blue and recorded it." });

    const { preview, offer } = await publishOffer(team, item.itemId);
    expect(preview.files.map(one => one.path)).toContain("notes.md");
    expect(preview.flagged).toEqual([]);
    // The offer is an open call: it names no receiver.
    expect(offer.receiver).toBeNull();
    expect(offer.epoch).toBe(1);
    // Grants on the item end when handover starts.
    expect(team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM item_grant WHERE item_id=? AND revoked_at IS NULL", item.itemId)[0]!.n).toBe(0);

    // Env B discovers it on its next shared-record read, at the recorded
    // 5-second default, without reading env A's message.
    const offerCard = await eventually("env B's own offer card", async () => cardFrom(team, team.envB, "Handover offered"), 60_000);
    expect(offerCard.from.id).toBe(team.envB.bot.id);
    expect(offerCard.from.id).not.toBe(team.envA.bot.id);
    expect(offerCard.text).toContain("names no receiver");
    expect(offerCard.text).toContain(item.tag);
    expect(offerCard.text).toContain(PROVIDER);

    // A second read does not repost it.
    await observeQuietPeriod(7_000, "a second offer card from env B");
    expect(team.fakeTelegram.transcript(team.groupChat.id).filter(message =>
      message.from.id === team.envB.bot.id && message.text.includes("Handover offered")).length).toBe(1);

    expect(await tap(team, team.envB, offerCard, "Accept and run")).toContain("Accepted");

    // Exactly one run exists and it is on env B, in its own worktree.
    await eventually("env B's handover run", async () =>
      team.envB.app.query<{ n: number }>("SELECT COUNT(*) n FROM agent_run WHERE role='execute'")[0]!.n === 1, 120_000);
    const worktree = team.envB.app.query<{ work_directory: string }>("SELECT work_directory FROM workspace WHERE name=?", `handover-${item.itemId}`)[0];
    expect(worktree, "env B runs the item in its own worktree of the handover branch").toBeTruthy();
    expect(worktree!.work_directory).toContain(item.itemId);
    // Env A started no second run for this item: the one run it has is the
    // original blocked one.
    expect(team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM agent_run WHERE prompt_id=?", item.task.promptId)[0]!.n).toBe(1);

    // The receiver's own bot offers Return work once its run has ended.
    const returnCard = await eventually("env B's Return work card", async () => cardFrom(team, team.envB, "Return work"), 180_000);
    expect(returnCard.from.id).toBe(team.envB.bot.id);
    expect(await tap(team, team.envB, returnCard, "Return work")).toContain("Returned");

    // jd's review card is posted by ENV A's bot, from its own record read.
    const reviewCard = await eventually("env A's review card", async () => cardFrom(team, team.envA, "Work returned"), 120_000);
    expect(reviewCard.from.id).toBe(team.envA.bot.id);
    expect(reviewCard.text).toContain(item.tag);
    expect(reviewCard.text, "Apply is offered only when the merge is clean").not.toContain("Apply is not offered");
    expect(await tap(team, team.envA, reviewCard, "Apply")).toContain("Applied");

    // One accept_offer receipt on env B, one apply_result receipt on env A,
    // each applied once.
    const applied = (member: TeamHarnessMember, action: string) => member.app.query<{ n: number }>(
      "SELECT COUNT(*) n FROM task_control_receipt r JOIN task_control_action a ON a.ref=r.action_ref WHERE a.action=? AND r.state='APPLIED'", action)[0]!.n;
    expect(applied(team.envB, "accept_offer")).toBe(1);
    expect(applied(team.envB, "return_work")).toBe(1);
    expect(applied(team.envA, "apply_result")).toBe(1);
    // Env A holds no second application, and the item's task is finished.
    await eventually("the applied item's task completes", async () =>
      team.envA.app.query<{ status: string }>("SELECT status FROM prompt WHERE id=?", item.task.promptId)[0]?.status === "DONE", 60_000);

    // No token, absolute path or credential in either bot's transcript.
    const transcript = team.fakeTelegram.transcript(team.groupChat.id).map(message => message.text).join("\n");
    expect(transcript).not.toMatch(/\d{8,10}:[A-Za-z0-9_-]{35}/);
    expect(transcript).not.toContain(team.envA.bot.token);
    expect(transcript).not.toContain(team.envB.bot.token);
    expect(transcript).not.toContain(team.bareRepository);
  } finally {
    await team.dispose();
  }
});

/** The shared record itself, read straight out of the bare repository. */
function controlRecord(team: TeamHarness, itemId: string): { state: string; epoch: number; executor: string | null; resultLabel: string | null } {
  return JSON.parse(git(team.root, "--git-dir", team.bareRepository, "show", `refs/aw/items/${itemId}/control:state.json`)) as never;
}

async function setSetting(member: TeamHarnessMember, patch: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${member.app.serverUrl}/api/settings`, {
    method: "POST",
    headers: { Origin: member.app.webUrl, "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  expect(response.ok, `settings ${JSON.stringify(patch)}`).toBe(true);
}

test("TM-T1-H2: contention and offline behaviour across two workstations", {
  annotation: { type: "covers", description: "TM-T1-H2, B17 to B20, B05, B13, B23" },
}, async () => {
  /*
   * Asserted here: an offer published while env B is stopped is unclaimed and
   * waiting, and env B's own Accept card appears when it returns; a restart mid
   * offer re-reads the record and posts no second card and no second action; a
   * tap while handover is disabled on env B alone answers with that capability
   * by name, leaves the record untouched and leaves personal control working,
   * and cards apply again when it is re-enabled; a decline is recorded rather
   * than silent, that person's card goes inert and the offer stays OFFERED for
   * anyone else; and a tap after the action expiry is rejected with the expiry
   * reason and renews nothing.
   *
   * Not asserted here, and recorded rather than implied:
   *
   * - The **simultaneous accept by two receivers** is not reachable with this
   *   harness. It needs two receivers, and this harness has one requester and
   *   one receiver: a requester does not accept their own open call, so there is
   *   no second acceptor to race. The record's half of it - two accepts from one
   *   head, one winner, the loser re-reading rather than retrying - is verified
   *   at the server tier in `teamHandoverRun.test.ts` and `teamControlRecord.test.ts`.
   *   A third environment is what this row would need, and adding one is a
   *   harness change outside H06.
   * - The **2.5 minute drop** is a property of real Telegram's callback queue,
   *   not of the fake, which never drops an update. Nothing here can make the
   *   fake lose a tap, so asserting it would assert the fake.
   * - The **partial return on quota exhaustion** needs the fake agent to stop
   *   with a quota reason, which it has no behaviour for; the classification
   *   itself is asserted in `teamHandoverRun.test.ts` and `teamHandoverSurface.test.ts`.
   */
  const ttl = 60_000;
  const team = await startTeamHarness({
    envA: { fakeProvider: "live", settings: HANDOVER_ON, serverEnv: { AGENT_CONSOLE_HARNESS_ACTION_TTL_MS: String(ttl) } },
    envB: { fakeProvider: "live", settings: HANDOVER_ON, serverEnv: { AGENT_CONSOLE_HARNESS_ACTION_TTL_MS: String(ttl) } },
  });
  try {
    await joinFixture(team);
    const item = await itemWithPendingWork(team, "h2");

    // Env B is stopped when the offer is published.
    await team.envB.app.stopServer();
    const { offer } = await publishOffer(team, item.itemId);
    expect(offer.receiver).toBeNull();
    await observeQuietPeriod(7_000, "an Accept card from a stopped env B");
    expect(cardFrom(team, team.envB, "Handover offered"), "a stopped workstation posts nothing").toBeUndefined();
    // jd sees the offer is unclaimed and waiting: that is what the record says.
    expect(controlRecord(team, item.itemId)).toMatchObject({ state: "OFFERED", executor: null });

    // The Accept card appears when env B returns.
    await team.envB.app.startServer();
    const offerCard = await eventually("env B's offer card after it returns", async () => cardFrom(team, team.envB, "Handover offered"), 120_000);
    const actionsAfterDiscovery = team.envB.app.query<{ n: number }>("SELECT COUNT(*) n FROM task_control_action WHERE action IN ('accept_offer','decline_offer')")[0]!.n;
    expect(actionsAfterDiscovery).toBe(2);

    // Env B restarts mid-offer: it re-reads the record rather than re-applying a
    // command id it already carries, so no second card and no second action.
    await team.envB.app.restartServer();
    await observeQuietPeriod(12_000, "a second offer card after a restart");
    expect(team.fakeTelegram.transcript(team.groupChat.id).filter(message =>
      message.from.id === team.envB.bot.id && message.text.includes("Handover offered")).length).toBe(1);
    expect(team.envB.app.query<{ n: number }>("SELECT COUNT(*) n FROM task_control_action WHERE action IN ('accept_offer','decline_offer')")[0]!.n).toBe(actionsAfterDiscovery);
    expect(controlRecord(team, item.itemId)).toMatchObject({ state: "OFFERED", executor: null });

    // Handover disabled on env B alone, mid-offer. Team stays on, and personal
    // control is unaffected throughout.
    await setSetting(team.envB, { "team.handoverEnabled": false });
    expect(await tap(team, team.envB, offerCard, "Accept and run")).toMatch(/not applied/i);
    expect(await tap(team, team.envB, offerCard, "Accept and run")).toMatch(/handover is not enabled/i);
    // The record is untouched by a refused tap.
    expect(controlRecord(team, item.itemId)).toMatchObject({ state: "OFFERED", executor: null });
    expect(team.envB.app.query<{ n: number }>("SELECT COUNT(*) n FROM agent_run WHERE role='execute'")[0]!.n).toBe(0);
    // The route says which capability refused it, and Team is not what did.
    const refused = await fetch(`${team.envB.app.serverUrl}/api/task-control/team/handover/${item.itemId}/begin`, {
      method: "POST", headers: { Origin: team.envB.app.webUrl, "content-type": "application/json" }, body: "{}",
    });
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "handover_disabled" } });
    // Personal control keeps working while handover is off.
    const personal = await fetch(`${team.envB.app.serverUrl}/api/task-control/telegram`, { headers: { Origin: team.envB.app.webUrl } });
    expect(personal.status).toBe(200);
    await expect(personal.json()).resolves.toMatchObject({ status: { state: "polling" } });

    // Re-enabled, cards apply again. Decline is the button that proves it,
    // because the refused Accept keeps its own receipt and is not re-decided.
    await setSetting(team.envB, { "team.handoverEnabled": true });
    expect(await tap(team, team.envB, offerCard, "Decline")).toContain("Declined");

    // A decline is recorded rather than silent, that person's own card goes
    // inert, and under the open call the offer stays OFFERED for anyone else.
    await eventually("the decliner's card goes inert", async () =>
      (offerCard.reply_markup?.inline_keyboard.flat().length ?? 0) === 0 && offerCard.text.includes("stays open for anyone else"), 60_000);
    expect(controlRecord(team, item.itemId)).toMatchObject({ state: "OFFERED", executor: null });
    expect(team.envB.app.query<{ n: number }>(
      "SELECT COUNT(*) n FROM task_control_receipt r JOIN task_control_action a ON a.ref=r.action_ref WHERE a.action='decline_offer' AND r.state='APPLIED'")[0]!.n).toBe(1);

    // A tap after the action expiry is rejected with the expiry reason and
    // renews nothing.
    const second = await itemWithPendingWork(team, "h2b");
    await publishOffer(team, second.itemId);
    const secondCard = await eventually("env B's offer card for the second item", async () => cardFrom(team, team.envB, "Handover offered", offerCard.message_id), 120_000);
    const lastBeforeExpiry = team.fakeTelegram.transcript(team.groupChat.id).at(-1)!.message_id;
    await observeQuietPeriod(ttl + 2_000, "the action expiry passing");
    expect(await tap(team, team.envB, secondCard, "Accept and run")).toMatch(/expired/i);
    await observeQuietPeriod(3_000, "a renewal message after an expired tap");
    expect(team.fakeTelegram.transcript(team.groupChat.id).some(message =>
      message.message_id > lastBeforeExpiry && /Item action renewed|Task needs input/.test(message.text)), "an expired handover tap renews nothing").toBe(false);
    expect(controlRecord(team, second.itemId)).toMatchObject({ state: "OFFERED", executor: null });
  } finally {
    await team.dispose();
  }
});

/** Drives one item from a published offer to returned work on env B. */
async function returnedWork(team: TeamHarness, item: { itemId: string; tag: string }, after: number): Promise<StoredMessage> {
  const offerCard = await eventually("env B's offer card", async () => cardFrom(team, team.envB, "Handover offered", after), 120_000);
  expect(await tap(team, team.envB, offerCard, "Accept and run")).toContain("Accepted");
  const returnCard = await eventually("env B's Return work card", async () => cardFrom(team, team.envB, "Return work", offerCard.message_id), 180_000);
  return returnCard;
}

test("TM-T1-H3: the return crosses back and jd applies it from his phone", {
  annotation: { type: "covers", description: "TM-T1-H3, B26, B27, D01, Q9, G04" },
}, async () => {
  /*
   * Asserted here: a checkout that moved on while the item was claimed shows as
   * a conflict and the review card offers **no Apply button at all**; Request
   * changes opens a new epoch whose fresh open call names no receiver and is
   * discovered by the same teammate again; D01, where env A is stopped when the
   * work is returned, the completion report is in the thread at once and Apply
   * waits for env A; a duplicate Apply tap is answered from the first receipt
   * and performs no second merge; G04's retention, the record readable after the
   * branch is gone; and the credential sweep over the branch, the record and its
   * events as well as the transcript.
   *
   * Not asserted here, and recorded rather than implied: B28, closing or leaving
   * the Telegram thread while a handover is live, because whether `/close` may
   * happen at all mid-handover is M-4's open question and is jd's to rule; and a
   * Telegram edit failure after a recorded application, which needs a fake that
   * can fail one edit on demand.
   */
  const team = await startTeamHarness({
    envA: { fakeProvider: "live", settings: HANDOVER_ON },
    envB: { fakeProvider: "live", settings: HANDOVER_ON },
  });
  try {
    await joinFixture(team);

    /* ---- the diverged checkout, Request changes, and a new epoch ---- */
    const diverged = await itemWithPendingWork(team, "h3a");
    team.envB.app.fakeProvider.queue({ behavior: "done", verificationSummary: "Chose blue." }, { behavior: "done", verificationSummary: "Chose blue again." });
    const start = team.fakeTelegram.transcript(team.groupChat.id).at(-1)!.message_id;
    await publishOffer(team, diverged.itemId);

    // jd's own checkout moves on while the item is claimed, both committed and
    // uncommitted, which is exactly what checking HEAD alone would miss.
    writeFileSync(join(team.envA.git.workspace, "notes.md"), "what is left: actually, green\n");
    git(team.envA.git.workspace, "add", "-A");
    git(team.envA.git.workspace, "-c", "user.email=jd@invalid", "-c", "user.name=jd", "commit", "-q", "-m", "jd moved on");
    writeFileSync(join(team.envA.git.workspace, "task.md"), "and then jd kept going\n");

    const returnCard = await returnedWork(team, diverged, start);
    expect(await tap(team, team.envB, returnCard, "Return work")).toContain("Returned");

    const conflicted = await eventually("env A's review card for a diverged checkout", async () => cardFrom(team, team.envA, "Work returned", start), 120_000);
    // Apply is offered only when the merge is clean, so a diverged checkout
    // shows as a conflict and the card offers no Apply button at all (Q9).
    expect(button(conflicted, "Apply"), "no Apply on a diverged checkout").toBeUndefined();
    expect(button(conflicted, "Request changes")).toBeTruthy();
    expect(conflicted.text).toContain("Apply is not offered while the merge is not clean");
    expect(conflicted.text).toMatch(/moved on|conflict/);
    // The record does not advance past RETURNED on a refused apply.
    expect(controlRecord(team, diverged.itemId)).toMatchObject({ state: "RETURNED", epoch: 1 });

    // Request changes opens a new epoch and a fresh open call that names no
    // receiver, and the same teammate discovers it again.
    expect(await tap(team, team.envA, conflicted, "Request changes")).toContain("offered again");
    await eventually("the new epoch's open call", async () => controlRecord(team, diverged.itemId).epoch === 2 && controlRecord(team, diverged.itemId).state === "OFFERED", 60_000);
    expect(controlRecord(team, diverged.itemId).executor).toBeNull();
    const secondRound = await eventually("env B's offer card at the new epoch", async () =>
      cardFrom(team, team.envB, "Handover offered", conflicted.message_id), 120_000);
    expect(secondRound.text).toContain("names no receiver");
    expect(secondRound.text).toContain("epoch 2");

    /* ---- D01: env A is stopped when the work is returned ---- */
    const waiting = await itemWithPendingWork(team, "h3b");
    team.envB.app.fakeProvider.queue({ behavior: "done", verificationSummary: "Finished while jd was away." });
    const before = team.fakeTelegram.transcript(team.groupChat.id).at(-1)!.message_id;
    await publishOffer(team, waiting.itemId);
    const waitingReturn = await returnedWork(team, waiting, before);

    await team.envA.app.stopServer();
    expect(await tap(team, team.envB, waitingReturn, "Return work")).toContain("Returned");
    // The completion report is visible in the thread at once, from env B's own
    // bot, while env A is stopped.
    const report = await eventually("env B's completion report while env A is stopped", async () =>
      team.fakeTelegram.transcript(team.groupChat.id).find(message =>
        message.from.id === team.envB.bot.id && message.message_id > waitingReturn.message_id && /Returned/.test(message.text)), 60_000);
    expect(report.from.id).toBe(team.envB.bot.id);
    expect(controlRecord(team, waiting.itemId)).toMatchObject({ state: "RETURNED", executor: null });
    // Apply waits for env A: no review card exists while it is stopped.
    expect(cardFrom(team, team.envA, "Work returned", waitingReturn.message_id), "Apply waits for env A").toBeUndefined();

    // When env A returns, the review card appears and the tap applies.
    await team.envA.app.startServer();
    const review = await eventually("env A's review card after it returns", async () => cardFrom(team, team.envA, "Work returned", waitingReturn.message_id), 180_000);
    expect(review.text).toContain(waiting.tag);
    expect(await tap(team, team.envA, review, "Apply")).toContain("Applied");
    await eventually("the applied item's task completes", async () =>
      team.envA.app.query<{ status: string }>("SELECT status FROM prompt WHERE id=?", waiting.task.promptId)[0]?.status === "DONE", 60_000);
    const headAfterApply = git(team.envA.git.workspace, "rev-parse", "HEAD");

    // B27: a duplicate delivery of the same tap is answered from the first
    // receipt and performs no second merge.
    expect(await tap(team, team.envA, review, "Apply")).toMatch(/already applied/i);
    expect(team.envA.app.query<{ n: number }>(
      "SELECT COUNT(*) n FROM task_control_receipt r JOIN task_control_action a ON a.ref=r.action_ref WHERE a.action='apply_result' AND r.state='APPLIED'")[0]!.n).toBe(1);
    expect(git(team.envA.git.workspace, "rev-parse", "HEAD")).toBe(headAfterApply);

    /* ---- G04 retention, and the credential sweep over every new ref ---- */
    const refs = git(team.root, "--git-dir", team.bareRepository, "for-each-ref", "--format=%(refname)");
    expect(refs).toContain(`refs/aw/items/${waiting.itemId}/control`);
    expect(refs).toContain(`refs/heads/aw/handover/${waiting.itemId}`);
    const recordBlobs = git(team.root, "--git-dir", team.bareRepository, "log", "--format=%H", `refs/aw/items/${waiting.itemId}/control`)
      .split("\n")
      .flatMap(commit => [
        git(team.root, "--git-dir", team.bareRepository, "show", `${commit}:state.json`),
        git(team.root, "--git-dir", team.bareRepository, "ls-tree", "-r", "--name-only", `${commit}:events`)
          .split("\n").filter(Boolean)
          .map(name => git(team.root, "--git-dir", team.bareRepository, "show", `${commit}:events/${name}`)).join("\n"),
      ]).join("\n");
    const transcript = team.fakeTelegram.transcript(team.groupChat.id).map(message => message.text).join("\n");
    for (const [what, text] of [["the control record and its events", recordBlobs], ["the transcript", transcript]] as const) {
      expect(text, `a bot token in ${what}`).not.toMatch(/\d{8,10}:[A-Za-z0-9_-]{35}/);
      expect(text, `env A's token in ${what}`).not.toContain(team.envA.bot.token);
      expect(text, `env B's token in ${what}`).not.toContain(team.envB.bot.token);
      expect(text, `an absolute path in ${what}`).not.toContain(team.root);
    }
  } finally {
    await team.dispose();
  }
});
