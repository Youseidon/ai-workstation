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
} from "@hydra/shared";
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
} from "@hydra/shared";
import type { Tone } from "@/components/ui/Badge";
import type { RunStatus } from "@/models/runs";

export const LABEL: Record<PromptOperationalState, string> = Object.fromEntries(
  STEP_DISPLAY_STATUSES.map((id) => [id, statusDefinition(DEFAULT_STATUS_CATALOG, id).label]),
) as Record<PromptOperationalState, string>;

export const TONE: Record<PromptOperationalState, Tone> = Object.fromEntries(
  STEP_DISPLAY_STATUSES.map((id) => [id, statusDefinition(DEFAULT_STATUS_CATALOG, id).tone]),
) as Record<PromptOperationalState, Tone>;

export function statusLabel(
  id: PromptOperationalState,
  catalog: readonly StatusDefinition[] = DEFAULT_STATUS_CATALOG,
): string {
  return statusDefinition(catalog, id).label;
}

export function statusTone(
  id: PromptOperationalState,
  catalog: readonly StatusDefinition[] = DEFAULT_STATUS_CATALOG,
): Tone {
  return statusDefinition(catalog, id).tone;
}

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

export const onBlockedChip = onUnfinishedChip;

export function overrideChip(rule: PromptPipelineRule): string | null {
  if (rule.provider === null) return null;
  const model = modelLabel(rule.provider, rule.model);
  return model === null ? rule.provider : `${rule.provider} · ${model}`;
}

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
  return (
    runs.find((run) => (run.source.type === "saved" || run.source.type === "wrapup") && run.source.promptId === item.prompt.id) ?? null
  );
}

export { CONTROL_LABEL, DEFAULT_PIPELINE_POLICY, PIPELINE_CONTROLS, STOP_REASON, TRANSITIONS, describeStopReason, matchTransition };
export type { PipelineControl, PipelinePolicy, PolicyKey, RuleContext, RulePolicy, TransitionRow };

export interface PipelineStatusView {
  label: string;
  tone: Tone;
  pulse: boolean;
  headline: string;
  hint: string | null;
  because: string;
  primary: PipelineControl | null;
  secondary: PipelineControl[];
  rowId: string;
  policy: RulePolicy;
}

export function pipelineStatus(args: {
  run: Pick<PipelineRun, "state" | "stopReason" | "waitReason"> | null;
  stationState?: PromptOperationalState | null;
  station: string | null;
  awaitingHuman: boolean;
  agentActive?: boolean;
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
