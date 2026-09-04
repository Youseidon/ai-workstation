/**
 * The pipeline transport interlocking: which controls a run offers, and why.
 *
 * This is deliberately *data* rather than a chain of `if`s. A chain can be
 * executed but not inspected — it cannot be rendered as a table, enumerated by
 * a test, or pointed at by a settings screen. Every one of those is something
 * the app needs, and keeping four hand-written copies of the same rules in
 * sync is what made the transport controls regress repeatedly.
 *
 * Rows are ordered and the first match wins, exactly like the `if` chain this
 * replaces. Add a row above the one it should pre-empt.
 */

import type {
  OnBlockedAction,
  OnDoneAction,
  PipelineState,
  PromptOperationalState,
  PromptPipelineRule,
} from "./index";
import type { PolicyKey, RulePolicy, StatusTone } from "./statusModel";

/**
 * The tone and rule-policy vocabularies moved to `statusModel`, which sits
 * below this module so a status can describe itself without depending on the
 * transport interlocking. Re-exported here so existing importers do not care.
 */
export type { PolicyKey, RulePolicy, StatusTone } from "./statusModel";

export const PIPELINE_CONTROLS = ["play", "resume", "newRun", "recover", "pause", "stop"] as const;

/**
 * The controls a pipeline can offer. Exactly one is ever primary, so a header
 * never presents two equally-weighted "do something" buttons.
 */
export type PipelineControl = (typeof PIPELINE_CONTROLS)[number];

export const CONTROL_LABEL: Record<PipelineControl, string> = {
  play: "Play",
  resume: "Resume",
  newRun: "Start new run",
  recover: "Recover station",
  pause: "Pause",
  stop: "Stop",
};

/* ------------------------------------------------------------------ */
/* Operator-settable policy                                            */
/* ------------------------------------------------------------------ */

export const PAUSE_MODES = ["graceful", "immediate"] as const;
export type PauseMode = (typeof PAUSE_MODES)[number];

export const HANDOFF_REQUIREMENTS = ["whenWorkProduced", "always", "never"] as const;
export type HandoffRequirement = (typeof HANDOFF_REQUIREMENTS)[number];

export const RESTART_POLICIES = ["newRun", "resumeSameRun"] as const;
export type RestartPolicy = (typeof RESTART_POLICIES)[number];

/**
 * What happens when a station blocks because its run ended without ever
 * posting DONE or BLOCKED — a dropped status post, not an agent asking a
 * question. "off" keeps the old behaviour. "report" sends a read-only auditor
 * to say whether the work was actually finished, and still parks for you.
 * "autocomplete" additionally lets a COMPLETE verdict close the station so an
 * unattended pipeline keeps moving.
 */
export const AUDIT_ON_BLOCKED_MODES = ["off", "report", "autocomplete"] as const;
export type AuditOnBlockedMode = (typeof AUDIT_ON_BLOCKED_MODES)[number];

export function isAuditOnBlockedMode(value: unknown): value is AuditOnBlockedMode {
  return typeof value === "string" && (AUDIT_ON_BLOCKED_MODES as readonly string[]).includes(value);
}

/**
 * House rules for how a pipeline behaves, resolved on the server from settings
 * and shipped to the client with the operations snapshot so that both sides
 * decide from the same values.
 *
 * Every field here is honoured by code today. A switch that changes nothing is
 * worse than a missing one, so a policy field lands in the same change as the
 * behaviour it governs.
 */
export interface PipelinePolicy {
  /** Whether Pause lets the running agent finish, or interrupts it. */
  pauseMode: PauseMode;
  /** Whether Stop also interrupts the agent that is running right now. */
  stopInterruptsAgent: boolean;
  /** What a run interrupted by a server restart offers when you come back. */
  onRestart: RestartPolicy;
  /** When resuming a station should first prepare a continuation brief. */
  handoffRequirement: HandoffRequirement;
  /** Whether a station that blocks summons a handoff agent instead of just parking. */
  autoHandoffOnBlocked: boolean;
  /** Whether a station blocked by a missing status post is audited before anything else. */
  auditOnBlocked: AuditOnBlockedMode;
  /** Hard cap on handoff generations for one station. */
  maxHandoffGenerations: number;
  /** The rule a station gets before anyone configures it. */
  defaultOnBlocked: OnBlockedAction;
  defaultOnDone: OnDoneAction;
}

