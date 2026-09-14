import { test as base, expect, type ConsoleMessage, type Page, type Request } from "@playwright/test";
import { HarnessEnvironment, serverUrl, webUrl, type EnvironmentOptions } from "./env/orchestrator.ts";

/*
 * `harness` is one booted environment per spec file (worker scope, serial).
 * Every test copies logs and a database snapshot on failure, and the file's
 * environment runs the token sweep and real-state checks when it is disposed.
 */

export interface PageHealth {
  consoleErrors: string[];
  failedRequests: string[];
  apiOrigins: Set<string>;
}

type WorkerFixtures = { harness: HarnessEnvironment; harnessOptions: EnvironmentOptions };
type TestFixtures = { pageHealth: PageHealth; harnessArtifacts: void };

export const test = base.extend<TestFixtures, WorkerFixtures>({
  harnessOptions: [{}, { scope: "worker", option: true }],
  harness: [
    async ({ harnessOptions }, use, workerInfo) => {
      const environment = new HarnessEnvironment(harnessOptions);
      try {
        await environment.start();
        await use(environment);
      } finally {
        await environment.dispose([workerInfo.project.outputDir]);
      }
    },
    { scope: "worker", timeout: 10 * 60_000 },
  ],
  harnessArtifacts: [
    async ({ harness }, use, testInfo) => {
      await use();
      if (testInfo.status !== testInfo.expectedStatus) harness.collectArtifacts(testInfo.outputPath("harness"));
    },
    { auto: true },
  ],
  pageHealth: async ({ page }, use) => {
    const health: PageHealth = { consoleErrors: [], failedRequests: [], apiOrigins: new Set() };
    page.on("console", (message: ConsoleMessage) => {
      if (message.type() === "error") health.consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => health.consoleErrors.push(error.message));
    page.on("requestfailed", (request: Request) => health.failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`));
    page.on("request", (request: Request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/") || url.protocol.startsWith("ws")) health.apiOrigins.add(url.origin);
    });
    page.on("websocket", (socket) => health.apiOrigins.add(new URL(socket.url()).origin.replace(/^ws/, "http")));
    await use(health);
  },
});

export { expect, serverUrl, webUrl };

export async function openApp(page: Page, path = "/"): Promise<void> {
  await page.goto(`${webUrl}${path}`);
}
