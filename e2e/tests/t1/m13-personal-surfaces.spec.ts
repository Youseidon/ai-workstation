import type { Page } from "@playwright/test";
import { expect, test, webUrl } from "../../src/fixtures.ts";
import { eventually, observeQuietPeriod, state, type SavedTask } from "../../src/drivers/state.ts";
import { runSavedTask } from "../../src/scenarios.ts";

/*
 * M-13. What the two personal-control surfaces actually render in the two
 * states `operationalState` can report for "this item is waiting on a person".
 *
 * THIS SPEC CHARACTERISES CURRENT BEHAVIOUR. It is green because it asserts
 * what the product does today, not what it should do. The behaviour it pins is
 * under jd's review (invariant A5 keeps `web/` unchanged until that ruling), so
 * a green here is not an endorsement of any of it: the cases below record a row
 * that offers the owner nothing to press while an item waits on them, and a
 * detail page that answers a question on the owner's behalf without asking.
 *
 * The two states, both reachable on one item without touching the database:
 *
 *  1. the C3 state - the agent stops with `{"status":"BLOCKED",...,"options":[...]}`,
 *     which writes no handoff, so `pendingHumanQuestion` is null and
 *     `operationalState` falls through to the stored `BLOCKED`
 *     (server/src/operationalState.ts:42);
 *  2. the handoff state - a read-only handoff agent returns a brief whose
 *     recommendation is WAIT_FOR_HUMAN with a `requiresHuman` blocker, so
 *     `pendingHumanQuestion` answers and the same item is reported
 *     `AWAITING_RESPONSE` (server/src/operationalState.ts:30).
 *
 *  3. the saved-answer state - the item stopped for a decision and a person
 *     answered it, so the prompt is `TODO` again with a `HUMAN_RESPONSE`
 *     remark. That is the banner's *second* condition
 *     (web/components/tasks/WorkItemDetail.tsx:245), and no row here reached it
 *     until P-A0 added the two below. It has two spellings and they do not
 *     render alike: with no `human_response_hold` the item reports `READY` and
 *     the banner reads "Answer saved"; with a hold, `operationalState` returns
 *     `AWAITING_RESPONSE` (server/src/operationalState.ts:30) and the same
 *     banner reads "Needs your input" instead.
 *
 * States 1 and 2 are the same row and the same detail page; only the reported
 * state moves. State 3 needs its own item, because reaching it moves the item
 * on. Neither surface is Team-specific - both render from `/api/operations`
 * alone - so one environment is the whole rig.
 */

test.use({ harnessOptions: { fakeProvider: "live" } });

const TITLE = "Choose the release colour";
/* One item per spelling of "the owner already answered", because reaching that
   state moves the item on and the first item is spent on states 1 and 2. */
const SAVED_TITLE = "Choose the invoice unit";
const HELD_TITLE = "Choose the rounding rule";
const SAVED_ANSWER = "Store invoice totals as integer cents";
const HELD_ANSWER = "Round half away from zero";

/** What a user can see and do on one surface, read from the rendered page. */
interface SurfaceView {
  reportedState: string;
  detailText: string;
  detailButtons: string[];
  banner: boolean;
  bannerHeading: string | null;
  responseBox: boolean;
  respondAndResume: "absent" | "enabled" | "disabled";
  rowText: string;
  rowButtons: string[];
  rowBadges: string[];
}

/** What pressing a banner button did to an answer that was already on the record. */
interface BannerPress {
  notification: string;
  dialog: boolean;
  status: string;
  reportedState: string;
  humanResponses: string[];
  runsBefore: number;
  runsAfter: number;
}

let task: SavedTask;
let promptId: number;
let blockedState: SurfaceView;
let awaitingState: SurfaceView;
/** What pressing the banner's only button actually submitted on the owner's behalf. */
let bannerTap: { dialog: boolean; textareas: number; response: string | null };
let savedAnswerItem: SavedTask;
let savedAnswerState: SurfaceView;
let savedAnswerPress: BannerPress;
let heldAnswerItem: SavedTask;
let heldAnswerState: SurfaceView;
let heldAnswerPress: BannerPress;

