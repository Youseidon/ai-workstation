import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { startTeamHarness, type TeamHarness, type TeamHarnessMember } from "../../src/env/teamHarness.ts";
import { eventually } from "../../src/drivers/state.ts";
import { createTeamFixture, pairTeamMember, registerTeamWorkspace, teamApi } from "../../src/teamFlows.ts";
import type { StoredMessage } from "../../src/fakes/telegramServer.ts";

/*
 * C3. An agent that stops with `{"status":"BLOCKED","reason":...,"options":[...]}`
 * writes no handoff record, so `pendingHumanQuestion` is null and
 * `operationalState` returns the stored `BLOCKED` rather than the
 * `AWAITING_RESPONSE` overlay. That is the ordinary Team path, not a corner.
 *
 * Two Team surfaces compared that state to `AWAITING_RESPONSE` by hand, so on
 * exactly the task a person is waiting on, `/status` said no decision was
 * waiting and the Open Team thread control was disabled - with text that told
 * the reader a task labelled "Needs you" was not awaiting a response.
 *
 * One harness drives the state once, through a real run; each surface is then
 * asserted in its own case, so each reports its own failure rather than hiding
 * behind the other.
 */

// Deliberately not serial. The three cases share one booted environment and
// one blocked item, but each asserts a different surface, and serial mode would
// skip the later ones the moment the first surface failed - which is precisely
// how C3's two surfaces would have gone on hiding behind one another.
test.setTimeout(15 * 60_000);

let team: TeamHarness;
let context: BrowserContext;
let page: Page;
let blocked: { promptId: number; anchor: StoredMessage; tag: string };

test.beforeAll(async ({ browser }) => {
  team = await startTeamHarness({ envA: { fakeProvider: "live" } });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  blocked = await driveBlockedItem();
});

test.afterAll(async () => {
  await context?.close();
  await team?.dispose();
});

async function joinFixture(): Promise<void> {
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

async function createTask(member: TeamHarnessMember): Promise<{ workspaceId: number; promptId: number }> {
  const listed = await teamApi<{ workspaces: Array<{ id: number; workDirectory: string }> }>(member, "GET", "/api/workspaces");
  const workspace = listed.workspaces.find(entry => entry.workDirectory === member.git.workspace)!;
  const { program } = await teamApi<{ program: { id: number } }>(member, "POST", `/api/workspaces/${workspace.id}/programs`, { name: "Release", overview: "" });
  const { suite } = await teamApi<{ suite: { id: number } }>(member, "POST", `/api/programs/${program.id}/suites`, { name: "Colour review", overview: "" });
  const { prompt } = await teamApi<{ prompt: { id: number } }>(member, "POST", `/api/suites/${suite.id}/prompts`, {
    title: "Choose the release colour",
    content: "Pick the colour the release ships in.",
  });
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

/** The operational state the server reports for a prompt, read the way the board reads it. */
async function reportedState(member: TeamHarnessMember, promptId: number): Promise<string | undefined> {
  const snapshot = await teamApi<{ suites: Array<{ prompts: Array<{ prompt: { id: number }; operationalState: string }> }> }>(member, "GET", "/api/operations");
  for (const suite of snapshot.suites) {
    const found = suite.prompts.find(item => item.prompt.id === promptId);
    if (found !== undefined) return found.operationalState;
  }
  return undefined;
}

const groupTranscript = () => team.fakeTelegram.transcript(team.groupChat.id);

/**
 * The ordinary Team path: the agent stops with a BLOCKED status carrying
 * options. Nothing requests a handoff, so no handoff row is written and the
 * reported state is the stored BLOCKED, not the AWAITING_RESPONSE overlay.
 */
async function driveBlockedItem(): Promise<{ promptId: number; anchor: StoredMessage; tag: string }> {
  await joinFixture();
  const task = await createTask(team.envA);
  team.envA.app.fakeProvider.queue({
    behavior: "block-on-decision",
    reason: "The release colour needs a person.",
    humanAction: "Choose blue or green.",
    options: [{ label: "Blue", advantages: ["Matches the brand guide"] }, { label: "Green", advantages: ["Matches the docs"] }],
  });
  await startRun(team.envA, task);
  await eventually("owner task blocked", async () => team.envA.app.query<{ status: string }>("SELECT status FROM prompt WHERE id=?", task.promptId)[0]?.status === "BLOCKED");
  const opened = await teamApi<{ item: { itemId: string } }>(team.envA, "POST", "/api/task-control/team/items", { promptId: task.promptId });
  const tag = `#item_${opened.item.itemId.slice(5)}`;
  const anchor = await eventually("owner item anchor", async () => groupTranscript().find(message =>
    message.from.id === team.envA.bot.id && message.text.includes(tag) && message.reply_to_message === undefined));
  return { promptId: task.promptId, anchor, tag };
}

test("C3 (T1): a Team item blocked on a decision writes no handoff, so the server reports the stored BLOCKED", {
  annotation: { type: "covers", description: "C3" },
}, async () => {
  expect(team.envA.app.query<{ n: number }>("SELECT COUNT(*) n FROM handoff WHERE prompt_id=?", blocked.promptId)[0]!.n).toBe(0);
  expect(team.envA.app.query<{ status: string }>("SELECT status FROM prompt WHERE id=?", blocked.promptId)[0]?.status).toBe("BLOCKED");
  expect(await reportedState(team.envA, blocked.promptId)).toBe("BLOCKED");
});

test("C3 (T1): /status on that item reports a decision waiting for the owner", {
  annotation: { type: "covers", description: "C3" },
}, async () => {
  const sent = team.fakeTelegram.userSendsMessage(team.envA.bot, team.envB.user, team.groupChat, "/status", { replyToMessageId: blocked.anchor.message_id });
  const status = await eventually("/status reply", async () => groupTranscript().find(message =>
    message.message_id > sent.message_id && message.from.id === team.envA.bot.id && message.text.startsWith("Item status")));
  expect(status.text).toContain("Decision: waiting for the owner");
  expect(status.text).not.toContain("Decision: none waiting");
});

test("C3 (T1): the Open Team thread control is enabled on that item", {
  annotation: { type: "covers", description: "C3" },
}, async () => {
  await page.goto(`${team.envA.app.webUrl}/tasks?prompt=${blocked.promptId}`);
  const panel = page.getByLabel("Team thread");
  await panel.waitFor();
  const reason = panel.getByTestId("team-thread-reason");
  const reasonText = (await reason.count()) > 0 ? (await reason.textContent()) ?? "" : null;
  // The self-contradicting sentence this gap was registered for: a task the
  // board labels "Needs you" was told it is not awaiting a response.
  expect(reasonText, `the Open Team thread control must be enabled on a blocked Team item, and was disabled with: ${reasonText}`).toBeNull();
  await expect(panel.getByRole("button", { name: "Open Team thread" })).toBeEnabled();
});
