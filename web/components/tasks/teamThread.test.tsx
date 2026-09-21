import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OperationsPrompt, PromptOperationalState } from "@agent-console/shared";
import { teamThreadAvailability, TeamThreadControl } from "./TeamThreadPanel";

type TeamStatus = Parameters<typeof teamThreadAvailability>[0];

function team(): NonNullable<TeamStatus> {
  return {
    teamId: "awt1_team",
    groupChatId: "-1001",
    members: [
      { personId: "jd", telegramUserId: "101", botId: "telegram-101", botUsername: "jd_bot", workstationId: "jd-laptop", workstationLabel: "jd-laptop" },
      { personId: "yousef", telegramUserId: "202", botId: "telegram-202", botUsername: "yousef_bot", workstationId: "yousef-desktop", workstationLabel: "yousef-desktop" },
    ],
    instruction: null,
    inviteLink: null,
    handoverEnabled: false,
  };
}

function item(operationalState: PromptOperationalState): OperationsPrompt {
  return { prompt: { id: 42 }, operationalState } as unknown as OperationsPrompt;
}

test("B2: the Open Team thread control is enabled only with a roster and a task awaiting a response", () => {
  assert.deepEqual(teamThreadAvailability(team(), item("AWAITING_RESPONSE")), { enabled: true });

  const noRoster = teamThreadAvailability(null, item("AWAITING_RESPONSE"));
  assert.equal(noRoster.enabled, false);
  assert.match(noRoster.enabled === false ? noRoster.reason : "", /Create or join a Team/);

  for (const state of ["WORKING", "READY", "RECOVERY_NEEDED", "FAILED", "WAITING_DEPENDENCY", "COMPLETE", "SKIPPED"] as const) {
    const blocked = teamThreadAvailability(team(), item(state));
    assert.equal(blocked.enabled, false, `${state} must not offer a Team thread`);
    assert.match(blocked.enabled === false ? blocked.reason : "", /awaiting a response/);
  }
});

test("B2: a disabled control carries its reason as visible text, not only a tooltip", () => {
  const html = renderToStaticMarkup(
    <TeamThreadControl
      availability={teamThreadAvailability(null, item("AWAITING_RESPONSE"))}
      opening={false}
      openedItemId={null}
      error={null}
      onOpen={() => {}}
    />,
  );
  assert.match(html, /Open Team thread/);
  assert.match(html, /<button[^>]*\sdisabled=""/);
  assert.match(html, /data-testid="team-thread-reason"[^>]*>Create or join a Team in Agents settings first\./);
});

test("B2: an enabled control offers the action, and a refused open shows the server's reason", () => {
  const enabled = renderToStaticMarkup(
    <TeamThreadControl
      availability={teamThreadAvailability(team(), item("AWAITING_RESPONSE"))}
      opening={false}
      openedItemId={null}
      error={null}
      onOpen={() => {}}
    />,
  );
  assert.doesNotMatch(enabled, /<button[^>]*\sdisabled=""/);
  assert.doesNotMatch(enabled, /data-testid="team-thread-reason"/);

  const refused = renderToStaticMarkup(
    <TeamThreadControl
      availability={teamThreadAvailability(team(), item("AWAITING_RESPONSE"))}
      opening={false}
      openedItemId={null}
      error="That task is already finished, so a Team thread cannot be opened on it."
      onOpen={() => {}}
    />,
  );
  assert.match(refused, /role="alert"[^>]*>That task is already finished/);

  const opened = renderToStaticMarkup(
    <TeamThreadControl
      availability={teamThreadAvailability(team(), item("AWAITING_RESPONSE"))}
      opening={false}
      openedItemId="awi1_75c3aabf7831461bc7c4a395"
      error={null}
      onOpen={() => {}}
    />,
  );
  assert.match(opened, /Thread opened\./);
  assert.match(opened, /awi1_75c3aabf7831461bc7c4a395/);
  assert.match(opened, /<button[^>]*\sdisabled=""/, "an opened thread is not opened twice");
});

test("B2: the client method posts the work item to the Team items route", () => {
  const source = readFileSync(fileURLToPath(new URL("../../lib/workspacesApi.ts", import.meta.url)), "utf8");
  const method = source.match(/openTeamItem\(serverUrl:string,promptId:number\)\{[^\n]*\}/);
  assert.ok(method, "workspacesApi must expose openTeamItem");
  assert.match(method[0], /"\/api\/task-control\/team\/items"/);
  assert.match(method[0], /method:"POST"/);
  assert.match(method[0], /json\(\{promptId\}\)/);

  const detail = readFileSync(fileURLToPath(new URL("./WorkItemDetail.tsx", import.meta.url)), "utf8");
  assert.match(detail, /<TeamThreadPanel key=\{item\.prompt\.id\} item=\{item\} \/>/, "the work-item detail renders the control");
});
