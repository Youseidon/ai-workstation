import { test } from "../../src/fixtures.ts";
import * as l1 from "../../src/scenarios/l1.ts";
import * as f1 from "../../src/scenarios/l3F1.ts";
import { pairThroughApi } from "../../src/telegramFlows.ts";

// L3 slice F1 (docs/e2e-scenarios/l3-f1-f2.md) on the fake backend through the route proxy, with the fake agent.
test.use({ harnessOptions: { fakeProvider: "live", telegram: { backend: "fake", proxy: true } } });
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ harness }) => pairThroughApi(harness.phone!));

const covers = (ids: string) => ({ annotation: { type: "covers", description: ids } });
type Fixtures = Parameters<Parameters<typeof test>[2]>[0];
const ctx = ({ harness, page }: Pick<Fixtures, "harness" | "page">) => ({ harness, page, phone: harness.phone! });

test("S-L3-F1-05: two edits change one message in place and stack nothing", covers("RTC-21, H-L3-01"), async ({ harness, page }) => f1.editInPlace(ctx({ harness, page })));
test("S-L3-F1-06: edited cards keep their reply mapping and actions apply once", covers("RTC-21, I03, I07"), async ({ harness, page }) => f1.editCardsKeepReplyMapping(ctx({ harness, page })));
test("S-L3-F1-07: edits queued during an outage coalesce to the last", covers("RTC-21"), async ({ harness, page }) => f1.coalescedBurst(ctx({ harness, page })));
test("S-L3-F1-09: edits of different messages never coalesce with each other or with sends", covers("RTC-21"), async ({ harness, page }) => f1.editsStayPerMessage(ctx({ harness, page })));
test("S-L3-F1-10: an identical edit is not modified and counts as delivered", covers("RTC-21, H-L3-01"), async ({ harness, page }) => f1.unmodifiedEditIsSuccess(ctx({ harness, page })));
test("S-L3-F1-11: a lost edit response is retried and applied once", covers("RTC-21, I08"), async ({ harness, page }) => f1.lostEditResponse(ctx({ harness, page })));
test("S-L3-F1-12: an edit of a deleted message fails once and nothing reappears", covers("RTC-21, H-L3-02"), async ({ harness, page }) => f1.editOfDeletedMessage(ctx({ harness, page })));
test("S-L3-F1-14: a 429 on an edit holds calls until retry_after, then the newest edit goes once", covers("RTC-21, H-L1-11"), async ({ harness, page }) => f1.rateLimitedEdit(ctx({ harness, page })));
test("S-L3-F1-15 (outage): edits and a new card wait out an outage and arrive once", covers("RTC-21, H-L1-11, H-L3-03"), async ({ harness, page }) => f1.editsThroughFaults(ctx({ harness, page }), "refuse"));
test("S-L3-F1-15 (5xx): edits and a new card wait out 5xx responses and arrive once", covers("RTC-21, H-L1-11, H-L3-03"), async ({ harness, page }) => f1.editsThroughFaults(ctx({ harness, page }), "5xx"));
test("S-L3-F1-17: an edit waits for its send's message id", covers("RTC-21"), async ({ harness, page }) => f1.editBeforeSend(ctx({ harness, page })));
test("S-L3-F1-18 (a): a queued edit survives a restart and is delivered once", covers("RTC-21, H-L1-12"), async ({ harness, page }) => f1.editsSurviveRestart(ctx({ harness, page }), false));
test("S-L3-F1-18 (b): coalescible edits survive a restart and deliver the newest once", covers("RTC-21, H-L1-12"), async ({ harness, page }) => f1.editsSurviveRestart(ctx({ harness, page }), true));
test("S-L3-F1-20: unpairing drops queued edits to that chat", covers("RTC-21, I01, I03, S-L1-24"), async ({ harness, page }) => f1.unpairDropsQueuedEdits(ctx({ harness, page }), () => pairThroughApi(harness.phone!)));
test("S-L3-F1-13: permanent edit rejections are recorded once and never retried", covers("RTC-21"), async ({ harness, page }) => f1.permanentEditFailures(ctx({ harness, page })));
test("S-L3-F1-22: after the edit failure paths, the token is in no DTO, setting, operation, database row or agent environment", covers("RTC-21, I10, H-L1-17"), async ({ harness, page }) => l1.tokenNeverExposed(ctx({ harness, page })));