export const DEFAULT_PIPELINE_POLICY: PipelinePolicy = {
  pauseMode: "graceful",
  stopInterruptsAgent: true,
  onRestart: "newRun",
  handoffRequirement: "whenWorkProduced",
  autoHandoffOnBlocked: false,
  auditOnBlocked: "autocomplete",
  maxHandoffGenerations: 3,
  defaultOnBlocked: "wait",
  defaultOnDone: "continue",
};

/**
 * Whether resuming this station should offer to prepare a handoff first.
 *
 * The question is not "is the station unfinished" — a station reset to TODO by
 * a retry is unfinished and has nothing to summarise. It is "did a previous run
 * leave work that a successor must not redo".
 */
export function handoffRequired(args: {
  policy: PipelinePolicy;
  /** A developer run has been recorded against this station before. */
  hasPriorRun: boolean;
  /** That run made at least one tool call. */
  producedWork: boolean;
}): boolean {
  if (!args.hasPriorRun) return false;
  if (args.policy.handoffRequirement === "never") return false;
  if (args.policy.handoffRequirement === "always") return true;
  return args.producedWork;
}

/** Everything a row is allowed to look at, both to match and to explain itself. */
export interface RuleContext {
  runState: PipelineState | null;
  /**
   * Operational state of the station the run is sitting on, or null when it is
   * not sitting on one. This is what lets a row tell "the run stopped" apart
   * from "the run stopped and its station needs recovering", which want very
   * different buttons.
   */
  stationState: PromptOperationalState | null;
  /** Where the run sits, e.g. "S6 · S6-07 · S6-07.2". */
  station: string | null;
  stopReason: string | null;
  /** Why a live run is parked, when the scheduler recorded one (D5). */
  waitReason: string | null;
  /** A human-intervention step on the current station is still unanswered. */
  awaitingHuman: boolean;
  /** The scheduler is paused, but its already-started agent is still draining. */
  agentActive: boolean;
  /** House rules in force. Rows read it so their copy matches what will happen. */
  policy: PipelinePolicy;
}

export interface TransitionRow {
  /** Stable id: a React key, a test label, and a policy anchor. */
  id: string;
  /**
   * Condition. `runState` is required so that "no run yet" (`null`) is never
   * confused with "don't care"; every other field is optional and an omitted
   * one matches anything.
   */
  when: {
    runState: PipelineState | null;
    agentActive?: boolean;
    awaitingHuman?: boolean;
    stationState?: PromptOperationalState;
    /** Matched against `policy.onRestart`, so a policy choice is a visible row. */
    onRestart?: RestartPolicy;
  };

  /**
   * When this row applies, as a short phrase. Declared rather than derived from
   * `when`, because the rules panel renders it verbatim and two rows can share
   * a `label` ("Needs you") while describing very different situations.
   */
  condition: string;

  /* The decision itself — static, so it can be rendered as a table cell. */
  label: string;
  tone: StatusTone;
  pulse: boolean;
  primary: PipelineControl | null;
  secondary: readonly PipelineControl[];

  /* The prose — a function, because it names the station and the reason. */
  /** One sentence: what the pipeline is doing right now. */
  headline: (ctx: RuleContext) => string;
  /** One sentence: what happens if you press the primary control. */
  hint: (ctx: RuleContext) => string | null;
  /** One sentence: what put the run in this state. */
  because: (ctx: RuleContext) => string;

  policy: RulePolicy;
}

/** Human sentences for the reasons the scheduler persists on a finished run. */
export const STOP_REASON: Record<string, string> = {
  operator_stop: "You stopped it.",
  server_restart: "The server restarted mid-run.",
  nothing_ready: "Nothing on the flowchart was ready to run.",
  blocked_on_dependencies: "Every remaining station is waiting on another one.",
  on_done_stop: "A station's rule said stop when done.",
  skip_rest: "A station's rule skipped the rest of the stage.",
  retry_exhausted: "A station ran out of retries.",
  recover_exhausted: "Recovery did not clear the block.",
  no_provider: "A station had no agent assigned.",
  handoff_running: "A handoff agent is summarising what the run left behind.",
  audit_running: "A read-only agent is checking whether the run actually finished the work.",
  audit_incomplete: "An audit found the work genuinely unfinished.",
  audit_unverifiable: "An audit could not confirm the work either way.",
  start_failed: "The agent process failed to start.",
};

/**
 * A stop reason as a sentence. An unrecognised reason is passed through rather
 * than dropped: a raw token in the UI is ugly, but silence is worse.
 */
export function describeStopReason(reason: string | null): string | null {
  if (reason === null) return null;
  return STOP_REASON[reason] ?? reason;
}

