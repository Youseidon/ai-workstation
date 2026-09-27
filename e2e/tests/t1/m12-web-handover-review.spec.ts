import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { startTeamHarness, type TeamHarness, type TeamHarnessMember } from "../../src/env/teamHarness.ts";
import { eventually } from "../../src/drivers/state.ts";
import { createTeamFixture, pairTeamMember, registerTeamWorkspace, teamApi } from "../../src/teamFlows.ts";
import type { StoredMessage } from "../../src/fakes/telegramServer.ts";

/*
 * M-12 (docs/telegram-task-control/team-gap-register.md).
 *
 * C5 proved the requester's **first** half is wired: prepare and publish, driven
 * from the real page. This is the second half, which had no caller in `web/` at
 * all. `handoverReview`, `applyHandover` and `requestHandoverChanges` each
 * appeared exactly twice in the whole web tier - their own definitions in
 * `workspacesApi.ts`, and a URL-shape table in `handoverControl.test.tsx` that
 * asserts each route's shape and never that anything calls it. That table is
 * what made this read as covered, and it is why "present" and "wired" had to be
 * separated again here.
 *
 * jd ruled on 2026-09-27 to build the surface, against the orchestrator's
 * recommendation to declare review-and-apply a deliberate phone action.
 *
 * What this row drives:
 *
 * - a real crossing to RETURNED: env A publishes, env B accepts through its own
 *   Telegram card, runs, and returns through its own Return work card;
 * - then `/tasks?prompt=<id>` in a real browser on env A, and the three real
 *   taps of the new control - "Check for returned work", the acceptance
 *   checkbox, and "Apply result".
 *
 * The publish half is driven through the routes rather than the page, on
 * purpose: C5 already owns that wiring, and restating it here would cost two
 * workstations for a claim that is already proven.
 *
 * The assertions are on effects the **server** wrote, in the shared bare
 * repository that neither the browser nor the component can reach. The
 * load-bearing claim is the shared control record leaving RETURNED and the work
 * item carrying the result as its evidence. A control that fabricated a review
 * locally, or that showed "Applied" without calling the route, leaves this page
 * looking exactly as correct as it does now and still fails this row.
 *
 * Not asserted here, and recorded rather than implied:
 *
 * - "Request changes". Its call site is built and typed the same way as apply's,
 *   but driving it needs a *second* crossing - the fresh offer it publishes has
 *   to be accepted, run and returned again - and that is a second row's cost for
 *   a third route. It is covered at the server tier in `teamResultApply.test.ts`
 *   and its web call site is rendered from props in `handoverControl.test.tsx`.
 *   **So M-12's third function is wired but not end-to-end proven, and the
 *   register says so rather than letting this row imply otherwise.**
 * - Every refusal branch of the review - protected branch, diverged baseline,
 *   merge conflict. `tm4-handover.spec.ts` H3 owns the refusals at the route
 *   level; here the merge is clean by construction, which is the path that has a
 *   button behind it.
 *
 * The fixture helpers below are `tm4-handover.spec.ts`'s, unchanged, for the
 * reason C5 gives for copying them: that spec exports nothing, and lifting them
 * into a shared module would edit the one spec that proves the handover itself.
 */

test.setTimeout(20 * 60_000);

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
  const { program } = await teamApi<{ program: { id: number } }>(member, "POST", `/api/workspaces/${workspace.id}/programs`, { name: `Web review program ${suffix}`, overview: "" });
  const { suite } = await teamApi<{ suite: { id: number } }>(member, "POST", `/api/programs/${program.id}/suites`, { name: "Web review", overview: "" });
  const { prompt } = await teamApi<{ prompt: { id: number } }>(member, "POST", `/api/suites/${suite.id}/prompts`, { title: `Web review task ${suffix}`, content: "Finish the release colour work." });
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

