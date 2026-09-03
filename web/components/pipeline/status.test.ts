/**
 * What the pipeline transport controls render, cell by cell.
 *
 * This started as a characterisation test around the old `if` chain, and it
 * passed unchanged through the conversion to the declarative table in
 * `shared/src/pipelineRules.ts` — that is what proved the conversion faithful.
 * It has since been extended deliberately for the recovery rows and for the
 * removal of the `resumable` argument.
 *
 * This file covers the view the UI actually renders. The table's structural
 * invariants — totality, ordering, no unreachable rows — live next to the table
 * itself in `shared/src/pipelineRules.test.ts`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { OnBlockedAction, PromptPipelineRule } from "@agent-console/shared";
import {
  CONTROL_LABEL,
  LABEL,
  PIPELINE_LABEL,
  PIPELINE_TONE,
  TONE,
  onBlockedChip,
  onDoneChip,
  overrideChip,
  pipelineStatus,
  type PipelineControl,
} from "./status";

type Args = Parameters<typeof pipelineStatus>[0];

const STATION = "S6 · S6-07";

function status(over: Partial<Args> = {}) {
  return pipelineStatus({
    run: null,
    stationState: null,
    station: STATION,
    awaitingHuman: false,
    ...over,
  });
}

/** The whole table in one shape, so a changed cell names itself in the diff. */
interface Cell {
  name: string;
  args: Partial<Args>;
  label: string;
  tone: string;
  pulse: boolean;
  primary: PipelineControl | null;
  secondary: PipelineControl[];
}

const TABLE: Cell[] = [
  {
    name: "no run yet → Play",
    args: { run: null },
    label: "Not started",
    tone: "neutral",
    pulse: false,
    primary: "play",
    secondary: [],
  },
  {
    name: "PLAYING → Pause, with Stop demoted",
    args: { run: { state: "PLAYING", stopReason: null, waitReason: null } },
    label: "Running",
    tone: "info",
    pulse: true,
    primary: "pause",
    secondary: ["stop"],
  },
  {
    name: "PAUSED while the agent is still draining → Stop only",
    args: { run: { state: "PAUSED", stopReason: null, waitReason: null }, agentActive: true },
    label: "Pausing",
    tone: "caution",
    pulse: true,
    primary: "stop",
    secondary: [],
  },
  {
    name: "PAUSED and idle → Resume",
    args: { run: { state: "PAUSED", stopReason: null, waitReason: null }, agentActive: false },
    label: "Paused",
    tone: "caution",
    pulse: false,
    primary: "resume",
    secondary: ["stop"],
  },
  {
    name: "WAITING_HUMAN on a station rule → Resume",
    args: { run: { state: "WAITING_HUMAN", stopReason: null, waitReason: null }, awaitingHuman: false },
    label: "Needs you",
    tone: "warning",
    pulse: true,
    primary: "resume",
    secondary: ["stop"],
  },
  {
    name: "WAITING_HUMAN on an unanswered intervention → Resume",
    args: { run: { state: "WAITING_HUMAN", stopReason: null, waitReason: null }, awaitingHuman: true },
    label: "Needs you",
    tone: "warning",
    pulse: true,
    primary: "resume",
    secondary: ["stop"],
  },
  {
    name: "WAITING_HUMAN whose station lost its agent → Recover",
    args: {
      run: { state: "WAITING_HUMAN", stopReason: null, waitReason: null },
      stationState: "RECOVERY_NEEDED",
    },
    label: "Recovery needed",
    tone: "caution",
    pulse: false,
    primary: "recover",
    secondary: ["stop"],
  },
  {
    name: "INTERRUPTED whose station lost its agent → Recover",
    args: {
      run: { state: "INTERRUPTED", stopReason: "server_restart", waitReason: null },
      stationState: "RECOVERY_NEEDED",
    },
    label: "Recovery needed",
    tone: "caution",
    pulse: false,
    primary: "recover",
    secondary: ["newRun"],
  },
  {
    name: "STOPPED whose station lost its agent → Recover",
    args: {
      run: { state: "STOPPED", stopReason: "operator_stop", waitReason: null },
      stationState: "RECOVERY_NEEDED",
    },
    label: "Recovery needed",
    tone: "caution",
    pulse: false,
    primary: "recover",
    secondary: ["newRun"],
  },
  {
    name: "INTERRUPTED → Start new run",
    args: { run: { state: "INTERRUPTED", stopReason: "server_restart", waitReason: null } },
    label: "Interrupted",
    tone: "caution",
    pulse: false,
    primary: "newRun",
    secondary: [],
  },
  {
    name: "STOPPED → Start new run",
    args: { run: { state: "STOPPED", stopReason: "operator_stop", waitReason: null } },
    label: "Stopped",
    tone: "neutral",
    pulse: false,
    primary: "newRun",
    secondary: [],
  },
  {
    name: "COMPLETE → Start new run",
    args: { run: { state: "COMPLETE", stopReason: null, waitReason: null } },
    label: "Complete",
    tone: "success",
    pulse: false,
    primary: "newRun",
    secondary: [],
  },
];