/** Where the run sits, in a form safe to drop into a sentence. */
function where(ctx: RuleContext): string {
  return ctx.station === null ? "the current station" : ctx.station;
}

const LOCKED_RUNNING =
  "A running pipeline can only be paused or stopped. Starting anything else would put a "
  + "second agent in the same working directory, which the workspace lock refuses anyway.";

const LOCKED_TERMINAL =
  "A finished run is history. A new run picks up only unfinished stations, so nothing "
  + "already done is repeated.";

/**
 * The interlocking, in order. First match wins.
 *
 * Rows are split so that every variation is its own row — the point is that a
 * reader can see each distinct outcome, rather than a ternary buried in one.
 */
export const TRANSITIONS: readonly TransitionRow[] = [
  {
    id: "not-started",
    when: { runState: null },
    condition: "No run yet",
    label: "Not started",
    tone: "neutral",
    pulse: false,
    primary: "play",
    secondary: [],
    headline: () => "This pipeline has never run.",
    hint: () => "Play walks every stage in order, one station at a time.",
    because: () => "No run has been started for this pipeline yet.",
    policy: { kind: "locked", reason: "Play is the only thing a pipeline that has never run can do." },
  },
  {
    id: "playing",
    when: { runState: "PLAYING" },
    condition: "An agent is working",
    label: "Running",
    tone: "info",
    pulse: true,
    primary: "pause",
    secondary: ["stop"],
    headline: (ctx) => `An agent is working ${where(ctx)}.`,
    hint: (ctx) =>
      ctx.policy.pauseMode === "immediate"
        ? "Pause interrupts the agent now and holds. Stop does the same and ends the run."
        : "Pause lets the current station finish, then holds. Stop interrupts it now.",
    because: (ctx) => `An agent is holding ${where(ctx)} right now.`,
    policy: { kind: "locked", reason: LOCKED_RUNNING },
  },
  {
    id: "pausing",
    when: { runState: "PAUSED", agentActive: true },
    condition: "Paused · the agent is still finishing",
    label: "Pausing",
    tone: "caution",
    pulse: true,
    primary: "stop",
    secondary: [],
    headline: (ctx) => `The agent is finishing ${where(ctx)}; no new step will start.`,
    hint: () => "Pause is graceful: it lets the current agent finish. Use Stop to interrupt it now.",
    because: (ctx) =>
      `You paused while an agent was working ${where(ctx)}. Pause is graceful, so it finishes first.`,
    policy: {
      kind: "setting",
      key: "pipeline.pauseMode",
      reason: "This state only exists because Pause is graceful. An immediate Pause would skip it.",
    },
  },
  {
    id: "paused",
    when: { runState: "PAUSED", agentActive: false },
    condition: "Paused and idle",
    label: "Paused",
    tone: "caution",
    pulse: false,
    primary: "resume",
    secondary: ["stop"],
    headline: (ctx) => `Holding at ${where(ctx)}. Nothing new will start.`,
    hint: () => "Resume picks the rail back up from here.",
    because: (ctx) => `You paused the run, and no agent is working ${where(ctx)} now.`,
    policy: { kind: "locked", reason: "A held run can only be continued or ended." },
  },
  {
    id: "waiting-human-recovery",
    when: { runState: "WAITING_HUMAN", stationState: "RECOVERY_NEEDED" },
    condition: "Blocked · the station lost its agent",
    label: "Recovery needed",
    tone: "caution",
    pulse: false,
    primary: "recover",
    secondary: ["stop"],
    headline: (ctx) => `${where(ctx)} lost its agent before it reported anything.`,
    hint: () => "Recover clears the dead run and puts the station back to TODO, keeping its work. Then the rail can start it again.",
    because: (ctx) =>
      `${where(ctx)}'s agent process ended without posting a status, so the rail cannot tell whether it finished.`,
    policy: {
      kind: "locked",
      reason: "A station whose run died has to be recovered before anything can start it again.",
    },
  },
  {
    id: "waiting-human-intervention",
    when: { runState: "WAITING_HUMAN", awaitingHuman: true },
    condition: "Blocked · your answer is needed",
    label: "Needs you",
    tone: "warning",
    pulse: true,
    primary: "resume",
    secondary: ["stop"],
    headline: (ctx) => `${where(ctx)} is blocked on a decision only you can make.`,
    hint: () => "Answer the Human intervention card below — Resume unlocks once it is answered.",
    because: (ctx) => `${where(ctx)} raised a question that only you can answer.`,
    policy: {
      kind: "locked",
      reason: "The station asked for a specific human decision; nothing else can supply it.",
    },
  },
  {
    id: "waiting-human-rule",
    when: { runState: "WAITING_HUMAN" },
    condition: "Blocked · the station's rule says wait",
    label: "Needs you",
    tone: "warning",
    pulse: true,
    primary: "resume",
    secondary: ["stop"],
    headline: (ctx) => `${where(ctx)} reported blocked, and its rule is "wait".`,
    hint: () => "Clear whatever blocked it, then Resume to retry from this station.",
    because: (ctx) => {
      const parked = describeStopReason(ctx.waitReason);
      return parked === null
        ? `${where(ctx)} posted BLOCKED, and its "on blocked" rule is "wait".`
        : `${where(ctx)} posted BLOCKED. ${parked}`;
    },
    policy: {
      kind: "stationRule",
      field: "onBlocked",
      reason: "This station's rule chose to wait. Retry, recover or skip would not stop here.",
    },
  },
  {
    id: "interrupted-recovery",
    when: { runState: "INTERRUPTED", stationState: "RECOVERY_NEEDED" },
    condition: "Interrupted · the station lost its agent",
    label: "Recovery needed",
    tone: "caution",
    pulse: false,
    primary: "recover",
    secondary: ["newRun"],
    headline: (ctx) => `${where(ctx)} was left mid-run and has to be recovered first.`,
    hint: () => "Recover clears the dead run and puts the station back to TODO, keeping its work. Then the rail can start it again.",
    because: () => "The server restarted while this station's agent was working, so its status was never posted.",
    policy: {
      kind: "locked",
      reason: "A new run cannot start a station that is still marked as running from a dead process.",
    },
  },
  {
    id: "interrupted-resume",
    when: { runState: "INTERRUPTED", onRestart: "resumeSameRun" },
    condition: "Interrupted · set to continue the same run",
    label: "Interrupted",
    tone: "caution",
    pulse: false,
    primary: "resume",
    secondary: [],
    headline: () => "This run ended mid-flight — the server restarted while an agent was working.",
    hint: () => "Resume picks this same run back up at its current station.",
    because: () => "The server restarted while this run was holding a station.",
    policy: {
      kind: "setting",
      key: "pipeline.onRestart",
      reason: "Your restart policy is to continue the interrupted run rather than start a fresh one.",
    },
  },
  {
    id: "interrupted",
    when: { runState: "INTERRUPTED" },
    condition: "Interrupted by a server restart",
    label: "Interrupted",
    tone: "caution",
    pulse: false,
    primary: "newRun",
    secondary: [],
    headline: () => "This run ended mid-flight — the server restarted while an agent was working.",
    hint: () => "Play starts a fresh run from the first unfinished station.",
    because: () => "The server restarted while this run was holding a station.",
    policy: {
      kind: "setting",
      key: "pipeline.onRestart",
      reason: "What an interrupted run offers is a policy choice, not a fixed rule.",
    },
  },
  {
    id: "stopped-recovery",
    when: { runState: "STOPPED", stationState: "RECOVERY_NEEDED" },
    condition: "Stopped · the station lost its agent",
    label: "Recovery needed",
    tone: "caution",
    pulse: false,
    primary: "recover",
    secondary: ["newRun"],
    headline: (ctx) => `${where(ctx)} was left mid-run and has to be recovered first.`,
    hint: () => "Recover clears the dead run and puts the station back to TODO, keeping its work. Then the rail can start it again.",
    because: () => "The run stopped while this station's agent was working, so its status was never posted.",
    policy: {
      kind: "locked",
      reason: "A new run cannot start a station that is still marked as running from a dead process.",
    },
  },
  {
    id: "stopped",
    when: { runState: "STOPPED" },
    condition: "Stopped",
    label: "Stopped",
    tone: "neutral",
    pulse: false,
    primary: "newRun",
    secondary: [],
    headline: (ctx) => stoppedHeadline(ctx),
    hint: () =>
      "Starting a new run picks up from the first unfinished station; finished work is not repeated.",
    because: (ctx) => stoppedBecause(ctx),
    policy: { kind: "locked", reason: LOCKED_TERMINAL },
  },
  {
    id: "complete",
    when: { runState: "COMPLETE" },
    condition: "Complete",
    label: "Complete",
    tone: "success",
    pulse: false,
    primary: "newRun",
    secondary: [],
    headline: () => "Every stage on this pipeline finished.",
    hint: () => "A new run only picks up work that is still unfinished.",
    because: () => "Every station on every stage reached DONE or SKIPPED.",
    policy: { kind: "locked", reason: LOCKED_TERMINAL },
  },
];

