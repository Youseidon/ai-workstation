// node --import tsx scripts/verify-handover-browser.mjs [--playwright @playwright/test]
//
// The two-width check for the handover surface (C1), committed as a rig rather
// than run once and deleted. L-4 in the gap register records that F03's
// two-width evidence was observed and is not reproducible, because its fixture
// was thrown away; this one stays, so the same check can be re-run by anyone.
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HandoverControlView, handoverAvailability } from "../web/components/tasks/HandoverControl.tsx";

const { values } = parseArgs({ options: { playwright: { type: "string" } } });

const team = {
  teamId: "awt1_team",
  groupChatId: "-1001",
  members: [],
  instruction: null,
  inviteLink: null,
  handoverEnabled: true,
};
const item = { prompt: { id: 42, status: "BLOCKED", currentRun: null } };

const preview = {
  itemId: "awi1_75c3aabf7831461bc7c4a395",
  provider: "claude",
  model: null,
  branch: "aw/handover/awi1_75c3aabf7831461bc7c4a395",
  files: [
    { path: "server/src/integrations/telegram/veryDeeplyNestedModuleName.ts", status: " M", bytes: 4120, shapes: [] },
    { path: ".env.local", status: "??", bytes: 92, shapes: ["aws_access_key_id"] },
  ],
  excluded: ["node_modules/.cache"],
  flagged: [{ path: ".env.local", shapes: ["aws_access_key_id"] }],
  totalBytes: 4212,
  large: false,
  requiredConfirmations: ["credential_exposure", "publish"],
  risk: "Accepted risk: a secret that reaches a shared remote stays in that remote's history, so deleting the file afterwards does not unpublish it.",
  mitigation: "The cheap mitigation is to gitignore the file and re-capture before publishing.",
};

const base = {
  held: null,
  preparing: false,
  publishing: false,
  credentialConfirmed: false,
  onCredentialConfirmed: () => {},
  provider: "claude",
  onProvider: () => {},
  error: null,
  onPrepare: () => {},
  onPublish: () => {},
};

const markup = renderToStaticMarkup(
  React.createElement(
    "main",
    { className: "fixture" },
    // Disabled, with its reason: the default state, because both settings are off.
    React.createElement(HandoverControlView, {
      ...base,
      availability: handoverAvailability({ ...team, handoverEnabled: false }, item),
      preview: null,
      offer: null,
    }),
    // The preview, with a flagged credential shape and its own confirmation.
    React.createElement(HandoverControlView, {
      ...base,
      availability: handoverAvailability(team, item),
      preview,
      offer: null,
    }),
    // A published open call.
    React.createElement(HandoverControlView, {
      ...base,
      availability: handoverAvailability(team, item),
      preview: null,
      offer: {
        itemId: preview.itemId,
        branch: preview.branch,
        snapshotCommit: "a".repeat(40),
        provider: "claude",
        model: null,
        receiver: null,
        epoch: 1,
        startDeadline: "2026-09-22T09:00:00.000Z",
      },
    }),
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
  .items-start { align-items: flex-start; }
  .justify-between { justify-content: space-between; }
  .gap-1 { gap: 4px; }
  .gap-1\\.5 { gap: 6px; }
  .gap-2 { gap: 8px; }
  .mt-0\\.5 { margin-top: 2px; }
  .mt-1 { margin-top: 4px; }
  .mt-2 { margin-top: 8px; }
  .mt-3 { margin-top: 12px; }
  .pt-3 { padding-top: 12px; }
  .p-2 { padding: 8px; }
  .p-4 { padding: 16px; }
  .px-2 { padding-left: 8px; padding-right: 8px; }
  .py-1 { padding-top: 4px; padding-bottom: 4px; }
  .min-w-0 { min-width: 0; }
  .flex-1 { flex: 1 1 0%; }
  .basis-56 { flex-basis: 224px; }
  .break-all { overflow-wrap: anywhere; word-break: break-all; }
  .break-words { overflow-wrap: anywhere; }
  .space-y-1 > * + * { margin-top: 4px; }
  .max-h-48 { max-height: 192px; }
  .overflow-y-auto { overflow-y: auto; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .rounded, .rounded-md, .rounded-panel { border-radius: 6px; }
  .border, .ring-1 { border: 1px solid rgba(255,255,255,.2); }
  button, a, select, code { max-width: 100%; }
  ul { margin: 0; padding: 0; list-style: none; }
`;

const browser = await chromium.launch();
try {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 1200 } });
    await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${markup}</body></html>`);
    const text = await page.locator("body").innerText();

    // Default-off says which capability refused, in visible text.
    assert.match(text, /Handover is off on this workstation/, `reason missing at ${width}px`);
    assert.match(text, /team\.handoverEnabled/, `setting name missing at ${width}px`);
    // The preview lists what is being published, flags the credential shape and
    // states the accepted risk and the cheap mitigation.
    assert.match(text, /\.env\.local/, `flagged path missing at ${width}px`);
    assert.match(text, /aws_access_key_id/, `credential shape missing at ${width}px`);
    assert.match(text, /stays in that remote's history/, `risk missing at ${width}px`);
    assert.match(text, /gitignore the file and re-capture/, `mitigation missing at ${width}px`);
    // The offer names no receiver.
    assert.match(text, /names no receiver/, `open-call wording missing at ${width}px`);
    // No token, path or identifier leaks into what the requester is shown.
    assert.doesNotMatch(text, /\d{8,10}:[A-Za-z0-9_-]{35}/, `bot token shape rendered at ${width}px`);

    // Publish stays refused while the exposure is unconfirmed, at both widths.
    const publishDisabled = await page.locator('button:has-text("Publish offer")').evaluateAll(
      nodes => nodes.every(node => node.hasAttribute("disabled")),
    );
    assert.equal(publishDisabled, true, `Publish was tappable with an unconfirmed credential shape at ${width}px`);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    assert.equal(overflow, false, `horizontal overflow at ${width}px`);
    await page.close();
  }
} finally {
  await browser.close();
}

console.log("PASS: the handover control fits 390px and 1280px, states which capability is off, and refuses Publish until a flagged credential shape is confirmed.");
