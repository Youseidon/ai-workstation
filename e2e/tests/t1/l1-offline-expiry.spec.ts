import { test } from "../../src/fixtures.ts";
import * as l1 from "../../src/scenarios/l1.ts";
import { pairThroughApi } from "../../src/telegramFlows.ts";

// S-L1-15 on the fake backend with a short action TTL; T3 uses the real 10-minute default.
const TTL_MS = 4000;
test.use({ harnessOptions: { fakeProvider: "live", telegram: { backend: "fake" }, serverEnv: { AGENT_CONSOLE_HARNESS_ACTION_TTL_MS: String(TTL_MS) } } });
test.beforeAll(async ({ harness }) => pairThroughApi(harness.phone!));

test("S-L1-15: a tap made offline and processed after the TTL is expired and the question reissued", { annotation: { type: "covers", description: "RTC-20, H-L1-08, B12, T06" } }, async ({ harness, page }) => l1.offlineLongGap({ harness, page, phone: harness.phone! }, TTL_MS));
