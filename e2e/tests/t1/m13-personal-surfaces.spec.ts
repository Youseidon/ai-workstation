import type { Page } from "@playwright/test";
import { expect, test, webUrl } from "../../src/fixtures.ts";
import { eventually, observeQuietPeriod, state, type SavedTask } from "../../src/drivers/state.ts";
import { runSavedTask } from "../../src/scenarios.ts";

/*
 * M-13. What the two personal-control surfaces actually render in the two
 * states `operationalState` can report for "this item is waiting on a person".
 *
 * THIS SPEC ASSERTED CURRENT BEHAVIOUR UNTIL P-A3. From 2026-09-26 to
 * 2026-09-27 it was green because it recorded what the product did rather than
 * what it should do, while invariant A5 kept `web/` unchanged pending jd's
 * ruling. **jd ruled on 2026-09-27: full fix, and the personal-control surfaces
 * A5 covers may be changed.** So the rows below no longer characterise; they
 * assert the fixed behaviour, and a green here is now an endorsement.
 *
 * What changed, and what each row therefore now asserts:
 *
 *  - The banner no longer submits anything. Both of its states open the already
 *    mounted `HumanInputDialog`, which is the surface built for this and was
 *    reachable from nothing. Rows 3, 6 and 7 assert a dialog rather than a
 *    stored answer.
 *  - `respond()` can no longer send an answer nobody typed. An empty box
 *    disables "Respond and resume", and retrying on the existing context is its
 *    own button that says so.
 *  - The work-item row branches on `awaitsResponse`, the shared predicate whose
 *    absence is what C3 was, so a waiting handoff offers "Respond" like a
 *    stored `BLOCKED` item does. Row 5 asserts that button.
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
 *     remark. No row here reached it until P-A0 added the two below. It has two
 *     spellings and they do not render alike, and the difference between them
 *     is what L-18 was. With no `human_response_hold` nothing is pending: the
 *     item reports `READY`, `humanInput.savedResponseId` is null, and since
 *     L-18 there is no banner at all - the page offers "Run work item". With a
 *     hold the answer really is saved, `operationalState` returns
 *     `AWAITING_RESPONSE` (server/src/operationalState.ts:30), and that is the
 *     state whose banner reads "Answer saved" / "Continue with saved answer".
 *     The two rows below recorded both of those the other way round until
 *     L-18, because the banner keyed its labels on `operationalState` rather
 *     than on whether an answer was held.
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
  dialogTextareas: number;
  dialogButtons: string[];
  /* Every heading inside the dialog, so a title that contradicts the panel
     under it is visible to a row rather than only to a person. */
  dialogHeadings: string[];
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
/* What the record still held after the saved-answer item's page was looked at.
   Since L-18 that item has no banner button, so there is nothing to press and
   the reading below is what replaces the press. */