function stoppedHeadline(ctx: RuleContext): string {
  const reason = describeStopReason(ctx.stopReason);
  return reason === null ? "This run is stopped." : `This run is stopped. ${reason}`;
}

function stoppedBecause(ctx: RuleContext): string {
  const reason = describeStopReason(ctx.stopReason);
  return reason === null ? "The run reached a stop with no reason recorded." : reason;
}

/** The last row, used when nothing matches. Never null, so callers need no guard. */
const FALLBACK: TransitionRow = TRANSITIONS[TRANSITIONS.length - 1]!;

function matches(row: TransitionRow, ctx: RuleContext): boolean {
  const { when } = row;
  if (when.runState !== ctx.runState) return false;
  if (when.agentActive !== undefined && when.agentActive !== ctx.agentActive) return false;
  if (when.awaitingHuman !== undefined && when.awaitingHuman !== ctx.awaitingHuman) return false;
  if (when.stationState !== undefined && when.stationState !== ctx.stationState) return false;
  if (when.onRestart !== undefined && when.onRestart !== ctx.policy.onRestart) return false;
  return true;
}

/**
 * The one place that decides which controls a run offers. Both the client (to
 * render) and the server (to validate a request) go through here, so a control
 * the table hides can never be accepted by an endpoint.
 */
