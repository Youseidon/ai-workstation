import { expect, openApp, test } from "../../src/fixtures.ts";
import { ApiError, eventually, observeQuietPeriod, state } from "../../src/drivers/state.ts";
import { telegramStatus, waitForTelegramState } from "../../src/telegramFlows.ts";

// S-L1-01 and S-L1-02. Task control starts disabled although a token and a fake Telegram exist.
test.use({
  harnessOptions: {
    telegram: { backend: "fake" },
    settings: { "taskControl.enabled": false },
    // No poll override: the production 25s window (S-L1-02).
    serverEnv: { AGENT_CONSOLE_HARNESS_TELEGRAM_POLL_TIMEOUT_SECONDS: "" },
  },
});
test.describe.configure({ mode: "serial" });

test("S-L1-01: disabled or fake transport makes no Bot API call and refuses pairing; saving on and off starts and stops polling", { annotation: { type: "covers", description: "RTC-19, H-L1-01, B01" } }, async ({ harness, page }) => {
  const server = harness.telegramServer!;
  await observeQuietPeriod(3_000, "any Bot API call while task control is disabled");
  expect(server.calls).toEqual([]);
  expect((await telegramStatus()).state).toBe("disabled");
  const refused = await state.post("/api/task-control/telegram/pairing").then(() => null, (error: ApiError) => error);
  expect(refused?.status).toBe(409);
  await openApp(page, "/agents");
  await expect(page.getByRole("button", { name: /Pair (a|another) phone/ })).toHaveCount(0);

  await state.updateSettings({ "taskControl.enabled": true, "taskControl.transport": "fake_telegram" });
  await observeQuietPeriod(3_000, "any Bot API call with the fake transport selected");
  expect(server.calls).toEqual([]);

  await state.updateSettings({ "taskControl.transport": "telegram" });
  await waitForTelegramState("polling");
  expect(server.calls.map((call) => call.method)).toContain("getUpdates");

  await state.updateSettings({ "taskControl.enabled": false });
  await eventually("the live transport to stop", async () => ((await telegramStatus()).state === "disabled" ? true : undefined));
  const stoppedAt = server.calls.length;
  await observeQuietPeriod(3_000, "Bot API calls after task control was turned off");
  expect(server.calls.length).toBe(stoppedAt);
});

test("S-L1-02: connecting reaches polling with the bot identity and the production 25s window", { annotation: { type: "covers", description: "RTC-17, RTC-19, H-L1-03" } }, async ({ harness, page }) => {
  await state.updateSettings({ "taskControl.enabled": true, "taskControl.transport": "telegram" });
  const status = await waitForTelegramState("polling");
  expect(status.bot).toEqual({ id: String(harness.telegramBot!.id), username: harness.telegramBot!.username });
  expect(status.reason).toBe("Long polling Telegram (25s window).");
  const poll = harness.telegramServer!.calls.filter((call) => call.method === "getUpdates").at(-1)!;
  expect(poll.body.timeout).toBe(25);
  await openApp(page, "/agents");
  const panel = page.locator("div.rounded-md").filter({ has: page.getByRole("heading", { name: "Live Telegram", exact: true }) });
  await expect(panel.getByText("connected", { exact: true })).toBeVisible();
  await expect(panel.getByText(`@${harness.telegramBot!.username}`)).toBeVisible();
  await state.updateSettings({ "taskControl.enabled": false });
});
