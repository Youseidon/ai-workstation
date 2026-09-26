import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { startTeamHarness, type TeamHarness, type TeamHarnessMember } from "../../src/env/teamHarness.ts";
import { eventually } from "../../src/drivers/state.ts";
import { createTeamFixture, pairTeamMember, registerTeamWorkspace, teamApi } from "../../src/teamFlows.ts";

/*
 * C5 (docs/telegram-task-control/team-gap-register.md).
 *
 * `tm4-handover.spec.ts` publishes a real offer and drives real taps, but it
 * never opens a browser: it calls the three requester routes over HTTP itself.
 * So `web/components/tasks/HandoverControl.tsx` - the control a requester
 * actually uses - had no end-to-end evidence that it is *wired* to those
 * routes. Its evidence was a props-rendered React test and the two-width rig,
 * which renders it in isolation behind a CSS shim. "Present" and "wired" are
 * different claims, and three times on this track a green server suite has been
 * consistent with a broken user surface. This file is the missing half: the
 * requester's handover driven from the real Next.js page, in a real browser,
 * on two booted workstations.
 *
 * What it drives, once:
 *
 * - `/tasks?prompt=<id>` opened in a browser on a blocked Team item that has
 *   uncommitted work in its workspace;
 * - the real "Prepare handover" tap, which must reach `openTeamItem`,
 *   `beginHandover` and `handoverPreview`. Nothing here pre-opens the item
 *   thread, so the item id the assertions read exists only because the page's
 *   own tap created it;
 * - the real "Publish offer" tap, which must reach `publishHandover`.
 *
 * The assertions are on the effect, never on the render alone. What the page
 * shows is asserted only where it must agree with something the server wrote:
 * the preview lists the file the capture actually found, and the offer line
 * names the branch the shared control record names. The load-bearing claims are
 * the shared record reaching PREPARING and then OFFERED at epoch 1, and the
 * package branch existing in the shared bare repository - none of which a
 * control that merely renders can produce. That is the whole point: a mutation
 * that fabricates the offer locally instead of calling the route leaves this
 * page looking exactly as correct as it does now, and this row still goes red.
 *
 * Not asserted here, and recorded rather than implied:
 *
 * - Everything downstream of the offer: env B's own offer card, the accept, the
 *   run, the return and the apply. `tm4-handover.spec.ts` owns that whole
 *   crossing and this row would only restate it at two workstations' cost.
 *   Deliberately so: waiting on a downstream card would turn a broken *web*
 *   wiring into a 60-second timeout instead of a named verdict, which is the
 *   failure shape C4 was corrected for.
 * - The disabled states of this control and the credential confirmation. Every
 *   branch of `handoverAvailability` and the flagged-credential checkbox are
 *   rendered from props alone and are covered in `handoverControl.test.tsx`;
 *   only the enabled path has a route behind it to be wired to.
 * - Every other web Team surface. This row proves one control on one page. The
 *   register entry says so, and criterion 5 of the card is answered there.
 */

test.setTimeout(15 * 60_000);

const HANDOVER_ON = { "team.enabled": true, "team.handoverEnabled": true };
/** The agent the blocked run uses, and the one picked in the control's own dropdown below. */
const PROVIDER = "grok";

/*
 * The fixture helpers below are tm4-handover.spec.ts's, unchanged, for the same
 * reason c4-close-guard-handover.spec.ts copies them: that spec exports
 * nothing, and lifting them into a shared module would edit the one spec that
 * proves the handover itself - a change outside this task's card.
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
  const { program } = await teamApi<{ program: { id: number } }>(member, "POST", `/api/workspaces/${workspace.id}/programs`, { name: `Web handover program ${suffix}`, overview: "" });
  const { suite } = await teamApi<{ suite: { id: number } }>(member, "POST", `/api/programs/${program.id}/suites`, { name: "Web handover", overview: "" });
  const { prompt } = await teamApi<{ prompt: { id: number } }>(member, "POST", `/api/suites/${suite.id}/prompts`, { title: `Web handover task ${suffix}`, content: "Finish the release colour work." });
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

/**
 * Env A's item: a blocked task, with uncommitted work in the workspace for the
 * capture to find. Unlike tm4's fixture this deliberately does NOT open the
 * Team item thread - the page's own "Prepare handover" tap has to do that, and
 * the item id every assertion below reads is looked up afterwards from what
 * that tap wrote.
 */
async function blockedItemWithPendingWork(suffix: string): Promise<{ workspaceId: number; promptId: number }> {
  // The harness clone sits on `main`, and this product never publishes from a
  // protected product branch, so a requester who means to hand work over works
  // on their own branch.
  git(team.envA.git.workspace, "checkout", "-q", "-b", `work-${suffix}`);
  const task = await createTask(team.envA, suffix);
  team.envA.app.fakeProvider.queue({ behavior: "block-on-decision", reason: "The release colour needs a person.", humanAction: "Choose blue or green." });
  await startRun(team.envA, task);
  await eventually("owner task blocked", async () => team.envA.app.query<{ status: string }>("SELECT status FROM prompt WHERE id=?", task.promptId)[0]?.status === "BLOCKED");
  // The work that is actually handed over: uncommitted, so the package has to
  // carry it rather than the branch already having it.
  writeFileSync(join(team.envA.git.workspace, "notes.md"), "what is left: choose the release colour\n");
  return task;
}

