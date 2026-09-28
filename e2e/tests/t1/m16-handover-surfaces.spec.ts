import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { startTeamHarness, type TeamHarness, type TeamHarnessMember } from "../../src/env/teamHarness.ts";
import { eventually } from "../../src/drivers/state.ts";
import { createTeamFixture, pairTeamMember, registerTeamWorkspace, teamApi } from "../../src/teamFlows.ts";
import type { StoredMessage } from "../../src/fakes/telegramServer.ts";

/*
 * M-16 (docs/telegram-task-control/team-gap-register.md), the alignment jd
 * re-scoped P-B5 to on 2026-09-28.
 *
 * P-A5 closed the loss M-17 recorded: the owner could answer, run and complete an
 * item a teammate was holding, and those actions **worked**. What P-A5 left, and
 * said so, is that the owner's surfaces still lie about it. With the shared record
 * RUNNING and the executor another person, the owner's page said:
 *
 *   row badge:      Needs you
 *   attention flag: true
 *   row buttons:    ["Respond"]
 *
 * It claimed the item needed the owner, it sat on the owner's attention list for
 * the whole handover, and it offered a button P-A5 now answers with a 409 - a dead
 * button of exactly the shape M-13 was.
 *
 * This row is the only thing that proves the fix is **wired** rather than present.
 * The server tier can show `/api/operations` carrying the field and the web tier
 * can show the components reading it from props; neither can show that the field
 * the route fills is the field the page renders. That gap is the failure mode this
 * track has hit three times.
 *
 * What it drives, on two booted workstations:
 *
 *   1. the owner's row **before** any handover, so "Needs you" and "Respond" are
 *      shown to be what this page says about an item nobody holds;
 *   2. a real crossing to a held state through env B's own Telegram card, then the
 *      same row, which must name the holder and offer no Respond, and the suite's
 *      "Needs you" count, which must have dropped;
 *   3. the handover finished by a real apply, then the same row again, which must
 *      stop naming a holder.
 *
 * ## The trap, from m17-handover-hold.spec.ts
 *
 * The product reads **this workstation's local** bare control clone, which can lag
 * the shared remote by up to one control poll. A first version of the M-17 row
 * asserted the remote's executor and failed, with the remote saying STARTING and
 * the refusal saying OFFERED. So nothing here is asserted against
 * `team.bareRepository`: the badge is cross-checked against env A's **own**
 * record, and the control state is only asserted to be *a* live state rather than
 * a particular one.
 *
 * `executor` is the one field that is safe to compare exactly, and that is worth
 * stating rather than assuming: it is null before `accept_offer` and stays the
 * same person through CLAIMED, STARTING, RUNNING, PAUSED and RETURNED, so once
 * the badge names somebody, a later read of the local record names the same
 * somebody. The lagging field is `state`, which is why only `state` is asserted
 * loosely.
 *
 * ## What it does not assert, and why
 *
 * Nothing about the receiver's own surfaces. P-A5 found that a guard over every
 * item link breaks the receiver's own run, and the executor-link case is covered
 * at the server tier in `operationsHandoverHold.test.ts`, where it costs one
 * fixture instead of a third workstation.
 *
 * Nothing about "Respond" coming back on a still-blocked item after the handover.
 * A finished apply completes the work item, so phase 3's item is DONE and Respond
 * is correctly absent for that reason instead. Getting back to a blocked item that
 * nobody holds needs a cancel, and there is no cancel route - begin, preview,
 * publish, review, apply and request-changes are the whole set. So phase 1 is what
 * carries the "this is what the row says when nobody holds it" half, and phase 3
 * asserts only that the holder line is gone.
 *
 * The fixture helpers are tm4-handover.spec.ts's, unchanged, for the reason C5
 * gives for copying them: that spec exports nothing.
 */

test.setTimeout(20 * 60_000);

const HANDOVER_ON = { "team.enabled": true, "team.handoverEnabled": true };
/** `LIVE_HANDOVER_STATES`, restated here so the row does not import server source. */
const LIVE_STATES = ["OFFERED", "CLAIMED", "STARTING", "RUNNING", "WAITING_INPUT", "PAUSED", "STOP_REQUESTED", "RETURNED", "APPLYING"];
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

