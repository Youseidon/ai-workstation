import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, openApp, serverUrl, test, webUrl } from "../../src/fixtures.ts";
import { isPortOpen } from "../../src/env/processes.ts";
import { WEB_DIST_DIR } from "../../src/env/webBuild.ts";
import { repoRoot } from "../../src/realState.ts";

// Scenario IDs refer to docs/e2e-scenarios/h0-h4.md.

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

test("S-H1-01: the app boots on an empty root and the home page renders cleanly against 4100", async ({ harness, page, pageHealth }) => {
  expect(harness.root).toContain("ai-workstation-e2e-");
  await openApp(page);
  await expect(page.getByRole("link", { name: "Tasks" }).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: test.info().outputPath("home.png"), fullPage: true });
  expect(pageHealth.consoleErrors).toEqual([]);
  expect(pageHealth.failedRequests).toEqual([]);
  expect([...pageHealth.apiOrigins]).toEqual([serverUrl]);
});

test("S-H1-05/06: no operator secret or repository .env reaches the harness processes or bundle", async ({ harness }) => {
  for (const pid of [harness.server.pid, harness.web.pid]) {
    const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    expect(environ.some((entry) => entry.startsWith("TELEGRAM_BOT_TOKEN="))).toBe(false);
    expect(environ).toContain("AGENT_CONSOLE_HARNESS=1");
  }
  const serverEnv = readFileSync(`/proc/${harness.server.pid}/environ`, "utf8").split("\0");
  expect(serverEnv).toContain(`AGENT_CONSOLE_REPO_ROOT=${harness.root}`);
  const bundle = join(repoRoot, "web", WEB_DIST_DIR, "static");
  const served = listFiles(bundle).filter((file) => file.endsWith(".js")).map((file) => readFileSync(file, "utf8")).join("\n");
  expect(served).toContain("http://127.0.0.1:4100");
  expect(served).not.toContain("http://127.0.0.1:4000");
});

test("S-H1-12: restart and stop use the real process lifecycle and keep durable state", async ({ harness }) => {
  const created = await fetch(`${serverUrl}/api/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: webUrl },
    body: JSON.stringify({ name: "lifecycle", description: "", workDirectory: harness.createGitWorkspace("lifecycle") }),
  });
  expect(created.ok).toBe(true);
  const firstPid = harness.server.pid;
  await harness.restartServer();
  expect(harness.server.pid).not.toBe(firstPid);
  const list = (await (await fetch(`${serverUrl}/api/workspaces`)).json()) as { workspaces?: Array<{ name: string }> } | Array<{ name: string }>;
  const names = (Array.isArray(list) ? list : list.workspaces ?? []).map((workspace) => workspace.name);
  expect(names).toContain("lifecycle");
  await harness.stopServer();
  expect(await isPortOpen(4100)).toBe(false);
  await harness.startServer();
  expect((await fetch(`${serverUrl}/api/health`)).ok).toBe(true);
});
