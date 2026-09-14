import { test } from "../../src/fixtures.ts";
import * as live from "../../src/scenarios/l1Live.ts";
import { pairThroughApi } from "../../src/telegramFlows.ts";

// Real Codex on its cheapest model with Host access on in the harness root only (docs/e2e-harness-plan.md 10.4:
// risk accepted, Codex runs in danger-full-access and is not confined to the workspace). The full event log is
// kept as an artifact for review. Uses the operator's own Codex login, so HOME is the operator's.
test.use({
  harnessOptions: {
    realHome: true,
    telegram: { backend: "real" },
    settings: { "codex.enabled": true, "codex.model": "gpt-5.5", "claude.enabled": false, "cursor.enabled": false, "grok.enabled": false, hostAccess: true },
  },
});
test.beforeAll(async ({ harness }) => pairThroughApi(harness.phone!));

test("S-L1-32: real Codex blocks; Save answer starts nothing; Resume with saved answer starts one run that finishes", { annotation: { type: "covers", description: "RTC-20, H-L1-06" } }, async ({ harness, page }, testInfo) => live.realCodexSaveThenResume({ harness, page, phone: harness.phone! }, testInfo.outputDir));
