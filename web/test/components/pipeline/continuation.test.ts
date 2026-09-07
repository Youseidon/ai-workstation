import test from "node:test";
import assert from "node:assert/strict";
import type { OperationsPrompt } from "@agent-console/shared";
import { nextPipelineLeaf } from "../../../components/pipeline/continuation";

function item(id: number, state: OperationsPrompt["operationalState"], children: OperationsPrompt[] = []): OperationsPrompt {
  return {
    prompt: { id } as OperationsPrompt["prompt"],
    operationalState: state,
    children,
  } as OperationsPrompt;
}

test("a fresh run targets the first unfinished leaf, not its previously-run parent", () => {
  const leaf = item(85, "READY");
  const parent = item(51, "WAITING_DEPENDENCY", [
    item(79, "DONE"),
    item(80, "DONE"),
    leaf,
  ]);

  assert.equal(nextPipelineLeaf([parent]), leaf);
});

test("the search follows nested unfinished children depth-first", () => {
  const leaf = item(3, "RECOVERY_NEEDED");
  assert.equal(nextPipelineLeaf([item(1, "WAITING_DEPENDENCY", [item(2, "WAITING_DEPENDENCY", [leaf])])]), leaf);
});

test("there is no continuation after every station is terminal", () => {
  assert.equal(nextPipelineLeaf([item(1, "DONE"), item(2, "SKIPPED")]), null);
});