async function reportedState(id: number): Promise<string | undefined> {
  const snapshot = await state.get<{ suites: Array<{ prompts: Array<{ prompt: { id: number }; operationalState: string }> }> }>("/api/operations");
  for (const suite of snapshot.suites) {
    const found = suite.prompts.find(item => item.prompt.id === id);
    if (found !== undefined) return found.operationalState;
  }
  return undefined;
}

/** Everything a person could act on, read from the real page in a real browser. */
async function observe(page: Page, id: number, title: string = TITLE): Promise<SurfaceView> {
  await page.goto(`${webUrl}/tasks?prompt=${id}`);
  const row = page.locator("li").filter({ hasText: title }).first();
  // Bounded, so a row that never arrives reports itself rather than eating the
  // hook's ten minutes - which is how the first attempt at the P-A0 rows
  // reported "the page is slow" when the real answer was "wrong workspace".
  await row.waitFor({ timeout: 30_000 });
  const detail = page.locator("aside").filter({ hasText: "Overview" }).last();
  await detail.getByRole("button", { name: "Overview", exact: true }).waitFor();
  /*
   * The banner's second condition reads `activity`, which arrives in a *second*
   * fetch after the panel mounts, so the tabs existing does not mean the panel
   * is finished. The session count is drawn from that same fetch, so waiting for
   * it is waiting for the data the banner needs. Reading too early is what made
   * the first green run of the saved-answer row below report the banner absent
   * while the panel's own text already contained it - a read race in the
   * observer, in a helper five green rows share.
   */
  await detail.getByRole("button", { name: /^Sessions · [1-9]/ }).waitFor({ timeout: 30_000 });

  const banner = detail.locator("h3", { hasText: /Needs your input|Answer saved/ });
  const bannerCount = await banner.count();
  const resume = detail.getByRole("button", { name: "Respond and resume", exact: true });
  const resumeCount = await resume.count();

  return {
    reportedState: (await reportedState(id)) ?? "unknown",
    detailText: (await detail.innerText()).trim(),
    detailButtons: await detail.getByRole("button").allInnerTexts(),
    banner: bannerCount > 0,
    bannerHeading: bannerCount > 0 ? (await banner.first().innerText()).trim() : null,
    responseBox: (await detail.getByLabel("Your response").count()) > 0,
    respondAndResume: resumeCount === 0 ? "absent" : (await resume.isEnabled()) ? "enabled" : "disabled",
    rowText: (await row.innerText()).trim().replaceAll("\n", " | "),
    rowButtons: (await row.getByRole("button").allInnerTexts()).map(text => text.trim()).filter(text => text !== "" && !text.includes(title)),
    rowBadges: await row.locator("span").filter({ hasText: /^(Needs you|Awaiting response|Working|Ready|Done)$/ }).allInnerTexts(),
  };
}

function report(label: string, view: SurfaceView): void {
  console.log(`\n===== M-13 ${label} =====\noperationalState: ${view.reportedState}\n` +
    `detail banner: ${view.banner ? `present - "${view.bannerHeading}"` : "ABSENT"}\n` +
    `detail "Your response" box: ${view.responseBox ? "present" : "ABSENT"}\n` +
    `detail "Respond and resume": ${view.respondAndResume}\n` +
    `detail buttons: ${JSON.stringify(view.detailButtons)}\n` +
    `row: ${view.rowText}\n` +
    `row badges: ${JSON.stringify(view.rowBadges)}\n` +
    `row buttons: ${JSON.stringify(view.rowButtons)}\n` +
    `----- detail overview text -----\n${view.detailText}\n===== end ${label} =====\n`);
}

