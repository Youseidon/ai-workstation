import { expect, test } from "@playwright/test";

test("forced failure leaves artifacts", async ({ page }) => {
  await page.setContent("<p>before failure</p>");
  expect(await page.textContent("p")).toBe("this assertion fails on purpose");
});
