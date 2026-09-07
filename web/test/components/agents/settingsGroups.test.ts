/**
 * The Agents page used to render only the "General" group, which quietly hid
 * every field in "Run budgets" and "Pipeline policy" — they were saved, read
 * and honoured by the server, but had no control anywhere in the UI. These
 * pin the derivation so a new group cannot go missing the same way.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { GROUP_BLURB, GROUP_TITLE } from "../../../lib/settingsGroups";

/** Mirrors AgentsView: provider groups render inside their agent's card. */
const PROVIDER_GROUPS = ["Claude Code", "Codex CLI", "Cursor CLI", "Grok CLI", "GitHub Copilot"];

/** Mirrors the server's exported GROUPS order. */
const SERVER_GROUPS = [
  "General",
  "Run budgets",
  "Pipeline policy",
  "Claude Code",
  "Codex CLI",
  "Cursor CLI",
  "Grok CLI",
  "GitHub Copilot",
];

function sharedGroups(groups: string[]): string[] {
  const provider = new Set(PROVIDER_GROUPS);
  return groups.filter((group) => !provider.has(group));
}

test("every non-provider group gets a section", () => {
  assert.deepEqual(sharedGroups(SERVER_GROUPS), ["General", "Run budgets", "Pipeline policy"]);
});

test("a group added to the server renders without touching the page", () => {
  const withNew = [...SERVER_GROUPS, "Scheduling"];
  assert.ok(sharedGroups(withNew).includes("Scheduling"));
});

test("provider groups stay out of the shared sections", () => {
  for (const group of PROVIDER_GROUPS) {
    assert.ok(!sharedGroups(SERVER_GROUPS).includes(group), `${group} should render in its agent card`);
  }
});

test("the shared groups all carry a blurb, so no section renders bare", () => {
  for (const group of sharedGroups(SERVER_GROUPS)) {
    assert.ok(GROUP_BLURB[group] !== undefined, `${group} has no blurb`);
  }
  assert.equal(GROUP_TITLE.General, "Runtime");
});
