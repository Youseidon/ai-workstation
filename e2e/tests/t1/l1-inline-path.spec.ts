import { test } from "../../src/fixtures.ts";
import * as l1 from "../../src/scenarios/l1.ts";
import { pairThroughApi } from "../../src/telegramFlows.ts";

// S-L1-05 and S-L1-06 on the inline path: a sandboxed provider that cannot reach the Progress API.
test.use({ harnessOptions: { fakeProvider: "inline", telegram: { backend: "fake" } } });
test.beforeAll(async ({ harness }) => pairThroughApi(harness.phone!));

const covers = (ids: string) => ({ annotation: { type: "covers", description: ids } });

test("S-L1-05 (inline): Answer and resume on the inline path", covers("RTC-20, H-L1-05, T02"), async ({ harness, page }) => l1.answerAndResume({ harness, page, phone: harness.phone! }));
test("S-L1-06 (inline): Save answer then Resume on the inline path", covers("RTC-20, H-L1-06, T01"), async ({ harness, page }) => l1.saveThenResume({ harness, page, phone: harness.phone! }));