async function createTask(member: TeamHarnessMember, suffix: string): Promise<{ workspaceId: number; promptId: number; title: string }> {
  const listed = await teamApi<{ workspaces: Array<{ id: number; workDirectory: string }> }>(member, "GET", "/api/workspaces");
  const workspace = listed.workspaces.find(entry => entry.workDirectory === member.git.workspace)!;
  const { program } = await teamApi<{ program: { id: number } }>(member, "POST", `/api/workspaces/${workspace.id}/programs`, { name: `Web review program ${suffix}`, overview: "" });
  const { suite } = await teamApi<{ suite: { id: number } }>(member, "POST", `/api/programs/${program.id}/suites`, { name: "Web review", overview: "" });
  const title = `Web review task ${suffix}`;
  const { prompt } = await teamApi<{ prompt: { id: number } }>(member, "POST", `/api/suites/${suite.id}/prompts`, { title, content: "Finish the release colour work." });
  return { workspaceId: workspace.id, promptId: prompt.id, title };
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

/** A tap, delivered to the bot that posted the card. The receiver's cards are env B's. */
async function tap(member: TeamHarnessMember, message: StoredMessage, label: string): Promise<string> {
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

interface ControlSnapshot { state: string; epoch: number; executor: string | null; branch: string }

/**
 * One workstation's **own** control record, out of the local bare clone the
 * product reads - `<repoRoot>/.agent-console/handover/control.git`, the path
 * `liveHandoverHolding` computes.
 *
 * Deliberately not `team.bareRepository`. The shared remote is ahead of this by up
 * to one control poll, and asserting a page against it is the mistake that cost
 * the M-17 row a red run.
 */
function localRecord(member: TeamHarnessMember, itemId: string): ControlSnapshot | null {
  const result = spawnSync("git", [
    "--git-dir", join(member.app.root, ".agent-console", "handover", "control.git"),
    "show", `refs/aw/items/${itemId}/control:state.json`,
  ], { encoding: "utf8" });
  return result.status === 0 ? JSON.parse(result.stdout) as ControlSnapshot : null;
}

const cardFrom = (member: TeamHarnessMember, needle: string) =>
  team.fakeTelegram.transcript(team.groupChat.id).find(message =>
    message.from.id === member.bot.id && message.text.includes(needle));

let team: TeamHarness;
let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  // A hook does not inherit the file's timeout, and this one boots two
  // workstations and drives a whole crossing.
  test.setTimeout(20 * 60_000);
  team = await startTeamHarness({
    envA: { fakeProvider: "live", settings: HANDOVER_ON },
    envB: { fakeProvider: "live", settings: HANDOVER_ON },
  });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
});

test.afterAll(async () => {
  await context?.close();
  await team?.dispose();
});

