import { test } from "../../src/fixtures.ts";
import * as a2 from "../../src/scenarios/l3A2.ts";
import { pairThroughApi } from "../../src/telegramFlows.ts";

// L3 slice A2 (docs/e2e-scenarios/l3-a2.md) on the fake backend through the route proxy, with the fake agent.
test.use({ harnessOptions: { fakeProvider: "live", telegram: { backend: "fake", proxy: true } } });
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ harness }) => pairThroughApi(harness.phone!));

const covers = (ids: string) => ({ annotation: { type: "covers", description: ids } });
type Fixtures = Parameters<Parameters<typeof test>[2]>[0];
const ctx = ({ harness, page }: Pick<Fixtures, "harness" | "page">) => ({ harness, page, phone: harness.phone! });

test("S-L3-A2-11: a card with identifier, age, question, options and history answers exactly as S-L1-05", covers("RTC-22, RTC-23, H-L1-05"), async ({ harness, page }) => a2.decidableCard(ctx({ harness, page })));
test("S-L3-A2-12: a blocker-only card shows the identifier, blocker and action with no empty sections", covers("RTC-23, H-L1-18"), async ({ harness, page }) => a2.blockerOnlyCard(ctx({ harness, page })));
test("S-L3-A2-13: /task shows the same sections from the same summary", covers("RTC-24"), async ({ harness, page }) => a2.taskViewMatchesCard(ctx({ harness, page })));
