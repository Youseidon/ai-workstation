import test from "node:test";
import assert from "node:assert/strict";
import type { OperationsPrompt } from "@agent-console/shared";
import {
  ancestorIdsForPrompt,
  countStations,
  countSubSteps,
  filterPromptTree,
  findOperationsPromptInTree,
  findParentPrompt,
  matchesFilter,
} from "../../../components/tasks/tree";

function item(
  id: number,
  state: OperationsPrompt["operationalState"],
  opts: {
    attention?: boolean;
    childAttention?: OperationsPrompt["childAttention"];
    children?: OperationsPrompt[];
    key?: string;
  } = {},
): OperationsPrompt {
  return {
    prompt: { id, externalKey: opts.key ?? `P${id}`, title: `Prompt ${id}` } as OperationsPrompt["prompt"],
    operationalState: state,
    attention: opts.attention ?? false,
    childAttention: opts.childAttention ?? null,
    childAttentionCount: opts.childAttention === null || opts.childAttention === undefined ? 0 : 1,
    children: opts.children ?? [],
  } as OperationsPrompt;
}

test("findOperationsPromptInTree walks nested children", () => {
  const leaf = item(3, "BLOCKED", { attention: true });
  const tree = [item(1, "WAITING_DEPENDENCY", { children: [item(2, "DONE"), leaf] })];
  assert.equal(findOperationsPromptInTree(tree, 3), leaf);
  assert.equal(findOperationsPromptInTree(tree, 99), null);
});

test("findParentPrompt returns the immediate parent", () => {
  const grand = item(3, "READY");
  const child = item(2, "WAITING_DEPENDENCY", { children: [grand] });
  const root = item(1, "WAITING_DEPENDENCY", { children: [child] });
  assert.equal(findParentPrompt([root], 2), root);
  assert.equal(findParentPrompt([root], 3), child);
  assert.equal(findParentPrompt([root], 1), null);
});

test("attention filter keeps parents of matching descendants", () => {
  const blocked = item(12, "BLOCKED", { attention: true });
  const ok = item(11, "DONE");
  const parent = item(10, "WAITING_DEPENDENCY", {
    childAttention: "BLOCKED",
    children: [ok, blocked],
  });
  const other = item(20, "READY");
  const filtered = filterPromptTree([parent, other], "attention");
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.prompt.id, 10);
  assert.deepEqual(
    filtered[0]?.children.map((c) => c.prompt.id),
    [12],
  );
});

test("working filter includes a parent when a child is WORKING", () => {
  const working = item(2, "WORKING");
  const parent = item(1, "WAITING_DEPENDENCY", { children: [working, item(3, "READY")] });
  const filtered = filterPromptTree([parent, item(9, "READY")], "working");
  assert.equal(filtered.length, 1);
  assert.deepEqual(
    filtered[0]?.children.map((c) => c.prompt.id),
    [2],
  );
});

test("matchesFilter attention uses childAttention without requiring own attention", () => {
  const parent = item(1, "WAITING_DEPENDENCY", {
    childAttention: "RECOVERY_NEEDED",
    children: [item(2, "RECOVERY_NEEDED", { attention: true })],
  });
  assert.equal(matchesFilter(parent, "attention"), true);
  assert.equal(matchesFilter(item(3, "READY"), "attention"), false);
});

test("countStations and countSubSteps separate top-level from nested", () => {
  const tree = [
    item(1, "DONE", { children: [item(2, "DONE"), item(3, "READY")] }),
    item(4, "READY"),
  ];
  assert.deepEqual(countStations(tree), { done: 1, total: 2 });
  assert.deepEqual(countSubSteps(tree), { done: 1, total: 2 });
});

test("ancestorIdsForPrompt returns the path above a nested id", () => {
  const leaf = item(3, "READY");
  const mid = item(2, "WAITING_DEPENDENCY", { children: [leaf] });
  const root = item(1, "WAITING_DEPENDENCY", { children: [mid] });
  assert.deepEqual(ancestorIdsForPrompt([root], 3), [1, 2]);
  assert.deepEqual(ancestorIdsForPrompt([root], 2), [1]);
  assert.deepEqual(ancestorIdsForPrompt([root], 1), []);
});
