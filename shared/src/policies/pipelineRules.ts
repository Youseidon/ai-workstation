import type { OnDoneAction, OnUnfinishedAction, PipelineState, PromptOperationalState, PromptPipelineRule } from "../contracts/pipeline.ts";
import type { ProviderId } from "../contracts/providers.ts";
import type { DodEnforcement, PolicyKey, RulePolicy, StatusTone } from "../models/statusModel.ts";

export type { PolicyKey, RulePolicy, StatusTone } from "../models/statusModel.ts";

export const PIPELINE_CONTROLS = ["play", "resume", "newRun", "recover", "pause", "stop"] as const;

export type PipelineControl = (typeof PIPELINE_CONTROLS)[number];

export const CONTROL_LABEL: Record<PipelineControl, string> = {
  play: "Play",
  resume: "Resume",
  newRun: "Start new run",
  recover: "Recover station",
  pause: "Pause",
  stop: "Stop",
};

export const PAUSE_MODES = ["graceful", "immediate"] as const;
export type PauseMode = (typeof PAUSE_MODES)[number];

export const RESTART_POLICIES = ["autoResume", "newRun", "resumeSameRun"] as const;
export type RestartPolicy = (typeof RESTART_POLICIES)[number];

export function isRestartPolicy(value: unknown): value is RestartPolicy {
  return typeof value === "string" && (RESTART_POLICIES as readonly string[]).includes(value);
}

export interface PipelinePolicy {
  pauseMode: PauseMode;
  stopInterruptsAgent: boolean;
  onRestart: RestartPolicy;
  maxContinuations: number;
  reviewAfterContinuations: boolean;
  dodEnforcement: DodEnforcement;
  defaultOnUnfinished: OnUnfinishedAction;
  defaultOnDone: OnDoneAction;
  fallbackProviders: ProviderId[];
}

export const DEFAULT_PIPELINE_POLICY: PipelinePolicy = {
  pauseMode: "graceful",
  stopInterruptsAgent: true,
  onRestart: "autoResume",
  maxContinuations: 4,
  reviewAfterContinuations: true,
  dodEnforcement: "block",
  defaultOnUnfinished: "continue",
  defaultOnDone: "continue",
  fallbackProviders: ["codex", "claude", "cursor"],
};

export interface RuleContext {
  runState: PipelineState | null;
  stationState: PromptOperationalState | null;
  station: string | null;
  stopReason: string | null;
  waitReason: string | null;
  awaitingHuman: boolean;
  agentActive: boolean;
  policy: PipelinePolicy;
}

export interface TransitionRow {
  id: string;
  when: {
    runState: PipelineState | null;
    agentActive?: boolean;
    awaitingHuman?: boolean;
    stationState?: PromptOperationalState;
    waitReason?: string;
    onRestart?: RestartPolicy;
  };

  condition: string;

  label: string;
  tone: StatusTone;
  pulse: boolean;
  primary: PipelineControl | null;
  secondary: readonly PipelineControl[];

  headline: (ctx: RuleContext) => string;
  hint: (ctx: RuleContext) => string | null;
  because: (ctx: RuleContext) => string;

  policy: RulePolicy;
}

export const STOP_REASON: Record<string, string> = {
  "execution:budget_exhausted": "The approved execution or recovery allowance is exhausted. Work is preserved. Resume cannot renew it; a new explicit allocation is required.",
  operator_stop: "You stopped it.",
  server_restart: "The server restarted mid-run.",
  nothing_ready: "Nothing on the flowchart was ready to run.",
  blocked_on_dependencies: "Every remaining station is waiting on another one.",
  on_done_stop: "A station's rule said stop when done.",
  skip_rest: "A station's rule skipped the rest of the stage.",
  no_provider: "A station had no agent assigned.",
  provider_unavailable: "The assigned agent hit a limit or could not run. Automatic reassignment is off. Choose another agent, enable automatic reassignment, or Resume to retry.",
  start_failed: "The agent process failed to start.",
  no_provider_available:
    "Every configured provider is unavailable or cooling. Resume tries them again now; assign another first if they are still out.",
  worktree_dirty:
    "The working tree has changes no agent run accounts for. Commit or stash them, then Resume.",
  start_refused: "The workspace refused the start before any agent ran.",
  human_question: "The agent asked a question only you can answer.",
  station_rule_wait: "This station's rule is to wait for you when it does not finish.",
  review_running: "A read-only reviewer is checking the station after its continuations ran out.",
  continuations_exhausted:
    "The station hit unfinished endings until its allowance ran out and is still not finished. Resume grants a fresh allowance.",
};

