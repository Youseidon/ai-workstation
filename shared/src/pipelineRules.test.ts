/**
 * Tests for the transport interlocking *as data*.
 *
 * The characterisation test in `web` pins what the table produces for the
 * handful of situations the UI renders. This file pins the properties the
 * table must hold as a structure — totality, ordering, and the invariants a
 * settings screen will rely on — so that adding a row cannot silently shadow
 * an existing one or leave a state with no control at all.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  HANDOFF_TRIGGERS,
  autoHandoffAllowed,
  PIPELINE_STATES,
  type OnBlockedAction,
  type OnDoneAction,
  type PipelineState,
  type PromptOperationalState,
} from "./index";
import {
  RESTART_POLICIES,
  CONTROL_LABEL,
  PIPELINE_CONTROLS,
  STOP_REASON,
  TRANSITIONS,
  DEFAULT_PIPELINE_POLICY,
  describeStopReason,
  matchTransition,
  onBlockedConsequence,
  onDoneConsequence,
  type RuleContext,
} from "./pipelineRules";

function context(over: Partial<RuleContext> = {}): RuleContext {
  return {
    runState: null,
    stationState: null,
    station: "S6 · S6-07",
    stopReason: null,
    waitReason: null,
    awaitingHuman: false,
    agentActive: false,
    policy: DEFAULT_PIPELINE_POLICY,
    ...over,
  };
}

/** Every situation the app can present, as a flat list. */
const STATION_STATES: Array<PromptOperationalState | null> = [
  null,
  "WORKING",
  "BLOCKED",
  "RECOVERY_NEEDED",
  "FAILED",
  "READY",
  "WAITING_DEPENDENCY",
  "DONE",
  "SKIPPED",
];