let savedAnswerRecord: { status: string; reportedState: string; humanResponses: string[]; runsBefore: number; runsAfter: number };
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
    /*
     * The fake pops one scenario per run from a single shared queue file, so a
     * run that is still starting when the next item writes its own scenario
     * takes that scenario instead - and the next item's run then finds the queue
     * empty and fails. That is what a first attempt at the state-3 rows hit, and
     * it is why every tap that may start a run is followed by this.
     */
    const settle = async (item: SavedTask, minRuns: number): Promise<void> => {
      await eventually(`prompt ${item.promptId} to hold ${minRuns} runs with none still going`, async () => {
        const runs = (await state.history(item)).runs;
        return runs.length >= minRuns && runs.every(run => !["STARTING", "RUNNING"].includes(run.state.toUpperCase()));
      }, 120_000);
    };
    /** Waits out a run that may or may not have been started, then settles it. */
    const settleIfStarted = async (item: SavedTask, runsBefore: number): Promise<void> => {
      // `console_.startRun` is a socket send, not an awaited call, so a run row
      // can land after the press has otherwise finished.
      await observeQuietPeriod(5_000, "a run started by the press");
      const after = (await state.history(item)).runs.length;
      if (after > runsBefore) await settle(item, after);
    };

    const runsBeforeTap = (await state.history(task)).runs.length;
    harness.fakeProvider.queue({ behavior: "done" });
    const detail = page.locator("aside").filter({ hasText: "Overview" }).last();
    await detail.getByRole("button", { name: "Review and respond", exact: true }).click();
    /*
     * Waits for whichever of the two things this press can do and records both,
     * so the row states which one happened rather than timing out on the one it
     * expected. Before P-A3 the press stored an answer; after it, the press opens
     * the dialog and stores nothing, and a wait for a stored answer would hang
     * for its whole timeout and report "the press did not work".
     */
    await eventually("the Review and respond press to do something visible", async () => {
      if ((await page.getByRole("dialog").count()) > 0) return "dialog";
      const stored = (await state.history(task)).remarks.find(entry => entry.kind === "HUMAN_RESPONSE");
      return stored === undefined ? undefined : "stored";
    }, 60_000);
    bannerTap = {
      dialog: (await page.getByRole("dialog").count()) > 0,
      textareas: await page.locator("textarea").count(),
      response: (await state.history(task)).remarks.find(entry => entry.kind === "HUMAN_RESPONSE")?.content ?? null,
    };

    await settleIfStarted(task, runsBeforeTap);

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
      /*
       * Waits for whichever of the two things a press can do, and records both,
       * so the row states which one happened rather than timing out on the one
       * it expected. Before P-A3 the press submitted and every branch of
       * `respond()` ended in a toast; after it, the press opens the modal and
       * raises nothing.
       */
      const region = page.getByRole("region", { name: "Notifications" });
      const dialogLocator = page.getByRole("dialog");
      await eventually(`the press of "${label}" to do something visible`, async () => {
        if ((await dialogLocator.count()) > 0) return "dialog";
        if ((await region.count()) > 0 && (await region.innerText()).trim() !== "") return "notification";
        return undefined;
      }, 60_000);
      const dialog = (await dialogLocator.count()) > 0;
      const dialogTextareas = dialog ? await dialogLocator.locator("textarea").count() : 0;
      const dialogButtons = dialog ? (await dialogLocator.getByRole("button").allInnerTexts()).map(text => text.trim()) : [];
      const dialogHeadings = dialog ? (await dialogLocator.locator("h2, h3").allInnerTexts()).map(text => text.trim()) : [];
      const notification = (await region.count()) === 0 ? "" : (await region.innerText()).trim();
      // "No run was started" is an assertion in these rows, so a run is given a
      // window to appear before the absence is believed.
      await settleIfStarted(item, before);
      const history = await state.history(item);
      return {
        notification: notification.replaceAll("\n", " | "),
        dialog,
        dialogTextareas,
        dialogButtons,
        dialogHeadings,
        status: (await state.prompt(item)).status,
        reportedState: (await reportedState(item.promptId)) ?? "unknown",
        humanResponses: history.remarks.filter(entry => entry.kind === "HUMAN_RESPONSE").map(entry => entry.content),
        runsBefore: before,
        runsAfter: history.runs.length,
      };
    };

    savedAnswerItem = await answeredItem(SAVED_TITLE, SAVED_ANSWER, false);
    /*
     * Since L-18 there is no banner on this item and so no banner button to
     * press. What the press proved is still asserted, without a press: the
     * owner's answer must still be the only answer on the record, and merely
     * looking at the page must start nothing. The quiet period is the same one
     * `settleIfStarted` uses, because a run row can land after a press or a
     * render has otherwise finished.
     */
    const savedRunsBefore = (await state.history(savedAnswerItem)).runs.length;
    savedAnswerState = await observe(page, savedAnswerItem.promptId, SAVED_TITLE);
    await observeQuietPeriod(5_000, "a run the saved-answer item's page might have started");
    const savedHistory = await state.history(savedAnswerItem);
    savedAnswerRecord = {
      status: (await state.prompt(savedAnswerItem)).status,
      reportedState: (await reportedState(savedAnswerItem.promptId)) ?? "unknown",
      humanResponses: savedHistory.remarks.filter(entry => entry.kind === "HUMAN_RESPONSE").map(entry => entry.content),
      runsBefore: savedRunsBefore,
      runsAfter: savedHistory.runs.length,
    };

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
  /*
   * Changed by P-A3 on jd's ruling of 2026-09-27, and this one was not
   * predicted: the red run found it. Until then "Respond and resume" was enabled
   * over an empty box, and pressing it submitted the canned retry text as though
   * the owner had written it - the same unauthored answer as the banner's, from
   * the one surface that does have a box. It is now disabled until something is
   * typed, and the affordance the blank box carried silently is its own button
   * that says what it does. The hint at :421 documented "leave blank to retry",
   * so the capability is kept rather than removed.
   */
  expect(blockedState.respondAndResume, "an empty box cannot be submitted as an answer").toBe("disabled");
  expect(blockedState.detailButtons.join(" | "), "and the retry it used to carry silently is now labelled").toContain("Retry with existing context");
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