export function describeStopReason(reason: string | null): string | null {
  if (reason === null) return null;
  if (reason.startsWith(START_REFUSED_PREFIX)) {
    const code = reason.slice(START_REFUSED_PREFIX.length);
    return START_REFUSAL[code] ?? `${STOP_REASON.start_refused} (${code})`;
  }
  return STOP_REASON[reason] ?? reason;
}

const START_REFUSED_PREFIX = "start_refused:";

const START_REFUSAL: Record<string, string> = {
  git_repository_busy: "Another agent is still writing in this Git repository.",
  workspace_busy: "Another run is already in progress in this workspace.",
  prompt_run_active: "This work item still has a live agent session. Stop it on the Sessions page, then Resume.",
  git_operation_failed:
    "Git could not commit the work the last run left behind — a commit hook rejecting it, most likely. Commit it by hand in the workspace.",
  git_history_rewritten:
    "The branch no longer descends from where the last run started, so its leftover work cannot be committed for it. Restore the branch or commit by hand.",
  git_repository_required: "The workspace directory is not a Git repository.",
  git_initial_commit_required: "The workspace's Git repository has no commits yet.",
  invalid_directory: "The workspace directory no longer exists.",
};

function waitKind(reason: string | null): string | null {
  return reason !== null && reason.startsWith(START_REFUSED_PREFIX) ? "start_refused" : reason;
}

function where(ctx: RuleContext): string {
  return ctx.station === null ? "the current station" : ctx.station;
}

function endedAs(ctx: RuleContext): string {
  switch (ctx.stationState) {
    case "BLOCKED":
      return "reported blocked";
    case "UNREPORTED":
      return "ended without reporting a status";
    case "FAILED":
      return "failed";
    case "NEEDS_REVIEW":
      return "was left needing review";
    default:
      return "did not finish";
  }
}

const LOCKED_RUNNING =
  "A running pipeline can only be paused or stopped. Starting anything else would put a "
  + "second agent in the same working directory, which the workspace lock refuses anyway.";

