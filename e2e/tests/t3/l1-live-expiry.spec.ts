import { test } from "../../src/fixtures.ts";
import * as l1 from "../../src/scenarios/l1.ts";
import { pairThroughApi } from "../../src/telegramFlows.ts";

// S-L1-15 on real Telegram with the production 10-minute action TTL (no harness override).
const PRODUCTION_ACTION_TTL_MS = 10 * 60_000;
test.use({ harnessOptions: { fakeProvider: "live", telegram: { backend: "real" } } });
test.beforeAll(async ({ harness }) => pairThroughApi(harness.phone!));

test("S-L1-15 (real): a tap made offline and processed after the real 10-minute TTL is expired and the question reissued", { annotation: { type: "covers", description: "RTC-20, H-L1-08, B12, T06" } }, async ({ harness, page }) => l1.offlineLongGap({ harness, page, phone: harness.phone! }, PRODUCTION_ACTION_TTL_MS));
