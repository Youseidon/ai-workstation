import { expect, test } from "../../src/fixtures.ts";
import { eventually, observeQuietPeriod } from "../../src/drivers/state.ts";
import { coexistenceProblems, sampleOperatorApp, type OperatorSample } from "../../src/operatorApp.ts";
import * as live from "../../src/scenarios/l1Live.ts";
import { inboxDrained } from "../../src/scenarios/l1Flows.ts";
import { pairThroughApi, telegramStatus, waitForTelegramState } from "../../src/telegramFlows.ts";

// S-L1-17 and the real-backend halves of S-H6-13/14: the harness server loses its route to api.telegram.org
// while the operator's automated client stays connected. S-H6-19 samples the operator's app during the cut.
test.use({ harnessOptions: { fakeProvider: "live", telegram: { backend: "real" } } });
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ harness }) => pairThroughApi(harness.phone!));

const covers = (ids: string) => ({ annotation: { type: "covers", description: ids } });
const samples: Array<OperatorSample | null> = [];

test("S-H6-13/14 (real, refuse): backoff with a sanitized error, the phone keeps working, a message sent during the cut is processed once", covers("H6, 4.2-proxy, H-L1-11"), async ({ harness }) => {
  samples.push(await sampleOperatorApp());
  await waitForTelegramState("polling", 60_000);
  harness.network.cutTelegram("refuse");
  const cutAt = Date.now();
  const status = await eventually("the transport to back off", async () => {
    const current = await telegramStatus();
    return current.state === "backoff" ? current : undefined;
  }, 60_000);
  for (const form of [harness.telegramToken(), harness.telegramToken().split(":")[1]!]) expect(status.lastError ?? "").not.toContain(form);
  const text = `sent during the cut ${Date.now()}`;
  await harness.phone!.send(text);
  expect((await harness.phone!.messages()).some((message) => message.text === text)).toBe(true);
  samples.push(await sampleOperatorApp());
  expect(harness.telegramCalls().filter((call) => call.at >= cutAt && "outcome" in call && typeof call.outcome === "number")).toEqual([]);
  harness.network.restoreTelegram();
  await waitForTelegramState("polling", 120_000);
  await eventually("the message sent during the cut to reach the inbox", async () => harness.query<{ n: number }>("SELECT COUNT(*) n FROM telegram_inbox WHERE json_extract(payload_json, '$.text') = ?", text)[0]!.n === 1, 60_000);
  await inboxDrained(harness);
  await observeQuietPeriod(3_000, "a second inbox row for the same message");
  expect(harness.query<{ n: number }>("SELECT COUNT(*) n FROM telegram_inbox WHERE json_extract(payload_json, '$.text') = ?", text)[0]!.n).toBe(1);
});

test("S-H6-13 (real, hang): held requests are never forwarded; the server's own timeout moves it to backoff; restore resumes", covers("H6, 4.2-proxy"), async ({ harness }) => {
  await waitForTelegramState("polling", 60_000);
  harness.network.cutTelegram("hang");
  const cutAt = Date.now();
  await eventually("the transport to back off after its own timeout", async () => ((await telegramStatus()).state === "backoff" ? true : undefined), 90_000);
  expect(harness.telegramCalls().filter((call) => call.at >= cutAt && "outcome" in call && typeof call.outcome === "number")).toEqual([]);
  samples.push(await sampleOperatorApp());
  harness.network.restoreTelegram();
  await waitForTelegramState("polling", 120_000);
});

test("S-L1-17 (real): a task blocks during a one-minute cut; the card arrives once after restore and the tap applies once", covers("RTC-19, H-L1-11, T07"), async ({ harness, page }) => {
  await live.routeCutWhileQueued({ harness, page, phone: harness.phone! }, 60_000);
  samples.push(await sampleOperatorApp());
});

test("S-H6-19 (part 2): the operator's app kept polling its own bot before, during and after the cuts", covers("H6-done, 6.2-telegram, 11-interfere"), async ({ harness }) => {
  samples.push(await sampleOperatorApp());
  expect(coexistenceProblems(samples, harness.telegramIdentity().id)).toEqual([]);
});
