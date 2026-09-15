import { test } from "../../src/fixtures.ts";
import * as l1 from "../../src/scenarios/l1.ts";
import { pairThroughApi } from "../../src/telegramFlows.ts";

// L1 scenarios (docs/e2e-scenarios/l1.md) on the fake Telegram backend with the fake agent on the live path.
test.use({ harnessOptions: { fakeProvider: "live", telegram: { backend: "fake" } } });

test.beforeAll(async ({ harness }) => {
  await pairThroughApi(harness.phone!);
});

const covers = (ids: string) => ({ annotation: { type: "covers", description: ids } });
const ctx = (harness: Parameters<Parameters<typeof test>[2]>[0]["harness"], page: Parameters<Parameters<typeof test>[2]>[0]["page"]) => ({ harness, page, phone: harness.phone! });

test("S-L1-05: reply and Answer and resume start one run that uses the answer", covers("RTC-20, H-L1-05, H-L1-18, T02, B08, I07"), async ({ harness, page }) => l1.answerAndResume(ctx(harness, page)));
test("S-L1-06: Save answer keeps waiting; Resume with saved answer starts exactly one run", covers("RTC-20, H-L1-06, T01, B08, I07"), async ({ harness, page }) => l1.saveThenResume(ctx(harness, page)));
test("S-L1-07: a double tap applies once", covers("H-L1-10, T02, B11, I08"), async ({ harness, page }) => l1.doubleTap(ctx(harness, page)));
test("S-L1-33: a reply that arrives before the card's send returns still answers the card", covers("RTC-20, B08"), async ({ harness, page }) => l1.replyBeforeCardSendReturns(ctx(harness, page)));
test("S-L1-09: of two replies only the first tapped answer stands", covers("T04, B11"), async ({ harness, page }) => l1.competingReplies(ctx(harness, page)));
test("S-L1-10 (case A): a local answer and resume makes the phone tap stale", covers("H-L1-09, T04, B11, B12"), async ({ harness, page }) => l1.answeredLocallyFirst(ctx(harness, page), "resume"));
test("S-L1-10 (case B): a local save makes the phone tap stale", covers("H-L1-09, T04, B11, B12"), async ({ harness, page }) => l1.answeredLocallyFirst(ctx(harness, page), "save"));
test("S-L1-11: a new question makes old cards and replies inert", covers("T04, B12"), async ({ harness, page }) => l1.newQuestionMakesOldCardsStale(ctx(harness, page)));
test("S-L1-12: stray messages record nothing", covers("B10, I03"), async ({ harness, page }) => l1.strayMessagesRecordNothing(ctx(harness, page)));
test("S-L1-13: a finished task ignores old cards", covers("B12, T31"), async ({ harness, page }) => l1.doneTaskIgnoresOldCards(ctx(harness, page)));
test("S-L1-25: resume that cannot start keeps the answer and resumes later", covers("H-L1-16, B19"), async ({ harness, page }) => l1.resumeCannotStart(ctx(harness, page)));
test("S-L1-23: Remote actions off rejects taps and does not replay them when turned on", covers("H-L1-15, B01, T34"), async ({ harness, page }) => l1.remoteActionsOffThenOn(ctx(harness, page)));
test("S-L1-21: a blocked pipeline step resumes and the pipeline continues once", covers("H-L1-13, B14"), async ({ harness, page }) => l1.pipelineStep(ctx(harness, page)));
test("S-L1-19 (question pending): a restart sends no duplicate and the card still works", covers("H-L1-12, B23"), async ({ harness, page }) => l1.restartWhileWaiting(ctx(harness, page), "question"));
test("S-L1-19 (answer pending): a restart keeps the answer card working", covers("H-L1-12, B23"), async ({ harness, page }) => l1.restartWhileWaiting(ctx(harness, page), "answer"));
test("S-L1-14 (tap): a tap made while offline is applied once on return", covers("RTC-20, H-L1-07, T06, B23"), async ({ harness, page }) => l1.offlineShortGap(ctx(harness, page), "tap"));
test("S-L1-14 (reply): a reply made while offline gets its answer card on return", covers("RTC-20, H-L1-07, T06, B23"), async ({ harness, page }) => l1.offlineShortGap(ctx(harness, page), "reply"));
test("S-L1-24: unpairing stops control; re-pairing gets new cards but old buttons stay dead", covers("H-L1-15, B29, T31, T34"), async ({ harness, page }) => l1.unpairStopsControl(ctx(harness, page), () => pairThroughApi(harness.phone!)));
