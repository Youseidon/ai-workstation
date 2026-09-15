import { defineConfig } from "@playwright/test";
import { allowSlowConnects } from "./src/env/network.ts";

// The config loads in the runner and in every worker, so this covers the
// route proxy, preflight and phone driver talking to real Telegram (T3).
allowSlowConnects();

/*
 * Tiers from docs/e2e-harness-plan.md section 5. Each tier is a project so a
 * run selects exactly one: T1 fake Telegram and fake agent, T2 UI quality,
 * T3 real Telegram. Runs are serial: scenarios share one booted environment
 * per file and the machine budget allows one worker (section 6.1).
 */
export default defineConfig({
  testDir: "tests",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["json", { outputFile: "test-results/report.json" }]],
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "t1", testDir: "tests/t1" },
    { name: "t2", testDir: "tests/t2" },
    { name: "t3", testDir: "tests/t3", timeout: 30 * 60_000 },
  ],
});
