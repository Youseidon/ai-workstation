// Run with HYDRA_PLAYWRIGHT_MODULE pointing to playwright-core if it is not installed locally.
// This builds the real page components against in-memory services; no Hydra server is started.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const fixture = path.join(root, "web/test/features/agents/browser/fixture.tsx");
const output = await mkdtemp(
  path.join(tmpdir(), "hydra-configuration-browser-"),
);
const playwright = await import(
  process.env.HYDRA_PLAYWRIGHT_MODULE
    ? pathToFileURL(process.env.HYDRA_PLAYWRIGHT_MODULE).href
    : "playwright-core"
);
const serviceExports = {
  "@/hooks/useHydra": "useFixtureHydra as useHydra",
  "@/contexts/hydra": "useFixtureHydra as useHydra",
  "@/contexts/fleetContext":
    "useFixtureFleet as useFleetConsole, useFixtureMetadata as useFleetMetadata",
  "@/contexts/workspaceContext": "useFixtureWorkspace as useWorkspace",
  "@/features/stop/components/StopCenter": "useFixtureStop as useStopCenter",
};
await build({
  define: {
    "process.env.NEXT_PUBLIC_AGENT_SERVER_URL": JSON.stringify(
      "https://hydra.fixture",
    ),
  },
  absWorkingDir: root,
  entryPoints: [fixture],
  bundle: true,
  outdir: output,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  tsconfig: path.join(root, "web/tsconfig.json"),
  plugins: [
    {
      name: "isolated-services",
      setup(builder) {
        builder.onResolve(
          { filter: /^(next\/(link|navigation)|@\/.*)$/ },
          (args) =>
            args.path in serviceExports ||
            args.path.startsWith("next/") ||
            args.path.endsWith("/DecisionDeck")
              ? { path: args.path, namespace: "fixture" }
              : undefined,
        );
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => {
          if (args.path in serviceExports)
            return {
              contents: `export { ${serviceExports[args.path]} } from ${JSON.stringify(fixture)};`,
              resolveDir: root,
            };
          if (args.path.endsWith("/DecisionDeck"))
            return {
              contents: "export function DecisionDeck() { return null; }",
            };
          if (args.path === "next/link")
            return {
              contents: `import { createElement } from 'react'; export default function Link({href,onClick,children,scroll,prefetch,...props}) {return createElement('a',{...props,href,onClick:event=>{onClick?.(event);if(!event.defaultPrevented && href.startsWith('/agents')){event.preventDefault();history.pushState({},'',href);window.dispatchEvent(new Event('popstate'));}}},children);}`,
              resolveDir: root,
            };
          return {
            contents: `import {useSyncExternalStore} from 'react'; const subscribe=f=>{window.addEventListener('popstate',f);return()=>window.removeEventListener('popstate',f)}; export function useSearchParams(){const query=useSyncExternalStore(subscribe,()=>location.search);return new URLSearchParams(query)}; const router={replace(url){history.replaceState({},'',url);window.dispatchEvent(new Event('popstate'));}}; export function useRouter(){return router;}`,
            resolveDir: root,
          };
        });
      },
    },
  ],
});
const css = await postcss([tailwind({ base: root })]).process(
  await readFile(path.join(root, "web/app/globals.css"), "utf8"),
  { from: path.join(root, "web/app/globals.css") },
);
await writeFile(
  path.join(output, "global.css"),
  css.css +
    "\n:root{--font-geist-sans:Arial;--font-geist-mono:monospace;font-family:Arial,sans-serif}\n@media(max-width:760px){#fixture-sidebar{display:none}}\n",
);
await writeFile(
  path.join(output, "index.html"),
  '<!doctype html><html data-theme="midnight"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/global.css"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
);
const url = "https://hydra.fixture/agents?view=configuration";
console.log("Fixture compiled:", output);
const browser = await playwright.chromium.launch({
  headless: true,
  executablePath: process.env.HYDRA_CHROMIUM_PATH,
  args: ["--no-sandbox"],
});
console.log("Chromium launched");
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.route("**/*", async (route) => {
  const requested = new URL(route.request().url());
  if (requested.origin !== "https://hydra.fixture") return route.abort();
  const name = requested.pathname;
  const target =
    name === "/" || name === "/agents" ? "index.html" : path.basename(name);
  try {
    const body = await readFile(path.join(output, target));
    await route.fulfill({
      body,
      contentType: target.endsWith(".css")
        ? "text/css"
        : target.endsWith(".js")
          ? "text/javascript"
          : "text/html",
    });
  } catch {
    await route.fulfill({ status: 404, body: "Fixture resource not found" });
  }
});
page.setDefaultTimeout(10000);
page.setDefaultNavigationTimeout(15000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (
    message.type() === "error" &&
    !message.text().includes("404") &&
    !message.text().includes("ERR_NAME_NOT_RESOLVED")
  )
    errors.push(message.text());
});
const shown = async (locator) => {
  await locator.waitFor({ state: "visible" });
};
const close = async () => {
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
};
const configure = async (label) => {
  await page
    .getByRole("button", { name: `Configure ${label}`, exact: true })
    .click();
  await shown(page.getByRole("dialog"));
};
const call = async (fn, argument) =>
  page.evaluate(
    ([name, arg]) => window.hydraFixture[name](arg),
    [fn, argument],
  );
