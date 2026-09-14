import { expect, openApp, test } from "../../src/fixtures.ts";

// Boots a real harness environment and fails on purpose (S-H1-11).
test("harness forced failure collects artifacts", async ({ page }) => {
  await openApp(page);
  expect(await page.title()).toBe("this assertion fails on purpose");
});
