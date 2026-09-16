import { test } from "../../src/fixtures.ts";
import * as a2 from "../../src/scenarios/l3A2.ts";
import * as c1 from "../../src/scenarios/l3C1.ts";
import { pairThroughApi } from "../../src/telegramFlows.ts";

// L3 slices A2 and C1 on the dedicated test bot (docs/e2e-scenarios/l3-a2.md, l3-c1.md).
// The card sections, the tag Telegram turns into a hashtag entity, and the reply chain are
// exactly the parts a fake cannot prove: real Telegram decides what counts as a hashtag and
// how a reply is echoed back.
test.use({ harnessOptions: { fakeProvider: "live", telegram: { backend: "real" } } });
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ harness }) => pairThroughApi(harness.phone!));

const covers = (ids: string) => ({ annotation: { type: "covers", description: ids } });
type Fixtures = Parameters<Parameters<typeof test>[2]>[0];
const ctx = ({ harness, page }: Pick<Fixtures, "harness" | "page">) => ({ harness, page, phone: harness.phone! });

test("S-L3-A2-14, S-L3-A2-13a (real): the sectioned card with options renders and its answer applies once", covers("RTC-22, RTC-23, H-L3-06"), async ({ harness, page }) => a2.decidableCard(ctx({ harness, page })));
test("S-L3-C1-10 (real): the task's messages carry its tag and reply to the anchor, which is never edited", covers("RTC-25"), async ({ harness, page }) => c1.taskThreadOnThePhone(ctx({ harness, page })));
