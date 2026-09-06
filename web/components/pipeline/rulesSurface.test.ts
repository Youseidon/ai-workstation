/**
 * A setting the UI cannot reach is a setting that does not exist.
 *
 * The reviewer matrix is the exact case: `GET/PATCH /api/reviewers` and
 * `DELETE /api/reviewers/:trigger` shipped, tested, and resolved through four
 * scopes — and nothing in the app called any of them. Every one of those
 * choices was reachable only by writing SQL, which for the person using the app
 * is the same as not existing at all.
 *
 * These read the panels as text rather than rendering them, the same way
 * `settingsCoverage.test.ts` reads AgentsView. That is enough to catch what
 * actually goes wrong here — a vocabulary growing a member that no control
 * offers, or a panel quietly losing its mount point — without a DOM.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DOD_CRITERION_KINDS,
  DOD_ENFORCEMENTS,
  REVIEW_ACTIONS,
  REVIEW_TRIGGERS,
} from "@agent-console/shared";

const read = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const REVIEWER_PANEL = read("ReviewerMatrixPanel.tsx");
const DOD_PANEL = read("DefinitionOfDonePanel.tsx");
const RULES_PANEL = read("RulesPanel.tsx");

test("the reviewer matrix is actually mounted somewhere an operator can open", () => {
  // The failure this whole panel exists to fix. An import alone would not do
  // it: a leftover import keeps a test passing after the JSX is gone.
  assert.match(RULES_PANEL, /<ReviewerMatrixPanel\b/, "nothing renders the reviewer matrix");
  assert.match(RULES_PANEL, /<DefinitionOfDonePanel\b/, "nothing renders the definition of done");
});

test("every reviewer situation gets a row, and every situation explains itself", () => {
  for (const trigger of REVIEW_TRIGGERS) {
    assert.match(REVIEWER_PANEL, new RegExp(`\\b${trigger}\\b`), `${trigger} has no entry in the matrix`);
  }
  // Rendered from the shared list rather than a hand-written one, so a new
  // situation appears without touching the panel — the same derivation
  // `settingsGroups.test.ts` pins for settings groups.
  assert.match(REVIEWER_PANEL, /reviewers\.map\(/, "the matrix hardcodes its rows instead of deriving them");
  assert.match(REVIEWER_PANEL, /REVIEW_ACTIONS\.map\(/, "the verdict actions are hardcoded");
});

test("every verdict action can be chosen, so none is configurable only in the database", () => {
  // The three verdict dropdowns all render from REVIEW_ACTIONS, so this checks
  // the vocabulary is complete rather than that each label was pasted in.
  assert.ok(REVIEW_ACTIONS.length >= 5);
  assert.match(REVIEWER_PANEL, /REVIEW_ACTION_LABEL\[action\]/, "an action would render as its raw token");
});

test("the panel says why an agent's question is not in the list", () => {
  // BLOCKED is deliberately absent from REVIEW_TRIGGERS. An absence with no
  // explanation reads as an oversight, and the next person adds it back.
  assert.match(REVIEWER_PANEL, /BLOCKED/, "nothing explains why a blocked run cannot be reviewed");
  assert.match(REVIEWER_PANEL, /human decision/);
});

test("every kind of criterion and every enforcement can be picked", () => {
  assert.match(DOD_PANEL, /DOD_CRITERION_KINDS\.map\(/, "the criterion kinds are hardcoded");
  assert.match(DOD_PANEL, /DOD_ENFORCEMENTS\.map\(/, "the enforcement options are hardcoded");
  assert.ok(DOD_CRITERION_KINDS.length === 3);
  assert.ok(DOD_ENFORCEMENTS.length === 3);
});

test("a failing criterion can be opened to its real output, not a summary of it", () => {
  // The operator's whole reason for trusting a refused close: the command's own
  // words. A panel that showed only "FAILED" would be another assertion to take
  // on faith, which is what the status redesign exists to retire.
  assert.match(DOD_PANEL, /show output/, "there is no way to read what the command actually printed");
  assert.match(DOD_PANEL, /result\.output/);
});

test("not-checked is shown as its own thing, never as a failure", () => {
  // FAILED and UNVERIFIED send an operator to different places. Collapsing them
  // is the same mistake as writing BLOCKED for a run that simply went quiet.
  assert.match(DOD_PANEL, /UNVERIFIED: "not checked"/, "an unchecked criterion would read as a failure");
});
