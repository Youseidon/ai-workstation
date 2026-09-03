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

/* ------------------------------------------------------------------ */
/* Pipeline transport state                                            */
/* ------------------------------------------------------------------ */

/**
 * The controls a pipeline can offer. Exactly one is ever primary, so the
 * header never presents two equally-weighted "do something" buttons.
 */
export type PipelineControl = "play" | "resume" | "newRun" | "pause" | "stop";

export const CONTROL_LABEL: Record<PipelineControl, string> = {
  play: "Play",
  resume: "Resume",
  newRun: "Start new run",
  pause: "Pause",
  stop: "Stop",
};

export interface PipelineStatusView {
  /** Short state word for the pill: "Running", "Paused", … */
  label: string;
  tone: Tone;
  pulse: boolean;
  /** One sentence: what the pipeline is doing right now. */
  headline: string;
  /** One sentence: what happens if you press the primary control. */
  hint: string | null;
  primary: PipelineControl | null;
  secondary: PipelineControl[];
}

const STOP_REASON: Record<string, string> = {
  operator_stop: "You stopped it.",
  server_restart: "The server restarted mid-run.",
  nothing_ready: "Nothing on the flowchart was ready to run.",
  blocked_on_dependencies: "Every remaining station is waiting on another one.",
  on_done_stop: "A station's rule said stop when done.",
  skip_rest: "A station's rule skipped the rest of the stage.",
  retry_exhausted: "A station ran out of retries.",
  recover_exhausted: "Recovery did not clear the block.",
  no_provider: "A station had no agent assigned.",
  start_failed: "The agent process failed to start.",
};

/**
 * Collapses run state, resumability and the current station into one status a
 * header can render without the caller re-deriving which buttons make sense.
 * `resumable` is `pipeline.active !== null` — a terminal run cannot be resumed,
 * pressing play there starts a fresh run instead.
 */
export function pipelineStatus(args: {
  run: Pick<PipelineRun, "state" | "stopReason"> | null;
  resumable: boolean;
  /** Human label for where the pipeline sits, e.g. "S6 · S6-07 · S6-07.2". */
  station: string | null;
  /** A human-intervention step on the current station is still unanswered. */
  awaitingHuman: boolean;
  /** The scheduler is paused, but its already-started agent is still draining. */
  agentActive?: boolean;
}): PipelineStatusView {
  const { run, resumable, station, awaitingHuman, agentActive = false } = args;
  const where = station === null ? "the current station" : station;

  if (run === null) {
    return {
      label: "Not started",
      tone: "neutral",
      pulse: false,
      headline: "This pipeline has never run.",
      hint: "Play walks every stage in order, one station at a time.",
      primary: "play",
      secondary: [],
    };
  }

  if (run.state === "PLAYING") {
    return {
      label: "Running",
      tone: "info",
      pulse: true,
      headline: `An agent is working ${where}.`,
      hint: "Pause lets the current station finish, then holds. Stop interrupts it now.",
      primary: "pause",
      secondary: ["stop"],
    };
  }

  if (run.state === "PAUSED") {
    if (agentActive) {
      return {
        label: "Pausing",
        tone: "caution",
        pulse: true,
        headline: `The agent is finishing ${where}; no new step will start.`,
        hint: "Pause is graceful: it lets the current agent finish. Use Stop to interrupt it now.",
        primary: "stop",
        secondary: [],
      };
    }
    return {
      label: "Paused",
      tone: "caution",
      pulse: false,
      headline: `Holding at ${where}. Nothing new will start.`,
      hint: "Resume picks the rail back up from here.",
      primary: "resume",
      secondary: ["stop"],
    };
  }

  if (run.state === "WAITING_HUMAN") {
    return {
      label: "Needs you",
      tone: "warning",
      pulse: true,
      headline: awaitingHuman
        ? `${where} is blocked on a decision only you can make.`
        : `${where} reported blocked, and its rule is "wait".`,
      hint: awaitingHuman
        ? "Answer the Human intervention card below — Resume unlocks once it is answered."
        : "Clear whatever blocked it, then Resume to retry from this station.",
      primary: "resume",
      secondary: ["stop"],
    };
  }

  if (run.state === "INTERRUPTED") {
    return {
      label: "Interrupted",
      tone: "caution",
      pulse: false,
      headline: "This run ended mid-flight — the server restarted while an agent was working.",
      hint: resumable ? "Resume continues this run." : "Play starts a fresh run from the first unfinished station.",
      primary: resumable ? "resume" : "newRun",
      secondary: resumable ? ["stop"] : [],
    };
  }

  if (run.state === "STOPPED") {
    const reason = run.stopReason === null ? null : (STOP_REASON[run.stopReason] ?? run.stopReason);
    return {
      label: "Stopped",
      tone: "neutral",
      pulse: false,
      headline: reason === null ? "This run is stopped." : `This run is stopped. ${reason}`,
      hint: "Starting a new run picks up from the first unfinished station; finished work is not repeated.",
      primary: resumable ? "resume" : "newRun",
      secondary: resumable ? ["stop"] : [],
    };
  }

  return {
    label: "Complete",
    tone: "success",
    pulse: false,
    headline: "Every stage on this pipeline finished.",
    hint: "A new run only picks up work that is still unfinished.",
    primary: "newRun",
    secondary: [],
  };
}
