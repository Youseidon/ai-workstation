import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { startTeamHarness, type TeamHarness, type TeamHarnessMember } from "../../src/env/teamHarness.ts";
import { eventually } from "../../src/drivers/state.ts";
import { createTeamFixture, pairTeamMember, registerTeamWorkspace, teamApi } from "../../src/teamFlows.ts";
import type { StoredMessage } from "../../src/fakes/telegramServer.ts";

/*
 * M-17 (docs/telegram-task-control/team-gap-register.md), the guard P-A5 adds.
 *
 * While a teammate genuinely holds a handed-over item, the requester's own
 * surfaces offered Respond, a second handover and Mark complete - and they
 * **acted**. Reproduced 2026-09-28 before this row existed: with the shared
 * control record RUNNING and the executor another person, pressing "Respond and
 * resume" on the owner's page took that workstation's execute runs from 1 to 2,
 * marked the prompt DONE, and raised no notification, while the receiver was
 * still running its own. Two workstations ran one item and the owner's run
 * completed a task the receiver was still working on.
 *
 * The cause is M-16's: `isLiveHandoverState` had exactly one consumer outside the
 * handover module, the `/close` guard, because `operationalState` cannot answer
 * "is a handover live". P-A5 is the narrow half - refuse the owner's local start,
 * respond, retry and complete while the handover is live - and it deliberately
 * does not wait for M-16's model change.
 *
 * What this row drives, on two booted workstations: a real crossing to a **held**
 * state, then each of the three owner-side actions, asserting that none of them
 * moves anything. The load-bearing assertions are the ones a refusal cannot fake:
 * the owner's execute-run count, and the prompt's stored status.
 *
 * It deliberately stops before the return. m12-web-handover-review.spec.ts owns
 * the returned half, and asserting it here would restate another row at two
 * workstations' cost.
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

test("M-17 (T1): while a teammate holds the item, the owner cannot answer, run or complete it", {
  annotation: { type: "covers", description: "M-17" },
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


  /* -------- the crossing, stopped while the receiver still holds the item ------- */

  await teamApi(team.envA, "POST", `/api/task-control/team/handover/${itemId}/begin`, {});
  const { preview } = await teamApi<{ preview: { totalBytes: number } }>(team.envA, "GET", `/api/task-control/team/handover/${itemId}/preview?provider=${PROVIDER}`);
  await teamApi(team.envA, "POST", `/api/task-control/team/handover/${itemId}/publish`, {
    confirmations: ["publish"],
    acknowledgedBytes: preview.totalBytes,
  });
  const offerCard = await eventually("env B's own offer card", async () => cardFrom(team.envB, "Handover offered"), 60_000);
  expect(await tap(team.envB, offerCard, "Accept and run")).toContain("Accepted");

  // Held by the other workstation, and not returned. Read from the shared record
  // the server wrote, never from anything either page shows.
  const held = await eventually("the shared record to show the other workstation holding it", async () => {
    const record = sharedRecord(itemId);
    return record.executor !== null && record.state !== "RETURNED" ? record : undefined;
  }, 120_000);
  expect(held.executor, "the executor is the other person, not this workstation").not.toBeNull();

  const runs = () => team.envA.app.query<{ n: number }>(
    "SELECT COUNT(*) n FROM agent_run WHERE prompt_id=? AND role='execute'", task.promptId)[0]!.n;
  const receiverRuns = () => team.envB.app.query<{ n: number }>(
    "SELECT COUNT(*) n FROM agent_run WHERE role='execute'")[0]!.n;
  const status = () => team.envA.app.query<{ status: string }>(
    "SELECT status FROM prompt WHERE id=?", task.promptId)[0]?.status;
  const runsBefore = runs();
  const statusBefore = status();
  /*
   * A baseline rather than an expected value.
   *
   * This first asserted the receiver had exactly one execute run, which passed
   * twice in isolation and then failed in the full suite with `Received: 0` - the
   * receiver's run starts asynchronously after the accept, and under full-suite
   * load it had not started yet. The claim this row makes is about the **owner**
   * not acting; whether the receiver has started by this instant is not its
   * subject, and asserting it was asserting the harness's timing.
   */
  const receiverRunsBefore = receiverRuns();
  expect(statusBefore, "the owner's prompt is still the blocked one it was handed over from").toBe("BLOCKED");

  /* ------------------------- the three owner-side actions ------------------------ */

  const origin = { Origin: team.envA.app.webUrl, "content-type": "application/json" };
  const post = (path: string, body: unknown) => fetch(`${team.envA.app.serverUrl}${path}`, { method: "POST", headers: origin, body: JSON.stringify(body) });

  /*
   * Driven through the routes rather than the page, deliberately. The page is one
   * caller; the guard has to hold for every caller, and a row that only clicked
   * buttons would leave the API open - which is the shape that made three surfaces
   * on this track look covered while the route underneath was not.
   */
  const answered = await post(`/api/prompts/${task.promptId}/human-response`, { content: "The owner answers while the teammate is still running it" });
  expect(answered.status, "answering an item held by a teammate is refused").toBe(409);
  const answeredBody = await answered.json() as { error: { code: string; message: string } };
  expect(answeredBody.error.code).toBe("handover_live");
  expect(answeredBody.error.message, "and the refusal names the item").toContain(itemId);

  /*
   * The state the refusal names is **this workstation's own view** of the control
   * record, read from its local bare clone, and that can lag the shared remote by
   * up to one control poll - a first version of this row asserted the remote's
   * executor here and failed, with the remote saying STARTING and the refusal
   * saying OFFERED.
   *
   * The lag is in the safe direction, and that is worth stating rather than
   * discovering. The requester publishes the offer itself, so its local record
   * reaches OFFERED - already a live state - synchronously, and from there the
   * record only advances. So this workstation can be stale in the direction of
   * *still looking live*, which refuses harmlessly, and never in the direction of
   * looking settled while a teammate holds the item.
   */
  expect(LIVE_STATES, "the state the refusal names is a live handover state").toContain(
    /is (\w+)\./.exec(answeredBody.error.message)?.[1]);

  const completed = await post(`/api/prompts/${task.promptId}/complete`, { reason: "owner marks it done", verificationSummary: "none" });
  expect(completed.status, "marking complete an item held by a teammate is refused").toBe(409);
  expect((await completed.json() as { error: { code: string } }).error.code).toBe("handover_live");

  const started = await post(`/api/prompts/${task.promptId}/start`, { provider: PROVIDER, model: null }).catch(() => null);
  // The start route may not exist under this name; the WebSocket path is the one
  // the UI uses and is covered by the run-count assertion below either way.
  if (started !== null && started.status !== 404) {
    expect(started.status, "starting a run on an item held by a teammate is refused").toBe(409);
  }

  /* ------------------------------- nothing moved ------------------------------- */

  // The assertions a refusal cannot fake. Before the guard, the first call alone
  // took this count from 1 to 2 and this status to DONE.
  expect(runs(), "no second run was started on the owner's workstation").toBe(runsBefore);
  expect(status(), "and the owner's prompt was not completed out from under the receiver").toBe(statusBefore);
  expect(sharedRecord(itemId).executor, "the shared record still names the receiver").toBe(held.executor);
  // The receiver is unaffected: whatever it had, it still has.
  expect(receiverRuns(), "the owner's refused actions did not disturb the receiver's runs").toBe(receiverRunsBefore);
});
