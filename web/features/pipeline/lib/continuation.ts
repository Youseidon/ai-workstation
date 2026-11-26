import type { OperationsPrompt } from "@hydra/shared";

function unfinished(item: OperationsPrompt): boolean {
  return item.operationalState !== "DONE" && item.operationalState !== "SKIPPED";
}

export function nextPipelineLeaf(items: OperationsPrompt[]): OperationsPrompt | null {
  const station = items.find(unfinished);
  if (station === undefined) return null;

  let node = station;
  while (true) {
    const child = node.children.find(unfinished);
    if (child === undefined) return node;
    node = child;
  }
}
