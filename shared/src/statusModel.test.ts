import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STATUS_CATALOG,
  DEFAULT_TRIGGER_SENTENCES,
  OVERLAY_STATUSES,
  STATUS_TRIGGERS,
  STEP_DISPLAY_STATUSES,
  STEP_SIGNALS,
  STEP_STATUSES,
  STEP_TRANSITIONS,
  describeTrigger,
  isStepStatus,
  matchStepTransition,
  rollupStatus,
  statusDefinition,
} from "./statusModel";
import type { StepSignal } from "./statusModel";

/* ------------------------------------------------------------------ */
/* The catalog is total                                                */
/* ------------------------------------------------------------------ */

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
  // An overlay is derived on every read and never written, so nothing can
  // observe it being "entered". A configurable on-enter there would be a
  // control that silently does nothing.
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
    // Terminal and blocks-parent are opposites by construction; a state that is
    // both would deadlock a parent that can never close.
    assert.notEqual(entry.isTerminal, entry.blocksParent, `${entry.id} is both terminal and blocking`);
  }
});

/* ------------------------------------------------------------------ */
/* The transition table is total, ordered, and reachable               */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* The behaviour the whole redesign exists to guarantee                */
/* ------------------------------------------------------------------ */

test("a run that ends without posting is never read as success or failure", () => {
  const row = matchStepTransition({ signal: "run_ended_no_post" });
  assert.ok(row !== null);
  assert.equal(row.to, "UNREPORTED");
  assert.equal(row.next, "review");
  assert.notEqual(row.to, "FAILED");
  assert.notEqual(row.to, "DONE");
  assert.notEqual(row.to, "BLOCKED");
  // This is the invariant the pipeline's credibility rests on, so it must not
  // be reachable through a settings screen.
  assert.equal(row.policy.kind, "locked");
});

test("only an observed process failure produces FAILED", () => {
  const failing = STEP_TRANSITIONS.filter((row) => row.to === "FAILED").map((row) => row.id);
  assert.deepEqual([...failing].sort(), ["run-crashed", "run-start-failed"]);
});

test("a handoff is prepared only for unfinished work that left something behind", () => {
  const handoffs = STEP_TRANSITIONS.filter((row) => row.next === "handoff");
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0]!.when.signal, "review_verdict_incomplete");
  assert.equal(handoffs[0]!.when.producedWork, true);

  // An agent that stopped to ask a question has not left unfinished work; it
  // has asked something. Summarising that would burn a run to say so.
  const blocked = matchStepTransition({ signal: "agent_posted_blocked", producedWork: true });
  assert.notEqual(blocked?.next, "handoff");

  // Nothing produced means nothing to summarise, however incomplete it is.
  const empty = matchStepTransition({ signal: "review_verdict_incomplete", producedWork: false });
  assert.notEqual(empty?.next, "handoff");
});

test("a status the agent posted itself is never overridden by a rule", () => {
  for (const signal of ["agent_posted_done", "agent_posted_blocked"] as StepSignal[]) {
    const row = matchStepTransition({ signal });
    assert.equal(row?.policy.kind, "locked");
  }
});

/* ------------------------------------------------------------------ */
/* Triggers and rollup                                                 */
/* ------------------------------------------------------------------ */

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
  // A partial override still falls through for everything it does not mention.
  assert.equal(describeTrigger("run_crashed", { agent_post: "…" }), DEFAULT_TRIGGER_SENTENCES.run_crashed);
});

test("a parent takes the worst outcome among its settled children", () => {
  const worst = rollupStatus(DEFAULT_STATUS_CATALOG, ["DONE", "BLOCKED", "FAILED", "SKIPPED"]);
  assert.equal(worst, "FAILED", "FAILED outranks BLOCKED");

  assert.equal(rollupStatus(DEFAULT_STATUS_CATALOG, ["BLOCKED", "NEEDS_REVIEW"]), "NEEDS_REVIEW");
  assert.equal(rollupStatus(DEFAULT_STATUS_CATALOG, ["UNREPORTED", "BLOCKED"]), "UNREPORTED");

  // Children that all finished cleanly propagate nothing, so the parent is free
  // to close on its own definition of done rather than inheriting a state.
  assert.equal(rollupStatus(DEFAULT_STATUS_CATALOG, ["DONE", "SKIPPED"]), null);
  assert.equal(rollupStatus(DEFAULT_STATUS_CATALOG, []), null);
});