test("M-16 (T1): the owner's row names the teammate holding the item and offers no Respond, and goes back when the handover ends", {
  annotation: { type: "covers", description: "M-16" },
}, async () => {
  await joinFixture(team);

  /* ------------ env A: a blocked item with uncommitted work to hand over ----------- */

  // This product never merges or pushes a protected product branch, so a
  // requester who means to apply a result works on their own branch.
  git(team.envA.git.workspace, "checkout", "-q", "-b", "work-m16");
  const task = await createTask(team.envA, "m16");
  team.envA.app.fakeProvider.queue({ behavior: "block-on-decision", reason: "The release colour needs a person.", humanAction: "Choose blue or green." });
  await startRun(team.envA, task);
  await eventually("owner task blocked", async () =>
    team.envA.app.query<{ status: string }>("SELECT status FROM prompt WHERE id=?", task.promptId)[0]?.status === "BLOCKED");
  writeFileSync(join(team.envA.git.workspace, "notes.md"), "what is left: choose the release colour\n");

  const { item } = await teamApi<{ item: { itemId: string } }>(team.envA, "POST", "/api/task-control/team/items", { promptId: task.promptId });
  const itemId = item.itemId;

  // The receiver finishes what it accepts, so the crossing reaches a returnable
  // result without a second queued behaviour.
  team.envB.app.fakeProvider.queue({ behavior: "done", verificationSummary: "Chose blue and recorded it." });

  /* ----------------------------- the owner's own row ----------------------------- */

  const row = (): Locator => page.locator("li").filter({ hasText: task.title }).first();
  /** The row's buttons, without the title button and the sub-step toggle. */
  const rowButtons = async (): Promise<string[]> =>
    (await row().getByRole("button").allInnerTexts())
      .map(text => text.trim())
      .filter(text => text !== "" && !text.includes(task.title));
  /*
   * The suite's own attention chip, which is the count M-16 also has to move.
   *
   * Read as a delta rather than as an absolute. `suite.attentionCount` counts every
   * prompt in the suite, and this row owns only one of them; pinning it to 1 would
   * assert something about the rest of the fixture instead of about the handover.
   */
  const needsYouCount = async (): Promise<number> => {
    const chip = page.locator("button[aria-pressed]").filter({ hasText: /Needs you/ }).first();
    const digits = /\d+/.exec((await chip.innerText()).trim());
    expect(digits, "the attention chip shows a count").not.toBeNull();
    return Number(digits![0]);
  };

  /* ---- phase 1: before any handover, so the next phase is a change rather than an absence ---- */

  await page.goto(`${team.envA.app.webUrl}/tasks?prompt=${task.promptId}`);
  await row().waitFor({ timeout: 60_000 });
  await expect(row(), "a blocked item nobody holds says it needs the owner").toContainText("Needs you");
  expect(await rowButtons(), "and offers the owner the way in").toContain("Respond");
  const attentionBefore = await needsYouCount();
  expect(attentionBefore, "and is counted on the owner's attention list").toBeGreaterThanOrEqual(1);

  /* -------- phase 2: the crossing, stopped while the receiver still holds the item ------- */

  await teamApi(team.envA, "POST", `/api/task-control/team/handover/${itemId}/begin`, {});
  const { preview } = await teamApi<{ preview: { totalBytes: number } }>(team.envA, "GET", `/api/task-control/team/handover/${itemId}/preview?provider=${PROVIDER}`);
  await teamApi(team.envA, "POST", `/api/task-control/team/handover/${itemId}/publish`, {
    confirmations: ["publish"],
    acknowledgedBytes: preview.totalBytes,
  });
  const offerCard = await eventually("env B's own offer card", async () => cardFrom(team.envB, "Handover offered"), 60_000);
  expect(await tap(team.envB, offerCard, "Accept and run")).toContain("Accepted");

  /*
   * Waited for on the **page**, reloading, because the claim is about what the
   * owner sees and the snapshot the page holds is only as fresh as its last read.
   * The badge is the thing under test, so the wait is on the badge.
   */
  const named = await eventually("the owner's row to name the teammate holding the item", async () => {
    await page.reload();
    await row().waitFor({ timeout: 60_000 });
    return /Held by (\S+)/.exec(await row().innerText())?.[1];
  }, 240_000);

  const mine = localRecord(team.envA, itemId);
  expect(mine, "env A has a control record of its own for this item").not.toBeNull();
  expect(named, "the badge names the executor this workstation's own record carries, not the remote's").toBe(mine!.executor);
  expect(mine!.executor, "and that executor is somebody, which is what makes the badge nameable").not.toBeNull();
  expect(LIVE_STATES, "the state the owner's own record is in is a live handover state")
    .toContain(mine!.state);

  // The three complaints M-16 exists to fix, in the order the design lists them.
  await expect(row(), "the row no longer claims the item needs the owner").not.toContainText("Needs you");
  expect(await rowButtons(), "and offers no Respond, which the route now answers with a 409")
    .not.toContain("Respond");
  expect(await needsYouCount(), "and the item is off the owner's attention list for the handover")
    .toBe(attentionBefore - 1);

  /* -------- phase 3: the handover ends for real, and the row stops naming a holder ------- */

  const returnCard = await eventually("env B's Return work card", async () => cardFrom(team.envB, "Return work"), 240_000);
  expect(await tap(team.envB, returnCard, "Return work")).toContain("Returned");
  await eventually("the shared record to reach RETURNED", async () =>
    localRecord(team.envA, itemId)?.state === "RETURNED" ? true : undefined, 180_000);

  // Applied through the route: m12-web-handover-review.spec.ts owns the web
  // control that calls it, and restating that here would cost two workstations
  // for a claim already proven.
  await teamApi(team.envA, "POST", `/api/task-control/team/handover/${itemId}/apply`, { acceptanceMet: true });

  const settled = await eventually("the owner's row to stop naming a holder", async () => {
    await page.reload();
    await row().waitFor({ timeout: 60_000 });
    const text = await row().innerText();
    return text.includes("Held by") ? undefined : text;
  }, 240_000);
  expect(settled, "the handover is over, so nothing on the row claims a teammate has it").not.toContain("Held by");
  /*
   * A finished apply completes the work item, so this is the state the row is
   * correctly in - not a second assertion that Respond came back. See the header:
   * there is no cancel route, so a blocked-and-unheld item is not reachable from
   * here, and phase 1 is what carries that half.
   */
  expect(localRecord(team.envA, itemId)!.state, "and the owner's own record has left every live state")
    .not.toBe("RETURNED");
  expect(LIVE_STATES, "the owner's own record is settled").not.toContain(localRecord(team.envA, itemId)!.state);
});