/** The item id the page's own tap created, read from the requester's link row. */
const requesterItemId = (promptId: number) => team.envA.app.query<{ itemId: string }>(
  "SELECT item_id itemId FROM item_link WHERE prompt_id=? AND role='requester'", promptId)[0]?.itemId;

let team: TeamHarness;
let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  // A hook does not inherit the file's test timeout, and this one boots two
  // workstations.
  test.setTimeout(15 * 60_000);
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

test("C5 (T1): the requester's web handover control publishes a real offer from the real page", {
  annotation: { type: "covers", description: "C5" },
}, async () => {
  await joinFixture(team);
  const task = await blockedItemWithPendingWork("c5");

  /* ------------------------- the page, as the requester opens it ------------------------ */

  await page.goto(`${team.envA.app.webUrl}/tasks?prompt=${task.promptId}`);
  const control = page.getByLabel("Hand over to the team");
  await control.waitFor();

  // Handover is on for this workstation and this item is not finished, so the
  // control acts rather than explaining why it cannot. If it is disabled here
  // the taps below would assert nothing at all, so this is checked by its own
  // reason line rather than left to a click that silently does nothing.
  const reason = control.getByTestId("handover-reason");
  const reasonText = (await reason.count()) > 0 ? (await reason.textContent()) ?? "" : null;
  expect(reasonText, `the handover control must be enabled on a live Team item, and was disabled with: ${reasonText}`).toBeNull();
  await expect(control.getByRole("button", { name: "Prepare handover" })).toBeEnabled();
  // The agent the offer asks for is chosen in the control's own dropdown, so
  // the preview route below is asked for what this select holds.
  await control.getByLabel("Handover agent").selectOption(PROVIDER);
  expect(requesterItemId(task.promptId), "nothing has opened this item's thread before the tap").toBeUndefined();

  /* ------------------------------- Prepare handover ------------------------------ */

  await control.getByRole("button", { name: "Prepare handover" }).click();
  const preview = control.getByTestId("handover-preview");
  // A git capture of a real workspace, so this is the one step worth a longer
  // wait than the default. It is still a wait for a named element, not a sleep.
  await preview.waitFor({ timeout: 120_000 });

  // The tap opened the item thread itself: this row exists only because the
  // page called `openTeamItem`.
  const itemId = requesterItemId(task.promptId);
  expect(itemId, "the Prepare handover tap must open the item thread through the route").toBeTruthy();

  // `beginHandover` fired: the shared record - written by the server, in the
  // bare repository neither the browser nor the component can reach - moved off
  // LOCAL. A control that only rendered could not move it.
  const prepared = sharedRecord(itemId!);
  expect(prepared, "the Prepare handover tap must reach the begin route").toMatchObject({ state: "PREPARING", epoch: 0, executor: null });

  // `handoverPreview` fired: what the page shows is the server's capture of the
  // real workspace, naming the uncommitted file it found and the branch the
  // record names. Props cannot invent either.
  await expect(preview).toContainText("notes.md");
  await expect(preview).toContainText(prepared.branch);

  /* -------------------------------- Publish offer -------------------------------- */

  const publish = control.getByRole("button", { name: "Publish offer" });
  await expect(publish, "a reviewed preview is what makes the offer publishable").toBeEnabled();
  await publish.click();
  await control.getByTestId("handover-offer").waitFor({ timeout: 120_000 });

  // The effect, and the reason this row exists. `publishHandover` fired, the
  // server advanced the shared control record, and the open call is now in the
  // one place every other workstation reads. This is what a fabricated offer in
  // the component cannot do, however right the page then looks.
  const offered = sharedRecord(itemId!);
  expect(offered, "the Publish offer tap must publish through the route: the shared control record must carry the open call")
    .toMatchObject({ state: "OFFERED", epoch: 1, executor: null, branch: prepared.branch });

  // And the package the offer points at was really pushed, so a teammate who
  // accepts has something to check out.
  expect(git(team.root, "--git-dir", team.bareRepository, "rev-parse", "--verify", `refs/heads/${offered.branch}`),
    "the published handover branch exists in the shared repository").toMatch(/^[0-9a-f]{40}$/);
  expect(git(team.root, "--git-dir", team.bareRepository, "show", "--name-only", "--format=", `refs/heads/${offered.branch}`))
    .toContain("notes.md");

  // What the requester is told agrees with what was written: the same branch,
  // the first epoch, and an open call that names no receiver.
  const told = (await control.getByTestId("handover-offer").textContent()) ?? "";
  expect(told).toContain(`Offered to the team on ${offered.branch} at epoch ${offered.epoch}`);
  expect(told).toContain("It names no receiver");
  // No error was surfaced anywhere in the control while this ran.
  expect(await control.getByRole("alert").count(), "the control reported no error").toBe(0);
  // Grants on the item end when handover starts, which is the server-side
  // consequence of a real publish rather than anything the page renders.
  expect(team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM item_grant WHERE item_id=? AND revoked_at IS NULL", itemId)[0]!.n).toBe(0);
});
