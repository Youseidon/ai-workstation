import { expect, test } from "../../src/fixtures.ts";
import { ApiError, eventually, observeQuietPeriod, state } from "../../src/drivers/state.ts";
import { telegramStatus } from "../../src/telegramFlows.ts";

// S-H6-18 on the fake backend: a bot that is not the registered test bot is refused by id before any poll.
const REGISTERED_TEST_BOT = "700999001";
test.use({ harnessOptions: { telegram: { backend: "fake" }, serverEnv: { AGENT_CONSOLE_HARNESS_TEST_BOT_IDS: REGISTERED_TEST_BOT } } });

test("S-H6-18 (fake): an unregistered bot is refused before getUpdates or sendMessage and its updates stay pending", { annotation: { type: "covers", description: "4.1-guard, H6" } }, async ({ harness }) => {
  const server = harness.telegramServer!;
  const bot = harness.telegramBot!;
  expect(String(bot.id)).not.toBe(REGISTERED_TEST_BOT);
  const status = await eventually("the guard to refuse the bot", async () => {
    const current = await telegramStatus();
    return current.state === "auth_failed" ? current : undefined;
  });
  expect(status.reason).toContain(`Harness mode refuses bot ${bot.id}: it is not the registered test bot.`);
  expect(status.reason).not.toContain(bot.token);
  expect(status.reason).not.toContain(bot.token.split(":")[1]!);
  await harness.phone!.send("/start any-code");
  await observeQuietPeriod(3_000, "the refused server polling or sending");
  const methods = server.calls.map((call) => call.method);
  expect(methods).toContain("getMe");
  expect(methods).not.toContain("getUpdates");
  expect(methods).not.toContain("sendMessage");
  expect(server.pendingUpdateCount(bot.id)).toBe(1);
  const refused = await state.post("/api/task-control/telegram/pairing").then(() => null, (error: ApiError) => error);
  expect(refused?.status).toBe(409);
  expect(harness.query<{ n: number }>("SELECT COUNT(*) n FROM telegram_inbox")[0]!.n).toBe(0);
});
