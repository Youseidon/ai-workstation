import type {
  OperationsPrompt,
  PipelineControl,
  PipelineRun,
  PipelineState,
  PipelinePolicy,
  PolicyKey,
  PromptOperationalState,
  PromptPipelineRule,
  OnDoneAction,
  RuleContext,
  RulePolicy,
  SuitePipelineRun,
  TransitionRow,
} from "@agent-console/shared";
import {
  CONTROL_LABEL,
  DEFAULT_PIPELINE_POLICY,
  PIPELINE_CONTROLS,
  STOP_REASON,
  TRANSITIONS,
  describeStopReason,
  matchTransition,
  modelLabel,
} from "@agent-console/shared";
import type { Tone } from "@/components/ui/Badge";
import type { RunStatus } from "@/lib/agentConsole";

export const LABEL: Record<PromptOperationalState, string> = {
  WORKING: "Agent working",
  AWAITING_RESPONSE: "Needs response",
  RECOVERY_NEEDED: "Recovery needed",
  FAILED: "Failed",
  READY: "Ready",
  WAITING_DEPENDENCY: "Waiting",
  COMPLETE: "Complete",
  SKIPPED: "Skipped",
};

export const TONE: Record<PromptOperationalState, Tone> = {
  WORKING: "info",
  AWAITING_RESPONSE: "warning",
  RECOVERY_NEEDED: "caution",
  FAILED: "danger",
  READY: "accent",
  WAITING_DEPENDENCY: "neutral",
  COMPLETE: "success",
  SKIPPED: "neutral",
};

export function onDoneChip(action: OnDoneAction): string {
  if (action === "continue") return "→ next";
  if (action === "stop") return "■ stop";
  return "↛ skip rest";
}

export function onBlockedChip(rule: PromptPipelineRule): string {
  if (rule.onBlocked === "wait") return "wait";
  if (rule.onBlocked === "retry") return `retry · ${rule.retryLimit}`;
  if (rule.onBlocked === "skip") return "skip";
  const who = rule.recoverProvider ?? "recover";
  const model = rule.recoverProvider === null ? null : modelLabel(rule.recoverProvider, rule.recoverModel);
  return model === null ? `recover · ${who}` : `recover · ${who} · ${model}`;
}

export function overrideChip(rule: PromptPipelineRule): string | null {
  if (rule.provider === null) return null;
  const model = modelLabel(rule.provider, rule.model);
  return model === null ? rule.provider : `${rule.provider} · ${model}`;
}

export const PIPELINE_LABEL: Record<PipelineState, string> = {
  PLAYING: "running",
  WAITING_HUMAN: "blocked",
  PAUSED: "paused",
  COMPLETE: "complete",
  STOPPED: "stopped",
  INTERRUPTED: "interrupted",
};

export const PIPELINE_TONE: Record<PipelineState, Tone> = {
  PLAYING: "info",
  WAITING_HUMAN: "warning",
  PAUSED: "caution",
  COMPLETE: "success",
  STOPPED: "neutral",
  INTERRUPTED: "caution",
};

export function stationOccupancy(
  item: OperationsPrompt,
  runs: RunStatus[],
  pipeline: SuitePipelineRun | null | undefined,
): RunStatus | null {
  const currentId = item.prompt.currentRun?.id ?? null;
  if (currentId !== null) {
    const live = runs.find((run) => run.runId === currentId);
    if (live !== undefined) return live;
  }
  if (pipeline?.currentPromptId === item.prompt.id && pipeline.currentRunId !== null) {
    const live = runs.find((run) => run.runId === pipeline.currentRunId);
    if (live !== undefined) return live;
  }
  return (
    runs.find((run) => run.source.type === "saved" && run.source.promptId === item.prompt.id) ?? null
  );
}

/* ------------------------------------------------------------------ */
/* Pipeline transport state                                            */
/* ------------------------------------------------------------------ */

/*
 * The rules themselves live in `shared` as an ordered, inspectable table so
 * that the status bar, the tests and (soon) the server all read one source.
 * Re-exported here because every existing caller imports them from this
 * module, and because the pipeline UI has no business knowing which package
 * the table happens to sit in.
 */
export { CONTROL_LABEL, DEFAULT_PIPELINE_POLICY, PIPELINE_CONTROLS, STOP_REASON, TRANSITIONS, describeStopReason, matchTransition };
export type { PipelineControl, PipelinePolicy, PolicyKey, RuleContext, RulePolicy, TransitionRow };

export interface PipelineStatusView {
  /** Short state word for the pill: "Running", "Paused", … */
  label: string;
  tone: Tone;
  pulse: boolean;
  /** One sentence: what the pipeline is doing right now. */
  headline: string;
  /** One sentence: what happens if you press the primary control. */
  hint: string | null;
  /** One sentence: what put the run into this state. */
  because: string;
  primary: PipelineControl | null;
  secondary: PipelineControl[];
  /** The row that produced this view, for the rules panel to point at. */
  rowId: string;
  /** How much of this decision the operator may change. */
  policy: RulePolicy;
}

/**
 * Collapses the run and its current station into one status a header can render
 * without re-deriving which buttons make sense.
 *
 * There is deliberately no `resumable` argument. Whether a run can be continued
 * follows from its state — only PLAYING, WAITING_HUMAN and PAUSED are active —
 * so the table derives it instead of trusting a caller to pass a boolean whose
 * invariant is invisible from here.
 */
export function pipelineStatus(args: {
  run: Pick<PipelineRun, "state" | "stopReason" | "waitReason"> | null;
  /** Operational state of the station the run sits on, when there is one. */
  stationState?: PromptOperationalState | null;
  /** Human label for where the pipeline sits, e.g. "S6 · S6-07 · S6-07.2". */
  station: string | null;
  /** A human-intervention step on the current station is still unanswered. */
  awaitingHuman: boolean;
  /** The scheduler is paused, but its already-started agent is still draining. */
  agentActive?: boolean;
  /** House rules from the operations snapshot; built-in defaults before it lands. */
  policy?: PipelinePolicy;
}): PipelineStatusView {
  const {
    run,
    station,
    awaitingHuman,
    stationState = null,
    agentActive = false,
    policy = DEFAULT_PIPELINE_POLICY,
  } = args;
  const context: RuleContext = {
    runState: run === null ? null : run.state,
    stationState,
    station,
    stopReason: run === null ? null : run.stopReason,
    waitReason: run === null ? null : run.waitReason,
    awaitingHuman,
    agentActive,
    policy,
  };
  const row = matchTransition(context);
  return {
    label: row.label,
    tone: row.tone,
    pulse: row.pulse,
    headline: row.headline(context),
    hint: row.hint(context),
    because: row.because(context),
    primary: row.primary,
    secondary: [...row.secondary],
    rowId: row.id,
    policy: row.policy,
  };
}
