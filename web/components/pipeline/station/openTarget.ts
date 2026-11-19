import type { OperationsSuite, PipelineRecord } from "@agent-console/shared";
import { suiteContainsPrompt } from "./tree";

export interface OpenRequest {
  suite: string | null;
  prompt: string | null;
  filter: string | null;
}

function positiveInt(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Where a link to a work item (or suite) should land. Prefers the pipeline that
 * is running the suite, then any pipeline that includes it, then the suite view.
 * Returns null when the item is not in these suites. With nothing to resolve,
 * lands on the pipelines overview.
 */
export function resolveOpenTarget(
  request: OpenRequest,
  suites: OperationsSuite[],
  pipelines: PipelineRecord[],
): string | null {
  const promptId = positiveInt(request.prompt);
  let suiteId = positiveInt(request.suite);
  const filter = request.filter === "attention" || request.filter === "working" ? request.filter : null;

  if (promptId !== null) {
    const home = suites.find((suite) => suiteContainsPrompt(suite, promptId)) ?? null;
    if (home === null) return null;
    suiteId = home.id;
  }
  if (suiteId === null) {
    return filter === "attention" ? "/pipeline#needs-you" : "/pipeline";
  }
  if (!suites.some((suite) => suite.id === suiteId)) return null;

  const query = new URLSearchParams();
  const including = pipelines.filter((pipeline) => pipeline.stages.some((stage) => stage.suiteId === suiteId));
  const pipeline =
    including.find((entry) => entry.active !== null && entry.active.currentSuiteId === suiteId) ??
    including.find((entry) => entry.active !== null) ??
    including[0] ??
    null;

  if (pipeline !== null) query.set("suite", String(suiteId));
  if (promptId !== null) query.set("prompt", String(promptId));
  if (filter !== null) {
    query.set("view", "list");
    query.set("filter", filter);
  }
  if (filter === "attention" && promptId !== null) query.set("tab", "conversation");
  const qs = query.toString();
  const base = pipeline !== null ? `/pipeline/${pipeline.id}` : `/pipeline/suite/${suiteId}`;
  return qs === "" ? base : `${base}?${qs}`;
}
