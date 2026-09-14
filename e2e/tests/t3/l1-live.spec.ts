import { expect, test } from "../../src/fixtures.ts";
import { eventually, state } from "../../src/drivers/state.ts";
import { coexistenceProblems, sampleOperatorApp, type OperatorSample } from "../../src/operatorApp.ts";
import * as l1 from "../../src/scenarios/l1.ts";
import * as live from "../../src/scenarios/l1Live.ts";
import { pairThroughApi, telegramStatus } from "../../src/telegramFlows.ts";

// L1 rows marked T3 real in docs/e2e-scenarios/l1.md, on the dedicated test bot through the operator's
// automated client (docs/e2e-live-setup.md), with the fake agent. Same bodies as the T1 specs.
test.use({ harnessOptions: { fakeProvider: "live", telegram: { backend: "real" } } });
test.describe.configure({ mode: "serial" });

const covers = (ids: string) => ({ annotation: { type: "covers", description: ids } });
type Fixtures = Parameters<Parameters<typeof test>[2]>[0];
const ctx = ({ harness, page }: Pick<Fixtures, "harness" | "page">) => ({ harness, page, phone: harness.phone! });
const operatorSamples: Array<OperatorSample | null> = [];

test.beforeAll(async () => {
  operatorSamples.push(await sampleOperatorApp());
});

test("S-L1-02 (real), S-H6-11: connecting through the route proxy reaches polling as the test bot with the 25s window", covers("RTC-17, RTC-19, H-L1-03"), async ({ harness, page }) => live.connectReachesPolling(ctx({ harness, page })));
test("S-L1-03 (real): pairing through the Agents page, then the first card arrives in the real chat", covers("RTC-17, RTC-18, H-L1-04"), async ({ harness, page }) => l1.pairThenFirstCard(ctx({ harness, page })));
test("S-H6-12 (real): the production long poll stays open for its window and lastPollAt keeps advancing", covers("H6, 4.2-proxy"), async ({ harness }) => {
  const polls: string[] = [];
  await eventually("three completed long polls", async () => {
    const { lastPollAt, state: current } = await telegramStatus();
    expect(current).toBe("polling");
    if (lastPollAt && !polls.includes(lastPollAt)) polls.push(lastPollAt);
    return polls.length >= 3 ? true : undefined;
  }, 120_000);
  const idle = harness.telegramCalls().filter((call) => call.method === "getUpdates" && "outcome" in call && call.outcome === 200);
  expect(idle.length).toBeGreaterThanOrEqual(2);
  expect(idle.every((call) => call.body.timeout === 25)).toBe(true);
});
test("S-L1-05 (real): reply and Answer and resume start one run that uses the answer", covers("RTC-20, H-L1-05, H-L1-18, T02, B08, I07"), async ({ harness, page }) => l1.answerAndResume(ctx({ harness, page })));
test("S-L1-06 (real): Save answer keeps waiting; Resume with saved answer starts exactly one run", covers("RTC-20, H-L1-06, T01, B08, I07"), async ({ harness, page }) => l1.saveThenResume(ctx({ harness, page })));
test("S-L1-07 (real): a double tap applies once", covers("H-L1-10, T02, B11, I08"), async ({ harness, page }) => l1.doubleTap(ctx({ harness, page })));
test("S-L1-10 (real, case A): a local answer and resume makes the phone tap stale", covers("H-L1-09, T04, B11, B12"), async ({ harness, page }) => l1.answeredLocallyFirst(ctx({ harness, page }), "resume"));
test("S-L1-10 (real, case B): a local save makes the phone tap stale", covers("H-L1-09, T04, B11, B12"), async ({ harness, page }) => l1.answeredLocallyFirst(ctx({ harness, page }), "save"));
test("S-L1-29 (real): blocker text is redacted on the card and the reply is stored literally", covers("I10"), async ({ harness, page }) => l1.redactionAndLiteralReplies(ctx({ harness, page })));
test("S-L1-25 (real): resume that cannot start keeps the answer and resumes later", covers("H-L1-16, B19"), async ({ harness, page }) => l1.resumeCannotStart(ctx({ harness, page })));
test("S-L1-23 (real): Remote actions off rejects taps and does not replay them when turned on", covers("H-L1-15, B01, T34"), async ({ harness, page }) => l1.remoteActionsOffThenOn(ctx({ harness, page })));
test("S-L1-21 (real): a blocked pipeline step resumes and the pipeline continues once", covers("H-L1-13, B14"), async ({ harness, page }) => l1.pipelineStep(ctx({ harness, page })));
test("S-L1-19 (real, question pending): a restart sends no duplicate and the card still works", covers("H-L1-12, B23"), async ({ harness, page }) => {
  await l1.restartWhileWaiting(ctx({ harness, page }), "question");
  operatorSamples.push(await sampleOperatorApp());
});
test("S-L1-19 (real, answer pending): a restart keeps the answer card working", covers("H-L1-12, B23"), async ({ harness, page }) => l1.restartWhileWaiting(ctx({ harness, page }), "answer"));
test("S-L1-14 (real, tap): a tap made while offline is applied once on return", covers("RTC-20, H-L1-07, T06, B23"), async ({ harness, page }) => {
  await l1.offlineShortGap(ctx({ harness, page }), "tap");
  operatorSamples.push(await sampleOperatorApp());
});
test("S-L1-14 (real, reply): a reply made while offline gets its answer card on return", covers("RTC-20, H-L1-07, T06, B23"), async ({ harness, page }) => l1.offlineShortGap(ctx({ harness, page }), "reply"));
test("S-L1-24 (real): unpairing stops control; re-pairing gets new cards but old buttons stay dead", covers("H-L1-15, B29, T31, T34"), async ({ harness, page }) => l1.unpairStopsControl(ctx({ harness, page }), () => pairThroughApi(harness.phone!)));
test("S-L1-28 (real), S-CLT-28: no token in DTOs, settings, operations, logs, database or the agent environment", covers("RTC-18, H-L1-02, H-L1-17, I10"), async ({ harness, page }) => l1.tokenNeverExposed(ctx({ harness, page })));
test("S-H6-19 (part 1): the operator's app kept polling its own bot through restarts and offline gaps", covers("H6-done, 6.2-telegram"), async ({ harness }) => {
  operatorSamples.push(await sampleOperatorApp());
  expect(coexistenceProblems(operatorSamples, harness.telegramIdentity().id)).toEqual([]);
  expect((await state.get<{ status: { actors: unknown[] } }>("/api/task-control/telegram")).status.actors.length).toBeGreaterThanOrEqual(1);
});
