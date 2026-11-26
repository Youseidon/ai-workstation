import test from "node:test";
import assert from "node:assert/strict";
import type { HumanInterventionStep, OperationsPrompt, OperationsSuite, PipelineRecord, PromptActivity, PromptRemark } from "@hydra/shared";
import { collectInbox } from "../../../features/pipeline/lib/station/inbox";
import { resolveOpenTarget } from "../../../features/pipeline/lib/station/openTarget";
import { buildThread, composerMode } from "../../../features/pipeline/lib/station/thread";
import { filterPromptTree, needsYou } from "../../../features/pipeline/lib/station/tree";

function item(
  id: number,
  state: OperationsPrompt["operationalState"],
  opts: {
    attention?: boolean;
    gate?: HumanInterventionStep | null;
    children?: OperationsPrompt[];
    recoverable?: boolean;
    lastActivityAt?: string;
    latestIntervention?: string | null;
  } = {},
): OperationsPrompt {
  return {
    prompt: { id, externalKey: `P${id}`, title: `Prompt ${id}`, recoverable: opts.recoverable ?? false } as OperationsPrompt["prompt"],
    operationalState: state,
    attention: opts.attention ?? false,
    childAttention: null,
    childAttentionCount: 0,
    children: opts.children ?? [],
    humanIntervention: opts.gate ?? null,
    lastActivityAt: opts.lastActivityAt ?? "2026-11-01T00:00:00.000Z",
    latestIntervention: opts.latestIntervention ?? null,
  } as OperationsPrompt;
}

function gate(promptId: number, status: HumanInterventionStep["status"], response: string | null = null): HumanInterventionStep {
  return {
    id: `gate-${promptId}`,
    promptId,
    requiredAction: "Approve the schema migration",
    status,
    requestedAt: "2026-11-01T10:00:00.000Z",
    response,
    completedAt: response === null ? null : "2026-11-01T11:00:00.000Z",
  };
}

function suite(id: number, prompts: OperationsPrompt[]): OperationsSuite {
  return { id, key: `S${id}`, name: `Suite ${id}`, programName: "Program", prompts } as OperationsSuite;
}

function pipeline(id: number, suiteIds: number[], active: { currentSuiteId: number } | null = null): PipelineRecord {
  return {
    id,
    name: `Pipeline ${id}`,
    stages: suiteIds.map((suiteId) => ({ suiteId })),
    active,
  } as unknown as PipelineRecord;
}

function remark(id: number, kind: PromptRemark["kind"], content: string, createdAt: string): PromptRemark {
  return { id, promptId: 1, runId: null, kind, content, actorType: "AGENT", createdAt };
}

function activity(target: OperationsPrompt, remarks: PromptRemark[]): PromptActivity {
  return { item: target, remarks, events: [], clarifications: [], sessions: [], audits: [], producedWork: false };
}

test("an unanswered approval point needs you even without the attention flag", () => {
  assert.equal(needsYou(item(1, "READY", { gate: gate(1, "PENDING") })), true);
  assert.equal(needsYou(item(1, "READY", { gate: gate(1, "COMPLETE", "ok") })), false);
  const filtered = filterPromptTree([item(1, "READY", { gate: gate(1, "PENDING") }), item(2, "READY")], "attention");
  assert.deepEqual(filtered.map((entry) => entry.prompt.id), [1]);
});

test("thread orders the conversation and marks the unanswered blocker", () => {
  const target = item(1, "BLOCKED", { attention: true });
  const thread = buildThread(
    target,
    activity(target, [
      remark(1, "PROGRESS", "ignored", "2026-11-01T09:00:00.000Z"),
      remark(2, "BLOCKER", "Which database?", "2026-11-01T10:00:00.000Z"),
      remark(3, "OPERATOR_BRIEFING", "Use the staging DB", "2026-11-01T08:00:00.000Z"),
    ]),
  );
  assert.deepEqual(thread.map((entry) => [entry.speaker, entry.text]), [
    ["you", "Use the staging DB"],
    ["agent", "Which database?"],
  ]);
  assert.equal(thread[1]?.open, true);
});

