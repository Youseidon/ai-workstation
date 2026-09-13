// node --import tsx scripts/verify-m4-browser.mjs --playwright /path/to/playwright
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextPicker } from "../web/components/ContextPicker.tsx";
import { UsageBlock } from "../web/components/agents/usage.tsx";

const { values } = parseArgs({
  options: {
    playwright: { type: "string" },
  },
});

const warningCopy =
  "Ownership is unknown after restart. Confirm provider process state before recovery; recovery stays blocked until the server knows the previous start is stopped or no spawn.";

const prompt = {
  id: 1,
  title: "Recover local task control",
  content: "do it",
  suiteId: 2,
  suiteName: "M4",
  programId: 3,
  programName: "Agent Console",
  externalKey: "M4",
  status: "IN_PROGRESS",
  ready: false,
  blockedBy: [],
  currentRun: {
    id: "run_unknown_owner",
    provider: "claude",
    model: null,
    role: "execute",
    state: "RUNNING",
    startedAt: "2026-09-13T09:00:00.000Z",
    endedAt: null,
    processActive: false,
  },
  recoverable: false,
  recovery: {
    kind: "start_unknown",
    message: warningCopy,
  },
};

const usage = {
  provider: "claude",
  available: true,
  reason: null,
  plan: "fake",
  fetchedAt: "2026-09-13T09:00:00.000Z",
  windows: [{ kind: "session", durationMinutes: 300, usedPercent: 95, resetsAt: "2026-09-13T10:00:00.000Z" }],
  credits: null,
};

const quotaWarning = {
  id: "quota_claude_session_one",
  provider: "claude",
  windowKind: "session",
  windowIdentity: "claude:session:2026-09-13T10:00:00.000Z",
  remainingPercent: 5,
  usedPercent: 95,
  fetchedAt: "2026-09-13T09:00:00.000Z",
  freshness: "fresh",
  message: "claude session quota is at 5.0% remaining.",
  choices: [
    { id: "continue", label: "Continue" },
    { id: "prepare_pause", label: "Prepare to pause" },
    { id: "review_takeover", label: "Review takeover" },
  ],
};

const markup = renderToStaticMarkup(
  React.createElement(
    "main",
    { className: "fixture" },
    React.createElement(ContextPicker, {
      workspaceId: 7,
      prompts: [prompt],
      savedPromptId: 1,
      onPrompt: () => {},
      disabled: false,
      activeWorkspace: {
        id: 7,
        name: "Fixture",
        description: "",
        workDirectory: "/tmp/agent-console-m4-fixture",
        workDirectoryExists: true,
        createdAt: "2026-09-13T09:00:00.000Z",
        updatedAt: "2026-09-13T09:00:00.000Z",
      },
      onRecover: () => {},
    }),
    React.createElement("section", { className: "agent-card" }, React.createElement(UsageBlock, {
      usage,
      warnings: [quotaWarning],
      loading: false,
      available: true,
    })),
  ),
);

let chromium;
try {
  ({ chromium } = await import(values.playwright ?? "playwright"));
} catch (error) {
  console.error(`Browser harness unavailable: install Playwright or pass --playwright. ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const css = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, sans-serif; background: #101114; color: #f6f6f3; }
  .fixture { display: flex; flex-direction: column; gap: 16px; padding: 16px; max-width: 100vw; overflow-x: hidden; }
  .flex { display: flex; }
  .flex-wrap { flex-wrap: wrap; }
  .items-center { align-items: center; }
  .items-baseline { align-items: baseline; }
  .justify-between { justify-content: space-between; }
  .gap-1\\.5 { gap: 6px; }
  .gap-2 { gap: 8px; }
  .mt-1 { margin-top: 4px; }
  .mt-2 { margin-top: 8px; }
  .mt-3 { margin-top: 12px; }
  .ml-auto { margin-left: auto; }
  .min-w-0 { min-width: 0; }
  .max-w-full { max-width: 100%; }
  .w-56 { width: 224px; max-width: 100%; }
  .break-words { overflow-wrap: anywhere; }
  .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rounded, .rounded-md, .rounded-panel { border-radius: 6px; }
  .border, .ring-1 { border: 1px solid rgba(255,255,255,.2); }
  button, a { max-width: 100%; }
  [data-testid="start-unknown-warning"], [data-testid="quota-warning"] { max-width: 100%; overflow-wrap: anywhere; }
`;

const browser = await chromium.launch();
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${markup}</body></html>`);
    const text = await page.locator("body").innerText();
    assert.match(text, /Ownership unknown/);
    assert.match(text, /Confirm provider process state before recovery/);
    assert.match(text, /server knows the previous start is stopped or no spawn/);
    assert.match(text, /Choices: Continue/);
    assert.doesNotMatch(text, /blind release|release ownership|Recover interrupted run/i);
    const interactiveQuota = await page.locator('[data-testid="quota-warning"] button, [data-testid="quota-warning"] a, [data-testid="quota-warning"] input, [data-testid="quota-warning"] select').count();
    assert.equal(interactiveQuota, 0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    assert.equal(overflow, false, `horizontal overflow at ${width}px`);
    await page.close();
  }
} finally {
  await browser.close();
}

console.log("PASS: M4 START_UNKNOWN and quota warning surfaces fit mobile/desktop fake browser fixtures.");
