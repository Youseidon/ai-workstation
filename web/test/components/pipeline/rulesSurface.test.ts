/**
 * A setting the UI cannot reach is a setting that does not exist.
 *
 * These read the panels as text rather than rendering them, the same way
 * `settingsCoverage.test.ts` reads AgentsView. That is enough to catch a
 * vocabulary growing a member that no control offers, or a panel quietly
 * losing its mount point — without a DOM.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DOD_CRITERION_KINDS,
  DOD_ENFORCEMENTS,
  TRANSITIONS,
  STEP_TRANSITIONS,
} from "@agent-console/shared";

const read = (name: string): string =>
  readFileSync(new URL(`../../../components/pipeline/${name}`, import.meta.url), "utf8");
const DOD_PANEL = read("DefinitionOfDonePanel.tsx");
const INSPECTOR = read("PipelineInspector.tsx");
const STEP_FORM = read("StepConfigForm.tsx");
const BOARD = read("PipelineBoard.tsx");

test("the definition of done is mounted where an operator can open it", () => {
  assert.match(INSPECTOR, /<DefinitionOfDonePanel\b/, "nothing renders the definition of done");
  assert.doesNotMatch(INSPECTOR, /ReviewerMatrixPanel/, "the deleted reviewer matrix must stay gone");
  assert.match(BOARD, /PipelineInspector/, "board lost the config inspector");
});

test("the inspector renders the shared TRANSITIONS table", () => {
  assert.match(INSPECTOR, /TRANSITIONS\.map\(/, "rows are hardcoded instead of derived");
  assert.ok(TRANSITIONS.length > 0);
  assert.ok(STEP_TRANSITIONS.length > 0);
});

test("every TRANSITIONS policy key points at a real pipeline setting surface", () => {
  for (const row of TRANSITIONS) {
    if (row.policy.kind !== "setting") continue;
    assert.match(row.policy.key, /^pipeline\./, `${row.id} policy key ${row.policy.key}`);
  }
});

test("station rule editor offers onUnfinished, not onBlocked / retry / recover", () => {
  assert.match(STEP_FORM, /onUnfinished/, "station form lost the unfinished control");
  assert.match(STEP_FORM, /onUnfinishedConsequence/);
  assert.doesNotMatch(STEP_FORM, /onBlockedConsequence/);
  assert.doesNotMatch(STEP_FORM, /recoverProvider/);
});

test("station and suite editors expose ordered provider fallbacks", () => {
  assert.match(STEP_FORM, /fallbackProviders/, "station editor lost the fallback list");
  assert.match(INSPECTOR, /TRANSIENT_PATTERNS/, "inspector lost the transient-failure table");
  assert.match(INSPECTOR, /SuiteFallbackEditor/, "suite fallbacks are not editable");
});

test("budgets are reachable from the pipeline inspector", () => {
  assert.match(INSPECTOR, /RUN_BUDGETS_GROUP/, "run budgets are not on the pipeline inspector");
});

test("every kind of criterion and every enforcement can be picked", () => {
  assert.match(DOD_PANEL, /DOD_CRITERION_KINDS\.map\(/, "the criterion kinds are hardcoded");
  assert.match(DOD_PANEL, /DOD_ENFORCEMENTS\.map\(/, "the enforcement options are hardcoded");
  assert.ok(DOD_CRITERION_KINDS.length === 3);
  assert.ok(DOD_ENFORCEMENTS.length === 3);
});

test("a failing criterion can be opened to its real output, not a summary of it", () => {
  assert.match(DOD_PANEL, /show output/, "there is no way to read what the command actually printed");
  assert.match(DOD_PANEL, /result\.output/);
});

test("not-checked is shown as its own thing, never as a failure", () => {
  assert.match(DOD_PANEL, /UNVERIFIED/);
  assert.match(DOD_PANEL, /not checked|Not checked|unchecked/i);
});
