import type {
  OperationsPrompt,
  OperationsSuite,
  PipelineRun,
  PipelineState,
  PromptOperationalState,
  PromptPipelineRule,
  OnDoneAction,
  ProviderId,
  SuitePipelineRun,
} from "@agent-console/shared";
import { modelLabel } from "@agent-console/shared";
import type { Tone } from "@/components/ui/Badge";
import type { ConnectionState, RunStatus } from "@/lib/agentConsole";

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

export function pipelineRunBadge(
  run: PipelineRun | SuitePipelineRun | null | undefined,
): { label: string; tone: Tone; pulse?: boolean } | null {
  if (run == null) return null;
  return {
    label: PIPELINE_LABEL[run.state],
    tone: PIPELINE_TONE[run.state],
    pulse: run.state === "PLAYING",
  };
}

export function pipelineBadge(
  suite: OperationsSuite,
): { label: string; tone: Tone; pulse?: boolean } | null {
  const active = suite.pipeline?.active;
  const latest = suite.pipeline?.latest;
  if (active != null) return pipelineRunBadge(active);
  if (latest?.state === "INTERRUPTED") return { label: "interrupted", tone: "caution" };
  return null;
}

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

export function workspaceOccupancy(workspaceId: number, runs: RunStatus[]): RunStatus | null {
  return runs.find((run) => run.workspace.id === workspaceId && run.role === "execute") ?? null;
}

export type PlayKind = "play" | "resume" | "hidden";

export function playKind(
  pipeline: Pick<SuitePipelineRun, "state" | "currentRunId"> | null | undefined,
  occupancy: RunStatus | null,
): PlayKind {
  if (pipeline == null) return "play";
  if (pipeline.state === "PLAYING") return "hidden";
  if (pipeline.state === "PAUSED") {
    if (occupancy !== null && occupancy.runId === pipeline.currentRunId) return "hidden";
    return "resume";
  }
  if (pipeline.state === "WAITING_HUMAN") return "resume";
  return "play";
}

export function namedPlayKind(run: Pick<PipelineRun, "state"> | null | undefined): PlayKind {
  if (run == null) return "play";
  if (run.state === "PLAYING") return "hidden";
  if (run.state === "PAUSED" || run.state === "WAITING_HUMAN" || run.state === "INTERRUPTED" || run.state === "STOPPED") return "resume";
  return "play";
}

export function showPause(pipeline: { state: PipelineState } | null | undefined): boolean {
  return pipeline?.state === "PLAYING";
}

export function showStop(pipeline: { state: PipelineState } | null | undefined): boolean {
  return pipeline?.state === "PLAYING" || pipeline?.state === "PAUSED" || pipeline?.state === "WAITING_HUMAN";
}

export function firstReadyId(prompts: OperationsPrompt[]): number | null {
  return prompts.find((item) => item.prompt.ready)?.prompt.id ?? null;
}

export function playBlockedReason(args: {
  suite: OperationsSuite;
  connection: ConnectionState;
  playProvider: ProviderId;
  providerAvailable: boolean;
  occupancy: RunStatus | null;
  otherPipeline: OperationsSuite | null;
}): string | null {
  const { suite, connection, playProvider, providerAvailable, occupancy, otherPipeline } = args;
  if (connection !== "open") return "backend disconnected";
  if (suite.prompts.length === 0) return "No stations yet. Add work items on the Workspaces page.";
  if (suite.prompts[0]?.workspace.workDirectoryExists === false) return "working directory is missing";
  if (!providerAvailable) return `${playProvider} is not available`;
  const pipeline = suite.pipeline?.active ?? null;
  if (occupancy !== null && occupancy.runId !== pipeline?.currentRunId) {
    return `${occupancy.provider} is already writing ${occupancy.workspace.name}`;
  }
  if (otherPipeline !== null) {
    return `${otherPipeline.key ?? otherPipeline.name} already owns this workspace`;
  }
  const kind = playKind(pipeline, occupancy);
  if (kind === "hidden") return "already playing";
  if (kind === "resume") {
    const current = suite.prompts.find((item) => item.prompt.id === pipeline?.currentPromptId);
    if (pipeline?.state === "WAITING_HUMAN" && current !== undefined && !current.prompt.ready) {
      return current.prompt.blockedBy.length > 0
        ? `waiting on ${current.prompt.blockedBy.join(", ")}`
        : "The waiting station is not ready to resume";
    }
    return null;
  }
  const ready = suite.prompts.filter((item) => item.prompt.ready);
  if (ready.length === 0) {
    const unfinished = suite.prompts.filter(
      (item) => item.operationalState !== "COMPLETE" && item.operationalState !== "SKIPPED",
    );
    if (unfinished.length === 0) return "All stations are done.";
    const keys = [...new Set(unfinished.flatMap((item) => item.prompt.blockedBy))];
    if (keys.length > 0) return `Nothing is ready. Waiting on ${keys.join(", ")}.`;
    return "Nothing is ready to play.";
  }
  return null;
}
