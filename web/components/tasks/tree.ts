import type { OperationsPrompt, OperationsSuite } from "@agent-console/shared";

export type TasksFilter = "all" | "attention" | "working";

export function isTerminal(item: OperationsPrompt): boolean {
  return item.operationalState === "DONE" || item.operationalState === "SKIPPED";
}

/** Walk station roots and their children (nesting is at most two levels). */
export function findOperationsPromptInTree(
  items: OperationsPrompt[],
  promptId: number,
): OperationsPrompt | null {
  for (const item of items) {
    if (item.prompt.id === promptId) return item;
    const nested = findOperationsPromptInTree(item.children, promptId);
    if (nested !== null) return nested;
  }
  return null;
}

export function findOperationsPromptInSuite(
  suite: OperationsSuite,
  promptId: number,
): OperationsPrompt | null {
  return findOperationsPromptInTree(suite.prompts, promptId);
}

/** Immediate parent of a nested prompt, or null for a station root / unknown id. */
export function findParentPrompt(
  items: OperationsPrompt[],
  promptId: number,
): OperationsPrompt | null {
  for (const item of items) {
    if (item.children.some((child) => child.prompt.id === promptId)) return item;
    for (const child of item.children) {
      if (child.children.some((grand) => grand.prompt.id === promptId)) return child;
    }
  }
  return null;
}

export function suiteContainsPrompt(suite: OperationsSuite, promptId: number): boolean {
  return findOperationsPromptInSuite(suite, promptId) !== null;
}

function matchesAttention(item: OperationsPrompt): boolean {
  return item.attention || item.childAttention !== null || item.children.some(matchesAttention);
}

function matchesWorking(item: OperationsPrompt): boolean {
  return item.operationalState === "WORKING" || item.children.some(matchesWorking);
}

function filterNode(item: OperationsPrompt, filter: TasksFilter): OperationsPrompt | null {
  if (filter === "all") return item;
  const children = item.children
    .map((child) => filterNode(child, filter))
    .filter((child): child is OperationsPrompt => child !== null);
  const self =
    filter === "attention"
      ? item.attention || item.childAttention !== null || children.length > 0
      : item.operationalState === "WORKING" || children.length > 0;
  if (!self) return null;
  return children.length === item.children.length ? item : { ...item, children };
}

/** Keep roots that match the filter, trimming non-matching descendants. */
export function filterPromptTree(items: OperationsPrompt[], filter: TasksFilter): OperationsPrompt[] {
  if (filter === "all") return items;
  return items
    .map((item) => filterNode(item, filter))
    .filter((item): item is OperationsPrompt => item !== null);
}

export function countStations(items: OperationsPrompt[]): { done: number; total: number } {
  return { done: items.filter(isTerminal).length, total: items.length };
}

export function countSubSteps(items: OperationsPrompt[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  const walk = (nodes: OperationsPrompt[]) => {
    for (const node of nodes) {
      for (const child of node.children) {
        total += 1;
        if (isTerminal(child)) done += 1;
        walk([child]);
      }
    }
  };
  walk(items);
  return { done, total };
}

export function ancestorIdsForPrompt(items: OperationsPrompt[], promptId: number): number[] {
  for (const item of items) {
    if (item.prompt.id === promptId) return [];
    for (const child of item.children) {
      if (child.prompt.id === promptId) return [item.prompt.id];
      for (const grand of child.children) {
        if (grand.prompt.id === promptId) return [item.prompt.id, child.prompt.id];
      }
    }
  }
  return [];
}

export function matchesFilter(item: OperationsPrompt, filter: TasksFilter): boolean {
  if (filter === "all") return true;
  if (filter === "attention") return matchesAttention(item);
  return matchesWorking(item);
}