export function matchTransition(ctx: RuleContext): TransitionRow {
  return TRANSITIONS.find((row) => matches(row, ctx)) ?? FALLBACK;
}

/* ------------------------------------------------------------------ */
/* What a station rule leads to                                        */
/* ------------------------------------------------------------------ */

/** "You get Resume and Stop." — the controls a row offers, in prose. */
function offers(row: TransitionRow): string {
  const controls = [...(row.primary === null ? [] : [row.primary]), ...row.secondary].map(
    (control) => CONTROL_LABEL[control],
  );
  if (controls.length === 0) return "";
  if (controls.length === 1) return ` You get ${controls[0]}.`;
  return ` You get ${controls.slice(0, -1).join(", ")} and ${controls[controls.length - 1]}.`;
}

/**
 * Where a rule lands the run, plus the controls the operator will then have.
 * The clause is written here, but the controls come from the row that state
 * matches — so a change to the table updates this copy automatically, and the
 * promise made in the editor cannot drift from what the status bar later says.
 */
function landsIn(
  policy: PipelinePolicy,
  runState: PipelineState,
  clause: string,
  reason: { stopReason?: string | null; waitReason?: string | null } = {},
): string {
  const row = matchTransition({
    runState,
    stationState: null,
    station: null,
    stopReason: reason.stopReason ?? null,
    waitReason: reason.waitReason ?? null,
    awaitingHuman: false,
    agentActive: false,
    policy,
  });
  const why = describeStopReason(reason.stopReason ?? reason.waitReason ?? null);
  const because = why === null ? "" : ` ${why}`;
  return `${clause}.${because}${offers(row)}`;
}

/**
 * What choosing this "on done" rule will actually do, phrased with the same
 * words the status bar will use when it happens.
 */
export function onDoneConsequence(action: OnDoneAction, policy: PipelinePolicy): string {
  // No stop reason passed: the clause already says what the status bar would,
  // and repeating it reads as padding.
  if (action === "stop") return landsIn(policy, "STOPPED", "Ends the run");
  if (action === "skip_rest") {
    return landsIn(policy, "STOPPED", "Marks every later station SKIPPED and ends the run");
  }
  return "The rail moves on to the next ready station.";
}

/** The same, for "on blocked". */
export function onBlockedConsequence(
  rule: Pick<PromptPipelineRule, "onBlocked" | "retryLimit" | "recoverProvider">,
  policy: PipelinePolicy,
): string {
  if (rule.onBlocked === "wait") return landsIn(policy, "WAITING_HUMAN", "Parks the run and waits for you");
  if (rule.onBlocked === "retry") {
    const times = rule.retryLimit === 1 ? "once" : `up to ${rule.retryLimit} times`;
    return landsIn(policy, "WAITING_HUMAN", `Restarts this station ${times}, then parks for you`, {
      waitReason: "retry_exhausted",
    });
  }
  if (rule.onBlocked === "recover") {
    const who = rule.recoverProvider ?? "the recovery agent";
    return landsIn(policy, "STOPPED", `Hands the station to ${who} for one attempt`, {
      stopReason: "recover_exhausted",
    });
  }
  return "Marks this station SKIPPED and carries on. Anything depending on it stays blocked.";
}