function everyContext(): RuleContext[] {
  const states: Array<PipelineState | null> = [null, ...PIPELINE_STATES];
  const out: RuleContext[] = [];
  for (const runState of states) {
    for (const stationState of STATION_STATES) {
      for (const awaitingHuman of [false, true]) {
        for (const agentActive of [false, true]) {
          // Policy is part of the condition, so a row a setting unlocks has to
          // be reachable here too — otherwise "every row is reachable" would
          // pass while a policy-gated row was quietly dead.
          for (const onRestart of RESTART_POLICIES) {
            out.push(context({
              runState,
              stationState,
              awaitingHuman,
              agentActive,
              policy: { ...DEFAULT_PIPELINE_POLICY, onRestart },
            }));
          }
        }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Structure                                                           */
/* ------------------------------------------------------------------ */

test("row ids are unique", () => {
  const ids = TRANSITIONS.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate row id in [${ids.join(", ")}]`);
});

test("row conditions are distinct, so the rules panel never shows the same line twice", () => {
  const conditions = TRANSITIONS.map((row) => row.condition);
  assert.equal(new Set(conditions).size, conditions.length, `duplicate condition in [${conditions.join(" / ")}]`);
});

test("every row is renderable: label, tone, controls and a policy reason", () => {
  for (const row of TRANSITIONS) {
    assert.ok(row.label.length > 0, `${row.id} has no label`);
    assert.ok(row.condition.length > 0, `${row.id} has no condition`);
    assert.ok(row.policy.reason.length > 0, `${row.id} has no policy reason`);
    if (row.primary !== null) {
      assert.ok(PIPELINE_CONTROLS.includes(row.primary), `${row.id} primary is not a control`);
      assert.ok(CONTROL_LABEL[row.primary].length > 0, `${row.id} primary has no label`);
    }
    for (const control of row.secondary) {
      assert.ok(PIPELINE_CONTROLS.includes(control), `${row.id} secondary ${control} is not a control`);
    }
  }
});

test("no row lists its primary control again as a secondary", () => {
  for (const row of TRANSITIONS) {
    assert.ok(
      row.primary === null || !row.secondary.includes(row.primary),
      `${row.id} offers ${row.primary} twice`,
    );
    assert.equal(new Set(row.secondary).size, row.secondary.length, `${row.id} repeats a secondary`);
  }
});

test("a setting-backed row names the key that governs it", () => {
  const keys = TRANSITIONS.flatMap((row) => (row.policy.kind === "setting" ? [row.policy.key] : []));
  assert.ok(keys.length > 0, "no row defers to a setting; the policy hook is unused");
  for (const key of keys) assert.match(key, /^pipeline\./);
});

/* ------------------------------------------------------------------ */
/* Totality and ordering                                               */
/* ------------------------------------------------------------------ */

test("every reachable situation matches a row", () => {
  for (const ctx of everyContext()) {
    const row = matchTransition(ctx);
    assert.ok(row !== undefined, `no row for ${JSON.stringify(ctx)}`);
    assert.equal(
      row.when.runState,
      ctx.runState,
      `${row.id} matched runState ${String(ctx.runState)} but declares ${String(row.when.runState)}`,
    );
  }
});

test("every situation offers at least one control, so no state is a dead end", () => {
  for (const ctx of everyContext()) {
    const row = matchTransition(ctx);
    const controls = [...(row.primary === null ? [] : [row.primary]), ...row.secondary];
    assert.ok(controls.length > 0, `${row.id} leaves the operator with no control at all`);
  }
});

test("every pipeline state is covered by a row", () => {
  for (const state of PIPELINE_STATES) {
    assert.ok(
      TRANSITIONS.some((row) => row.when.runState === state),
      `${state} has no row`,
    );
  }
  assert.ok(
    TRANSITIONS.some((row) => row.when.runState === null),
    "no row for a pipeline that has never run",
  );
});

test("a narrower row always precedes the broader row it must pre-empt", () => {
  // First match wins, so a row with extra conditions is only ever reachable if
  // it sits above the row that shares its runState and has fewer conditions.
  const width = (row: (typeof TRANSITIONS)[number]) => Object.keys(row.when).length;
  for (let i = 0; i < TRANSITIONS.length; i += 1) {
    for (let j = i + 1; j < TRANSITIONS.length; j += 1) {
      const earlier = TRANSITIONS[i]!;
      const later = TRANSITIONS[j]!;
      if (earlier.when.runState !== later.when.runState) continue;
      assert.ok(
        width(earlier) >= width(later),
        `${later.id} is narrower than ${earlier.id} but sits below it, so it can never match`,
      );
    }
  }
});

/*
 * The invariant that killed D2. A row no context can reach is dead code that
 * still reads as policy, which is exactly how the old `resumable ? ... : ...`
 * branches survived unnoticed. There is no exemption flag: a row that cannot
 * match must be deleted, not annotated.
 */
test("every row is reachable by some context", () => {
  const matched = new Set(everyContext().map((ctx) => matchTransition(ctx).id));
  for (const row of TRANSITIONS) {
    assert.ok(matched.has(row.id), `${row.id} can never match any situation, so it is dead`);
  }
});

/* ------------------------------------------------------------------ */
/* Resumability is derived, never passed in                            */
/* ------------------------------------------------------------------ */

/*
 * D2: the table used to take a `resumable` boolean whose invariant nobody had
 * written down — a STOPPED or INTERRUPTED run is never active, so it was never
 * resumable, and the branches keyed on it could not render. Resumability is a
 * function of `runState`, so the table derives it and the contradiction is
 * unwritable.
 */

test("terminal runs offer a fresh run, never a resume", () => {
  for (const runState of ["STOPPED", "INTERRUPTED", "COMPLETE"] as const) {
    const row = matchTransition(context({ runState }));
    assert.equal(row.primary, "newRun", `${runState} should offer a new run`);
    assert.ok(!row.secondary.includes("resume"), `${runState} offers resume as a secondary`);
  }
});

test("only an active run offers resume, unless the restart policy says otherwise", () => {
  for (const ctx of everyContext()) {
    const row = matchTransition(ctx);
    const offersResume = row.primary === "resume" || row.secondary.includes("resume");
    if (!offersResume) continue;
    const active = ctx.runState === "PLAYING" || ctx.runState === "WAITING_HUMAN" || ctx.runState === "PAUSED";
    const adopted = ctx.runState === "INTERRUPTED" && ctx.policy.onRestart === "resumeSameRun";
    assert.ok(active || adopted, `${row.id} offers resume on ${String(ctx.runState)} with no policy allowing it`);
  }
});

test("onRestart flips what an interrupted run offers, and only that", () => {
  const fresh = matchTransition(context({ runState: "INTERRUPTED" }));
  const adopt = matchTransition(context({
    runState: "INTERRUPTED",
    policy: { ...DEFAULT_PIPELINE_POLICY, onRestart: "resumeSameRun" },
  }));
  assert.equal(fresh.primary, "newRun");
  assert.equal(adopt.primary, "resume");
  // Recovery still wins: a dead station has to be cleared either way.
  const dead = matchTransition(context({
    runState: "INTERRUPTED",
    stationState: "RECOVERY_NEEDED",
    policy: { ...DEFAULT_PIPELINE_POLICY, onRestart: "resumeSameRun" },
  }));
  assert.equal(dead.primary, "recover");
});

test("a row that offers recovery says so on the pill", () => {
  for (const row of TRANSITIONS) {
    if (row.primary !== "recover") continue;
    assert.equal(row.label, "Recovery needed", `${row.id} offers recovery but its pill reads "${row.label}"`);
  }
});

test("a station left mid-run is recovered before anything else is offered", () => {
  for (const runState of ["WAITING_HUMAN", "STOPPED", "INTERRUPTED"] as const) {
    const row = matchTransition(context({ runState, stationState: "RECOVERY_NEEDED" }));
    assert.equal(row.primary, "recover", `${runState} + RECOVERY_NEEDED should offer recovery first`);
  }
});

test("recovery does not hijack a station that is merely blocked", () => {
  const row = matchTransition(context({ runState: "WAITING_HUMAN", stationState: "BLOCKED" }));
  assert.equal(row.primary, "resume");
  assert.equal(row.id, "waiting-human-rule");
});

/* ------------------------------------------------------------------ */
/* Prose                                                               */
/* ------------------------------------------------------------------ */

test("every row explains itself without leaking a placeholder", () => {
  for (const ctx of everyContext()) {
    const row = matchTransition(ctx);
    for (const [name, text] of [
      ["headline", row.headline(ctx)],
      ["because", row.because(ctx)],
    ] as const) {
      assert.ok(text.length > 0, `${row.id} produced an empty ${name}`);
      assert.doesNotMatch(text, /\bnull\b|\bundefined\b|\[object/, `${row.id} ${name} leaked a placeholder`);
    }
  }
});

test("a missing station reads as a phrase rather than a hole", () => {
  const row = matchTransition(context({ runState: "PLAYING" }));
  const ctx = context({ runState: "PLAYING", station: null });
  assert.match(row.headline(ctx), /the current station/);
});

/*
 * D5: retry exhaustion parks the run rather than ending it, so the reason lives
 * in `waitReason`. It used to be written to `stopReason`, which the status bar
 * only reads on a STOPPED run — the explanation was dropped exactly where it
 * would have helped most.
 */
test("a parked run explains what parked it", () => {
  const plain = matchTransition(context({ runState: "WAITING_HUMAN" }));
  const exhausted = context({ runState: "WAITING_HUMAN", waitReason: "retry_exhausted" });
  assert.match(plain.because(context({ runState: "WAITING_HUMAN" })), /rule is "wait"/);
  assert.match(matchTransition(exhausted).because(exhausted), /ran out of retries/);
});

test("stop reasons: known translated, unknown passed through, null omitted", () => {
  assert.equal(describeStopReason("retry_exhausted"), "A station ran out of retries.");
  assert.equal(describeStopReason("unexpected_status:WEIRD"), "unexpected_status:WEIRD");
  assert.equal(describeStopReason(null), null);
});

/*
 * Every reason `terminate()` and its callers persist. A new reason added to the
 * scheduler without a sentence here shows the operator a raw snake_case token.
 */
test("every stopReason the scheduler writes has a human sentence", () => {
  const written = [
    "operator_stop",
    "server_restart",
    "blocked_on_dependencies",
    "on_done_stop",
    "skip_rest",
    "retry_exhausted",
    "recover_exhausted",
    "no_provider",
    "start_failed",
  ];
  for (const reason of written) {
    assert.ok(STOP_REASON[reason] !== undefined, `${reason} would be shown raw`);
  }
});

/* ------------------------------------------------------------------ */
/* Rule consequences                                                   */
/* ------------------------------------------------------------------ */

test("every rule choice explains where it lands, naming real controls", () => {
  const done: OnDoneAction[] = ["continue", "stop", "skip_rest"];
  const blocked: OnBlockedAction[] = ["wait", "retry", "recover", "skip"];
  const labels = new Set(Object.values(CONTROL_LABEL));
  for (const action of done) {
    const text = onDoneConsequence(action, DEFAULT_PIPELINE_POLICY);
    assert.ok(text.length > 0, `${action} has no consequence`);
    assert.doesNotMatch(text, /\bnull\b|\bundefined\b/, `${action} leaked a placeholder`);
  }
  for (const onBlocked of blocked) {
    const text = onBlockedConsequence(
      { onBlocked, retryLimit: 2, recoverProvider: "codex" },
      DEFAULT_PIPELINE_POLICY,
    );
    assert.ok(text.length > 0, `${onBlocked} has no consequence`);
    assert.doesNotMatch(text, /\bnull\b|\bundefined\b/, `${onBlocked} leaked a placeholder`);
  }
  // The controls named must be ones the table can actually offer.
  const parked = onBlockedConsequence(
    { onBlocked: "wait", retryLimit: 1, recoverProvider: null },
    DEFAULT_PIPELINE_POLICY,
  );
  for (const named of ["Resume", "Stop"]) {
    assert.ok(labels.has(named) && parked.includes(named), `parking should name ${named}`);
  }
});

test("the retry consequence counts the operator's own limit", () => {
  const once = onBlockedConsequence({ onBlocked: "retry", retryLimit: 1, recoverProvider: null }, DEFAULT_PIPELINE_POLICY);
  const thrice = onBlockedConsequence({ onBlocked: "retry", retryLimit: 3, recoverProvider: null }, DEFAULT_PIPELINE_POLICY);
  assert.match(once, /once/);
  assert.match(thrice, /up to 3 times/);
});

/* ------------------------------------------------------------------ */
/* When a handoff is prepared without being asked                      */
/* ------------------------------------------------------------------ */

const handoff = (over: Partial<Parameters<typeof autoHandoffAllowed>[0]> = {}) =>
  autoHandoffAllowed({ trigger: "reviewerIncomplete", status: "UNREPORTED", producedWork: true, reviewed: true, ...over });

test("a question an agent asked is never summarised", () => {
  // The case that motivated narrowing this. BLOCKED means the agent stopped to
  // ask the operator something — that is a question, not unfinished work, and
  // paying a full agent run to report that somebody needs to answer it is
  // exactly the waste the old boolean caused.
  for (const trigger of HANDOFF_TRIGGERS) {
    assert.equal(handoff({ trigger, status: "BLOCKED" }), false, `${trigger} summarised a question`);
  }
});

test("nothing produced means nothing to hand over", () => {
  assert.equal(handoff({ producedWork: false }), false);
  assert.equal(handoff({ trigger: "anyUnfinished", producedWork: false }), false);
});

test("the default waits for a reviewer to call the work unfinished", () => {
  assert.equal(handoff({ reviewed: true }), true);
  assert.equal(handoff({ reviewed: false }), false, "a brief was prepared before anything judged the work");
  // The broader setting does not wait for that judgement, which is the whole
  // difference between the two.
  assert.equal(handoff({ trigger: "anyUnfinished", reviewed: false }), true);
});

test("manual only means manual only", () => {
  for (const status of ["UNREPORTED", "FAILED", "NEEDS_REVIEW"]) {
    assert.equal(handoff({ trigger: "manualOnly", status, reviewed: true }), false);
  }
});

test("every handoff trigger is a real choice", () => {
  // A setting whose options behave identically is a setting that lies about
  // having options.
  const outcomes = HANDOFF_TRIGGERS.map((trigger) =>
    ["UNREPORTED", "FAILED"].flatMap((status) =>
      [true, false].map((reviewed) => handoff({ trigger, status, reviewed })),
    ).join(","));
  assert.equal(new Set(outcomes).size, HANDOFF_TRIGGERS.length);
});
