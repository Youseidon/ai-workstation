import { expect, test } from "../../src/fixtures.ts";
import { eventually, observeQuietPeriod } from "../../src/drivers/state.ts";
import * as live from "../../src/scenarios/l1Live.ts";
import { inboxDrained } from "../../src/scenarios/l1Flows.ts";
import { pairThroughApi, telegramStatus, waitForTelegramState } from "../../src/telegramFlows.ts";

// Scenario IDs refer to docs/e2e-scenarios/h6.md and l1.md. The route proxy on the fake backend: the same
// cut the T3 run uses, so its app-level behaviour is proven without credentials.
test.use({ harnessOptions: { fakeProvider: "live", telegram: { backend: "fake", proxy: true } } });
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ harness }) => pairThroughApi(harness.phone!));

const covers = (ids: string) => ({ annotation: { type: "covers", description: ids } });

test("S-H6-13/14 (refuse, fake): the server backs off with a sanitized error, the phone keeps working, and a message sent during the cut is processed once", covers("H6, 4.2-proxy, H-L1-11"), async ({ harness }) => {
  const server = harness.telegramServer!;
  const bot = harness.telegramBot!;
  await waitForTelegramState("polling");
  harness.network.cutTelegram("refuse");
  const cutAt = Date.now();
  const status = await eventually("the transport to back off", async () => {
    const current = await telegramStatus();
    return current.state === "backoff" ? current : undefined;
  }, 30_000);
  expect(status.lastError ?? "").not.toContain(harness.telegramToken());
  expect(status.lastError ?? "").not.toContain(harness.telegramToken().split(":")[1]!);
  const upstreamCalls = server.calls.length;
  await harness.phone!.send("sent while the workstation is cut off");
  expect((await harness.phone!.messages()).at(-1)?.text).toBe("sent while the workstation is cut off");
  await observeQuietPeriod(2_000, "an upstream call while the route is cut");
  expect(server.calls.length).toBe(upstreamCalls);
  expect(server.pendingUpdateCount(bot.id)).toBe(1);
  expect(harness.telegramCalls().filter((call) => call.at >= cutAt && "outcome" in call && typeof call.outcome === "number")).toEqual([]);

  harness.network.restoreTelegram();
  await waitForTelegramState("polling", 90_000);
  await inboxDrained(harness);
  const rows = harness.query<{ n: number }>("SELECT COUNT(*) n FROM telegram_inbox WHERE json_extract(payload_json, '$.text') = ?", "sent while the workstation is cut off");
  expect(rows[0]!.n).toBe(1);
  await eventually("the upstream update queue to drain", async () => server.pendingUpdateCount(bot.id) === 0 || undefined);
});

test("S-H6-13 (hang, fake): requests are held and never forwarded until the client times out; restore resumes polling", covers("H6, 4.2-proxy"), async ({ harness }) => {
  const server = harness.telegramServer!;
  await waitForTelegramState("polling");
  harness.network.cutTelegram("hang");
  const upstreamCalls = server.calls.length;
  const status = await eventually("the transport to back off after its own timeout", async () => {
    const current = await telegramStatus();
    return current.state === "backoff" ? current : undefined;
  }, 60_000);
  expect(status.lastError ?? "").not.toContain(harness.telegramToken());
  expect(server.calls.length).toBe(upstreamCalls);
  expect(harness.telegramCalls().some((call) => "outcome" in call && call.outcome === "hang")).toBe(true);
  harness.network.restoreTelegram();
  await waitForTelegramState("polling", 90_000);
  expect(server.calls.length).toBeGreaterThan(upstreamCalls);
});

test("S-L1-17 (fake backend): a task that blocks while the route is cut gets its card once after restore and the tap applies once", covers("RTC-19, H-L1-11, T07"), async ({ harness, page }) => {
  await waitForTelegramState("polling");
  await live.routeCutWhileQueued({ harness, page, phone: harness.phone! }, 5_000);
});
