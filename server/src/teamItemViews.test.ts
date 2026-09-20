import assert from "node:assert/strict";
import test from "node:test";
import { renderTeamItemView, type TeamItemViewState } from "./teamItemViews.ts";
import type { TaskSummary } from "./telegramSummary.ts";

// TM-T1-4 requires that "/access and /help show only current capabilities".
// /access did this from the start; /help returned a fixed list and was never
// asserted at any tier, which is B12 in docs/telegram-task-control/pilot-bug-log.md.

const summary: TaskSummary = {
  promptId: 42,
  key: "42",
  tag: "#item_0123456789abcdef01234567",
  source: "brief",
  breadcrumb: { workstation: "jd-laptop", workspace: "ai-workstation", program: "Team", suite: "Grants", step: null, nextStep: null },
  title: "WI_TC03",
  blockedAt: null,
  options: null,
  optionsOmitted: 0,
  history: { runs: [], moreRuns: 0, blocks: 1, previousAnswer: null, morePreviousAnswers: 0 },
  objective: "Decide the timestamp format",
  completedWork: null,
  verification: null,
  blockers: null,
  decisions: null,
  importantFiles: null,
  recommendation: null,
  ifYouWait: "Only this task waits.",
};

const OWNER = "owner-person";
const TEAMMATE = "teammate-person";

function state(capabilities: TeamItemViewState["memberAccess"], askingPersonId: string): TeamItemViewState {
  return {
    promptStatus: "BLOCKED",
    operationalState: "AWAITING_RESPONSE",
    ownerWorkstation: "jd-laptop",
    memberLabels: ["Jj", "Junaid"],
    memberAccess: capabilities,
    askingPersonId,
    now: new Date("2026-09-20T03:00:00.000Z"),
  };
}

const access = (capabilities: Array<"context" | "answer" | "resume">) => ([
  { personId: OWNER, label: "Jj", owner: true, capabilities: [] },
  { personId: TEAMMATE, label: "Junaid", owner: false, capabilities },
] satisfies TeamItemViewState["memberAccess"]);

const help = (capabilities: Array<"context" | "answer" | "resume">, asking: string) =>
  renderTeamItemView("help", summary, state(access(capabilities), asking)).text;

test("B12: /help lists the read-only commands only, for a teammate holding nothing", () => {
  const text = help([], TEAMMATE);
  for (const command of ["/task", "/status", "/access", "/help"]) assert.ok(text.includes(command), `${command} is always listed`);
  for (const command of ["/context", "/answer", "/resume", "/close", "/grant", "/revoke"]) {
    assert.ok(!text.includes(command), `${command} is not offered without a grant`);
  }
});

test("B12: /help lists exactly the commands a teammate's grants unlock", () => {
  const answerOnly = help(["answer"], TEAMMATE);
  assert.ok(answerOnly.includes("/answer"), "answer is unlocked");
  assert.ok(!answerOnly.includes("/resume"), "resume stays hidden without its grant");
  assert.ok(!answerOnly.includes("/context"), "context stays hidden without its grant");

  const both = help(["answer", "resume"], TEAMMATE);
  assert.ok(both.includes("/answer") && both.includes("/resume"), "both are unlocked");
  assert.ok(!both.includes("/context"), "context stays hidden");

  const contextOnly = help(["context"], TEAMMATE);
  assert.ok(contextOnly.includes("/context"), "context is unlocked");
  assert.ok(!contextOnly.includes("/answer"), "answer stays hidden");
});

test("B12: /help never offers the owner-only commands to a teammate, whatever they hold", () => {
  const text = help(["context", "answer", "resume"], TEAMMATE);
  for (const command of ["/close", "/grant", "/revoke"]) {
    assert.ok(!text.includes(command), `${command} is owner-only`);
  }
});

test("B12: /help gives the owner every command, since the owner needs no grant", () => {
  const text = help([], OWNER);
  for (const command of ["/task", "/status", "/access", "/help", "/context", "/answer", "/resume", "/close", "/grant", "/revoke"]) {
    assert.ok(text.includes(command), `${command} is available to the owner`);
  }
});

test("B12: /help falls back to the read-only commands when the asker is unknown", () => {
  const text = renderTeamItemView("help", summary, { ...state(access([]), OWNER), askingPersonId: null }).text;
  assert.ok(text.includes("/task"), "the read-only commands are always listed");
  assert.ok(!text.includes("/grant"), "an unidentified asker is given nothing extra");
});
