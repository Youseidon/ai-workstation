import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STATUS_CATALOG,
  DEFAULT_TRIGGER_SENTENCES,
  DOD_COMMAND_TIMEOUT_MAX_MS,
  DOD_CRITERION_KINDS,
  DOD_ENFORCEMENTS,
  DOD_ENFORCEMENT_LABEL,
  DOD_KIND_HINT,
  DOD_KIND_LABEL,
  OVERLAY_STATUSES,
  STATUS_TRIGGERS,
  STEP_DISPLAY_STATUSES,
  STEP_SIGNALS,
  STEP_STATUSES,
  STEP_TRANSITIONS,
  clampDodTimeout,
  describeTrigger,
  isStepStatus,
  matchStepTransition,
  rollupStatus,
  statusDefinition,
} from "../../src/models/statusModel";
import type { StepSignal } from "../../src/models/statusModel";

test("every display status has exactly one definition", () => {
  const ids = DEFAULT_STATUS_CATALOG.map((entry) => entry.id);
  assert.deepEqual([...ids].sort(), [...STEP_DISPLAY_STATUSES].sort());
  assert.equal(new Set(ids).size, ids.length, "a status is defined twice");
});

test("storable is the line between a stored status and a live overlay", () => {
  for (const entry of DEFAULT_STATUS_CATALOG) {
    const stored = (STEP_STATUSES as readonly string[]).includes(entry.id);
    assert.equal(entry.storable, stored, `${entry.id} disagrees about whether it is stored`);
  }
  for (const overlay of OVERLAY_STATUSES) {
    assert.equal(statusDefinition(DEFAULT_STATUS_CATALOG, overlay).storable, false);
    assert.equal(isStepStatus(overlay), false, `${overlay} must never be writable to prompt.status`);
  }
});

test("an overlay cannot carry entry behaviour it will never reach", () => {
  for (const overlay of OVERLAY_STATUSES) {
    const definition = statusDefinition(DEFAULT_STATUS_CATALOG, overlay);
    assert.equal(definition.onEnter, "none", `${overlay} has entry behaviour that can never fire`);
    assert.ok(definition.locked.includes("onEnter"), `${overlay} lets its dead on-enter be edited`);
  }
});

test("no state is terminal without also being a way to finish", () => {
  const terminal = DEFAULT_STATUS_CATALOG.filter((entry) => entry.isTerminal).map((entry) => entry.id);
  assert.deepEqual([...terminal].sort(), ["DONE", "SKIPPED"]);
  for (const entry of DEFAULT_STATUS_CATALOG) {
    assert.notEqual(entry.isTerminal, entry.blocksParent, `${entry.id} is both terminal and blocking`);
  }
});

test("every signal is decided by some row", () => {
  for (const signal of STEP_SIGNALS) {
    const matched = [false, true].map((producedWork) => matchStepTransition({ signal, producedWork }));
    assert.ok(matched[0] !== null, `${signal} has no row when the run produced nothing`);
    assert.ok(matched[1] !== null, `${signal} has no row when the run produced work`);
  }
});

test("every row is reachable — none is shadowed by an earlier one", () => {
  const reached = new Set<string>();
  for (const signal of STEP_SIGNALS) {
    for (const producedWork of [false, true]) {
      const row = matchStepTransition({ signal, producedWork });
      if (row !== null) reached.add(row.id);
    }
  }
  const unreachable = STEP_TRANSITIONS.filter((row) => !reached.has(row.id)).map((row) => row.id);
  assert.deepEqual(unreachable, [], `these rows can never match: ${unreachable.join(", ")}`);
});

test("row ids are unique, so the ledger can name the one that decided", () => {
  const ids = STEP_TRANSITIONS.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every row explains itself and names a known trigger", () => {
  for (const row of STEP_TRANSITIONS) {
    assert.ok(row.condition.length > 0, `${row.id} has no condition`);
    assert.ok(row.because.length > 10, `${row.id} does not explain itself`);
    assert.ok(
      (STATUS_TRIGGERS as readonly string[]).includes(row.trigger),
      `${row.id} names an unknown trigger ${row.trigger}`,
    );
    if (row.to !== null) {
      assert.ok(isStepStatus(row.to), `${row.id} lands on ${row.to}, which is not a stored status`);
    }
    assert.ok(row.policy.reason.length > 20, `${row.id} does not say why it is or is not editable`);
  }
});

test("a run that ends without posting is never read as success or failure", () => {
  const row = matchStepTransition({ signal: "run_ended_no_post" });
  assert.ok(row !== null);
  assert.equal(row.to, "UNREPORTED");
  assert.equal(row.next, "continue");
  assert.notEqual(row.to, "FAILED");
  assert.notEqual(row.to, "DONE");
  assert.notEqual(row.to, "BLOCKED");
  assert.equal(row.policy.kind, "locked");
});

test("only an observed process failure produces FAILED", () => {
  const failing = STEP_TRANSITIONS.filter((row) => row.to === "FAILED").map((row) => row.id);
  assert.deepEqual([...failing].sort(), ["run-crashed", "run-start-failed"]);
});