const LOCKED_TERMINAL =
  "A finished run is history. A new run picks up only unfinished stations, so nothing "
  + "already done is repeated.";

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
    id: "waiting-execution-budget",
    when: { runState: "WAITING_HUMAN", waitReason: "execution:budget_exhausted" },
    condition: "Approved execution or recovery allowance exhausted",
    label: "Allowance exhausted",
    tone: "warning",
    pulse: false,
    primary: null,
    secondary: ["stop"],
    headline: (ctx) => `${where(ctx)} reached its approved execution or recovery limit.`,
    hint: () => "Work is preserved. Review the execution exception and approve a new allocation before restarting. Resume cannot renew the allowance.",
    because: () => STOP_REASON["execution:budget_exhausted"]!,
    policy: { kind: "locked", reason: "Play and Resume retain all recorded consumption and cannot renew an exhausted approved allowance." },
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
    id: "waiting-human-question",
    when: { runState: "WAITING_HUMAN", waitReason: "human_question" },
    condition: "Blocked · the agent asked a question",
    label: "Needs you",
    tone: "warning",
    pulse: true,
    primary: "resume",
    secondary: ["stop"],
    headline: (ctx) => `${where(ctx)} asked a question only you can answer.`,
    hint: () => "Answer it — post a response, then Resume.",
    because: (ctx) => `${where(ctx)} stopped and reported BLOCKED with a specific question for you.`,
    policy: {
      kind: "locked",
      reason: "An agent's question is never continued automatically — it is the one thing that always parks for a human.",
    },
  },
  {
    id: "waiting-human-review-running",
    when: { runState: "WAITING_HUMAN", waitReason: "review_running" },
    condition: "Parked · a reviewer is checking whether the work is finished",
    label: "Checking",
    tone: "info",
    pulse: true,
    primary: "resume",
    secondary: ["stop"],
    headline: (ctx) =>
      `${where(ctx)} ${endedAs(ctx)} after using up its continuations. A read-only agent is checking whether the work is actually finished.`,
    hint: () => "Nothing is needed yet — the rail acts on the verdict by itself. Resume overrides it.",
    because: (ctx) =>
      `${where(ctx)} hit automatic continuations the full number of times its allowance permits, so a reviewer is checking it before the run parks.`,
    policy: {
      kind: "setting",
      key: "pipeline.maxContinuations",
      reason: "Whether a reviewer is sent once a station's continuations run out is a house rule.",
    },
  },
  {
    id: "waiting-human-continuations-exhausted",
    when: { runState: "WAITING_HUMAN", waitReason: "continuations_exhausted" },
    condition: "Blocked · continued repeatedly and still not finished",
    label: "Needs you",
    tone: "warning",
    pulse: true,
    primary: "resume",
    secondary: ["stop"],
    headline: (ctx) => `${where(ctx)} hit unfinished endings repeatedly and is still not finished.`,
    hint: () => "Resume re-queues the station with a fresh automatic-continuation allowance. No separate fix is required unless a real blocker is in the last brief.",
    because: (ctx) =>
      `${where(ctx)} ${endedAs(ctx)} with work remaining (CONTINUE, crash, unreported, or verification failure) until its automatic continuations allowance ran out.`,
    policy: {
      kind: "setting",
      key: "pipeline.maxContinuations",
      reason: "How many times a station is re-run on its own before it parks here is a house rule.",
    },
  },
  {
    id: "waiting-human-provider-unavailable",
    when: { runState: "WAITING_HUMAN", waitReason: "provider_unavailable" },
    condition: "Blocked · assigned agent unavailable; automatic reassignment off",
    label: "Needs you",
    tone: "warning",
    pulse: true,
    primary: "resume",
    secondary: ["stop"],
    headline: (ctx) => `${where(ctx)}'s assigned agent hit a limit or could not run.`,
    hint: () => "Choose another agent in Agent assignments or enable automatic reassignment, then Resume. Resume alone retries the assigned agent.",
    because: () => "Automatic reassignment is off for this pipeline, so the assigned agent was kept.",
    policy: { kind: "locked", reason: "Enable automatic reassignment in this pipeline's Agent assignments to allow provider changes." },
  },
  {
    id: "waiting-human-no-provider-available",
    when: { runState: "WAITING_HUMAN", waitReason: "no_provider_available" },
    condition: "Blocked · every provider is unavailable or cooling",
    label: "Needs you",
    tone: "warning",
    pulse: true,
    primary: "resume",
    secondary: ["stop"],
    headline: (ctx) =>
      `${where(ctx)} could not start: every configured provider is unavailable or cooling.`,
    hint: () => "Resume tries every provider again now. If they are still out, assign another first.",
    because: () =>
      "The station's provider and every fallback on its list are cooling or unavailable, so nothing could be started.",
    policy: {
      kind: "locked",
      reason: "With no agent that can run, the rail has nowhere to go until a provider recovers or you change the list.",
    },
  },
  {
    id: "waiting-human-worktree-dirty",
    when: { runState: "WAITING_HUMAN", waitReason: "worktree_dirty" },
    condition: "Blocked · the working tree has changes no run accounts for",
    label: "Needs you",
    tone: "warning",
    pulse: true,
    primary: "resume",
    secondary: ["stop"],
    headline: (ctx) =>
      `${where(ctx)} could not start: the working tree has changes no agent run accounts for.`,
    hint: () => "Commit or stash them in the workspace, then Resume.",
    because: () =>
      "Every run starts from a clean tree so that its commits are its own. Work an interrupted run left behind is committed for it automatically; these changes were made outside any run.",
    policy: {
      kind: "locked",
      reason: "A run started on top of someone else's uncommitted changes could not say which changes were its own.",
    },
  },
  {
    id: "waiting-human-start-refused",
    when: { runState: "WAITING_HUMAN", waitReason: "start_refused" },
    condition: "Blocked · the workspace refused the start",
    label: "Needs you",
    tone: "warning",
    pulse: true,
    primary: "resume",
    secondary: ["stop"],
    headline: (ctx) => `${where(ctx)} could not start. ${describeStopReason(ctx.waitReason) ?? STOP_REASON.start_refused}`,
    hint: () => "Clear what is in the way, then Resume — it is tried again from this station.",
    because: (ctx) =>
      `The workspace refused the start before any agent ran, so no provider was at fault and none was swapped. ${describeStopReason(ctx.waitReason) ?? ""}`.trim(),
    policy: {
      kind: "locked",
      reason: "Nothing can run in a workspace that refuses a writer, whichever provider is asked.",
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
    headline: (ctx) => {
      const parked = describeStopReason(ctx.waitReason);
      return parked === null
        ? `${where(ctx)} ${endedAs(ctx)}, and its rule is "wait".`
        : `${where(ctx)} ${endedAs(ctx)}. ${parked}`;
    },
    hint: () => "Clear whatever stopped it, then Resume to retry from this station.",
    because: (ctx) => {
      const parked = describeStopReason(ctx.waitReason);
      return parked === null
        ? `${where(ctx)} ${endedAs(ctx)}, and its "on unfinished" rule is "wait".`
        : `${where(ctx)} ${endedAs(ctx)}. ${parked}`;
    },
    policy: {
      kind: "stationRule",
      field: "onUnfinished",
      reason: "This station's rule chose to wait. Continue or skip would have done something else first.",
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
    id: "interrupted-auto-resume",
    when: { runState: "INTERRUPTED", onRestart: "autoResume" },
    condition: "Interrupted · resuming by itself",
    label: "Resuming",
    tone: "info",
    pulse: true,
    primary: "stop",
    secondary: [],
    headline: () => "The server restarted; this run is being picked back up automatically.",
    hint: () => "Stop cancels the automatic resume and leaves the station exactly where it is.",
    because: () =>
      "The server restarted while this run was holding a station, and your restart policy is to resume by itself.",
    policy: {
      kind: "setting",
      key: "pipeline.onRestart",
      reason: "Your restart policy resumes an interrupted run without waiting for you.",
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

const FALLBACK: TransitionRow = TRANSITIONS[TRANSITIONS.length - 1]!;

function matches(row: TransitionRow, ctx: RuleContext): boolean {
  const { when } = row;
  if (when.runState !== ctx.runState) return false;
  if (when.agentActive !== undefined && when.agentActive !== ctx.agentActive) return false;
  if (when.awaitingHuman !== undefined && when.awaitingHuman !== ctx.awaitingHuman) return false;
  if (when.stationState !== undefined && when.stationState !== ctx.stationState) return false;
  if (when.waitReason !== undefined && when.waitReason !== waitKind(ctx.waitReason)) return false;
  if (when.onRestart !== undefined && when.onRestart !== ctx.policy.onRestart) return false;
  return true;
}

export function matchTransition(ctx: RuleContext): TransitionRow {
  return TRANSITIONS.find((row) => matches(row, ctx)) ?? FALLBACK;
}

function offers(row: TransitionRow): string {
  const controls = [...(row.primary === null ? [] : [row.primary]), ...row.secondary].map(
    (control) => CONTROL_LABEL[control],
  );
  if (controls.length === 0) return "";
  if (controls.length === 1) return ` You get ${controls[0]}.`;
  return ` You get ${controls.slice(0, -1).join(", ")} and ${controls[controls.length - 1]}.`;
}

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

export function onDoneConsequence(action: OnDoneAction, policy: PipelinePolicy): string {
  if (action === "stop") return landsIn(policy, "STOPPED", "Ends the run");
  if (action === "skip_rest") {
    return landsIn(policy, "STOPPED", "Marks every later station SKIPPED and ends the run");
  }
  return "The rail moves on to the next ready station.";
}

export function onUnfinishedConsequence(
  rule: Pick<PromptPipelineRule, "onUnfinished">,
  policy: PipelinePolicy,
): string {
  if (rule.onUnfinished === "wait") {
    return "Does not stop the pipeline. A wait-for-a-person rule is ignored and the station keeps going.";
  }
  if (rule.onUnfinished === "skip") {
    return "Marks this station SKIPPED and carries on. Anything depending on it stays blocked.";
  }
  const times = policy.maxContinuations === 1 ? "once" : `up to ${policy.maxContinuations} times`;
  const after = policy.reviewAfterContinuations
    ? "then a read-only reviewer checks it before the run parks for you"
    : "then parks for you";
  return landsIn(
    policy,
    "WAITING_HUMAN",
    `Re-queues on the same tree; an agent's own continue keeps going, unfinished endings (crash/unreported) are capped ${times}, ${after}`,
    { waitReason: "continuations_exhausted" },
  );
}
