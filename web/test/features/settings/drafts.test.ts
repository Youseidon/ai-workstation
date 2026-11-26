import test from "node:test";
import assert from "node:assert/strict";
import type { SettingField } from "@hydra/shared";
import {
  clearSubmittedDrafts,
  dangerousSetting,
  dirtySettings,
} from "../../../features/settings/lib/drafts.ts";

const fields = [
  { key: "codex.model", value: "saved" },
  { key: "claude.model", value: "claude" },
  { key: "codex.apiKey", value: "", type: "password" },
] as SettingField[];
test("provider switching and snapshot updates preserve other groups and secret drafts", () => {
  const drafts = {
    "codex.model": "new",
    "claude.model": "other",
    "codex.apiKey": "replacement",
  };
  assert.deepEqual(dirtySettings(fields.slice(0, 1), drafts), ["codex.model"]);
  assert.deepEqual(clearSubmittedDrafts(drafts, { "codex.model": "new" }), {
    "claude.model": "other",
    "codex.apiKey": "replacement",
  });
  assert.equal(drafts["codex.model"], "new");
  assert.deepEqual(
    dirtySettings([{ ...fields[0], value: "new" } as SettingField], drafts),
    [],
  );
});
test("saving or resetting an older submission cannot drop a more recent draft", () => {
  assert.deepEqual(
    clearSubmittedDrafts(
      { value: "newer", other: true },
      { value: "submitted" },
    ),
    { value: "newer", other: true },
  );
  assert.deepEqual(
    clearSubmittedDrafts(
      { value: "submitted", other: true },
      { value: "submitted" },
    ),
    { other: true },
  );
});
test("permission and host access confirmations use the value being saved or inherited on reset", () => {
  const host = { type: "boolean", dangerWhenTrue: true } as SettingField;
  const sandbox = {
    type: "select",
    options: [
      { value: "workspace-write", danger: false },
      { value: "danger-full-access", danger: true },
    ],
  } as SettingField;
  assert.equal(dangerousSetting(host, true), true);
  assert.equal(dangerousSetting(host, false), false);
  assert.equal(dangerousSetting(sandbox, "danger-full-access"), true);
  assert.equal(dangerousSetting(sandbox, "workspace-write"), false);
});