const row = (id) => page.locator(`#agent-${id}`);
try {
  console.log("Opening fixture");
  await page.goto(url);
  console.log("Fixture loaded");
  await shown(page.getByRole("switch", { name: "Enable Codex CLI" }));
  await page.waitForFunction(
    () =>
      !document.querySelector('button[aria-label="Enable Codex CLI"]').disabled,
  );
  const first = await row("claude").boundingBox();
  assert(first.y < 330, `Configuration starts at ${first.y}px`);
  assert(
    first.height >= 64 && first.height <= 96,
    `Provider row is ${first.height}px`,
  );
  assert.equal(await page.locator('li[id^="agent-"]').count(), 6);
  console.log("Initial geometry", first);
  for (const label of [
    "Runtime",
    "Run budgets",
    "Resource containment",
    "Pipeline policy",
    "Retention",
    "Future scheduling",
  ])
    await shown(
      page
        .getByRole("region", { name: "Shared settings", exact: true })
        .getByRole("button", { name: new RegExp(label) })
        .last(),
    );
  await page.screenshot({
    path: path.join(output, "desktop-dark.png"),
    fullPage: true,
    animations: "disabled",
  });

  const ids = ["claude", "codex", "cursor", "grok", "copilot", "kilocode"];
  for (const id of ids)
    for (const state of ["available", "unavailable", "disabled", "busy"]) {
      await page.evaluate(
        ([id, state]) => window.hydraFixture.setState(id, state),
        [id, state],
      );
      await shown(
        row(id).getByText(
          state === "disabled"
            ? "Not eligible · disabled"
            : state === "unavailable"
              ? "Unavailable"
              : "Available",
          { exact: true },
        ),
      );
      assert.equal(
        await row(id).getByRole("switch").getAttribute("aria-checked"),
        state === "disabled" ? "false" : "true",
      );
      if (state === "busy")
        await shown(row(id).getByRole("link", { name: /1 active/ }));
    }
  for (const id of ids)
    await page.evaluate(
      (id) => window.hydraFixture.setState(id, "available"),
      id,
    );

  // Active work keeps its server clock, transcript destination and mocked stop entry points.
  await page.evaluate(() => window.hydraFixture.setState("codex", "busy"));
  await configure("Codex CLI");
  await page
    .getByRole("button", { name: "Active work · 1", exact: true })
    .click();
  await shown(page.getByText("Fixture workspace", { exact: true }));
  assert.equal(
    await page
      .getByRole("link", { name: "View run & transcript →", exact: true })
      .getAttribute("href"),
    "/?workspace=1&thread=fixture-thread",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Stop", exact: true })
    .click();
  assert.equal(
    await page.evaluate(() => window.hydraFixture.requests.at(-1).url),
    "fixture-stop",
  );
  await page
    .getByRole("button", { name: "Usage & maintenance", exact: true })
    .click();
  assert(
    await page
      .getByRole("button", { name: "Update CLI", exact: true })
      .isDisabled(),
  );
  await close();
  await page.evaluate(() => window.hydraFixture.setState("claude", "busy"));
  await configure("Claude Code");
  await page
    .getByRole("button", { name: "Active work · 1", exact: true })
    .click();
  await shown(
    page.getByRole("heading", { name: "Active consults", exact: true }),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Stop", exact: true })
    .click();
  assert.equal(
    await page.evaluate(() => window.hydraFixture.requests.at(-1).body.runId),
    "fixture-claude-consult",
  );
  await close();
  for (const id of ["claude", "codex"])
    await page.evaluate(
      (id) => window.hydraFixture.setState(id, "available"),
      id,
    );
  await page.evaluate(() => window.hydraFixture.pin("codex", "codex-frontier"));
  await page.getByRole("radio", { name: "Auto Select", exact: true }).click();
  await shown(row("codex").getByText(/Saved pin inactive/));
  await configure("Codex CLI");
  await shown(
    page.getByText("Preserved · inactive under current policy or effort", {
      exact: true,
    }),
  );
  await page
    .locator("summary")
    .filter({ hasText: "Change browser model" })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "codex-frontier · recommended" })
      .count(),
    0,
  );
  await close();
  await page.getByRole("radio", { name: "Manual", exact: true }).click();
  await shown(row("codex").getByText("Browser pin", { exact: true }));
  await page
    .getByLabel("Access tier", { exact: true })
    .selectOption("efficient");
  await shown(row("codex").getByText("codex-efficient", { exact: true }));
  await configure("Codex CLI");
  await shown(page.getByText("Saved provider default", { exact: true }));
  await shown(
    page.getByText("Preserved · inactive under current policy", {
      exact: true,
    }),
  );
  await page
    .locator("summary")
    .filter({ hasText: "Change browser model" })
    .click();
  assert.equal(await page.getByLabel("Custom model id").count(), 0);
  await close();
  await page.getByLabel("Access tier", { exact: true }).selectOption("all");
  await shown(row("codex").getByText("codex-frontier", { exact: true }));
  await page.getByRole("radio", { name: "High", exact: true }).click();
  await shown(row("cursor").getByText("cursor-frontier-high", { exact: true }));

  await configure("Codex CLI");
  const model = page.getByLabel("Model", { exact: true });
  await model.fill("codex-custom-draft");
  await page.getByLabel("Switch provider").selectOption("cursor");
  await page
    .getByRole("dialog")
    .getByRole("radio", { name: "Low", exact: true })
    .click();
  await page.getByRole("button", { name: "Save 1", exact: true }).click();
  await shown(page.getByText(/Saved 1 setting/));
  await page.getByLabel("Switch provider").selectOption("codex");
  assert.equal(await model.inputValue(), "codex-custom-draft");
  await close();
  await shown(row("codex").getByText("1 unsaved", { exact: true }));
  await shown(row("cursor").getByText(/low effort · override/));
  await configure("Codex CLI");
  assert.equal(await model.inputValue(), "codex-custom-draft");
  await page
    .getByRole("button", { name: "Discard edits", exact: true })
    .click();
  assert.equal(await model.inputValue(), "codex-frontier");
  await model.fill("codex-saved");
  await call("fail", "save");
  await page.getByRole("button", { name: "Save 1", exact: true }).click();
  await shown(
    page.getByRole("alert").filter({ hasText: "Fixture validation" }),
  );
  assert.equal(await model.inputValue(), "codex-saved");
  await page.getByRole("button", { name: "Save 1", exact: true }).click();
  await shown(page.getByText(/Saved 1 setting/));
  const apiKey = page.getByLabel("API key", { exact: true });
  assert.equal(await apiKey.inputValue(), "");
  assert.equal(await apiKey.getAttribute("type"), "password");
  await apiKey.fill("fixture-replacement-secret");
  await page.getByRole("button", { name: "Save 1", exact: true }).click();
  await page.waitForFunction(
    () => document.getElementById("codex.apiKey").value === "",
  );

  // A save response cannot erase a newer draft entered after closing and reopening.
  await call("delayMutation", 700);
  await model.fill("codex-race-saved");
  await page.getByRole("button", { name: "Save 1", exact: true }).click();
  await shown(page.getByRole("status").filter({ hasText: "Saving…" }));
  await close();
  await configure("Codex CLI");
  await model.fill("newer-edit");
  await page.waitForFunction(
    () =>
      window.hydraFixture
        .snapshot()
        .fields.find((field) => field.key === "codex.model").value ===
      "codex-race-saved",
  );
  assert.equal(await model.inputValue(), "newer-edit");
  await shown(page.getByRole("button", { name: "Save 1", exact: true }));
  await page
    .getByRole("button", { name: "Discard edits", exact: true })
    .click();
  assert.equal(await model.inputValue(), "codex-race-saved");
  await call("delayMutation", 0);
  const reset = model
    .locator("xpath=../..")
    .getByRole("button", { name: "reset saved", exact: true });
  await call("fail", "reset");
  await reset.click();
  await shown(
    page.getByRole("alert").filter({ hasText: "Fixture validation" }),
  );
  assert.equal(await model.inputValue(), "codex-race-saved");
  await reset.click();
  await shown(page.getByText(/Reset Model to its inherited value/));
  assert.equal(await model.inputValue(), "");
  await page.getByRole("radio", { name: "Full access", exact: true }).click();
  await shown(page.getByText(/⚠ Removes the OS sandbox/));
  const before = await page.evaluate(
    () =>
      window.hydraFixture.requests.filter((request) => request.method === "PUT")
        .length,
  );
  await page.getByRole("button", { name: "Save 1", exact: true }).click();
  await shown(
    page.getByRole("dialog", {
      name: "This turns off a sandbox or permission check",
      exact: true,
    }),
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.hydraFixture.requests.filter(
          (request) => request.method === "PUT",
        ).length,
    ),
    before,
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Save 1", exact: true }).click();
  await page.getByRole("button", { name: "Save anyway", exact: true }).click();
  await shown(page.getByText(/Saved 1 setting/));
  await close();

  await page
    .getByRole("region", { name: "Shared settings", exact: true })
    .getByRole("button", { name: /Run budgets/ })
    .last()
    .click();
  const calls = page.locator('input[id="budget.maxCalls"]');
  await calls.fill("200");
  await close();
  await page
    .getByRole("region", { name: "Shared settings", exact: true })
    .getByRole("button", { name: /Run budgets/ })
    .last()
    .click();
  assert.equal(await calls.inputValue(), "200");
  await page
    .getByRole("button", { name: "Discard edits", exact: true })
    .click();
  assert.equal(await calls.inputValue(), "120");
  await close();
  await page
    .getByRole("region", { name: "Shared settings", exact: true })
    .getByRole("button", { name: /Runtime/ })
    .last()
    .click();
  await page.getByRole("switch", { name: "Host access (Docker)" }).click();
  await shown(page.getByText(/⚠ Removes provider sandboxes/));
  await page.getByRole("button", { name: "Save 1", exact: true }).click();
  await shown(
    page.getByRole("dialog", {
      name: "This turns off a sandbox or permission check",
      exact: true,
    }),
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Discard edits", exact: true })
    .click();
  await close();

  await row("codex")
    .getByRole("button", { name: /usage windows/ })
    .click();
  await shown(page.getByText("5h", { exact: true }));
  await shown(page.getByText("weekly", { exact: true }));
  await shown(page.getByText("0%", { exact: true }));
  await shown(page.getByText("72%", { exact: true }));
  await shown(page.getByText(/credits · \$0.00 left/));
  await call("fail", "usage");
  await page
    .getByRole("button", { name: "Refresh usage", exact: true })
    .click();
  await shown(page.getByText("Usage stale · refresh failed", { exact: true }));
  await page
    .getByRole("button", { name: "Refresh usage", exact: true })
    .click();
  await shown(page.getByText("2 usage windows", { exact: true }).last());
  // Samples remain separate; unknown or stale telemetry never becomes reported zero.
  const refreshUsage = () =>
    page.getByRole("button", { name: "Refresh usage", exact: true }).click();
  await page.evaluate(() => window.hydraFixture.setUsage([]));
  await refreshUsage();
  await shown(
    page.getByRole("dialog").getByText("Usage not reported", { exact: true }),
  );
  await page.evaluate(() =>
    window.hydraFixture.setUsage([
      {
        provider: "codex",
        available: false,
        reason: "Fixture telemetry unavailable",
        fetchedAt: null,
        plan: null,
        windows: [],
        credits: null,
      },
    ]),
  );
  await refreshUsage();
  await shown(
    page.getByRole("dialog").getByText("Usage unavailable", { exact: true }),
  );
  await shown(page.getByText("Fixture telemetry unavailable", { exact: true }));
  await page.evaluate(() =>
    window.hydraFixture.setUsage([
      {
        provider: "codex",
        available: true,
        reason: null,
        fetchedAt: new Date(Date.now() - 600_000).toISOString(),
        plan: null,
        windows: [
          {
            kind: "weekly",
            usedPercent: 0,
            resetsAt: null,
            durationMinutes: null,
          },
        ],
        credits: null,
      },
    ]),
  );
  await refreshUsage();
  await shown(
    page.getByRole("dialog").getByText("Usage stale", { exact: true }),
  );
  await page.evaluate(() =>
    window.hydraFixture.setUsage([
      {
        provider: "codex",
        available: true,
        reason: null,
        fetchedAt: new Date().toISOString(),
        plan: null,
        windows: [
          {
            kind: "weekly",
            usedPercent: 100,
            resetsAt: null,
            durationMinutes: null,
          },
        ],
        credits: null,
      },
    ]),
  );
  await refreshUsage();
  await shown(
    page.getByRole("dialog").getByText("Quota reached", { exact: true }),
  );
  await call("delayUsage", 350);
  await refreshUsage();
  await shown(
    page.getByRole("dialog").getByText("Refreshing usage…", { exact: true }),
  );
  await shown(
    page.getByRole("dialog").getByText("Quota reached", { exact: true }),
  );
  await call("delayUsage", 0);
  await page.getByRole("button", { name: "Update CLI", exact: true }).click();
  await shown(page.getByText(/Codex CLI updated/).last());
  await close();

  await configure("Codex CLI");
  await model.fill("retained-across-fleet");
  await close();
  await page
    .getByRole("link", { name: /Live fleet/ })
    .first()
    .click();
  await shown(page.getByRole("heading", { name: "Agent constellation" }));
  await page
    .getByRole("link", { name: /Configuration/ })
    .first()
    .click();
  await configure("Codex CLI");
  assert.equal(await model.inputValue(), "retained-across-fleet");
  await page
    .getByRole("button", { name: "Discard edits", exact: true })
    .click();
  await close();
  await page.evaluate(() => window.hydraFixture.setConnection("disconnected"));
  await shown(page.getByRole("alert").filter({ hasText: "Reconnecting" }));
  assert(
    await page.getByRole("switch", { name: "Enable Codex CLI" }).isDisabled(),
  );
  await configure("Codex CLI");
  assert(await model.isDisabled());
  await close();
  await call("setConnection", "open");

  // Live deep links still land on the requested provider row.
  await page.goto(url + "#agent-codex");
  await shown(row("codex"));
  await configure("Codex CLI");
  await page.keyboard.press("Escape");
  assert.equal(
    await page
      .getByRole("button", { name: "Configure Codex CLI", exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.getByRole("radio", { name: "Auto Select", exact: true }).click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('[role="radio"]')).some(
      (element) =>
        element.textContent.trim() === "Auto Select" &&
        element.getAttribute("aria-checked") === "true",
    ),
  );
  await page.getByRole("radio", { name: "Auto Select", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('[role="radio"]')).some(
      (element) =>
        element.textContent.trim() === "Manual" &&
        element.getAttribute("aria-checked") === "true",
    ),
  );
  assert.equal(
    await page
      .getByRole("radio", { name: "Manual", exact: true })
      .getAttribute("aria-checked"),
    "true",
  );

  await page
    .locator("summary")
    .filter({ hasText: "Policy & tier guide" })
    .click();
  for (const tier of [
    "Free",
    "Efficient",
    "Professional",
    "Frontier",
    "All models",
  ])
    await shown(page.locator("dt").filter({ hasText: tier }).last());
  await page
    .locator("summary")
    .filter({ hasText: "Policy & tier guide" })
    .click();
  await configure("Codex CLI");
  await page
    .getByRole("button", { name: "Close · keep drafts", exact: true })
    .focus();
  await page.keyboard.press("Tab");
  assert(
    await page
      .getByRole("dialog")
      .evaluate((element) => element.contains(document.activeElement)),
  );
  await close();
  await page.goto(url + "&fixtureSettings=slow");
  await shown(
    page.getByText("Waiting for saved model policy…", { exact: true }),
  );
  await page.waitForFunction(
    () =>
      !document.querySelector('button[aria-label="Enable Codex CLI"]').disabled,
  );
  await page.goto(url + "&fixtureSettings=failed");
  await shown(
    page.getByRole("alert").filter({ hasText: "settings request failed" }),
  );
  assert(
    await page.getByRole("switch", { name: "Enable Codex CLI" }).isDisabled(),
  );
  await page
    .getByRole("button", { name: "Retry settings", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      !document.querySelector('button[aria-label="Enable Codex CLI"]').disabled,
  );
  await page.locator("summary").filter({ hasText: "Maintenance" }).click();
  await call("fail", "detect");
  await page.getByRole("button", { name: "Re-detect", exact: true }).click();
  await shown(
    page.getByRole("alert").filter({ hasText: "Provider detection failed" }),
  );
  await shown(row("codex").getByText("Last known", { exact: true }));
  await page.getByRole("button", { name: "Re-detect", exact: true }).click();
  await shown(page.getByText("Provider detection refreshed.", { exact: true }));
  await page.locator("summary").filter({ hasText: "Maintenance" }).click();
  console.log(
    "Model policy, provider states, drafts, mutations, usage, maintenance and keyboard checks passed",
  );
  const darkSurface = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--surface-0"),
  );
  await page.evaluate(
    () => (document.documentElement.dataset.theme = "daylight"),
  );
  assert.notEqual(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue(
        "--surface-0",
      ),
    ),
    darkSurface,
  );
  await page.screenshot({
    path: path.join(output, "desktop-light.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 820, height: 1000 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({
    path: path.join(output, "tablet.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(
    () => (document.documentElement.dataset.theme = "midnight"),
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({
    path: path.join(output, "mobile-dark.png"),
    fullPage: true,
    animations: "disabled",
  });
  await configure("Codex CLI");
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({
    path: path.join(output, "mobile-editor.png"),
    fullPage: true,
    animations: "disabled",
  });
  assert.deepEqual(errors, []);
  console.log(
    `Browser checks passed. First provider y=${first.y}px, height=${first.height}px. Screenshots: ${output}`,
  );
} catch (error) {
  console.error("Browser errors:", errors);
  await page.screenshot({
    path: path.join(output, "failure.png"),
    fullPage: true,
    animations: "disabled",
  });
  throw error;
} finally {
  await browser.close();
}
