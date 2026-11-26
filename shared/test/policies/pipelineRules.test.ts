import test from "node:test";
import assert from "node:assert/strict";
import {
  PIPELINE_STATES,
  type OnDoneAction,
  type OnUnfinishedAction,
  type PipelineState,
  type PromptOperationalState,
} from "../../src/index";
import {
  RESTART_POLICIES,
  type RestartPolicy,
  CONTROL_LABEL,
  PIPELINE_CONTROLS,
  STOP_REASON,
  TRANSITIONS,
  DEFAULT_PIPELINE_POLICY,
  describeStopReason,
  matchTransition,
  onUnfinishedConsequence,
  onDoneConsequence,
  type RuleContext,
} from "../../src/policies/pipelineRules";

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

const STATION_STATES: Array<PromptOperationalState | null> = [
  null,
  "WORKING",
  "BLOCKED",
  "UNREPORTED",
  "NEEDS_REVIEW",
  "RECOVERY_NEEDED",
  "FAILED",
  "READY",
  "WAITING_DEPENDENCY",
  "DONE",
  "SKIPPED",
];

const WAIT_REASONS: Array<string | null> = [
  null,
  "human_question",
  "station_rule_wait",
  "review_running",
  "continuations_exhausted",
  "no_provider_available",
  "provider_unavailable",
  "worktree_dirty",
  "execution:budget_exhausted",
  "start_refused:git_repository_busy",
];

function everyContext(): RuleContext[] {
  const states: Array<PipelineState | null> = [null, ...PIPELINE_STATES];
  const out: RuleContext[] = [];
  for (const runState of states) {
    for (const stationState of STATION_STATES) {
      for (const awaitingHuman of [false, true]) {
        for (const agentActive of [false, true]) {
          for (const waitReason of WAIT_REASONS) {
            for (const onRestart of RESTART_POLICIES) {
              out.push(context({
                runState,
                stationState,
                awaitingHuman,
                agentActive,
                waitReason,
                policy: { ...DEFAULT_PIPELINE_POLICY, onRestart },
              }));
            }
          }
        }
      }
    }
  }
  return out;
}

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

test("every row is reachable by some context", () => {
  const matched = new Set(everyContext().map((ctx) => matchTransition(ctx).id));
  for (const row of TRANSITIONS) {
    assert.ok(matched.has(row.id), `${row.id} can never match any situation, so it is dead`);
  }
});

