import { emptyBudgetSnapshot } from "./runner.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import type { RunHandle } from "./runner.ts";
import { runHub } from "./runHub.ts";
import { runContexts } from "./runContext.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${seq}`;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "consult-"));
  const workspace = workspaces.create({ name: unique("ws"), description: "Standing rules.", workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: unique("prog"), overview: "" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: unique("suite"), overview: "" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: unique("p0"), content: "do work" }) as PromptRecord;
  return {
    dir,
    workspace,
    prompt,
    cleanup() {
      workspaces.remove(workspace.id);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function fakeHandle(runId: string, role: RunHandle["role"] = "consult"): RunHandle {
  return {
    runId,
    provider: "claude",
    model: null,
    role,
    permissionMode: role === "consult" ? "plan" : null,
    budget: emptyBudgetSnapshot,
    interrupt: async () => {},
    done: Promise.resolve("done"),
  };
}

function future(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

test("schema version 9 rebuilds agent_run with nullable prompt_id and execute-only uniqueness", () => {
  const source = readFileSync(new URL("./workspaces.ts", import.meta.url), "utf8");
  // Bounded to migration 9 alone: the slice used to run to the end of every
  // migration, so any later table with a NOT NULL prompt_id failed this.
  const migrate9 = source.slice(source.indexOf("if (version < 9)"), source.indexOf("const afterNine"));
  assert.match(migrate9, /prompt_id INTEGER REFERENCES prompt\(id\) ON DELETE CASCADE/);
  assert.doesNotMatch(migrate9, /prompt_id INTEGER NOT NULL/);
  assert.match(migrate9, /WHERE state IN \('STARTING','RUNNING'\) AND role = 'execute'/);
  const recover = source.slice(source.indexOf("const recoverAbandonedRuns"), source.indexOf("recoverAbandonedRuns();"));
  assert.match(recover, /role='execute'/);
  assert.doesNotMatch(recover, /role='consult'/);
});

test("consult finish does not force the prompt BLOCKED", () => {
  const ctx = fixture();
  try {
    const runId = unique("run");
    const credential = runContexts.create(runId, ctx.workspace.id, ctx.prompt.id, undefined, "why?");
    workspaces.beginConsultRun({
      runId,
      workspaceId: ctx.workspace.id,
      promptId: ctx.prompt.id,
      provider: "claude",
      model: null,
      tokenHash: credential.tokenHash,
      expiresAt: credential.expiresAt,
    });
    workspaces.markAgentRunRunning(runId);
    const before = workspaces.resolvePrompt(ctx.workspace.id, ctx.prompt.id);
    assert.equal(before.status, "TODO");
    workspaces.finishAgentRun(runId, "done", "I would have blocked this");
    const after = workspaces.resolvePrompt(ctx.workspace.id, ctx.prompt.id);
    assert.equal(after.status, "TODO");
    const history = workspaces.promptHistory(ctx.prompt.id);
    assert.equal((history.events as Array<{ newStatus: string }>).some((event) => event.newStatus === "BLOCKED"), false);
  } finally {
    ctx.cleanup();
  }
});

test("consult finish leaves an IN_PROGRESS execute prompt untouched", () => {
  const ctx = fixture();
  try {
    const executeId = unique("run");
    const consultId = unique("run");
    const executeCred = runContexts.create(executeId, ctx.workspace.id, ctx.prompt.id);
    workspaces.beginAgentRun({
      runId: executeId,
      workspaceId: ctx.workspace.id,
      promptId: ctx.prompt.id,
      provider: "claude",
      model: null,
      tokenHash: executeCred.tokenHash,
      expiresAt: executeCred.expiresAt,
      role: "execute",
    });
    const consultCred = runContexts.create(consultId, ctx.workspace.id, ctx.prompt.id, undefined, "why?");
    workspaces.beginConsultRun({
      runId: consultId,
      workspaceId: ctx.workspace.id,
      promptId: ctx.prompt.id,
      provider: "grok",
      model: null,
      tokenHash: consultCred.tokenHash,
      expiresAt: consultCred.expiresAt,
    });
    assert.equal(workspaces.resolvePrompt(ctx.workspace.id, ctx.prompt.id).status, "IN_PROGRESS");
    workspaces.finishAgentRun(consultId, "done");
    assert.equal(workspaces.resolvePrompt(ctx.workspace.id, ctx.prompt.id).status, "IN_PROGRESS");
    workspaces.finishAgentRun(executeId, "error");
    assert.equal(workspaces.resolvePrompt(ctx.workspace.id, ctx.prompt.id).status, "BLOCKED");
  } finally {
    ctx.cleanup();
  }
});

test("consult status and remarks are 403 consult_read_only", () => {
  const ctx = fixture();
  try {
    const runId = unique("run");
    const credential = runContexts.create(runId, ctx.workspace.id, ctx.prompt.id, undefined, "why?");
    workspaces.beginConsultRun({
      runId,
      workspaceId: ctx.workspace.id,
      promptId: ctx.prompt.id,
      provider: "claude",
      model: null,
      tokenHash: credential.tokenHash,
      expiresAt: future(),
    });
    workspaces.markAgentRunRunning(runId);
    assert.throws(
      () => workspaces.updateAgentStatus(runId, { requestId: "status-01", expectedStatus: "TODO", status: "DONE", reason: "nope", verificationSummary: "nope" }),
      (error: unknown) => error instanceof WorkspaceError && error.status === 403 && error.code === "consult_read_only",
    );
    assert.throws(
      () => workspaces.addAgentRemark(runId, { requestId: "remark-01", kind: "PROGRESS", content: "writing" }),
      (error: unknown) => error instanceof WorkspaceError && error.status === 403 && error.code === "consult_read_only",
    );
    assert.equal(workspaces.resolvePrompt(ctx.workspace.id, ctx.prompt.id).status, "TODO");
  } finally {
    ctx.cleanup();
  }
});

test("processActive is execute-only when a consult is attached to the same prompt", () => {
  const ctx = fixture();
  const consultId = unique("run");
  const executeId = unique("run");
  try {
    const consultCred = runContexts.create(consultId, ctx.workspace.id, ctx.prompt.id, undefined, "why?");
    workspaces.beginConsultRun({
      runId: consultId,
      workspaceId: ctx.workspace.id,
      promptId: ctx.prompt.id,
      provider: "grok",
      model: null,
      tokenHash: consultCred.tokenHash,
      expiresAt: consultCred.expiresAt,
    });
    runHub.start({
      handle: fakeHandle(consultId, "consult"),
      workspace: { id: ctx.workspace.id, name: ctx.workspace.name, workDirectory: ctx.workspace.workDirectory },
      source: { type: "consult", promptId: ctx.prompt.id, promptKey: ctx.prompt.externalKey, title: ctx.prompt.title, question: "why?" },
      role: "consult",
      permissionMode: "plan",
    });
    const consulting = workspaces.resolvePrompt(ctx.workspace.id, ctx.prompt.id);
    assert.equal(consulting.currentRun?.id, consultId);
    assert.equal(consulting.currentRun?.processActive, false);
    assert.equal(consulting.status, "TODO");

    const executeCred = runContexts.create(executeId, ctx.workspace.id, ctx.prompt.id);
    workspaces.beginAgentRun({
      runId: executeId,
      workspaceId: ctx.workspace.id,
      promptId: ctx.prompt.id,
      provider: "claude",
      model: null,
      tokenHash: executeCred.tokenHash,
      expiresAt: executeCred.expiresAt,
      role: "execute",
    });
    runHub.start({
      handle: fakeHandle(executeId, "execute"),
      workspace: { id: ctx.workspace.id, name: ctx.workspace.name, workDirectory: ctx.workspace.workDirectory },
      source: { type: "saved", promptId: ctx.prompt.id, promptKey: ctx.prompt.externalKey, title: ctx.prompt.title, programName: "p", suiteName: "s" },
      role: "execute",
      permissionMode: null,
    });
    const writing = workspaces.resolvePrompt(ctx.workspace.id, ctx.prompt.id);
    assert.equal(writing.currentRun?.id, executeId);
    assert.equal(writing.currentRun?.role, "execute");
    assert.equal(writing.currentRun?.processActive, true);
    assert.equal(writing.status, "IN_PROGRESS");
  } finally {
    runHub.end(consultId, "done");
    runHub.end(executeId, "done");
    ctx.cleanup();
  }
});

test("custom consults persist without a prompt and show as research", () => {
  const ctx = fixture();
  try {
    const runId = unique("run");
    const credential = runContexts.create(runId, ctx.workspace.id, null, undefined, "what owns auth?");
    workspaces.beginConsultRun({
      runId,
      workspaceId: ctx.workspace.id,
      promptId: null,
      provider: "codex",
      model: null,
      tokenHash: credential.tokenHash,
      expiresAt: credential.expiresAt,
    });
    const session = workspaces.sessions().find((item) => item.id === runId);
    assert.equal(session?.promptId, null);
    assert.equal(session?.promptTitle, "(research)");
    assert.equal(session?.promptStatus, null);
    assert.equal(session?.role, "consult");
    workspaces.finishAgentRun(runId, "done");
    const prompt = workspaces.resolvePrompt(ctx.workspace.id, ctx.prompt.id);
    assert.equal(prompt.status, "TODO");
  } finally {
    ctx.cleanup();
  }
});

test("agent API consult path forbids mutation and omits the Progress API appendix", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const agentApi = source.slice(source.indexOf("const agentMatch"), source.indexOf('url.pathname === "/api/sessions"'));
  assert.match(agentApi, /consult_read_only/);
  assert.match(agentApi, /persisted\.role==="consult"/);
  const consultGet = agentApi.slice(agentApi.indexOf("operation===\"context\""), agentApi.indexOf("Progress API"));
  assert.match(consultGet, /consultContextText/);
  assert.doesNotMatch(consultGet, /## Progress API/);
});