test("an answered blocker is not left open", () => {
  const target = item(1, "BLOCKED", { attention: true });
  const thread = buildThread(
    target,
    activity(target, [
      remark(2, "BLOCKER", "Which database?", "2026-11-01T10:00:00.000Z"),
      remark(3, "HUMAN_RESPONSE", "Postgres", "2026-11-01T10:05:00.000Z"),
    ]),
  );
  assert.equal(thread.some((entry) => entry.open === true), false);
});

test("an approval point answer is not duplicated when it is also a remark", () => {
  const target = item(1, "READY", { gate: gate(1, "COMPLETE", "Approved") });
  const thread = buildThread(target, activity(target, [remark(5, "HUMAN_RESPONSE", "Approved", "2026-11-01T11:00:00.000Z")]));
  assert.equal(thread.filter((entry) => entry.text === "Approved").length, 1);
  assert.equal(thread.find((entry) => entry.speaker === "gate")?.open, false);
});

test("activity for another item is ignored", () => {
  const target = item(1, "READY");
  const other = item(2, "READY");
  assert.deepEqual(buildThread(target, activity(other, [remark(1, "BLOCKER", "x", "2026-11-01T10:00:00.000Z")])), []);
});

test("composer answers when waiting, takes notes otherwise, closes when done", () => {
  assert.equal(composerMode(item(1, "BLOCKED")), "answer");
  assert.equal(composerMode(item(1, "READY", { gate: gate(1, "PENDING") })), "answer");
  assert.equal(composerMode(item(1, "READY")), "note");
  assert.equal(composerMode(item(1, "DONE")), "closed");
  assert.equal(composerMode(item(1, "SKIPPED")), "closed");
});

test("inbox collects nested waiting items, oldest first, with what they ask", () => {
  const deep = item(3, "BLOCKED", { attention: true, lastActivityAt: "2026-11-01T01:00:00.000Z", latestIntervention: "Need a key" });
  const gated = item(4, "READY", { gate: gate(4, "PENDING"), lastActivityAt: "2026-11-01T05:00:00.000Z" });
  const entries = collectInbox([
    suite(1, [item(1, "WAITING_DEPENDENCY", { children: [item(2, "DONE"), deep] })]),
    suite(2, [gated, item(5, "READY")]),
  ]);
  assert.deepEqual(entries.map((entry) => entry.item.prompt.id), [3, 4]);
  assert.equal(entries[0]?.ask, "Need a key");
  assert.equal(entries[1]?.ask, "Approve the schema migration");
  assert.equal(entries[1]?.suite.id, 2);
});

const suites = [suite(10, [item(1, "READY", { children: [item(2, "BLOCKED")] })]), suite(20, [item(3, "READY")])];

test("a prompt opens on the pipeline that drives its suite, sub-steps included", () => {
  const target = resolveOpenTarget({ suite: null, prompt: "2", filter: null }, suites, [pipeline(7, [10])]);
  assert.equal(target, "/pipeline/7?suite=10&prompt=2");
});

test("the running pipeline wins over other pipelines with the suite", () => {
  const target = resolveOpenTarget({ suite: "10", prompt: null, filter: null }, suites, [
    pipeline(7, [10]),
    pipeline(8, [20, 10], { currentSuiteId: 10 }),
  ]);
  assert.equal(target, "/pipeline/8?suite=10");
});

test("a suite with no pipeline opens its own view", () => {
  assert.equal(resolveOpenTarget({ suite: null, prompt: "3", filter: null }, suites, [pipeline(7, [10])]), "/pipeline/suite/20?prompt=3");
});

test("the needs-you filter opens the list on the conversation", () => {
  const target = resolveOpenTarget({ suite: null, prompt: "2", filter: "attention" }, suites, [pipeline(7, [10])]);
  assert.equal(target, "/pipeline/7?suite=10&prompt=2&view=list&filter=attention&tab=conversation");
});

test("unknown items resolve to nothing; no target goes to the overview", () => {
  assert.equal(resolveOpenTarget({ suite: null, prompt: "99", filter: null }, suites, []), null);
  assert.equal(resolveOpenTarget({ suite: "99", prompt: null, filter: null }, suites, []), null);
  assert.equal(resolveOpenTarget({ suite: null, prompt: null, filter: null }, suites, []), "/pipeline");
  assert.equal(resolveOpenTarget({ suite: null, prompt: null, filter: "attention" }, suites, []), "/pipeline#needs-you");
});
