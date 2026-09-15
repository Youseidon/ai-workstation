import { test } from "../../src/fixtures.ts";
import * as f1 from "../../src/scenarios/l3F1.ts";
import { pairThroughApi } from "../../src/telegramFlows.ts";

// L3 slice F1 rows marked T3 real (docs/e2e-scenarios/l3-f1-f2.md) on the dedicated test bot.
test.use({ harnessOptions: { fakeProvider: "live", telegram: { backend: "real" } } });
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ harness }) => pairThroughApi(harness.phone!));

const covers = (ids: string) => ({ annotation: { type: "covers", description: ids } });
type Fixtures = Parameters<Parameters<typeof test>[2]>[0];
const ctx = ({ harness, page }: Pick<Fixtures, "harness" | "page">) => ({ harness, page, phone: harness.phone! });

test("S-L3-F1-05 (real): two edits change one message in place and stack nothing", covers("RTC-21, H-L3-01"), async ({ harness, page }) => f1.editInPlace(ctx({ harness, page })));
test("S-L3-F1-10 (real): an identical edit is not modified and counts as delivered", covers("RTC-21, H-L3-01"), async ({ harness, page }) => f1.unmodifiedEditIsSuccess(ctx({ harness, page })));
test("S-L3-F1-12 (real): an edit of a deleted message fails once and nothing reappears", covers("RTC-21, H-L3-02"), async ({ harness, page }) => f1.editOfDeletedMessage(ctx({ harness, page })));
test("S-L3-F1-16, S-L3-F1-18 (real, a): edits queued while the route is cut survive a restart and deliver the newest once", covers("RTC-21, H-L3-03, S-L1-17"), async ({ harness, page }) => f1.editsSurviveRestart(ctx({ harness, page }), true));
