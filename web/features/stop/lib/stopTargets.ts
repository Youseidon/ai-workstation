import type { OperationsSnapshot, PipelineRecord, PipelineState } from "@hydra/shared";
import type { RunStatus } from "@/models/runs";

export interface PipelineTarget {
  key: string;
  pipelineId: number | null;
  name: string;
  workspaceName: string;
  href: string;
  state: PipelineState;
  run: RunStatus | null;
  stepTitle: string | null;
  phase: PipelinePhase;
}

export type PipelinePhase = "running" | "pausing" | "paused" | "waiting";

export interface StopTargets {
  pipelines: PipelineTarget[];
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
