import assert from "node:assert/strict";
import test from "node:test";
import { completedSummary, renderTeamItemAnchor, renderTeamItemView, type TeamItemViewState } from "./teamItemViews.ts";
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
    ownerPerson: "Jj",
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

// B13: a completed item's anchor is the permanent record of the item in the group,
// because nothing edits it again once it is retired. It used to mark completion in
// the hint line alone and leave the blocked state rendered around it.

const blocked: TaskSummary = {
  ...summary,
  blockedAt: "2026-09-19T12:00:00.000Z",
  options: [{ label: "Recalculate", advantages: ["Accurate"], disadvantages: ["Slow"] }],
  history: { runs: [{ provider: "claude", startedAt: "2026-09-19T12:58:00.000Z", state: "RUNNING" }, { provider: "grok", startedAt: "2026-09-19T11:00:00.000Z", state: "DONE" }], moreRuns: 0, blocks: 1, previousAnswer: null, morePreviousAnswers: 0 },
  blockers: [{ description: "Amounts disagree with the owner list.", requiredAction: "Choose whether amounts are recalculated." }],
  recommendation: "Wait for your decision.",
  ifYouWait: "This task and its pipeline stay paused; other workspaces continue.",
};

const anchor = (promptStatus: string) => renderTeamItemAnchor(blocked, { ...state(access([]), OWNER), promptStatus }).text;

test("B13: an open item's anchor still states the block, the options and what waiting costs", () => {
  const text = anchor("BLOCKED");
  assert.ok(text.includes("Blocked on:"), "the blocker is what the group is being asked about");
  assert.ok(text.includes("Action: Choose whether amounts are recalculated."), "with the action only a human can take");
  assert.ok(text.includes("If you wait: This task and its pipeline stay paused"), "and what waiting costs");
  assert.ok(text.includes("State: awaiting response · Owner: Jj"), "the hint line states the operational state and who owns the item");
  assert.ok(/- [\d: -]+claude \(running\)/.test(text), "a running run is stated as running");
});

for (const promptStatus of ["DONE", "SKIPPED"]) {
  test(`B13: a ${promptStatus} item's anchor is rendered from the completed state`, () => {
    const text = anchor(promptStatus);
    assert.ok(text.includes("Completed · Owner: Jj"), "the card says the item is complete");
    assert.ok(!text.includes("Blocked on:"), "a completed item is not blocked on a decision");
    assert.ok(!text.includes("Action: Choose"), "and asks the group for no action");
    assert.ok(!text.includes("If you wait:"), "nothing is waiting on the reader");
    assert.ok(!text.includes("Agent recommends:"), "and no advice about an open decision survives completion");
    assert.ok(!text.includes("Options:"), "the choice the item blocked on is no longer offered");
    assert.ok(!/blocked \d+ min ago|blocked just now/.test(text), "and the head line states no age, because the item is no longer blocked");
    assert.ok(/- [\d: -]+claude \(finished\)/.test(text), "a run the prompt has already completed past is stated as finished");
    assert.ok(/- [\d: -]+grok \(done\)/.test(text), "a run that really ended keeps its own outcome");
    assert.ok(text.includes("Blocked once."), "the block count reads in the past tense, not as a block the reader is standing in");
  });
}

test("B5: a Team view names the workstation where a workstation belongs and the person where a person does", () => {
  // The roster carries both, because the paired Telegram account's display name
  // and the machine's own label are different things and the pilot's group said
  // the first wherever it meant the second.
  const owner = state(access(["answer"]), OWNER);
  assert.ok(renderTeamItemAnchor(blocked, owner).text.includes("Owner: Jj"), "the anchor footer names the person who owns the item");
  assert.ok(renderTeamItemAnchor(blocked, owner).text.includes("jd-laptop · ai-workstation"), "and its breadcrumb names the workstation");
  const status = renderTeamItemView("status", blocked, owner).text;
  assert.ok(status.includes("Owner workstation: jd-laptop"), "the workstation line names the workstation");
  assert.ok(!status.includes("Jj"), "and never the person");
  const list = renderTeamItemView("access", blocked, owner).text;
  assert.ok(list.includes("Jj: owner") && list.includes("Junaid: answer"), "access is a list of people");
  assert.ok(!list.includes("jd-laptop"), "and never of workstations");
});

test("B13: the completed summary changes nothing but the completed state's own fields", () => {
  const completed = completedSummary(blocked);
  assert.deepEqual(
    { ...completed, blockedAt: blocked.blockedAt, options: blocked.options, blockers: blocked.blockers, recommendation: blocked.recommendation, ifYouWait: blocked.ifYouWait, history: blocked.history },
    blocked,
    "identity, title, breadcrumb, objective and the rest of the record are untouched",
  );
  assert.deepEqual(completed.history.runs.map(run => run.state), ["FINISHED", "DONE"], "only a run that has not ended is restated");
  assert.equal(blocked.blockers?.length, 1, "the caller's summary is not mutated");
});
