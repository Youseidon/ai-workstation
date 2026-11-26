import { isTerminalDisplayStatus, type OperationsPrompt, type OperationsSuite, type PipelineFlowchartView, type StatusDefinition } from "@hydra/shared";

export interface SuiteProgress {
  known: boolean;
  done: number;
  total: number;
  skipped: number;
  attention: number;
  complete: boolean;
}

export function enabledPipelineItems(suite: OperationsSuite | null, flowchart: PipelineFlowchartView | null): OperationsPrompt[] {
  const roots = new Map(suite?.prompts.map((item) => [item.prompt.id, item]) ?? []);
  return (flowchart?.steps ?? []).filter((step) => step.enabled).flatMap((step) => {
    const item = roots.get(step.promptId);
    return item === undefined ? [] : [item];
  });
}

export function projectSuiteProgress(
  suite: OperationsSuite | null,
  flowchart: PipelineFlowchartView | null,
  catalog: readonly StatusDefinition[],
  expectedSteps = 0,
): SuiteProgress {
  const steps = flowchart?.steps.filter((step) => step.enabled) ?? [];
  const items = enabledPipelineItems(suite, flowchart);
  const known = suite !== null && flowchart !== null && items.length === steps.length;
  const total = flowchart === null ? expectedSteps : steps.length;
  const done = items.filter((item) => isTerminalDisplayStatus(catalog, item.operationalState)).length;
  const skipped = items.filter((item) => item.operationalState === "SKIPPED").length;
  let attention = 0;
  const visit = (item: OperationsPrompt) => {
    if (item.attention || item.humanIntervention?.status === "PENDING") attention++;
    for (const child of item.children) visit(child);
  };
  for (const item of items) visit(item);
  return { known, done, total, skipped, attention, complete: known && total > 0 && done === total && attention === 0 };
}

export function progressLabel(progress: SuiteProgress): string {
  if (!progress.known) return "Progress unavailable";
  if (progress.total === 0) return "No enabled steps";
  return `${progress.done}/${progress.total} settled${progress.skipped > 0 ? ` · ${progress.skipped} skipped` : ""}`;
}
