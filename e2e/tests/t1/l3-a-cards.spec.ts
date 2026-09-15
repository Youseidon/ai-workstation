import { test } from "../../src/fixtures.ts";
import * as a from "../../src/scenarios/l3A.ts";
import { pairThroughApi } from "../../src/telegramFlows.ts";

// L3 slice A (docs/e2e-scenarios/l3-f3-a.md) on the fake backend through the route proxy, with the fake agent.
test.use({ harnessOptions: { fakeProvider: "live", telegram: { backend: "fake", proxy: true } } });
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ harness }) => pairThroughApi(harness.phone!));

const covers = (ids: string) => ({ annotation: { type: "covers", description: ids } });
type Fixtures = Parameters<Parameters<typeof test>[2]>[0];
const ctx = ({ harness, page }: Pick<Fixtures, "harness" | "page">) => ({ harness, page, phone: harness.phone! });

test("S-L3-A-01: a brief card runs general to specific with one collapsed details entity", covers("RTC-23, H-L3-06, H-L3-07"), async ({ harness, page }) => a.briefCard(ctx({ harness, page })));
test("S-L3-A-02: a remark-only card keeps line breaks, has no empty sections and applies once", covers("RTC-23, B21, H-L3-08, H-L1-18"), async ({ harness, page }) => a.remarkCard(ctx({ harness, page })));
test("S-L3-A-04: answer and saved-answer cards carry the summary and the answer", covers("RTC-23, RTC-20, I07, B08"), async ({ harness, page }) => a.answerCards(ctx({ harness, page })));
test("S-L3-A-06: an oversized brief is one card within the limit and applies once", covers("RTC-23, B21, B07"), async ({ harness, page }) => a.oversizedBriefCard(ctx({ harness, page })));
test("S-L3-A-07: the phone shows the formatter's UTF-16 entity bounds", covers("RTC-23"), async ({ harness, page }) => a.entityOffsetsOnPhone(ctx({ harness, page })));
test("S-L3-A-10, S-L3-A-11, S-L3-A-19: markup stays literal and secrets are redacted inside and outside the details", covers("RTC-23, I10, I03"), async ({ harness, page }) => a.literalAndRedactedCard(ctx({ harness, page })));
test("S-L3-A-12: a new brief makes the old answer card stale and a brief card is reissued", covers("RTC-23, B12, I07, I08"), async ({ harness, page }) => a.briefChangesRevision(ctx({ harness, page })));
test("S-L3-A-13: a blocked pipeline step shows its position and the next step runs once", covers("RTC-23, H-L1-13, B14"), async ({ harness, page }) => a.pipelineCard(ctx({ harness, page })));
test("S-L3-A-14: the workstation label reaches new cards and never edits old ones", covers("RTC-23, RTC-22, H-L3-10"), async ({ harness, page }) => a.labelOnCards(ctx({ harness, page })));
test("S-L3-A-15 (a): a reply made during an outage gets its rich card once after a restart", covers("RTC-23, H-L1-12, H-L3-05"), async ({ harness, page }) => a.queuedCardSurvivesRestart(ctx({ harness, page })));
