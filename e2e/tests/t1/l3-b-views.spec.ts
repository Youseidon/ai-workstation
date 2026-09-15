import { test } from "../../src/fixtures.ts";
import * as b from "../../src/scenarios/l3B.ts";
import { pairThroughApi } from "../../src/telegramFlows.ts";

// L3 slice B (docs/e2e-scenarios/l3-b.md) on the fake backend through the route proxy, with the fake agent.
test.use({ harnessOptions: { fakeProvider: "live", telegram: { backend: "fake", proxy: true } } });
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ harness }) => pairThroughApi(harness.phone!));

const covers = (ids: string) => ({ annotation: { type: "covers", description: ids } });
type Fixtures = Parameters<Parameters<typeof test>[2]>[0];
const ctx = ({ harness, page }: Pick<Fixtures, "harness" | "page">) => ({ harness, page, phone: harness.phone! });

test("S-L3-B-29: the command menu registered at connect equals the help list", covers("RTC-24, H-L3-42"), async ({ harness, page }) => b.commandMenuRegistered(ctx({ harness, page })));
test("S-L3-B-02: /status counts match local state and Refresh updates them in place", covers("RTC-24, B30, H-L3-40"), async ({ harness, page }) => b.statusView(ctx({ harness, page })));
test("S-L3-B-10: help, plain text, unknown commands and a bare /start all get the help view", covers("RTC-24, H-L3-45"), async ({ harness, page }) => b.helpEverywhere(ctx({ harness, page })));
test("S-L3-B-12, S-L3-B-14: drilling down and back edits one message and changes nothing", covers("RTC-24, B30, I03, H-L3-41"), async ({ harness, page }) => b.drillDownInOneMessage(ctx({ harness, page })));
test("S-L3-B-15, S-L3-B-20: views and card actions coexist; commands as replies are views, other replies are answers", covers("RTC-24, RTC-20"), async ({ harness, page }) => b.viewsBesideCards(ctx({ harness, page })));
test("S-L3-B-18: a crafted navigation tap on a question card changes nothing", covers("I03, I07"), async ({ harness, page }) => b.craftedNavigationOnCard(ctx({ harness, page })));
test("S-L3-B-21: commands addressed to this bot work; commands for another bot are ignored", covers("RTC-24"), async ({ harness, page }) => b.botAddressedCommands(ctx({ harness, page })));
test("S-L3-B-23: a stranger gets no view and cannot navigate the operator's view", covers("RTC-24, B30, B02, H-L3-48"), async ({ harness, page }) => b.strangerGetsNothing(ctx({ harness, page })));
test("S-L3-B-26: a long list pages inside one message", covers("RTC-24, H-L3-43"), async ({ harness, page }) => b.pagedList(ctx({ harness, page })));
test("S-L3-B-32: a view from before a restart still navigates", covers("RTC-24, H-L1-12, H-L3-46"), async ({ harness, page }) => b.navigationAfterRestart(ctx({ harness, page })));
test("S-L3-B-37: every command and a navigation tap start nothing and record nothing", covers("RTC-24, B30, H-L3-47"), async ({ harness, page }) => b.viewsChangeNothing(ctx({ harness, page })));