/** The shared record itself, read straight out of the bare repository. */
function sharedRecord(itemId: string): ControlSnapshot {
  return JSON.parse(git(team.root, "--git-dir", team.bareRepository, "show", `refs/aw/items/${itemId}/control:state.json`)) as ControlSnapshot;
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

test("M-12 (T1): the requester's web control reviews returned work and applies it for real", {
  annotation: { type: "covers", description: "M-12" },
}, async () => {
  await joinFixture(team);

  /* ------------ env A: a blocked item with uncommitted work to hand over ----------- */

  // This product never merges or pushes a protected product branch, so a
  // requester who means to apply a result works on their own branch.
  git(team.envA.git.workspace, "checkout", "-q", "-b", "work-m12");
  const task = await createTask(team.envA, "m12");
  team.envA.app.fakeProvider.queue({ behavior: "block-on-decision", reason: "The release colour needs a person.", humanAction: "Choose blue or green." });
  await startRun(team.envA, task);
  await eventually("owner task blocked", async () =>
    team.envA.app.query<{ status: string }>("SELECT status FROM prompt WHERE id=?", task.promptId)[0]?.status === "BLOCKED");
  writeFileSync(join(team.envA.git.workspace, "notes.md"), "what is left: choose the release colour\n");

  const { item } = await teamApi<{ item: { itemId: string } }>(team.envA, "POST", "/api/task-control/team/items", { promptId: task.promptId });
  const itemId = item.itemId;

  /*
   * The receiver finishes what it accepts. The returned package carries one
   * verification entry - the run that produced it - so the result is labelled
   * `full` **with** evidence, and `evidenceMissing` is false. That entry is a run
   * reference rather than the summary text handed to the fake, which is worth
   * knowing before asserting on it: a first version of this row asserted the
   * summary string and then its absence, and both were wrong about the same fact.
   */
  team.envB.app.fakeProvider.queue({ behavior: "done", verificationSummary: "Chose blue and recorded it." });

  /* ---- the crossing to RETURNED, through the routes and the receiver's own cards ---- */

  await teamApi(team.envA, "POST", `/api/task-control/team/handover/${itemId}/begin`, {});
  const { preview } = await teamApi<{ preview: { totalBytes: number } }>(team.envA, "GET", `/api/task-control/team/handover/${itemId}/preview?provider=${PROVIDER}`);
  await teamApi(team.envA, "POST", `/api/task-control/team/handover/${itemId}/publish`, {
    confirmations: ["publish"],
    acknowledgedBytes: preview.totalBytes,
  });

  const offerCard = await eventually("env B's own offer card", async () => cardFrom(team.envB, "Handover offered"), 60_000);
  expect(await tap(team.envB, offerCard, "Accept and run")).toContain("Accepted");
  const returnCard = await eventually("env B's Return work card", async () => cardFrom(team.envB, "Return work"), 180_000);
  expect(await tap(team.envB, returnCard, "Return work")).toContain("Returned");

  // The state this whole row exists to review, read from the shared record the
  // server wrote rather than from anything either page shows.
  const returned = await eventually("the shared record to reach RETURNED", async () =>
    sharedRecord(itemId).state === "RETURNED" ? sharedRecord(itemId) : undefined, 120_000);
  expect(returned.epoch).toBe(1);

  /* ----------------------- env A's page, as the requester opens it ---------------------- */

  await page.goto(`${team.envA.app.webUrl}/tasks?prompt=${task.promptId}`);
  const control = page.getByLabel("Review returned work");
  await control.waitFor({ timeout: 60_000 });

  // Handover is on and the item is not finished, so this half is offered at all.
  // If it were not, every tap below would assert nothing.
  await expect(control.getByRole("button", { name: "Check for returned work" })).toBeEnabled();

  /* ------------------------------ Check for returned work ----------------------------- */

  await control.getByRole("button", { name: "Check for returned work" }).click();
  const review = control.getByTestId("handover-review");
  await review.waitFor({ timeout: 120_000 });

  // `handoverReview` fired. What the page shows is the server's own reading of
  // the returned package: the result commit the receiver pushed, and the label
  // it was returned under. Props cannot invent either.
  await expect(review, "the review names the label the receiver returned under").toContainText("full");
  await expect(review, "and the reason the server computed for a clean merge").toContainText("merges cleanly");
  expect(await control.getByTestId("handover-review-refusals").count(), "a clean merge names no refusal").toBe(0);

  /*
   * The commit the page is showing, captured before the apply so the evidence
   * assertion below is a cross-check between what the requester was told and
   * what the server then wrote - not two readings of the same string.
   */
  const shown = (await review.textContent()) ?? "";
  const resultCommit = /\b[0-9a-f]{40}\b/.exec(shown)?.[0];
  expect(resultCommit, "the review names the returned result's commit").toBeTruthy();

  /*
   * A full result that does carry evidence, so the warning is absent. The warning
   * itself - jd's rule that a DONE statement without evidence is not acceptance -
   * is rendered from `review.evidenceMissing` alone and is covered from props in
   * `handoverControl.test.tsx`; driving it here would mean a receiver that returns
   * without any verification, which this crossing does not produce.
   */
  expect(await control.getByTestId("handover-review-evidence").count(),
    "a full result carrying verification raises no evidence warning").toBe(0);

  /* ----------------------------------- Apply result ---------------------------------- */

  const apply = control.getByRole("button", { name: "Apply result" });
  // Acceptance is the requester's own decision and the server refuses to infer
  // it, so the button must not act until it is stated.
  await expect(apply, "Apply is refused until acceptance is stated").toBeDisabled();
  await control.getByTestId("handover-acceptance").locator("input[type=checkbox]").check();
  await expect(apply).toBeEnabled();
  await apply.click();
  await control.getByTestId("handover-applied").waitFor({ timeout: 180_000 });

  /*
   * The effect, and the reason this row exists. `applyHandover` fired: the server
   * advanced the shared control record out of RETURNED, in the bare repository
   * neither the browser nor the component can reach. A control that merely
   * rendered "Applied" could not move it.
   */
  const afterApply = await eventually("the shared record to leave RETURNED", async () => {
    const record = sharedRecord(itemId);
    return record.state === "RETURNED" ? undefined : record;
  }, 120_000);
  expect(afterApply.state, "applying advances the shared record past RETURNED").not.toBe("RETURNED");

  // And the work item itself carries the result. This is the requester-side
  // consequence of a real apply rather than anything the page renders.
  await eventually("the applied item's task to finish", async () =>
    team.envA.app.query<{ status: string }>("SELECT status FROM prompt WHERE id=?", task.promptId)[0]?.status === "DONE", 120_000);
  /*
   * The evidence the apply wrote onto the work item, naming the commit the
   * receiver pushed. This is the assertion `tm4-handover.spec.ts` makes with an
   * `apply_result` **receipt** - and deliberately not the one made here: a
   * receipt exists only for a Telegram card's tap, and this apply came from the
   * web route, which mints no action and no receipt. A first version of this row
   * asserted the receipt and failed with 0, which is correct behaviour rather
   * than a defect, and is recorded here so the next reader does not re-add it.
   */
  const result = team.envA.app.query<{ result: string }>("SELECT result FROM prompt WHERE id=?", task.promptId)[0]?.result ?? "";
  expect(result, "the evidence names the same result commit the page showed the requester").toContain(resultCommit!);
  expect(result, "and names the branch the work crossed on").toContain(returned.branch);
  expect(result, "and the label it was returned under").toContain("labelled full");
  expect(result, "and the receiver's verification entry").toMatch(/\brun run_[0-9a-f-]+/);
  expect(
    team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM prompt_remark WHERE prompt_id=? AND kind='COMPLETION'", task.promptId)[0]!.n,
    "exactly one completion remark, so the apply landed once",
  ).toBe(1);

  // No error was surfaced anywhere in the control while this ran.
  expect(await control.getByRole("alert").count(), "the control reported no error").toBe(0);
});
