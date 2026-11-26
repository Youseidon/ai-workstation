import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PROVIDER_SETTINGS_GROUP,
  sharedSettingsGroups,
} from "../../../web/features/agents/lib/configuration.ts";
import { PROVIDER_IDS } from "@hydra/shared";
import {
  GROUPS,
  groupsWithFields,
  resetSettings,
  settings,
  snapshot,
  updateSettings,
} from "../../src/config/settings.ts";

const AGENTS_VIEW = new URL(
  "../../../web/features/agents/components/AgentsView.tsx",
  import.meta.url,
);

test("every declared group has at least one field", () => {
  const populated = new Set(groupsWithFields());
  for (const group of GROUPS) {
    assert.ok(populated.has(group), `${group} is declared but has no fields`);
  }
});

test("every group the server ships has somewhere to render", () => {
  const view = readFileSync(AGENTS_VIEW, "utf8");
  const providerGroups = new Set(Object.values(PROVIDER_SETTINGS_GROUP));
  const shared = new Set(sharedSettingsGroups(snapshot().groups));
  const rendersSharedGroups =
    /groups\.map\(/.test(view) && /<SettingsGroupDialog\b/.test(view);
  assert.ok(
    rendersSharedGroups,
    "the Agents page no longer opens shared groups in a dialog",
  );

  assert.ok(
    sharedSettingsGroups([
      ...snapshot().groups,
      "Future settings group",
    ]).includes("Future settings group"),
  );
  for (const group of snapshot().groups) {
    const covered =
      providerGroups.has(group) ||
      group === "Model access" ||
      (shared.has(group) && rendersSharedGroups);
    assert.ok(covered, `${group} has no section on the Agents page`);
  }
});

test("the pipeline policy group is visible, not just settable by env var", () => {
  const fields = snapshot().fields.filter(
    (field) => field.group === "Pipeline policy",
  );
  assert.ok(
    fields.length >= 8,
    `expected the full policy group, found ${fields.length}`,
  );
  for (const field of fields) {
    assert.ok(field.label.length > 0, `${field.key} has no label to render`);
    assert.ok(field.description.length > 0, `${field.key} has no description`);
    assert.match(
      field.envVar,
      /^PIPELINE_/,
      `${field.key} has an off-pattern env var`,
    );
  }
});

test("every settings field has a code reader", () => {
  const source = readFileSync(
    new URL("../../src/config/settings.ts", import.meta.url),
    "utf8",
  );
  const accessor = source.slice(source.indexOf("export const settings"));
  assert.ok(accessor.length > 0, "settings accessor export not found");
  for (const field of snapshot().fields) {
    const named = new RegExp(
      String.raw`(?:count|flag|text|optionalText|commaList|argvList|limit|bytes)\(\s*["\`]${field.key.replace(/\./g, "\\.")}["\`]`,
    );
    assert.match(
      accessor,
      named,
      `${field.key} is declared but never read by the settings accessor`,
    );
  }
});

test("retention group is present and env-prefixed", () => {
  const fields = snapshot().fields.filter(
    (field) => field.group === "Retention",
  );
  assert.equal(fields.length, 3);
  for (const field of fields) {
    assert.match(field.envVar, /^RETENTION_/);
  }
});

test("resource containment defaults fit an 8 GiB WSL host and remain configurable", () => {
  const keys = [
    "resources.memoryHighMiB",
    "resources.memoryMaxMiB",
    "resources.memorySwapMaxMiB",
    "resources.tasksMax",
  ];
  resetSettings(keys);
  try {
    assert.deepEqual(settings.resourceLimits, {
      memoryHighBytes: 3 * 1024 ** 3,
      memoryMaxBytes: 4 * 1024 ** 3,
      memorySwapMaxBytes: 512 * 1024 ** 2,
      tasksMax: 512,
    });
    const updated = updateSettings({
      "resources.memoryHighMiB": "2048",
      "resources.memoryMaxMiB": 3072,
      "resources.memorySwapMaxMiB": 0,
      "resources.tasksMax": 256,
    });
    assert.deepEqual(updated.errors, []);
    assert.deepEqual(settings.resourceLimits, {
      memoryHighBytes: 2 * 1024 ** 3,
      memoryMaxBytes: 3 * 1024 ** 3,
      memorySwapMaxBytes: 0,
      tasksMax: 256,
    });
  } finally {
    resetSettings(keys);
  }
});

test("open tool call timeout defaults to fifteen minutes and 0 disables it", () => {
  resetSettings(["budget.maxOpenToolCallMinutes"]);
  try {
    assert.equal(settings.budgetFor().maxOpenToolCallMs, 15 * 60_000);
    assert.equal(
      updateSettings({ "budget.maxOpenToolCallMinutes": 0 }).ok,
      true,
    );
    assert.equal(settings.budgetFor().maxOpenToolCallMs, null);
  } finally {
    resetSettings(["budget.maxOpenToolCallMinutes"]);
  }
});

test("reasoning effort has a global default and one override per provider", () => {
  const fields = snapshot().fields;
  const global = fields.find((field) => field.key === "models.reasoningEffort");
  assert.deepEqual(
    global?.options?.map((entry) => entry.value),
    ["low", "medium", "high"],
  );

  for (const provider of PROVIDER_IDS) {
    const field = fields.find(
      (entry) => entry.key === `${provider}.reasoningEffort`,
    );
    assert.ok(field, `${provider} has no reasoning-effort setting`);
    assert.deepEqual(
      field.options?.map((entry) => entry.value),
      ["", "low", "medium", "high"],
    );
  }
});

test("provider effort overrides the global effort and invalid levels are rejected", () => {
  const keys = ["models.reasoningEffort", "claude.reasoningEffort"];
  resetSettings(keys);
  try {
    assert.equal(updateSettings({ "models.reasoningEffort": "low" }).ok, true);
    assert.equal(settings.reasoningEffortFor("claude"), "low");
    assert.equal(updateSettings({ "claude.reasoningEffort": "high" }).ok, true);
    assert.equal(settings.reasoningEffortFor("claude"), "high");
    assert.equal(
      updateSettings({ "claude.reasoningEffort": "maximum" }).ok,
      false,
    );
    assert.equal(settings.reasoningEffortFor("claude"), "high");
  } finally {
    resetSettings(keys);
  }
});
