import { test } from "../../src/fixtures.ts";
import * as c1 from "../../src/scenarios/l3C1.ts";
import { pairThroughApi } from "../../src/telegramFlows.ts";

// L3 slice C1 (docs/e2e-scenarios/l3-c1.md) on the fake backend through the route proxy, with the fake agent.
test.use({ harnessOptions: { fakeProvider: "live", telegram: { backend: "fake", proxy: true } } });
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ harness }) => pairThroughApi(harness.phone!));

const covers = (ids: string) => ({ annotation: { type: "covers", description: ids } });
type Fixtures = Parameters<Parameters<typeof test>[2]>[0];
const ctx = ({ harness, page }: Pick<Fixtures, "harness" | "page">) => ({ harness, page, phone: harness.phone! });

test("S-L3-C1-10: a task's messages carry its tag and reply to its card, which is never overwritten", covers("RTC-25, H-L1-05"), async ({ harness, page }) => c1.taskThreadOnThePhone(ctx({ harness, page })));
test("S-L3-C1-11: one control panel, pinned once and edited in place", covers("RTC-25"), async ({ harness, page }) => c1.pinnedControlPanel(ctx({ harness, page })));
test("S-L3-C1-12: a deleted panel is registered again by the next /status", covers("RTC-25, H-L3-02"), async ({ harness, page }) => c1.panelRecovery(ctx({ harness, page })));