test("M-13 (T1): the banner's Review and respond opens the dialog and stores nothing on the owner's behalf", {
  annotation: { type: "covers", description: "M-13" },
}, async () => {
  console.log(`\n===== M-13 the Review and respond tap (AWAITING_RESPONSE) =====\n` +
    `dialog opened: ${bannerTap.dialog}\ntextareas on the page: ${bannerTap.textareas}\n` +
    `answer stored on the owner's behalf: ${JSON.stringify(bannerTap.response)}\n===== end tap =====\n`);
  /*
   * Inverted by P-A3 on jd's ruling of 2026-09-27. Until then this row asserted
   * `dialog: false` and a stored remark containing "Retry requested with no
   * additional context" - one click, no review step, nothing typed, and an
   * answer on the record. The press now opens `HumanInputDialog` with a box in
   * it, and nothing reaches the record until the owner sends something.
   */
  expect(bannerTap.dialog, "the banner opens the dialog built for this").toBe(true);
  expect(bannerTap.textareas, "and the dialog has a box to answer in").toBeGreaterThan(0);
  expect(bannerTap.response, "nothing is stored by the press itself").toBeNull();
});

test("M-13 (T1): in the C3 state the work-item row offers Respond", {
  annotation: { type: "covers", description: "M-13" },
}, async () => {
  report("row / C3 state (stored BLOCKED, no handoff)", blockedState);
  expect(blockedState.rowBadges).toContain("Needs you");
  expect(blockedState.rowButtons).toContain("Respond");
});

test("M-13 (T1): with a real handoff question the work-item row offers Respond, like the stored BLOCKED state", {
  annotation: { type: "covers", description: "M-13" },
}, async () => {
  report("row / handoff state (AWAITING_RESPONSE)", awaitingState);
  expect(awaitingState.rowBadges).toContain("Awaiting response");
  /*
   * Inverted by P-A3 on jd's ruling of 2026-09-27. Until then this row asserted
   * `rowButtons` was empty: `RowAction` branched on the single spelling
   * `BLOCKED`, so a row could say the item needed a person and offer nothing to
   * press. It now branches on `awaitsResponse`, which is the shared predicate
   * that covers both spellings - the one whose absence C3 was.
   */
  expect(awaitingState.rowButtons).toContain("Respond");
});

