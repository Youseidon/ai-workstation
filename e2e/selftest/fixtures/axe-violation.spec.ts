import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("axe reports a known violation", async ({ page }) => {
  await page.setContent(`<html lang="en"><head><title>axe</title></head><body><main><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" /></main></body></html>`);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((violation) => violation.id)).toContain("image-alt");
});