test.beforeAll(async ({ harness, browser }) => {
  test.setTimeout(10 * 60_000);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    /* ---- state 1: the C3 state, driven by a real run of the fake agent ---- */
    ({ task } = await runSavedTask(harness, {
      title: TITLE,
      content: "Pick the colour the release ships in.",
      scenarios: [{
        behavior: "block-on-decision",
        reason: "The release colour needs a person.",
        humanAction: "Choose blue or green.",
        options: [{ label: "Blue", advantages: ["Matches the brand guide"] }, { label: "Green", advantages: ["Matches the docs"] }],
      }],
    }));
    promptId = task.promptId;
    await eventually("the item to be stored BLOCKED", async () => (await state.prompt(task)).status === "BLOCKED");
    expect(await reportedState(promptId), "the C3 state is the stored BLOCKED, with no handoff").toBe("BLOCKED");
    blockedState = await observe(page, promptId);

    /* ---- state 2: a real handoff question on the same item ---- */
    // The handoff agent's prompt names no launcher, so the fake answers on the
    // custom channel: its text is the brief, and it reports no status of its own.
    harness.fakeProvider.queue({
      behavior: "done",
      text: JSON.stringify({
        originalObjective: "Pick the colour the release ships in.",
        terminationReason: "The agent stopped for an owner decision.",
        completedWork: ["Read the brand guide"],
        pendingWork: ["Ship the chosen colour"],
        verificationPassed: [],
        verificationFailed: [],
        blockers: [{ description: "The release colour needs a person.", requiresHuman: true, requiredAction: "Choose blue or green." }],
        importantFiles: [],
        decisionsAndAssumptions: [],
        recommendation: "WAIT_FOR_HUMAN",
        successorInstructions: "Continue once the owner has chosen.",
      }),
    });
    await state.post(`/api/prompts/${promptId}/handoff`, { handoffProvider: "grok", successorProvider: "grok" });
    await eventually("the item to report AWAITING_RESPONSE", async () => (await reportedState(promptId)) === "AWAITING_RESPONSE", 120_000);
    awaitingState = await observe(page, promptId);

    /* ---- what the banner's one button does when there is no box to type in ---- */
    // Pressed last, because it moves the item on. The run it starts needs a
    // scenario, or the fake would fail the run and hide what was submitted.
    const runsBeforeTap = (await state.history(task)).runs.length;
    harness.fakeProvider.queue({ behavior: "done" });
    const detail = page.locator("aside").filter({ hasText: "Overview" }).last();
    await detail.getByRole("button", { name: "Review and respond", exact: true }).click();
    const answer = await eventually("a stored answer from the tap", async () =>
      (await state.history(task)).remarks.find(entry => entry.kind === "HUMAN_RESPONSE"), 60_000);
    bannerTap = {
      dialog: (await page.getByRole("dialog").count()) > 0,
      textareas: await page.locator("textarea").count(),
      response: answer.content,
    };

    /*
     * The fake pops one scenario per run from a single shared queue file, so a
     * run that is still starting when the next item writes its own scenario
     * takes that scenario instead - and the next item's run then finds the queue
     * empty and fails. That is what a first attempt at the rows below hit, and
     * it is why every tap that may start a run is followed by this.
     */
    const settle = async (item: SavedTask, minRuns: number): Promise<void> => {
      await eventually(`prompt ${item.promptId} to hold ${minRuns} runs with none still going`, async () => {
        const runs = (await state.history(item)).runs;
        return runs.length >= minRuns && runs.every(run => !["STARTING", "RUNNING"].includes(run.state.toUpperCase()));
      }, 120_000);
    };
    await settle(task, runsBeforeTap + 1);

    /* ---- state 3: the owner's answer is already on the record ---- */
    /*
     * Built the way a person reaches it. An item stops for a decision, and the
     * answer is posted to `/api/prompts/:id/human-response` - the one route the
     * detail page's own BLOCKED box and a Telegram reply both post to, so
     * nothing here writes to the database behind the product's back. `hold` is
     * the only difference between the two spellings, and it is the flag the rig
     * is carrying on prompt 1.
     */
    const suiteId = (await state.prompt(task)).suiteId;
    const answeredItem = async (title: string, answer: string, hold: boolean): Promise<SavedTask> => {
      // Same workspace and same suite as the item above, deliberately. The page
      // reads `/api/operations` for the *selected* workspace, so an item in a
      // workspace of its own is not on the page at all and the deep link cannot
      // put it there - the first attempt at these rows lost ten minutes to that.
      const { prompt } = await state.post<{ prompt: { id: number } }>(`/api/suites/${suiteId}/prompts`, { title, content: "Pick how the invoice totals are stored." });
      const item: SavedTask = { workspaceId: task.workspaceId, promptId: prompt.id, workDirectory: task.workDirectory };
      harness.fakeProvider.queue({
        behavior: "block-on-decision",
        reason: "The money representation needs a person.",
        humanAction: "Choose integer cents or a decimal.",
        options: [{ label: "Integer cents", advantages: ["No rounding drift"] }, { label: "Decimal", advantages: ["Reads naturally"] }],
      });
      const started = await state.startSavedTask(item, "grok");
      if ("error" in started) throw new Error(`${title} did not start: ${started.error}`);
      await eventually(`${title} to be stored BLOCKED`, async () => (await state.prompt(item)).status === "BLOCKED");
      await state.post(`/api/prompts/${item.promptId}/human-response`, hold ? { content: answer, hold: true } : { content: answer });
      await eventually(`${title} to carry the owner's answer on a TODO item`, async () => {
        const stored = await state.prompt(item);
        const remarks = (await state.history(item)).remarks;
        return stored.status === "TODO" && remarks.some(entry => entry.kind === "HUMAN_RESPONSE" && entry.content === answer);
      });
      return item;
    };

    /*
     * Presses the banner's one button and reads back what it did to the answer
     * that was already there. The run it may start needs a scenario queued, or
     * a failing fake would hide what was submitted - the same reason the tap
     * above queues one.
     */
    const pressBanner = async (item: SavedTask, label: string): Promise<BannerPress> => {
      const before = (await state.history(item)).runs.length;
      harness.fakeProvider.queue({ behavior: "done" });
      const detail = page.locator("aside").filter({ hasText: "Overview" }).last();
      await detail.getByRole("button", { name: label, exact: true }).click();
      // Every branch of `respond()` ends in a toast: "Response sent" on the way
      // through, "That did not work" with the server's own message otherwise.
      const notification = await eventually(`a notification from pressing "${label}"`, async () => {
        const region = page.getByRole("region", { name: "Notifications" });
        if ((await region.count()) === 0) return undefined;
        const text = (await region.innerText()).trim();
        return text === "" ? undefined : text;
      }, 60_000);
      const dialog = (await page.getByRole("dialog").count()) > 0;
      // `console_.startRun` is a socket send, not an awaited call, so a run row
      // can land after the toast. "No run was started" is an assertion here, so
      // one is given a window to appear before the absence is believed.
      await observeQuietPeriod(5_000, "a run started by the press");
      let history = await state.history(item);
      if (history.runs.length > before) {
        await settle(item, history.runs.length);
        history = await state.history(item);
      }
      return {
        notification: notification.replaceAll("\n", " | "),
        dialog,
        status: (await state.prompt(item)).status,
        reportedState: (await reportedState(item.promptId)) ?? "unknown",
        humanResponses: history.remarks.filter(entry => entry.kind === "HUMAN_RESPONSE").map(entry => entry.content),
        runsBefore: before,
        runsAfter: history.runs.length,
      };
    };

    savedAnswerItem = await answeredItem(SAVED_TITLE, SAVED_ANSWER, false);
    savedAnswerState = await observe(page, savedAnswerItem.promptId, SAVED_TITLE);
    savedAnswerPress = await pressBanner(savedAnswerItem, "Continue with saved answer");

    heldAnswerItem = await answeredItem(HELD_TITLE, HELD_ANSWER, true);
    heldAnswerState = await observe(page, heldAnswerItem.promptId, HELD_TITLE);
    heldAnswerPress = await pressBanner(heldAnswerItem, heldAnswerState.bannerHeading === "Answer saved" ? "Continue with saved answer" : "Review and respond");
  } finally {
    await page.close();
  }
});

