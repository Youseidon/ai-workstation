import { expect, openApp, test } from "../../src/fixtures.ts";

// Step 7a defect: the capability badge said "Telegram configured" from settings alone, with no token loaded.
test.use({ harnessOptions: { settings: { "taskControl.enabled": true, "taskControl.transport": "telegram", "taskControl.notificationsEnabled": true, "taskControl.remoteActionsEnabled": true } } });

test("without a bot token the Task Control badge and reason say so, matching the Live Telegram panel", async ({ page }) => {
  await openApp(page, "/agents");
  const section = page.locator("section").filter({ has: page.getByText("Task Control", { exact: true }) }).first();
  const panel = page.locator("div.rounded-md").filter({ has: page.getByRole("heading", { name: "Live Telegram", exact: true }) });
  await expect(panel.getByText("no token", { exact: true })).toBeVisible();
  await expect(section.getByText("Telegram configured", { exact: true })).toHaveCount(0);
  await expect(section.getByText("Telegram token missing", { exact: true })).toBeVisible();
  await expect(section.getByText("Set TELEGRAM_BOT_TOKEN in .env and restart the server.").first()).toBeVisible();
});
