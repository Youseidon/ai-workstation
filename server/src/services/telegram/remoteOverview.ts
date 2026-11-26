import type { PromptOption, RunSource } from "@hydra/shared";
import type { RemoteGate, RemoteOverview, RemotePipeline, RemoteRun, RemoteStep } from "../../contracts/remote.ts";
import { workspaces } from "../../repositories/workspaces.ts";
import { runHub } from "../runs/runHub.ts";

export function runTitle(source: RunSource): string {
  switch (source.type) {
    case "custom": return source.title ?? source.displayText;
    case "saved": return source.promptKey ? `${source.promptKey} · ${source.title}` : source.title;
    case "clarification": return `Question on ${source.title}`;
    case "verification": return `Verify ${source.suiteName}`;
    case "consult": return source.title ? `Consult on ${source.title}` : "Consult";
    case "wrapup": return `Wrap-up of ${source.title}`;
    case "audit": return `Audit of ${source.title}`;
    case "author": return source.programName ? `${source.revision ? "Revise" : "Author"} ${source.programName}` : `Author: ${source.goal}`;
    case "instructions": return `Edit ${source.file}`;
  }
}

const step = (option: PromptOption): RemoteStep => ({ promptId: option.id, key: option.externalKey, title: option.title, status: option.status });

export function remoteGates(): RemoteGate[] {
  return workspaces.blockedPrompts().map(row => ({
    promptId: row.promptId, key: row.promptKey, title: row.title, workspaceName: row.workspaceName, question: row.question, since: row.since,
  }));
}

export function remoteOverview(): RemoteOverview {
  const runs: RemoteRun[] = runHub.snapshots().map(run => ({
    runId: run.runId, title: runTitle(run.source), workspaceName: run.workspace.name, provider: run.provider,
    model: run.model, role: run.role, elapsedMs: run.elapsedMs,
  }));
  const options = new Map<number, PromptOption[]>();
  const optionsFor = (workspaceId: number) => {
    let found = options.get(workspaceId);
    if (found === undefined) { found = workspaces.promptOptions(workspaceId); options.set(workspaceId, found); }
    return found;
  };
  const pipelines: RemotePipeline[] = workspaces.listPipelines().map(pipeline => {
    const order = new Map(pipeline.stages.map((stage, index) => [stage.suiteId, index]));
    const stations = optionsFor(pipeline.workspaceId)
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => order.has(option.suiteId) && option.parentPromptId === null)
      .sort((a, b) => ((order.get(a.option.suiteId) ?? 0) - (order.get(b.option.suiteId) ?? 0)) || a.index - b.index)
      .map(({ option }) => option);
    const active = pipeline.active;
    let current: RemoteStep | null = null;
    let currentSuite: string | null = null;
    if (active !== null) {
      currentSuite = pipeline.stages.find(stage => stage.suiteId === active.currentSuiteId)?.suiteName ?? null;
      const suiteRun = active.currentSuiteRunId ? workspaces.pipelineById(active.currentSuiteRunId) : null;
      const promptId = suiteRun?.currentPromptId ?? null;
      const option = promptId === null ? undefined : optionsFor(pipeline.workspaceId).find(candidate => candidate.id === promptId);
      if (option !== undefined) current = step(option);
    }
    const next = stations.find(option => option.ready && option.id !== current?.promptId);
    return {
      id: pipeline.id, name: pipeline.name, workspaceName: pipeline.workspaceName,
      state: active?.state ?? null, waitReason: active?.waitReason ?? null, currentSuite, current,
      next: next ? step(next) : null,
      done: stations.filter(option => option.status === "DONE" || option.status === "SKIPPED").length,
      total: stations.length,
    };
  });
  return { runs, pipelines, gates: remoteGates() };
}