test("unfinished runs continue the same station rather than handing off or reviewing first", () => {
  for (const signal of ["run_ended_no_post", "run_crashed", "run_start_failed"] as StepSignal[]) {
    const row = matchStepTransition({ signal });
    assert.equal(row?.next, "continue", `${signal} should continue, not park or hand off`);
  }
  assert.ok(
    !STEP_TRANSITIONS.some((row) => (row.next as string) === "handoff"),
    "handoff was removed from STEP_NEXT_ACTIONS",
  );

  const blocked = matchStepTransition({ signal: "agent_posted_blocked", producedWork: true });
  assert.notEqual(blocked?.next, "continue");
});

test("a status the agent posted itself is never overridden by a rule", () => {
  for (const signal of ["agent_posted_done", "agent_posted_blocked"] as StepSignal[]) {
    const row = matchStepTransition({ signal });
    assert.equal(row?.policy.kind, "locked");
  }
});

test("every trigger has a sentence", () => {
  for (const trigger of STATUS_TRIGGERS) {
    const sentence = DEFAULT_TRIGGER_SENTENCES[trigger];
    assert.ok(sentence !== undefined && sentence.length > 0, `${trigger} has no sentence`);
  }
  assert.deepEqual(Object.keys(DEFAULT_TRIGGER_SENTENCES).sort(), [...STATUS_TRIGGERS].sort());
});

test("an unknown trigger is passed through rather than dropped", () => {
  assert.equal(describeTrigger(null), null);
  assert.equal(describeTrigger(""), null);
  assert.equal(describeTrigger("agent_post"), DEFAULT_TRIGGER_SENTENCES.agent_post);
  assert.equal(describeTrigger("something_new"), "something_new");
});

test("an operator's wording wins over the shipped sentence", () => {
  assert.equal(describeTrigger("agent_post", { agent_post: "The robot said so." }), "The robot said so.");
  assert.equal(describeTrigger("run_crashed", { agent_post: "…" }), DEFAULT_TRIGGER_SENTENCES.run_crashed);
});

test("a parent takes the worst outcome among its settled children", () => {
  const worst = rollupStatus(DEFAULT_STATUS_CATALOG, ["DONE", "BLOCKED", "FAILED", "SKIPPED"]);
  assert.equal(worst, "FAILED", "FAILED outranks BLOCKED");

  assert.equal(rollupStatus(DEFAULT_STATUS_CATALOG, ["BLOCKED", "NEEDS_REVIEW"]), "NEEDS_REVIEW");
  assert.equal(rollupStatus(DEFAULT_STATUS_CATALOG, ["UNREPORTED", "BLOCKED"]), "UNREPORTED");

  assert.equal(rollupStatus(DEFAULT_STATUS_CATALOG, ["DONE", "SKIPPED"]), null);
  assert.equal(rollupStatus(DEFAULT_STATUS_CATALOG, []), null);
});

test("every kind of criterion says what it is and how it is checked", () => {
  for (const kind of DOD_CRITERION_KINDS) {
    assert.ok(DOD_KIND_LABEL[kind]?.length > 0, `${kind} has no label`);
    assert.ok(DOD_KIND_HINT[kind]?.length > 30, `${kind} does not explain how it is checked`);
  }
  for (const enforcement of DOD_ENFORCEMENTS) {
    assert.ok(DOD_ENFORCEMENT_LABEL[enforcement]?.length > 0, `${enforcement} has no label`);
  }
});

test("a command timeout cannot exceed what the server will honour", () => {
  assert.equal(clampDodTimeout(Number.MAX_SAFE_INTEGER), DOD_COMMAND_TIMEOUT_MAX_MS);
  assert.equal(clampDodTimeout(-1), 1_000);
});

test("the rule row an unmet definition of done lands on holds the line", () => {
  const row = matchStepTransition({ signal: "dod_unmet" });
  assert.ok(row !== null);
  assert.equal(row.to, "NEEDS_REVIEW");
  assert.notEqual(row.to, "DONE");
  assert.notEqual(row.to, "FAILED");
  assert.equal(row.next, "park");
  assert.equal(row.policy.kind, "setting");
});

test("every settings key a rule row defers to is one the pipeline policy group has", () => {
  const known = new Set([
    "pipeline.pauseMode",
    "pipeline.onRestart",
    "pipeline.maxContinuations",
    "pipeline.reviewAfterContinuations",
    "pipeline.dodEnforcement",
  ]);
  for (const row of STEP_TRANSITIONS) {
    if (row.policy.kind !== "setting") continue;
    assert.ok(known.has(row.policy.key), `${row.id} defers to ${row.policy.key}, which is not a known setting`);
  }
});

test("continuation is a real trigger with a sentence", () => {
  assert.ok((STATUS_TRIGGERS as readonly string[]).includes("continuation"));
  assert.match(DEFAULT_TRIGGER_SENTENCES.continuation, /re-queued|same working tree/i);
});
