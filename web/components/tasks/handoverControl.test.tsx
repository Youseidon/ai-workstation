import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OperationsPrompt } from "@agent-console/shared";
import { handoverAvailability, HandoverControlView, type HandoverAvailability } from "./HandoverControl";
import type { HandoverPreview } from "@/lib/workspacesApi";

type TeamStatus = Parameters<typeof handoverAvailability>[0];

function team(handoverEnabled: boolean): NonNullable<TeamStatus> {
  return {
    teamId: "awt1_team",
    groupChatId: "-1001",
    members: [
      { personId: "jd", telegramUserId: "101", botId: "telegram-101", botUsername: "jd_bot", workstationId: "jd-laptop", workstationLabel: "jd-laptop" },
      { personId: "yousef", telegramUserId: "202", botId: "telegram-202", botUsername: "yousef_bot", workstationId: "yousef-desktop", workstationLabel: "yousef-desktop" },
    ],
    instruction: null,
    inviteLink: null,
    handoverEnabled,
  };
}

function item(status: string): OperationsPrompt {
  return { prompt: { id: 42, status, currentRun: null } } as unknown as OperationsPrompt;
}

function preview(flagged: Array<{ path: string; shapes: string[] }>): HandoverPreview {
  return {
    itemId: "awi1_75c3aabf7831461bc7c4a395",
    provider: "claude",
    model: null,
    branch: "aw/handover/awi1_75c3aabf7831461bc7c4a395",
    files: [
      { path: "src/colour.ts", status: " M", bytes: 412, shapes: [] },
      ...flagged.map(one => ({ path: one.path, status: "??", bytes: 90, shapes: one.shapes })),
    ],
    excluded: ["node_modules/.cache"],
    flagged,
    totalBytes: 502,
    large: false,
    requiredConfirmations: flagged.length > 0 ? ["credential_exposure", "publish"] : ["publish"],
    risk: "Accepted risk: a secret that reaches a shared remote stays in that remote's history.",
    mitigation: "The cheap mitigation is to gitignore the file and re-capture before publishing.",
  };
}

