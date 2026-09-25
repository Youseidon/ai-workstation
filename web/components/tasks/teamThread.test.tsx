import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { STEP_DISPLAY_STATUSES, type OperationsPrompt, type PromptOperationalState } from "@agent-console/shared";
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

/*
 * C3. The negative list below used to be hand-written, and `BLOCKED` was in
 * neither it nor the positive case - because when this test was written
 * `operationalState` could not return `BLOCKED`. So the test passed whichever
 * way the gate behaved for the one state that now actually occurs, and it went
 * on passing while the control was disabled on exactly the task a person was
 * waiting on.
 *
 * The positive set stays written out, because it is a claim about the product
 * rather than a restatement of the predicate the product uses. The negative
 * list is then everything else the status model has - `OPERATIONAL_STATES` is
 * `[...STEP_DISPLAY_STATUSES]` - so a state added to, or moved within, the
 * model cannot again be absent from both lists.
 */
const AWAITING: readonly PromptOperationalState[] = ["AWAITING_RESPONSE", "BLOCKED"];
const NOT_AWAITING = STEP_DISPLAY_STATUSES.filter((state) => !AWAITING.includes(state));

test("C3: every state in the status model is claimed by exactly one of the two lists", () => {
  assert.deepEqual(
    [...AWAITING, ...NOT_AWAITING].slice().sort(),
    [...STEP_DISPLAY_STATUSES].slice().sort(),
    "a state the model gained or lost must not be able to go missing from both lists",
  );
  for (const state of AWAITING) {
    assert.ok(STEP_DISPLAY_STATUSES.includes(state), `${state} is no longer in the status model`);
  }
});

test("B2: the Open Team thread control is enabled only with a roster and a task awaiting a response", () => {
  // C3: BLOCKED is here as well as AWAITING_RESPONSE. It is the state the
  // ordinary Team path actually produces - an agent stops with a BLOCKED status
  // and no handoff record - and it is the one this case used to skip.
  for (const state of AWAITING) {
    assert.deepEqual(teamThreadAvailability(team(), item(state)), { enabled: true }, `${state} must offer a Team thread`);
  }

  const noRoster = teamThreadAvailability(null, item("AWAITING_RESPONSE"));
  assert.equal(noRoster.enabled, false);
  assert.match(noRoster.enabled === false ? noRoster.reason : "", /Create or join a Team/);

  for (const state of NOT_AWAITING) {
    const blocked = teamThreadAvailability(team(), item(state));
    assert.equal(blocked.enabled, false, `${state} must not offer a Team thread`);
    const reason = blocked.enabled === false ? blocked.reason : "";
    assert.match(reason, /awaiting a response/);
    // The reason names the item's own label, so it must never be produced for a
    // state the board calls "Needs you": that sentence contradicted itself, and
    // it is what a person read on the task they were being asked about (C3).
    assert.doesNotMatch(reason, /this one is needs you/i, `${state} must not be told it is not awaiting a response while labelled "Needs you"`);
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
