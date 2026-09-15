import { test } from "../../src/fixtures.ts";
import * as a from "../../src/scenarios/l3A.ts";
import { pairThroughApi } from "../../src/telegramFlows.ts";

// L3 slice A rows marked T3 real (docs/e2e-scenarios/l3-f3-a.md) on the dedicated test bot. The cards these send are
// the ones the operator's phone look check (S-L3-A-21) reads.
test.use({ harnessOptions: { fakeProvider: "live", telegram: { backend: "real" } } });
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ harness }) => pairThroughApi(harness.phone!));

const covers = (ids: string) => ({ annotation: { type: "covers", description: ids } });
type Fixtures = Parameters<Parameters<typeof test>[2]>[0];
const ctx = ({ harness, page }: Pick<Fixtures, "harness" | "page">) => ({ harness, page, phone: harness.phone! });

test("S-L3-A-01 (real): a brief card with one collapsed details entity", covers("RTC-23, H-L3-06, H-L3-07"), async ({ harness, page }) => a.briefCard(ctx({ harness, page })));
test("S-L3-A-02 (real): a remark-only card keeps line breaks and applies once", covers("RTC-23, H-L3-08"), async ({ harness, page }) => a.remarkCard(ctx({ harness, page })));
test("S-L3-A-04 (real): answer and saved-answer cards carry the summary and the answer", covers("RTC-23, RTC-20"), async ({ harness, page }) => a.answerCards(ctx({ harness, page })));
test("S-L3-A-08 (real): emoji and combining marks ahead of the details are accepted with the right entity bounds", covers("RTC-23"), async ({ harness, page }) => a.entityOffsetsOnPhone(ctx({ harness, page })));
test("S-L3-A-10, S-L3-A-19 (real): markup stays literal and secrets are redacted", covers("RTC-23, I10"), async ({ harness, page }) => a.literalAndRedactedCard(ctx({ harness, page })));
test("S-L3-A-13 (real): a blocked pipeline step shows its position and the next step runs once", covers("RTC-23, H-L1-13"), async ({ harness, page }) => a.pipelineCard(ctx({ harness, page })));
