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
  StatusDefinition,
  SuitePipelineRun,
  TransitionRow,
} from "@agent-console/shared";
import {
  CONTROL_LABEL,
  DEFAULT_STATUS_CATALOG,
  STEP_DISPLAY_STATUSES,
  DEFAULT_PIPELINE_POLICY,
  PIPELINE_CONTROLS,
  STOP_REASON,
  TRANSITIONS,
  describeStopReason,
  matchTransition,
  modelLabel,
  statusDefinition,
} from "@agent-console/shared";
import type { Tone } from "@/components/ui/Badge";
import type { RunStatus } from "@/lib/agentConsole";

/**
 * Labels and tones come from the status catalog, not from a map kept here.
 *
 * There used to be two hardcoded maps in this file, and they disagreed with the
 * shared rule table about what to call the same state — `WAITING_HUMAN` read
 * "blocked" in one place and "Needs you" in another. Deriving both from the one
 * catalog is what stops that recurring, and it is what lets an operator rename
 * a state once and see it change everywhere.
 *
 * These are the shipped defaults. Once the operator's edits are persisted these
 * views take the resolved catalog from the operations snapshot instead; the
 * lookup helpers below already accept one.
 */
export const LABEL: Record<PromptOperationalState, string> = Object.fromEntries(
  STEP_DISPLAY_STATUSES.map((id) => [id, statusDefinition(DEFAULT_STATUS_CATALOG, id).label]),
) as Record<PromptOperationalState, string>;

export const TONE: Record<PromptOperationalState, Tone> = Object.fromEntries(
  STEP_DISPLAY_STATUSES.map((id) => [id, statusDefinition(DEFAULT_STATUS_CATALOG, id).tone]),
) as Record<PromptOperationalState, Tone>;

/** The operator's label for a state, falling back to the shipped one. */
export function statusLabel(
  id: PromptOperationalState,
  catalog: readonly StatusDefinition[] = DEFAULT_STATUS_CATALOG,
): string {
  return statusDefinition(catalog, id).label;
}

/** The operator's tone for a state, falling back to the shipped one. */
export function statusTone(
  id: PromptOperationalState,
  catalog: readonly StatusDefinition[] = DEFAULT_STATUS_CATALOG,
): Tone {
  return statusDefinition(catalog, id).tone;
}

/** Whether a state settles a parent and lets the pipeline move past it. */
export function isTerminalState(
  id: PromptOperationalState,
  catalog: readonly StatusDefinition[] = DEFAULT_STATUS_CATALOG,
): boolean {
  return statusDefinition(catalog, id).isTerminal;
}

export function onDoneChip(action: OnDoneAction): string {
  if (action === "continue") return "→ next";
  if (action === "stop") return "■ stop";
  return "↛ skip rest";
}

export function onUnfinishedChip(rule: PromptPipelineRule): string {
  if (rule.onUnfinished === "wait") return "wait";
  if (rule.onUnfinished === "skip") return "skip";
  return "continue";
}

/** @deprecated Use onUnfinishedChip — kept as an alias during the cutover. */
export const onBlockedChip = onUnfinishedChip;

export function overrideChip(rule: PromptPipelineRule): string | null {
  if (rule.provider === null) return null;
  const model = modelLabel(rule.provider, rule.model);
  return model === null ? rule.provider : `${rule.provider} · ${model}`;
}

/**
 * Short lowercase names for a run state, used on stage badges where there is no
 * `RuleContext` to match a transition row against. Kept deliberately in step
 * with the `TRANSITIONS` labels — this map said "blocked" where the rule table
 * said "Needs you", so the same run read as two different things depending on
 * which part of the board you looked at.
 */
export const PIPELINE_LABEL: Record<PipelineState, string> = {
  PLAYING: "running",
  WAITING_HUMAN: "needs you",
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
  // A wrap-up turn counts as this station being occupied: it is a live run on
  // the same work item, and the card that showed nothing would read as idle
  // while an agent was still writing its notes.
  return (
    runs.find((run) => (run.source.type === "saved" || run.source.type === "wrapup") && run.source.promptId === item.prompt.id) ?? null
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
