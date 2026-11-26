import type { OperationsPrompt, OperationsSnapshot, PipelineFlowchartView, PipelineRecord, ProviderId } from "@hydra/shared";
import type { PendingAgentInput, RunStatus } from "@/models/runs";

export interface RunOrigin {
  kind: string;
  title: string;
  context: string;
  href?: string;
  /** Where in a pipeline the run is working, when a pipeline owns it. */
  pipeline?: PipelinePlace;
}

/** Pipeline › suite › (station ›) step, each with its short key when it has one. */
export interface PipelinePlace {
  /** The named pipeline, or null when the suite runs on its own. */
  name: string | null;
  suiteKey: string | null;
  suiteName: string;
  /** The parent station when the running prompt is a sub-step. */
  stationKey: string | null;
  stepKey: string | null;
  stepTitle: string;
}

/** Source labels work even before optional pipeline metadata arrives. */
export function runOrigin(run: RunStatus): RunOrigin {
  const source = run.source;
  switch (source.type) {
    case "custom": return { kind: run.role === "consult" ? "Consult" : "Custom prompt", title: source.title || source.displayText, context: "Chat" };
    case "saved": return { kind: "Saved prompt", title: source.title, context: `${source.programName} / ${source.suiteName}` };
    case "consult": return { kind: "Consult", title: source.title || source.question, context: "Read-only research" };
    case "clarification": return { kind: "Clarification", title: source.title, context: source.question };
    case "verification": return { kind: "Verification", title: source.suiteName, context: source.promptKey ?? "Suite verification" };
    case "wrapup": return { kind: "Wrap-up", title: source.title, context: "Finalizing work" };
    case "audit": return { kind: "Audit", title: source.title, context: "Completion review" };
    case "author": return { kind: source.revision ? "Program revision" : "Program authoring", title: source.goal, context: source.programName ?? "New program" };
    case "instructions": return { kind: "Instructions", title: source.goal, context: source.file };
  }
}

export interface QueuedAgentTask {
  id: string;
  workspaceId: number;
  workspaceName: string;
  title: string;
  context: string;
  href: string;
  provider: ProviderId | null;
  model: string | null;
}

function findPrompt(prompts: OperationsPrompt[], id: number): OperationsPrompt | undefined {
  for (const prompt of prompts) {
    if (prompt.prompt.id === id) return prompt;
    const child = findPrompt(prompt.children ?? [], id);
    if (child) return child;
  }
}

/** Only a suite run's recorded currentRunId establishes pipeline ownership. */
export function fleetMetadata(operations: OperationsSnapshot | null, pipelines: PipelineRecord[], runs: RunStatus[], flowcharts: Record<string, PipelineFlowchartView> = {}) {
  const origins: Record<string, RunOrigin> = {};
  const queued: QueuedAgentTask[] = [];
  for (const suite of operations?.suites ?? []) {
    const active = suite.pipeline?.active;
    if (!active) continue;
    const named = pipelines.find(pipeline => pipeline.active?.id === active.pipelineRunId);
    const context = named ? `${named.name} / ${suite.name}` : `${suite.programName} / ${suite.name}`;
    const href = named ? `/pipeline/${named.id}?workspace=${suite.workspaceId}&suite=${suite.id}` : `/pipeline/suite/${suite.id}?workspace=${suite.workspaceId}`;
    if (active.currentRunId !== null) {
      const run = runs.find(run => run.runId === active.currentRunId);
      if (run) {
        const promptId = "promptId" in run.source && typeof run.source.promptId === "number" ? run.source.promptId : active.currentPromptId;
        const prompt = promptId === null ? undefined : findPrompt(suite.prompts, promptId);
        const parentId = prompt?.prompt.parentPromptId ?? null;
        const station = parentId === null ? undefined : findPrompt(suite.prompts, parentId);
        const origin = runOrigin(run);
        origins[run.runId] = { ...origin, kind: "Pipeline", context, href, pipeline: {
          name: named?.name ?? null,
          suiteKey: suite.key,
          suiteName: suite.name,
          stationKey: station === undefined ? null : station.prompt.externalKey ?? station.prompt.title,
          stepKey: prompt?.prompt.externalKey ?? (run.source.type === "saved" ? run.source.promptKey : null),
          stepTitle: prompt?.prompt.title ?? origin.title,
        } };
      }
    } else if (active.state === "PLAYING" && active.currentPromptId !== null) {
      const promptId = active.currentPromptId;
      // Socket announcements can beat the operations refresh. Do not show
      // the same task as queued and live during that interval.
      if (runs.some(run => run.role === "execute" && "promptId" in run.source && run.source.promptId === promptId)) continue;
      const prompt = findPrompt(suite.prompts, promptId);
      if (!prompt) continue;
      // Operations contains baseline rules, not the named pipeline's overrides.
      // Leave assignment unknown until its scoped flowchart has been read.
      const chart = flowcharts[active.id];
      const rule = chart?.steps.find(step => step.promptId === promptId) ?? chart?.subSteps.find(step => step.promptId === promptId)?.rule;
      const defaults = chart?.defaults;
      queued.push({ id: active.id, workspaceId: suite.workspaceId, workspaceName: suite.workspaceName,
        title: prompt.prompt.title, context, href,
        provider: rule && defaults ? rule.provider ?? defaults.defaultProvider ?? active.playProvider : null,
        model: rule && defaults ? rule.provider !== null ? rule.model : defaults.defaultProvider !== null ? defaults.defaultModel : active.playModel : null });
    }
  }
  return { origins, queued };
}

/** Compare server timestamps/elapsed values, so waiting clocks also freeze offline. */
export function waitingElapsed(run: RunStatus, request: PendingAgentInput): number | null {
  if (!request.requestedAt) return null;
  const requested = Date.parse(request.requestedAt);
  if (run.clockAt) {
    const sample = Date.parse(run.clockAt);
    return Number.isFinite(requested) && Number.isFinite(sample) ? Math.max(0, sample - requested) : null;
  }
  const started = Date.parse(run.startedAt);
  if (!Number.isFinite(requested) || !Number.isFinite(started)) return null;
  return Math.max(0, run.elapsedMs - Math.max(0, requested - started));
}

export function fleetClock(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