function view(overrides: Partial<Parameters<typeof HandoverControlView>[0]> = {}): string {
  const base: Parameters<typeof HandoverControlView>[0] = {
    availability: { enabled: true } as HandoverAvailability,
    // M-16 added this prop. Null is this file's subject: every row here is about
    // an item with no live handover, so no assertion below changes meaning.
    held: null,
    preview: null,
    offer: null,
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
  return renderToStaticMarkup(<HandoverControlView {...base} {...overrides} />);
}

test("C1: handover is off by default, and the control says which capability refused it", () => {
  const noTeam = handoverAvailability(null, item("BLOCKED"));
  assert.equal(noTeam.enabled, false);
  assert.match(noTeam.enabled === false ? noTeam.reason : "", /Create or join a Team/);

  // Team on, handover off: the distinction the routes make, made visible.
  const handoverOff = handoverAvailability(team(false), item("BLOCKED"));
  assert.equal(handoverOff.enabled, false);
  assert.match(handoverOff.enabled === false ? handoverOff.reason : "", /team\.handoverEnabled/);
  assert.match(handoverOff.enabled === false ? handoverOff.reason : "", /item threads keep working/);

  assert.deepEqual(handoverAvailability(team(true), item("BLOCKED")), { enabled: true });
  for (const finished of ["DONE", "SKIPPED"]) {
    const refused = handoverAvailability(team(true), item(finished));
    assert.equal(refused.enabled, false, `${finished} has nothing to hand over`);
  }
});

test("C1: a disabled control carries its reason as visible text and offers no tap", () => {
  const html = view({ availability: handoverAvailability(team(false), item("BLOCKED")) });
  assert.match(html, /Hand over to the team/);
  assert.match(html, /data-testid="handover-reason"[^>]*>Handover is off on this workstation\./);
  assert.match(html, /<button[^>]*\sdisabled=""/);
});

test("TM-T0-7: the preview lists every file being published and names what is excluded", () => {
  const html = view({ preview: preview([]) });
  assert.match(html, /data-testid="handover-preview"/);
  assert.match(html, /src\/colour\.ts/);
  assert.match(html, /aw\/handover\/awi1_75c3aabf7831461bc7c4a395/);
  assert.match(html, /1 ignored file\(s\) are excluded, not published\./);
  assert.doesNotMatch(html, /data-testid="handover-credential-confirmation"/);
});

test("TM-T0-7: a flagged credential shape takes its own confirmation, separate from Publish", () => {
  const flagged = [{ path: ".env.local", shapes: ["aws_access_key_id"] }];
  const unconfirmed = view({ preview: preview(flagged) });
  assert.match(unconfirmed, /data-testid="handover-credential-confirmation"/);
  assert.match(unconfirmed, /aws_access_key_id/);
  // The warning states the accepted risk and the cheap mitigation, and Publish
  // is refused until the exposure is confirmed on its own.
  assert.match(unconfirmed, /stays in that remote&#x27;s history/);
  assert.match(unconfirmed, /gitignore the file and re-capture/);
  assert.match(unconfirmed, /Publish offer<\/button>/);
  const publishButton = /<button[^>]*>Publish offer<\/button>/.exec(unconfirmed)?.[0] ?? "";
  assert.match(publishButton, /\sdisabled=""/, "Publish stays refused while the exposure is unconfirmed");

  const confirmed = view({ preview: preview(flagged), credentialConfirmed: true });
  const enabledPublish = /<button[^>]*>Publish offer<\/button>/.exec(confirmed)?.[0] ?? "";
  assert.doesNotMatch(enabledPublish, /\sdisabled=""/);
});

test("C1: a published offer names no receiver and reports its own deadline", () => {
  const html = view({
    offer: {
      itemId: "awi1_75c3aabf7831461bc7c4a395",
      branch: "aw/handover/awi1_75c3aabf7831461bc7c4a395",
      snapshotCommit: "a".repeat(40),
      provider: "claude",
      model: null,
      receiver: null,
      epoch: 1,
      startDeadline: "2026-09-22T09:00:00.000Z",
    },
  });
  assert.match(html, /data-testid="handover-offer"/);
  assert.match(html, /names no receiver/);
  assert.doesNotMatch(html, /data-testid="handover-preview"/);
});

test("C1: the server's refusal is shown rather than swallowed", () => {
  const html = view({ error: "Handover is not enabled on this workstation." });
  assert.match(html, /role="alert"[^>]*>Handover is not enabled on this workstation\./);
});

test("C1: the client methods call the six handover routes, and the detail renders the control", () => {
  const source = readFileSync(fileURLToPath(new URL("../../lib/workspacesApi.ts", import.meta.url)), "utf8");
  for (const [method, step, verb] of [
    ["beginHandover", "begin", "POST"],
    ["handoverPreview", "preview", "GET"],
    ["publishHandover", "publish", "POST"],
    ["handoverReview", "review", "GET"],
    ["applyHandover", "apply", "POST"],
    ["requestHandoverChanges", "request-changes", "POST"],
  ] as const) {
    const line = source.split("\n").find(one => one.trimStart().startsWith(`${method}(`));
    assert.ok(line, `workspacesApi must expose ${method}`);
    assert.match(line, new RegExp(`/api/task-control/team/handover/\\$\\{encodeURIComponent\\(itemId\\)\\}/${step}`));
    if (verb === "POST") assert.match(line, /method:"POST"/);
    else assert.doesNotMatch(line, /method:"POST"/);
  }

  const panel = readFileSync(fileURLToPath(new URL("./TeamThreadPanel.tsx", import.meta.url)), "utf8");
  assert.match(panel, /<HandoverControl team=\{team\} item=\{item\} \/>/, "the work-item detail renders the handover control");
});
