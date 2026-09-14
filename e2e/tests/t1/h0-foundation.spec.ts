import { expect, test } from "@playwright/test";

// S-H0: the toolchain itself works: Playwright Test runs and drives Chromium.
test("Playwright drives headless Chromium", async ({ page }) => {
  await page.setContent("<main><h1>harness</h1></main>");
  await expect(page.getByRole("heading", { name: "harness" })).toBeVisible();
});