test("M-13 (T1): in the C3 state the detail page offers no banner, and its own BLOCKED branch as the only way to answer", {
  annotation: { type: "covers", description: "M-13" },
}, async () => {
  report("detail / C3 state (stored BLOCKED, no handoff)", blockedState);
  expect(blockedState.reportedState).toBe("BLOCKED");
  // WorkItemDetail.tsx:245 gates the banner on AWAITING_RESPONSE, so it is absent.
  expect(blockedState.banner, "the \"Needs your input\" banner is gated on AWAITING_RESPONSE alone").toBe(false);
  // WorkItemDetail.tsx:407 has its own BLOCKED branch: the page is degraded, not a dead end.
  expect(blockedState.responseBox, "the BLOCKED branch's \"Your response\" box is the owner's way through").toBe(true);
  expect(blockedState.respondAndResume).toBe("enabled");
});

test("M-13 (T1): with a real handoff question the detail page shows the banner and drops the response box", {
  annotation: { type: "covers", description: "M-13" },
}, async () => {
  report("detail / handoff state (AWAITING_RESPONSE)", awaitingState);
  expect(awaitingState.reportedState).toBe("AWAITING_RESPONSE");
  expect(awaitingState.banner).toBe(true);
  expect(awaitingState.bannerHeading).toContain("Needs your input");
  expect(awaitingState.detailButtons.join(" | ")).toContain("Review and respond");
  // The BLOCKED branch at :407 is gone in this state, so the banner's button is
  // the whole affordance: there is no box to type the answer into.
  expect(awaitingState.responseBox).toBe(false);
  expect(awaitingState.respondAndResume).toBe("absent");
});