for (const cell of TABLE) {
  test(`control table: ${cell.name}`, () => {
    const view = status(cell.args);
    assert.equal(view.label, cell.label, "label");
    assert.equal(view.tone, cell.tone, "tone");
    assert.equal(view.pulse, cell.pulse, "pulse");
    assert.equal(view.primary, cell.primary, "primary control");
    assert.deepEqual(view.secondary, cell.secondary, "secondary controls");
  });
}

test("every state offers at most one primary control, and never repeats it as secondary", () => {
  for (const cell of TABLE) {
    const view = status(cell.args);
    assert.ok(
      view.primary === null || !view.secondary.includes(view.primary),
      `${cell.name} lists its primary control twice`,
    );
    assert.equal(new Set(view.secondary).size, view.secondary.length, `${cell.name} has duplicate secondaries`);
  }
});

test("every control the table can emit has a label", () => {
  for (const cell of TABLE) {
    const view = status(cell.args);
    for (const control of [...(view.primary === null ? [] : [view.primary]), ...view.secondary]) {
      assert.ok(CONTROL_LABEL[control] !== undefined, `${control} has no label`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* D2: resumability is derived, not supplied                           */
/* ------------------------------------------------------------------ */

/*
 * `pipelineStatus` used to take a `resumable` boolean. A STOPPED or INTERRUPTED
 * run is never active and so was never resumable, which made two branches of
 * the old chain unrenderable. The argument is gone; these assert that the
 * contradiction it allowed cannot come back.
 */

test("a terminal run never offers Resume, whatever the station is doing", () => {
  const states = ["STOPPED", "INTERRUPTED", "COMPLETE"] as const;
  for (const state of states) {
    for (const stationState of [null, "RECOVERY_NEEDED", "AWAITING_RESPONSE", "READY"] as const) {
      const view = status({ run: { state, stopReason: null, waitReason: null }, stationState });
      assert.notEqual(view.primary, "resume", `${state}/${stationState} offered Resume`);
      assert.ok(!view.secondary.includes("resume"), `${state}/${stationState} offered Resume`);
    }
  }
});

test("recovery takes precedence over the ordinary blocked path", () => {
  const blocked = status({ run: { state: "WAITING_HUMAN", stopReason: null, waitReason: null }, stationState: "AWAITING_RESPONSE" });
  const dead = status({ run: { state: "WAITING_HUMAN", stopReason: null, waitReason: null }, stationState: "RECOVERY_NEEDED" });
  assert.equal(blocked.primary, "resume");
  assert.equal(dead.primary, "recover");
  assert.notEqual(blocked.rowId, dead.rowId);
});

test("every view names the row that produced it and explains itself", () => {
  for (const cell of TABLE) {
    const view = status(cell.args);
    assert.ok(view.rowId.length > 0, `${cell.name} has no row id`);
    assert.ok(view.because.length > 0, `${cell.name} has no because`);
    assert.ok(view.policy.reason.length > 0, `${cell.name} has no policy reason`);
  }
});

/* ------------------------------------------------------------------ */
/* Copy that the operator actually reads                               */
/* ------------------------------------------------------------------ */

test("the station label is interpolated into the headline", () => {
  assert.equal(
    status({ run: { state: "PLAYING", stopReason: null, waitReason: null } }).headline,
    `An agent is working ${STATION}.`,
  );
});

test("a missing station falls back to a generic phrase rather than 'null'", () => {
  const view = status({ run: { state: "PLAYING", stopReason: null, waitReason: null }, station: null });
  assert.equal(view.headline, "An agent is working the current station.");
  assert.ok(!view.headline.includes("null"));
});

test("WAITING_HUMAN says something different when an intervention is unanswered", () => {
  const onRule = status({ run: { state: "WAITING_HUMAN", stopReason: null, waitReason: null }, awaitingHuman: false });
  const onIntervention = status({ run: { state: "WAITING_HUMAN", stopReason: null, waitReason: null }, awaitingHuman: true });
  assert.notEqual(onRule.headline, onIntervention.headline);
  assert.notEqual(onRule.hint, onIntervention.hint);
  assert.match(onRule.headline, /reported blocked/);
  assert.match(onIntervention.headline, /only you can make/);
});

test("a known stopReason is translated into a sentence", () => {
  const view = status({ run: { state: "STOPPED", stopReason: "retry_exhausted", waitReason: null } });
  assert.equal(view.headline, "This run is stopped. A station ran out of retries.");
});

test("an unknown stopReason is passed through rather than dropped", () => {
  const view = status({ run: { state: "STOPPED", stopReason: "unexpected_status:WEIRD", waitReason: null } });
  assert.equal(view.headline, "This run is stopped. unexpected_status:WEIRD");
});

test("a null stopReason produces no trailing explanation", () => {
  const view = status({ run: { state: "STOPPED", stopReason: null, waitReason: null } });
  assert.equal(view.headline, "This run is stopped.");
});

/*
 * Every reason the scheduler can persist. If `terminate()` gains a new one and
 * this list is not updated, the operator sees a raw snake_case token in the UI.
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
    const view = status({ run: { state: "STOPPED", stopReason: reason, waitReason: null } });
    assert.notEqual(
      view.headline,
      `This run is stopped. ${reason}`,
      `${reason} has no sentence and would be shown raw`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* Chips and lookups the station cards render                          */
/* ------------------------------------------------------------------ */

test("every operational state has a label and a tone", () => {
  const states = Object.keys(LABEL) as Array<keyof typeof LABEL>;
  assert.equal(states.length, 8);
  for (const state of states) {
    assert.ok(LABEL[state].length > 0, `${state} has no label`);
    assert.ok(TONE[state] !== undefined, `${state} has no tone`);
  }
});

test("every pipeline state has a label and a tone", () => {
  const states = Object.keys(PIPELINE_LABEL) as Array<keyof typeof PIPELINE_LABEL>;
  assert.equal(states.length, 6);
  for (const state of states) {
    assert.ok(PIPELINE_LABEL[state].length > 0, `${state} has no label`);
    assert.ok(PIPELINE_TONE[state] !== undefined, `${state} has no tone`);
  }
});

test("onDone chips", () => {
  assert.equal(onDoneChip("continue"), "→ next");
  assert.equal(onDoneChip("stop"), "■ stop");
  assert.equal(onDoneChip("skip_rest"), "↛ skip rest");
});

function rule(over: Partial<PromptPipelineRule> = {}): PromptPipelineRule {
  return {
    promptId: 1,
    provider: null,
    model: null,
    onDone: "continue",
    onBlocked: "wait",
    retryLimit: 1,
    recoverProvider: null,
    recoverModel: null,
    enabled: true,
    stepOrder: 0,
    ...over,
  };
}

test("onBlocked chips, including the retry count and the recover agent", () => {
  assert.equal(onBlockedChip(rule({ onBlocked: "wait" })), "wait");
  assert.equal(onBlockedChip(rule({ onBlocked: "skip" })), "skip");
  assert.equal(onBlockedChip(rule({ onBlocked: "retry", retryLimit: 3 })), "retry · 3");
  assert.match(onBlockedChip(rule({ onBlocked: "recover", recoverProvider: "codex" })), /^recover · codex/);
  assert.equal(onBlockedChip(rule({ onBlocked: "recover", recoverProvider: null })), "recover · recover");
});

test("every onBlocked action renders a chip rather than falling through empty", () => {
  const actions: OnBlockedAction[] = ["wait", "retry", "recover", "skip"];
  for (const onBlocked of actions) {
    assert.ok(onBlockedChip(rule({ onBlocked })).length > 0, `${onBlocked} renders nothing`);
  }
});

test("an unset execute override renders no chip", () => {
  assert.equal(overrideChip(rule({ provider: null })), null);
  assert.match(overrideChip(rule({ provider: "claude" })) ?? "", /^claude/);
});
