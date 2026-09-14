import { defineConfig } from "@playwright/test";

// Fixture specs that prove the harness toolchain can fail (H0 self-tests).
export default defineConfig({
  testDir: "fixtures",
  outputDir: process.env.SELFTEST_OUTPUT_DIR ?? "selftest-results",
  workers: 1,
  retries: 0,
  reporter: [["json", { outputFile: `${process.env.SELFTEST_OUTPUT_DIR ?? "selftest-results"}/report.json` }]],
  use: { browserName: "chromium", headless: true, trace: "retain-on-failure", screenshot: "only-on-failure" },
});
