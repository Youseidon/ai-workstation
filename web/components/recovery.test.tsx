import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OperationsPrompt, OperationsSuite, PromptOption } from "@agent-console/shared";
import { ContextPicker, promptState } from "./ContextPicker";
import { activityRemarkLabel, WorkItemDetail } from "./tasks/WorkItemDetail";

function prompt(overrides: Partial<PromptOption> = {}): PromptOption {
  return {
    id: 1,
    title: "Recover local task control",
    content: "do it",
    suiteId: 2,
    suiteName: "M4",
    programId: 3,
    programName: "Agent Console",
    externalKey: "M4",
    status: "IN_PROGRESS",
    ready: false,
    blockedBy: [],
    currentRun: {
      id: "run_unknown_owner",
      provider: "claude",
      model: null,
      role: "execute",
      state: "RUNNING",
      startedAt: "2026-09-13T09:00:00.000Z",
      endedAt: null,
      processActive: false,
    },
    recoverable: false,
    recovery: {
      kind: "start_unknown",
      message: "Ownership is unknown after restart. Confirm provider process state before recovery; recovery stays blocked until the server knows the previous start is stopped or no spawn.",
      startIntentId: "run_unknown_owner",
    },
    ...overrides,
  };
}

function operationsPrompt(item: PromptOption = prompt()): OperationsPrompt {
  return {
    prompt: item,
    workspace: {
      id: 7,
      name: "Fixture",
      workDirectory: "/tmp/agent-console-m4-fixture",
      workDirectoryExists: true,
    },
    programKey: null,
    suiteKey: "M4",
    operationalState: "RECOVERY_NEEDED",
    attention: true,
    latestIntervention: null,
    lastActivityAt: "2026-09-13T09:00:00.000Z",
    sessionCount: 1,
    latestHandoff: null,
    pipelineRule: {
      promptId: item.id,
      provider: null,
      model: null,
      onDone: "continue",
      onBlocked: "wait",
      retryLimit: 1,
      recoverProvider: null,
      recoverModel: null,
      enabled: false,
      stepOrder: 0,
    },
  };
}

function suite(item: OperationsPrompt): OperationsSuite {
  return {
    id: 2,
    key: "M4",
    name: "M4",
    programId: 3,
    programKey: null,
    programName: "Agent Console",
    workspaceId: 7,
    workspaceName: "Fixture",
    counts: {
      WORKING: 0,
      AWAITING_RESPONSE: 0,
      RECOVERY_NEEDED: 1,
      FAILED: 0,
      READY: 0,
      WAITING_DEPENDENCY: 0,
      COMPLETE: 0,
      SKIPPED: 0,
    },
    attentionCount: 1,
    prompts: [item],
    sessions: [],
    latestVerification: null,
    pipeline: {
      defaults: { suiteId: 2, defaultProvider: null, defaultModel: null },
      active: null,
      latest: null,
    },
  };
}

test("START_UNKNOWN reads as ownership unknown in prompt state", () => {
  assert.deepEqual(promptState(prompt()), { text: "ownership unknown", tone: "warning" });
});

test("ContextPicker shows START_UNKNOWN guidance without blind recovery or release", () => {
  const html = renderToStaticMarkup(
    <ContextPicker
      workspaceId={7}
      prompts={[prompt()]}
      savedPromptId={1}
      onPrompt={() => {}}
      disabled={false}
      activeWorkspace={{
        id: 7,
        name: "Fixture",
        description: "",
        workDirectory: "/tmp/agent-console-m4-fixture",
        workDirectoryExists: true,
        createdAt: "2026-09-13T09:00:00.000Z",
        updatedAt: "2026-09-13T09:00:00.000Z",
      }}
      onRecover={() => {}}
      onClassifyStartUnknown={() => {}}
    />,
  );

  assert.match(html, /data-testid="start-unknown-warning"/);
  assert.match(html, /Ownership unknown/);
  assert.match(html, /Confirm provider process state before recovery/);
  assert.match(html, /server knows the previous start is stopped or no spawn/);
  assert.match(html, /Mark known stopped/);
  assert.match(html, /Mark no spawn/);
  assert.doesNotMatch(html, /Recover interrupted run|blind release|release ownership/i);
  assert.equal(/<(button|a)\b[^>]*>\s*(Recover|Release)/i.test(html), false);
  assert.match(html, /min-w-0/);
  assert.match(html, /break-words/);
  assert.match(html, /flex-wrap/);
});

test("Tasks detail blocks START_UNKNOWN recovery while preserving visible guidance", () => {
  const item = operationsPrompt();
  const html = renderToStaticMarkup(
    <WorkItemDetail
      suite={suite(item)}
      item={item}
      activity={null}
      busy={false}
      canStart={false}
      verifyingItem={false}
      connectionOpen={true}
      providerLabel="Claude"
      model={null}
      onRun={() => {}}
      onStop={() => {}}
      onRecover={() => {}}
      onClassifyStartUnknown={() => {}}
      onRespond={() => {}}
      onVerifyItem={() => {}}
    />,
  );

  assert.match(html, /data-testid="start-unknown-warning"/);
  assert.match(html, /Ownership unknown/);
  assert.match(html, /Recovery blocked/);
  assert.match(html, /Mark known stopped/);
  assert.match(html, /Mark no spawn/);
  assert.doesNotMatch(html, /Recover and resume|blind release|release ownership/i);
  assert.match(html, /flex-wrap/);
});

test("task activity labels Telegram-originated human responses distinctly", () => {
  assert.equal(activityRemarkLabel({
    id: 1,
    promptId: 1,
    runId: null,
    kind: "HUMAN_RESPONSE",
    content: "Use directory.example",
    actorType: "USER",
    createdAt: "2026-09-16T00:00:00.000Z",
    source: "telegram",
  }), "Telegram · HUMAN_RESPONSE");
  assert.equal(activityRemarkLabel({
    id: 2,
    promptId: 1,
    runId: null,
    kind: "HUMAN_RESPONSE",
    content: "Local answer",
    actorType: "USER",
    createdAt: "2026-09-16T00:01:00.000Z",
    source: "local",
  }), "USER · HUMAN_RESPONSE");
});