function reportPress(label: string, press: BannerPress): void {
  console.log(`\n===== M-13 ${label} =====\n` +
    `notification: ${press.notification}\ndialog opened: ${press.dialog} (textareas in it: ${press.dialogTextareas})\n` +
    `dialog buttons: ${JSON.stringify(press.dialogButtons)}\n` +
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

test("M-13 (T1): an answered item with nothing held carries no saved-answer banner, and offers the run instead", {
  annotation: { type: "covers", description: "M-13" },
}, async () => {
  report("detail / saved-answer state (TODO with a HUMAN_RESPONSE remark)", savedAnswerState);
  console.log(`\n===== M-13 the saved-answer record after the page was looked at =====\n` +
    `stored status: ${savedAnswerRecord.status}\noperationalState: ${savedAnswerRecord.reportedState}\n` +
    `HUMAN_RESPONSE remarks: ${JSON.stringify(savedAnswerRecord.humanResponses)}\n` +
    `runs before / after the visit: ${savedAnswerRecord.runsBefore} / ${savedAnswerRecord.runsAfter}\n===== end record =====\n`);

  // The state no row reached before P-A0: TODO, not AWAITING_RESPONSE, with the
  // owner's answer on the record. Every item answered from the BLOCKED box or
  // from Telegram lands here, so this state is ordinary rather than exotic.
  expect(savedAnswerState.reportedState).toBe("READY");

  /*
   * INVERTED for L-18, on jd's ruling of 2026-09-27 that folded L-18 into P-B5
   * and jd's confirmation of 2026-09-28 to take it as its own task after P-B5
   * shipped without it. Until then this row asserted `banner: true` with the
   * heading "Answer saved" and a "Continue with saved answer" button, and that
   * was a correct record of the defect rather than an endorsement: the banner's
   * second condition was `prompt.status === "TODO"` plus *any* `HUMAN_RESPONSE`
   * remark, so every item that had ever been blocked and answered carried the
   * banner forever. This item is plainly `READY` - no hold, no pending
   * question, `humanInput.savedResponseId` null - so there is no saved answer
   * to continue from and nothing to review, and offering either was the whole
   * complaint. The banner is now gated on `AWAITING_RESPONSE` alone.
   */
  expect(savedAnswerState.banner, "a READY item has nothing pending, so it carries no saved-answer banner").toBe(false);
  expect(savedAnswerState.bannerHeading).toBeNull();
  expect(savedAnswerState.detailButtons.join(" | "), "the READY branch's own button is the whole affordance here").toContain("Run work item");
  expect(savedAnswerState.detailButtons.join(" | ")).not.toContain("Continue with saved answer");
  expect(savedAnswerState.detailButtons.join(" | ")).not.toContain("Review and respond");
  // The detail page's own response box is gated on BLOCKED or recoverable, and
  // TODO is neither, so there is again nothing to type into - and nothing to say.
  expect(savedAnswerState.responseBox).toBe(false);
  expect(savedAnswerState.respondAndResume).toBe("absent");

  /*
   * What the press assertions here used to prove, kept without a press because
   * there is no banner button on this item any more: the owner's answer is
   * still the only answer on the record, and looking at the page starts
   * nothing. Before L-18 those assertions read the outcome of pressing
   * "Continue with saved answer", which opened `HumanInputDialog` on a state
   * with nothing to resume.
   */
  expect(savedAnswerRecord.humanResponses, "the owner's own answer is still the only answer on the record").toEqual([SAVED_ANSWER]);
  expect(savedAnswerRecord.status).toBe("TODO");
  expect(savedAnswerRecord.reportedState).toBe("READY");
  expect(savedAnswerRecord.runsAfter, "looking at the item starts no run").toBe(savedAnswerRecord.runsBefore);
});

test("M-13 (T1): a held answer reports AWAITING_RESPONSE, and that is the state whose banner says the answer is saved", {
  annotation: { type: "covers", description: "M-13" },
}, async () => {
  report("detail / held-answer state (TODO with human_response_hold)", heldAnswerState);
  reportPress("the held-answer banner press", heldAnswerPress);

  /*
   * INVERTED for L-18, on the same ruling of 2026-09-27 and jd's confirmation
   * of 2026-09-28. Until then this row asserted the heading "Needs your input",
   * a "Review and respond" button and no "Continue with saved answer" anywhere,
   * and that too was a correct record of the defect: `human_response_hold` is
   * the product's own record of a saved answer - it is the flag the rig carries
   * on prompt 1 - and operationalState.ts:30 promotes a held answer to
   * AWAITING_RESPONSE, so labels keyed on `operationalState` put "Needs your
   * input" on the one state that *has* an answer and "Answer saved" on the one
   * that has none. Both labels are now chosen from
   * `humanInput.savedResponseId`, which is the fact itself rather than a state
   * name that two situations share, and it is the same fact
   * `HumanInputDialog` already branched on for its own heading.
   */
  expect(heldAnswerState.reportedState).toBe("AWAITING_RESPONSE");
  expect(heldAnswerState.banner).toBe(true);
  expect(heldAnswerState.bannerHeading).toBe("Answer saved");
  expect(heldAnswerState.detailButtons.join(" | ")).toContain("Continue with saved answer");
  expect(heldAnswerState.detailButtons.join(" | ")).not.toContain("Review and respond");

  /*
   * Inverted by P-A3 on the same ruling. Until then the press was refused here
   * too, for the same reason: a hold makes the prompt neither `BLOCKED` nor the
   * carrier of a pending question. It now opens the dialog, and the held answer
   * is still the only answer on the record.
   */
  expect(heldAnswerPress.dialog).toBe(true);
  expect(heldAnswerPress.notification).toBe("");
  expect(heldAnswerPress.humanResponses, "the held answer survives the press").toEqual([HELD_ANSWER]);
  expect(heldAnswerPress.runsAfter).toBe(heldAnswerPress.runsBefore);

  /*
   * L-18's third instance, asserted here for the first time. The dialog's own
   * `Modal` title was hardcoded to "Needs your input" over a panel whose
   * heading reads "Your answer is recorded" for exactly this state. The Modal
   * wraps the panel and is rendered before the panel has fetched the activity,
   * so it cannot know which of the two states it is in; its title is now
   * state-neutral and the panel's heading is what carries the state.
   */
  expect(heldAnswerPress.dialogHeadings, "the panel still names this state correctly").toContain("Your answer is recorded");
  expect(heldAnswerPress.dialogHeadings, "and no heading above it contradicts that").not.toContain("Needs your input");
});
