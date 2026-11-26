import type { OperationsSnapshot, PipelineRecord, PipelineState } from "@hydra/shared";
import type { RunStatus } from "@/models/runs";

/**
 * What the stop center shows. The server owns every state here; this only
 * groups it so each pipeline appears once with the agent working for it, and
 * every other live agent appears on its own.
 */
export interface PipelineTarget {
  /** The suite run's id: stable for one execution, unlike the named run's stage. */
  key: string;
  /** The named pipeline, or null for a suite played on its own (no pipeline-level controls). */
  pipelineId: number | null;
  name: string;
  workspaceName: string;
  href: string;
  state: PipelineState;
  /** The live agent on the current station, if one is running. */
  run: RunStatus | null;
  stepTitle: string | null;
  phase: PipelinePhase;
}

/**
 * - running: playing with an agent on a step
 * - pausing: paused, but the agent it let finish is still working
 * - paused: held; nothing runs until Resume
 * - waiting: active without an agent (parked for a person, or between steps)
 */
export type PipelinePhase = "running" | "pausing" | "paused" | "waiting";

export interface StopTargets {
  pipelines: PipelineTarget[];
  /** Live agents no pipeline owns: chat, consults, verification, audits. */
  agents: RunStatus[];
}

export type StopAction = "pause" | "resume" | "forceStop" | "stopPipeline" | "stopAgent";

export function phaseOf(state: PipelineState, run: RunStatus | null): PipelinePhase {
  if (state === "PAUSED") return run !== null ? "pausing" : "paused";
  if (state === "PLAYING" && run !== null) return "running";
  return "waiting";
}

function findTitle(prompts: OperationsSnapshot["suites"][number]["prompts"], id: number): string | null {
  for (const prompt of prompts) {
    if (prompt.prompt.id === id) return prompt.prompt.externalKey ?? prompt.prompt.title;
    const child = findTitle(prompt.children ?? [], id);
    if (child !== null) return child;
  }
  return null;
}

export function stopTargets(operations: OperationsSnapshot | null, pipelines: PipelineRecord[], runs: RunStatus[]): StopTargets {
  const owned = new Set<string>();
  const targets: PipelineTarget[] = [];
  for (const suite of operations?.suites ?? []) {
    const active = suite.pipeline?.active;
    if (!active) continue;
    const named = pipelines.find((pipeline) => pipeline.active !== null && pipeline.active.id === active.pipelineRunId);
    const run = active.currentRunId === null ? null : runs.find((candidate) => candidate.runId === active.currentRunId) ?? null;
    if (run !== null) owned.add(run.runId);
    targets.push({
      key: active.id,
      pipelineId: named?.id ?? null,
      name: named?.name ?? suite.name,
      workspaceName: suite.workspaceName,
      href: named ? `/pipeline/${named.id}?workspace=${suite.workspaceId}&suite=${suite.id}` : `/pipeline/suite/${suite.id}?workspace=${suite.workspaceId}`,
      state: active.state,
      run,
      stepTitle: active.currentPromptId === null ? null : findTitle(suite.prompts, active.currentPromptId),
      phase: phaseOf(active.state, run),
    });
  }
  return { pipelines: targets, agents: runs.filter((run) => !owned.has(run.runId)) };
}

/**
 * Whether a requested action has visibly happened, so its spinner can go.
 * Judged from the server's state, not from the HTTP reply: a stop is only
 * done once the agent is gone from the live run list.
 */
export function actionSettled(action: StopAction, target: { pipeline?: PipelineTarget | undefined; runId?: string | null }, runs: RunStatus[]): boolean {
  const runGone = target.runId === undefined || target.runId === null || !runs.some((run) => run.runId === target.runId);
  switch (action) {
    case "pause": return target.pipeline === undefined || target.pipeline.state === "PAUSED";
    case "resume": return target.pipeline === undefined || target.pipeline.state !== "PAUSED";
    case "forceStop": return runGone;
    case "stopPipeline": return target.pipeline === undefined && runGone;
    case "stopAgent": return runGone;
  }
}
