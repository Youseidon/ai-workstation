import { emptyBudgetSnapshot } from "./runner.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { RunHandle } from "./runner.ts";
import { runHub } from "./runHub.ts";
import { ProviderUnavailableError, startConsult, startExecute, startVerifySuite } from "./runService.ts";
import { WorkspaceError } from "./workspaces.ts";

function fakeHandle(runId: string): RunHandle {
  return {
    runId,
    provider: "claude",
    model: null,
    role: "execute",
    permissionMode: null,
    budget: emptyBudgetSnapshot,
    interrupt: async () => {},
    done: Promise.resolve("done"),
  };
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `missing ${name}`);
  const next = source.indexOf("export async function", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function firstIndex(source: string, pattern: string): number {
  const index = source.indexOf(pattern);
  assert.ok(index >= 0, `missing ${pattern}`);
  return index;
}

const workspace = { id: 91001, name: "Lock", workDirectory: "/tmp/run-service-lock" };

test("startExecute refuses a second writer before checking the provider", async () => {
  const executeId = "run_svc_lock";
  try {
    runHub.start({
      handle: fakeHandle(executeId),
      workspace,
      source: { type: "custom", displayText: "write" },
      role: "execute",
      permissionMode: null,
    });
    await assert.rejects(
      () => startExecute({ workspaceId: workspace.id, provider: "not-a-provider", model: null, prompt: "x" }),
      (error: unknown) =>
        error instanceof WorkspaceError &&
        error.status === 409 &&
        error.code === "workspace_busy" &&
        error.fields?.detail === "Stop the running agent before starting another in the same working directory.",
    );
  } finally {
    runHub.end(executeId, "done");
  }
});

test("provider unavailable keeps the detection snapshot", () => {
  const providers = [] as ProviderUnavailableError["providers"];
  const error = new ProviderUnavailableError("claude", "detection failed", providers);
  assert.equal(error.status, 409);
  assert.equal(error.code, "provider_unavailable");
  assert.equal(error.fields?.detail, "detection failed");
  assert.equal(error.providers, providers);
  assert.equal(error instanceof WorkspaceError, true);
});

test("startExecute rejects an unknown provider when the workspace is free", async () => {
  await assert.rejects(
    () => startExecute({ workspaceId: workspace.id, provider: "not-a-provider", model: null, prompt: "x" }),
    (error: unknown) =>
      error instanceof WorkspaceError &&
      error.status === 422 &&
      error.code === "unknown_provider",
  );
});

test("runService starts without a socket and does not interrupt", () => {
  const source = readFileSync(new URL("./runService.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from ["']ws["']/);
  assert.doesNotMatch(source, /import\s+(?:type\s+)?\{[^}]*\bWebSocket\b/);
  assert.equal(startExecute.length, 1);
  assert.equal(startVerifySuite.length, 1);
  assert.equal(startConsult.length, 1);
  assert.doesNotMatch(source, /\brunHub\.stop\b|\.interrupt\s*\(/);
});

test("startExecute lock, persist, launch, and finish happen in order", () => {
  const body = functionBody(readFileSync(new URL("./runService.ts", import.meta.url), "utf8"), "startExecute");
  const pipelineLock = firstIndex(body, "activePipelineForWorkspace");
  const lock = firstIndex(body, "runHub.activeForWorkspace");
  const begin = firstIndex(body, "beginAgentRun");
  const launch = firstIndex(body, "startRun(");
  const running = firstIndex(body, "markAgentRunRunning");
  const hubStart = firstIndex(body, "runHub.start");
  assert.ok(pipelineLock < lock && lock < begin && begin < launch && launch < running && running < hubStart);
  const onEnd = body.slice(firstIndex(body, "onEnd:"), running);
  assert.ok(firstIndex(onEnd, "finishAgentRun") < firstIndex(onEnd, "finishClarification"));
  assert.ok(firstIndex(onEnd, "finishClarification") < firstIndex(onEnd, "runHub.end"));
  assert.ok(firstIndex(onEnd, "runHub.end") < firstIndex(onEnd, "onExecuteEnded"));
});

test("startConsult does not take the writer lock and forces the consult sandbox", () => {
  const body = functionBody(readFileSync(new URL("./runService.ts", import.meta.url), "utf8"), "startConsult");
  assert.doesNotMatch(body, /activeForWorkspace|activePipelineForWorkspace|beginAgentRun|onExecuteEnded/);
  assert.match(body, /consultsForWorkspace/);
  assert.match(body, /beginConsultRun/);
  assert.match(body, /permissionOverride:\s*"consult"/);
  assert.doesNotMatch(body, /permissionOverride:\s*"inherit"/);
  assert.doesNotMatch(body, /hostAccess/);
  const cap = firstIndex(body, "consultsForWorkspace");
  const cursor = firstIndex(body, 'args.provider === "cursor"');
  const provider = firstIndex(body, "requireAvailableProvider");
  const begin = firstIndex(body, "beginConsultRun");
  const launch = firstIndex(body, "startRun(");
  assert.ok(cursor < cap && cap < provider && provider < begin && begin < launch);
});

test("startConsult does not 409 when an execute owns the workspace", async () => {
  const executeId = "run_svc_consult_lock";
  try {
    runHub.start({
      handle: fakeHandle(executeId),
      workspace,
      source: { type: "custom", displayText: "write" },
      role: "execute",
      permissionMode: null,
    });
    await assert.rejects(
      () => startConsult({ workspaceId: workspace.id, provider: "not-a-provider", model: null, prompt: "why?" }),
      (error: unknown) =>
        error instanceof WorkspaceError &&
        error.status === 422 &&
        error.code === "unknown_provider",
    );
  } finally {
    runHub.end(executeId, "done");
  }
});

test("startConsult rejects Cursor with 422 consult_not_supported", async () => {
  await assert.rejects(
    () => startConsult({ workspaceId: workspace.id, provider: "cursor", model: null, prompt: "why?" }),
    (error: unknown) =>
      error instanceof WorkspaceError &&
      error.status === 422 &&
      error.code === "consult_not_supported",
  );
});

test("startConsult caps concurrent consults per workspace at 3", async () => {
  const ids = ["run_c1", "run_c2", "run_c3"];
  try {
    for (const runId of ids) {
      runHub.start({
        handle: { ...fakeHandle(runId), role: "consult", permissionMode: "plan" },
        workspace,
        source: { type: "consult", promptId: null, promptKey: null, title: null, question: "ask" },
        role: "consult",
        permissionMode: "plan",
      });
    }
    await assert.rejects(
      () => startConsult({ workspaceId: workspace.id, provider: "claude", model: null, prompt: "why?" }),
      (error: unknown) =>
        error instanceof WorkspaceError &&
        error.status === 422 &&
        error.code === "consult_limit",
    );
  } finally {
    for (const runId of ids) runHub.end(runId, "done");
  }
});

test("startVerifySuite lock, persist, launch, and finish happen in order", () => {
  const body = functionBody(readFileSync(new URL("./runService.ts", import.meta.url), "utf8"), "startVerifySuite");
  const available = firstIndex(body, "requireAvailableProvider");
  const suite = firstIndex(body, "suiteHeader");
  const lock = firstIndex(body, "activeForWorkspace");
  const begin = firstIndex(body, "beginSuiteVerification");
  const launch = firstIndex(body, "startRun(");
  const hubStart = firstIndex(body, "runHub.start");
  assert.ok(available < suite && suite < lock && lock < begin && begin < launch && launch < hubStart);
  const onEnd = body.slice(firstIndex(body, "onEnd:"), hubStart);
  assert.ok(firstIndex(onEnd, "finishSuiteVerification") < firstIndex(onEnd, "runHub.end"));
});
