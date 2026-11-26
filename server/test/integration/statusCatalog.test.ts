import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_STATUS_CATALOG, STEP_DISPLAY_STATUSES, statusDefinition } from "@hydra/shared";
import { workspaces, WorkspaceError } from "../../src/repositories/workspaces.ts";

const find = (id: string) => statusDefinition(workspaces.statusCatalog(), id as never);
const reset = (id: string) => workspaces.resetStatusDefinition(id);

test("an untouched catalog is exactly what ships", () => {
  for (const id of STEP_DISPLAY_STATUSES) reset(id);
  assert.deepEqual(workspaces.statusCatalog(), [...DEFAULT_STATUS_CATALOG]);
});

test("renaming a status changes it everywhere it is read from", () => {
  try {
    workspaces.updateStatusDefinition("NEEDS_REVIEW", { label: "Second opinion", shortLabel: "2nd" });
    assert.equal(find("NEEDS_REVIEW").label, "Second opinion");
    assert.equal(find("NEEDS_REVIEW").shortLabel, "2nd");
    const snapshot = workspaces.operations();
    assert.equal(statusDefinition(snapshot.statusCatalog, "NEEDS_REVIEW").label, "Second opinion");
  } finally {
    reset("NEEDS_REVIEW");
  }
});

test("an untouched field keeps falling through to the shipped default", () => {
  try {
    workspaces.updateStatusDefinition("FAILED", { label: "Broke" });
    assert.equal(find("FAILED").description, statusDefinition(DEFAULT_STATUS_CATALOG, "FAILED").description);
    assert.equal(find("FAILED").tone, "danger");
  } finally {
    reset("FAILED");
  }
});

test("a locked invariant is refused, with the reason", () => {
  assert.throws(
    () => workspaces.updateStatusDefinition("DONE", { isTerminal: false }),
    (error: unknown) => error instanceof WorkspaceError && error.status === 422,
  );
  assert.equal(find("DONE").isTerminal, true);

  assert.throws(() => workspaces.updateStatusDefinition("UNREPORTED", { satisfiesDependency: true }));
  assert.equal(find("UNREPORTED").satisfiesDependency, false);
});

test("an overlay cannot be given entry behaviour that could never fire", () => {
  for (const overlay of ["WORKING", "READY", "WAITING_DEPENDENCY", "RECOVERY_NEEDED"]) {
    assert.throws(() => workspaces.updateStatusDefinition(overlay, { onEnter: "review" }), `${overlay} accepted a dead on-enter`);
  }
});

test("a refusal names the field, so the UI can say which control was rejected", () => {
  try {
    workspaces.updateStatusDefinition("DONE", { isTerminal: false, label: "Finished" });
    assert.fail("expected a refusal");
  } catch (error) {
    assert.ok(error instanceof WorkspaceError);
    assert.equal(error.code, "validation_error");
    assert.ok(error.fields?.isTerminal !== undefined, "the refused field is not named");
    assert.notEqual(find("DONE").label, "Finished");
  }
});

test("editable policy really is editable", () => {
  try {
    workspaces.updateStatusDefinition("BLOCKED", { needsAttention: false, precedence: 5, onEnter: "review" });
    assert.equal(find("BLOCKED").needsAttention, false);
    assert.equal(find("BLOCKED").precedence, 5);
    assert.equal(find("BLOCKED").onEnter, "review");
  } finally {
    reset("BLOCKED");
  }
});

test("garbage is refused rather than stored", () => {
  for (const patch of [{ tone: "chartreuse" }, { icon: "<svg/>" }, { precedence: -1 }, { label: "  " }, { onEnter: "explode" }]) {
    assert.throws(() => workspaces.updateStatusDefinition("NEEDS_REVIEW", patch), JSON.stringify(patch));
  }
});

test("an unknown status is a 404, not a new row", () => {
  assert.throws(
    () => workspaces.updateStatusDefinition("INVENTED", { label: "x" }),
    (error: unknown) => error instanceof WorkspaceError && error.status === 404,
  );
});

test("a trigger sentence is the operator's wording over our token", () => {
  try {
    const after = workspaces.updateTriggerSentence("run_ended_without_post", "The agent went quiet.");
    assert.equal(after.run_ended_without_post, "The agent went quiet.");
    assert.ok((after.run_crashed ?? "").length > 0);
    assert.equal(workspaces.operations().triggerSentences.run_ended_without_post, "The agent went quiet.");
  } finally {
    workspaces.updateTriggerSentence("run_ended_without_post", null);
  }
  assert.throws(() => workspaces.updateTriggerSentence("not_a_trigger", "x"));
});