test("terminal runs offer a fresh run, never a resume", () => {
  for (const runState of ["STOPPED", "COMPLETE"] as const) {
    const row = matchTransition(context({ runState }));
    assert.equal(row.primary, "newRun", `${runState} should offer a new run`);
    assert.ok(!row.secondary.includes("resume"), `${runState} offers resume as a secondary`);
  }
  const fresh = matchTransition(context({
    runState: "INTERRUPTED",
    policy: { ...DEFAULT_PIPELINE_POLICY, onRestart: "newRun" },
  }));
  assert.equal(fresh.primary, "newRun");
  assert.ok(!fresh.secondary.includes("resume"));
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
  const offered = (onRestart: RestartPolicy) =>
    matchTransition(context({ runState: "INTERRUPTED", policy: { ...DEFAULT_PIPELINE_POLICY, onRestart } }));
  assert.equal(offered("newRun").primary, "newRun");
  assert.equal(offered("resumeSameRun").primary, "resume");
  assert.equal(offered("autoResume").primary, "stop");
  assert.equal(offered("autoResume").label, "Resuming");
  assert.equal(matchTransition(context({ runState: "INTERRUPTED" })).id, "interrupted-auto-resume");
  const adopt = offered("resumeSameRun");
  const dead = matchTransition(context({
    runState: "INTERRUPTED",
    stationState: "RECOVERY_NEEDED",
    policy: { ...DEFAULT_PIPELINE_POLICY, onRestart: "resumeSameRun" },
  }));
  assert.equal(dead.primary, "recover");
  assert.equal(adopt.primary, "resume");
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

test("a parked run explains what parked it", () => {
  const plain = matchTransition(context({ runState: "WAITING_HUMAN" }));
  const exhausted = context({ runState: "WAITING_HUMAN", waitReason: "continuations_exhausted" });
  assert.match(plain.because(context({ runState: "WAITING_HUMAN" })), /rule is "wait"/);
  assert.match(matchTransition(exhausted).because(exhausted), /continued|continuations/i);
});

test('only the "wait" rule is described as the "wait" rule', () => {
  for (const ctx of everyContext()) {
    if (ctx.runState !== "WAITING_HUMAN" || ctx.waitReason === null) continue;
    if (ctx.waitReason === "station_rule_wait") continue;
    const row = matchTransition(ctx);
    for (const [name, text] of [
      ["headline", row.headline(ctx)],
      ["because", row.because(ctx)],
    ] as const) {
      assert.doesNotMatch(
        text,
        /rule is "wait"/,
        `${row.id} ${name} claims the rule is "wait" while parked on ${ctx.waitReason}`,
      );
    }
  }
});

test("every park reason the scheduler writes reaches a row that names it", () => {
  for (const waitReason of WAIT_REASONS.filter(
    (reason) => reason !== null && reason !== "station_rule_wait",
  )) {
    const ctx = context({ runState: "WAITING_HUMAN", waitReason, stationState: "UNREPORTED" });
    const row = matchTransition(ctx);
    assert.notEqual(
      row.id,
      "waiting-human-rule",
      `${waitReason} still falls through to the catch-all, which will describe it as "wait"`,
    );
  }
});

test("a station that never posted a status is not said to have reported blocked", () => {
  for (const ctx of everyContext()) {
    if (ctx.runState !== "WAITING_HUMAN") continue;
    if (ctx.stationState === "BLOCKED") continue;
    const row = matchTransition(ctx);
    for (const [name, text] of [
      ["headline", row.headline(ctx)],
      ["because", row.because(ctx)],
    ] as const) {
      assert.doesNotMatch(
        text,
        /reported blocked|posted BLOCKED/,
        `${row.id} ${name} says a ${String(ctx.stationState)} station reported blocked`,
      );
    }
  }
});

test("an unfinished station is described by how its run actually ended", () => {
  const parked = (stationState: PromptOperationalState) =>
    matchTransition(context({ runState: "WAITING_HUMAN", stationState }))
      .headline(context({ runState: "WAITING_HUMAN", stationState }));
  assert.match(parked("BLOCKED"), /reported blocked/);
  assert.match(parked("UNREPORTED"), /without reporting a status/);
  assert.match(parked("FAILED"), /failed/);
});

test("stop reasons: known translated, unknown passed through, null omitted", () => {
  assert.equal(
    describeStopReason("continuations_exhausted"),
    STOP_REASON.continuations_exhausted,
  );
  assert.equal(describeStopReason("unexpected_status:WEIRD"), "unexpected_status:WEIRD");
  assert.match(describeStopReason("start_refused:git_repository_busy")!, /still writing in this Git repository/);
  assert.equal(describeStopReason("start_refused:odd_code"), `${STOP_REASON.start_refused} (odd_code)`);
  assert.equal(describeStopReason(null), null);
  assert.match(describeStopReason("execution:budget_exhausted")!,/Resume cannot renew it/);
});

test("an exhausted execution allowance offers no Resume or recovery reset",()=>{
  for(const stationState of ["UNREPORTED","RECOVERY_NEEDED","NEEDS_REVIEW"] as const) {
    const row=matchTransition(context({runState:"WAITING_HUMAN",waitReason:"execution:budget_exhausted",stationState}));
    assert.equal(row.id,"waiting-execution-budget");
    assert.equal(row.primary,null);
    assert.deepEqual(row.secondary,["stop"]);
    assert.match(row.hint(context()),/approve a new allocation/);
  }
});

test("every stopReason the scheduler writes has a human sentence", () => {
  const written = [
    "operator_stop",
    "server_restart",
    "blocked_on_dependencies",
    "on_done_stop",
    "skip_rest",
    "no_provider",
    "start_failed",
    "no_provider_available",
    "worktree_dirty",
    "start_refused",
    "human_question",
    "station_rule_wait",
    "review_running",
    "continuations_exhausted",
  ];
  for (const reason of written) {
    assert.ok(STOP_REASON[reason] !== undefined, `${reason} would be shown raw`);
  }
});

test("every rule choice explains where it lands, naming real controls", () => {
  const done: OnDoneAction[] = ["continue", "stop", "skip_rest"];
  const unfinished: OnUnfinishedAction[] = ["continue", "skip", "wait"];
  const labels = new Set(Object.values(CONTROL_LABEL));
  for (const action of done) {
    const text = onDoneConsequence(action, DEFAULT_PIPELINE_POLICY);
    assert.ok(text.length > 0, `${action} has no consequence`);
    assert.doesNotMatch(text, /\bnull\b|\bundefined\b/, `${action} leaked a placeholder`);
  }
  for (const onUnfinished of unfinished) {
    const text = onUnfinishedConsequence({ onUnfinished }, DEFAULT_PIPELINE_POLICY);
    assert.ok(text.length > 0, `${onUnfinished} has no consequence`);
    assert.doesNotMatch(text, /\bnull\b|\bundefined\b/, `${onUnfinished} leaked a placeholder`);
  }
  const parked = onUnfinishedConsequence({ onUnfinished: "continue" }, DEFAULT_PIPELINE_POLICY);
  for (const named of ["Resume", "Stop"]) {
    assert.ok(labels.has(named) && parked.includes(named), `a spent allowance should name ${named}`);
  }
  const waited = onUnfinishedConsequence({ onUnfinished: "wait" }, DEFAULT_PIPELINE_POLICY);
  assert.match(waited, /does not stop the pipeline/i);
  assert.doesNotMatch(waited, /\bResume\b|\bStop\b/);
});

test("the continue consequence counts the operator's own limit", () => {
  const once = onUnfinishedConsequence(
    { onUnfinished: "continue" },
    { ...DEFAULT_PIPELINE_POLICY, maxContinuations: 1 },
  );
  const thrice = onUnfinishedConsequence(
    { onUnfinished: "continue" },
    { ...DEFAULT_PIPELINE_POLICY, maxContinuations: 3 },
  );
  assert.match(once, /once/);
  assert.match(thrice, /up to 3 times/);
});

test("PipelinePolicy defaults include the continuation knobs", () => {
  assert.equal(DEFAULT_PIPELINE_POLICY.maxContinuations, 4);
  assert.equal(DEFAULT_PIPELINE_POLICY.reviewAfterContinuations, true);
  assert.equal(DEFAULT_PIPELINE_POLICY.defaultOnUnfinished, "continue");
  assert.equal(DEFAULT_PIPELINE_POLICY.defaultOnDone, "continue");
});
