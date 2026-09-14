import { expect, openApp, test } from "../../src/fixtures.ts";

// Operator decision 2026-09-14 (Telegram plan step 7a): the Live Telegram panel appears as soon as the
// transport is Telegram, instead of only after task control is enabled and saved.

test("the Live Telegram panel appears when Telegram is chosen, before saving, with clear status", async ({ page, pageHealth }) => {
  await openApp(page, "/agents");
  const transport = page.locator("select").filter({ has: page.locator('option[value="telegram"]') });
  await expect(transport).toHaveValue("fake_telegram");
  await expect(page.getByRole("heading", { name: "Live Telegram", exact: true })).toHaveCount(0);

  await transport.selectOption("telegram");
  const heading = page.getByRole("heading", { name: "Live Telegram", exact: true });
  await expect(heading).toBeVisible();
  const panel = page.locator("div.rounded-md").filter({ has: heading });
  await expect(panel.getByText("Save the Task Control changes above to apply them.")).toBeVisible();
  await expect(panel.getByText("Telegram task control is disabled.")).toBeVisible();
  await panel.screenshot({ path: test.info().outputPath("panel-unsaved.png") });

  await page.getByRole("button", { name: /^Discard$/ }).click();
  await expect(heading).toHaveCount(0);
  expect(pageHealth.consoleErrors).toEqual([]);
});
