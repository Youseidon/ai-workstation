import { test } from "../../src/fixtures.ts";
import * as b from "../../src/scenarios/l3B.ts";
import { pairThroughApi } from "../../src/telegramFlows.ts";

// L3 slice B rows marked T3 real (docs/e2e-scenarios/l3-b.md) on the dedicated test bot.
test.use({ harnessOptions: { fakeProvider: "live", telegram: { backend: "real" } } });
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ harness }) => pairThroughApi(harness.phone!));

const covers = (ids: string) => ({ annotation: { type: "covers", description: ids } });
type Fixtures = Parameters<Parameters<typeof test>[2]>[0];
const ctx = ({ harness, page }: Pick<Fixtures, "harness" | "page">) => ({ harness, page, phone: harness.phone! });

test("S-L3-B-29 (real): the command menu registered at connect equals the help list", covers("RTC-24, H-L3-42"), async ({ harness, page }) => b.commandMenuRegistered(ctx({ harness, page })));
test("S-L3-B-02 (real): /status counts match local state and Refresh updates them in place", covers("RTC-24, H-L3-40"), async ({ harness, page }) => b.statusView(ctx({ harness, page })));
test("S-L3-B-10 (real): help, plain text and unknown commands get the help view", covers("RTC-24, H-L3-45"), async ({ harness, page }) => b.helpEverywhere(ctx({ harness, page })));
test("S-L3-B-12 (real): drilling down and back edits one message and changes nothing", covers("RTC-24, H-L3-41"), async ({ harness, page }) => b.drillDownInOneMessage(ctx({ harness, page })));
test("S-L3-B-15, S-L3-B-20 (real): views and card actions coexist", covers("RTC-24, RTC-20"), async ({ harness, page }) => b.viewsBesideCards(ctx({ harness, page })));
test("S-L3-B-21 (real): commands addressed to the test bot work; others are ignored", covers("RTC-24"), async ({ harness, page }) => b.botAddressedCommands(ctx({ harness, page })));
test("S-L3-B-32 (real): a view from before a restart still navigates", covers("RTC-24, H-L3-46"), async ({ harness, page }) => b.navigationAfterRestart(ctx({ harness, page })));