test("M-13 (T1): the banner's Review and respond submits a canned retry, because the page never asks the owner for an answer", {
  annotation: { type: "covers", description: "M-13" },
}, async () => {
  console.log(`\n===== M-13 the Review and respond tap (AWAITING_RESPONSE) =====\n` +
    `dialog opened: ${bannerTap.dialog}\ntextareas on the page: ${bannerTap.textareas}\n` +
    `answer stored on the owner's behalf: ${JSON.stringify(bannerTap.response)}\n===== end tap =====\n`);
  // One click, no review step and nothing typed, yet an answer is on the record.
  expect(bannerTap.dialog).toBe(false);
  expect(bannerTap.response).toContain("Retry requested with no additional context");
});

test("M-13 (T1): in the C3 state the work-item row offers Respond", {
  annotation: { type: "covers", description: "M-13" },
}, async () => {
  report("row / C3 state (stored BLOCKED, no handoff)", blockedState);
  expect(blockedState.rowBadges).toContain("Needs you");
  expect(blockedState.rowButtons).toContain("Respond");
});

test("M-13 (T1): with a real handoff question the work-item row offers no action at all", {
  annotation: { type: "covers", description: "M-13" },
}, async () => {
  report("row / handoff state (AWAITING_RESPONSE)", awaitingState);
  expect(awaitingState.rowBadges).toContain("Awaiting response");
  // WorkItemList.tsx:365 has no AWAITING_RESPONSE branch, so RowAction returns
  // null: the row says the item needs a person and offers nothing to press.
  expect(awaitingState.rowButtons).toEqual([]);
});

function reportPress(label: string, press: BannerPress): void {
  console.log(`\n===== M-13 ${label} =====\n` +
    `notification: ${press.notification}\ndialog opened: ${press.dialog}\n` +
    `stored status after: ${press.status}\noperationalState after: ${press.reportedState}\n` +
    `HUMAN_RESPONSE remarks after: ${JSON.stringify(press.humanResponses)}\n` +
    `runs before / after: ${press.runsBefore} / ${press.runsAfter}\n===== end ${label} =====\n`);
}

