/**
 * A setting the UI cannot show is a setting that does not exist for the person
 * using the app. "Run budgets" and "Pipeline policy" were both in this state:
 * saved, read, and honoured by the server, with no control anywhere on the
 * Agents page, because that page filtered for the "General" group alone.
 *
 * This asserts the contract between the two sides — every group the server
 * declares is either a provider's own (rendered in that agent's card) or a
 * shared one (rendered as its own section).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GROUPS, groupsWithFields, snapshot } from "../src/settings.ts";

const AGENTS_VIEW = new URL("../../web/components/agents/AgentsView.tsx", import.meta.url);

test("every declared group has at least one field", () => {
  const populated = new Set(groupsWithFields());
  for (const group of GROUPS) {
    assert.ok(populated.has(group), `${group} is declared but has no fields`);
  }
});

test("every group the server ships has somewhere to render", () => {
  const view = readFileSync(AGENTS_VIEW, "utf8");
  // Provider groups are named in the page's own provider→group map; everything
  // else must fall through to the shared-section loop.
  const providerGroups = new Set(
    [...view.matchAll(/^\s+\w+: "([^"]+)",$/gm)].map((match) => match[1]!),
  );
  // Matching the JSX, not the import: a leftover import would otherwise keep
  // this passing after the dialog itself was removed from the page.
  // Shared groups render as buttons that open SettingsGroupDialog. Both halves
  // have to be present: a loop with no dialog is a row of buttons that do
  // nothing, and a dialog with no loop is a form nothing can open.
  const rendersSharedGroups = /sharedGroups\.map\(/.test(view) && /<SettingsGroupDialog\b/.test(view);
  assert.ok(rendersSharedGroups, "the Agents page no longer opens shared groups in a dialog");

  for (const group of snapshot().groups) {
    const covered = providerGroups.has(group) || rendersSharedGroups;
    assert.ok(covered, `${group} has no section on the Agents page`);
  }
});

test("the pipeline policy group is visible, not just settable by env var", () => {
  const fields = snapshot().fields.filter((field) => field.group === "Pipeline policy");
  assert.ok(fields.length >= 8, `expected the full policy group, found ${fields.length}`);
  for (const field of fields) {
    assert.ok(field.label.length > 0, `${field.key} has no label to render`);
    assert.ok(field.description.length > 0, `${field.key} has no description`);
    assert.match(field.envVar, /^PIPELINE_/, `${field.key} has an off-pattern env var`);
  }
});

test("every settings field has a code reader", () => {
  // A switch that changes nothing is worse than none (00-read-first invariant 5).
  // The public `settings` object is the only sanctioned reader; FIELDS entries
  // that never appear there are dead weight in .env and on the Agents page.
  const source = readFileSync(new URL("../src/settings.ts", import.meta.url), "utf8");
  const accessor = source.slice(source.indexOf("export const settings"));
  assert.ok(accessor.length > 0, "settings accessor export not found");
  for (const field of snapshot().fields) {
    // Direct helpers, or a local wrapper that still names the key (budgetFor's
    // `limit("budget.maxToolCalls", …)` pattern).
    const named = new RegExp(
      String.raw`(?:count|flag|text|optionalText|commaList|argvList|limit)\(\s*["\`]${field.key.replace(/\./g, "\\.")}["\`]`,
    );
    assert.match(accessor, named, `${field.key} is declared but never read by the settings accessor`);
  }
});

test("retention group is present and env-prefixed", () => {
  const fields = snapshot().fields.filter((field) => field.group === "Retention");
  assert.equal(fields.length, 3);
  for (const field of fields) {
    assert.match(field.envVar, /^RETENTION_/);
  }
});
