import { test } from "../../src/fixtures.ts";
import * as live from "../../src/scenarios/l1Live.ts";
import { pairThroughApi } from "../../src/telegramFlows.ts";

// Real Claude on its cheapest model with Host access off (typed tool path), paired to the test bot
// (docs/e2e-harness-plan.md 10.4). Uses the operator's own Claude login, so HOME is the operator's.
test.use({
  harnessOptions: {
    realHome: true,
    telegram: { backend: "real" },
    settings: { "claude.enabled": true, "claude.model": "claude-haiku-4-5", "codex.enabled": false, "cursor.enabled": false, "grok.enabled": false, hostAccess: false },
  },
});
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ harness }) => pairThroughApi(harness.phone!));

test("S-CLT-02, S-CLT-27: real Claude finishes a trivial task through get_context, post_remark and post_status with no shell or refusal", { annotation: { type: "covers", description: "7a, RTC-20, E2E-10.4" } }, async ({ harness, page }, testInfo) => live.realClaudeTrivialDone({ harness, page, phone: harness.phone! }, testInfo.outputDir));
test("S-L1-31, S-CLT-03, S-CLT-29: real Claude blocks, the phone answers and resumes, Claude reads the answer and finishes", { annotation: { type: "covers", description: "RTC-20, H-L1-05, H-L1-18, B05" } }, async ({ harness, page }, testInfo) => live.realClaudeAnswerAndResume({ harness, page, phone: harness.phone! }, testInfo.outputDir));