/*
 * P-A0. The two rows below are the reproduction jd asked for on 2026-09-27,
 * after the gap register recorded this half of M-13 in the voice of proven fact
 * on the strength of a code read. They change no product code, and their green
 * is a record of what the product does, not an endorsement of it - the same
 * standing as the five rows above.
 */

test("M-13 (T1): the saved-answer banner offers a button that the server refuses, so the owner's answer survives it", {
  annotation: { type: "covers", description: "M-13" },
}, async () => {
  report("detail / saved-answer state (TODO with a HUMAN_RESPONSE remark)", savedAnswerState);
  reportPress("the Continue with saved answer press", savedAnswerPress);

  // The state no row reached before P-A0: TODO, not AWAITING_RESPONSE, with the
  // owner's answer on the record. Every item answered from the BLOCKED box or
  // from Telegram lands here, so the banner is ordinary rather than exotic.
  expect(savedAnswerState.reportedState).toBe("READY");
  expect(savedAnswerState.banner, "WorkItemDetail.tsx:245's second condition is a TODO item with a HUMAN_RESPONSE remark").toBe(true);
  expect(savedAnswerState.bannerHeading).toBe("Answer saved");
  expect(savedAnswerState.detailButtons.join(" | ")).toContain("Continue with saved answer");
  // :407 gates the box on BLOCKED or recoverable, and TODO is neither.
  expect(savedAnswerState.responseBox, "the :407 box is absent, so there is again nothing to type into").toBe(false);
  expect(savedAnswerState.respondAndResume).toBe("absent");

  // What the press actually does. `respondToBlockedPrompt` (server/src/workspaces.ts:5914)
  // refuses any prompt that is neither BLOCKED nor carrying a pending question,
  // and an answered TODO item is neither - so the canned string at
  // TasksView.tsx:309 is never written and `startRun` is never reached.
  expect(savedAnswerPress.notification).toContain("That did not work");
  expect(savedAnswerPress.notification).toContain("no longer needs human input");
  expect(savedAnswerPress.humanResponses, "the owner's own answer is the only answer on the record").toEqual([SAVED_ANSWER]);
  expect(savedAnswerPress.runsAfter, "no run is started, so no provider budget is spent on it").toBe(savedAnswerPress.runsBefore);
  expect(savedAnswerPress.status).toBe("TODO");
});

test("M-13 (T1): a held answer reports AWAITING_RESPONSE, so the saved-answer label never appears on the state that has one", {
  annotation: { type: "covers", description: "M-13" },
}, async () => {
  report("detail / held-answer state (TODO with human_response_hold)", heldAnswerState);
  reportPress("the held-answer banner press", heldAnswerPress);

  // `human_response_hold` is the product's own name for a saved answer, and it
  // is the flag the rig carries on prompt 1. operationalState.ts:30 promotes a
  // held answer to AWAITING_RESPONSE, so the banner takes its *first* branch and
  // reads "Needs your input" - the label that means the opposite.
  expect(heldAnswerState.reportedState).toBe("AWAITING_RESPONSE");
  expect(heldAnswerState.banner).toBe(true);
  expect(heldAnswerState.bannerHeading).toBe("Needs your input");
  expect(heldAnswerState.detailButtons.join(" | ")).toContain("Review and respond");
  expect(heldAnswerState.detailButtons.join(" | ")).not.toContain("Continue with saved answer");

  // The same refusal, for the same reason: the hold does not make the prompt
  // BLOCKED and does not create a pending question.
  expect(heldAnswerPress.notification).toContain("no longer needs human input");
  expect(heldAnswerPress.humanResponses, "the held answer survives the press").toEqual([HELD_ANSWER]);
  expect(heldAnswerPress.runsAfter).toBe(heldAnswerPress.runsBefore);
});
