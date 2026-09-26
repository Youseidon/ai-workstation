import type { Page } from "@playwright/test";
import { expect, test, webUrl } from "../../src/fixtures.ts";
import { eventually, state, type SavedTask } from "../../src/drivers/state.ts";
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
 * The item is the same row and the same detail page in both; only the reported
 * state moves. Neither surface is Team-specific - both render from
 * `/api/operations` alone - so one environment is the whole rig.
 */

test.use({ harnessOptions: { fakeProvider: "live" } });

const TITLE = "Choose the release colour";

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

let task: SavedTask;
let promptId: number;
let blockedState: SurfaceView;
let awaitingState: SurfaceView;
/** What pressing the banner's only button actually submitted on the owner's behalf. */
let bannerTap: { dialog: boolean; textareas: number; response: string | null };

async function reportedState(id: number): Promise<string | undefined> {
  const snapshot = await state.get<{ suites: Array<{ prompts: Array<{ prompt: { id: number }; operationalState: string }> }> }>("/api/operations");
  for (const suite of snapshot.suites) {
    const found = suite.prompts.find(item => item.prompt.id === id);
    if (found !== undefined) return found.operationalState;
  }
  return undefined;
}

/** Everything a person could act on, read from the real page in a real browser. */
async function observe(page: Page, id: number): Promise<SurfaceView> {
  await page.goto(`${webUrl}/tasks?prompt=${id}`);
  const row = page.locator("li").filter({ hasText: TITLE }).first();
  await row.waitFor();
  const detail = page.locator("aside").filter({ hasText: "Overview" }).last();
  await detail.getByRole("button", { name: "Overview", exact: true }).waitFor();

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
    rowButtons: (await row.getByRole("button").allInnerTexts()).map(text => text.trim()).filter(text => text !== "" && !text.includes(TITLE)),
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
