import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { RunHandle } from "./runner.ts";
import { runHub } from "./runHub.ts";
import { startExecute, startVerifySuite } from "./runService.ts";
import { WorkspaceError } from "./workspaces.ts";

function fakeHandle(runId: string): RunHandle {
  return {
    runId,
    provider: "claude",
    model: null,
    role: "execute",
    permissionMode: null,
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
  assert.doesNotMatch(source, /\brunHub\.stop\b|\.interrupt\s*\(/);
});

test("startExecute lock, persist, launch, and finish happen in order", () => {
  const body = functionBody(readFileSync(new URL("./runService.ts", import.meta.url), "utf8"), "startExecute");
  const lock = firstIndex(body, "activeForWorkspace");
  const begin = firstIndex(body, "beginAgentRun");
  const launch = firstIndex(body, "startRun(");
  const running = firstIndex(body, "markAgentRunRunning");
  const hubStart = firstIndex(body, "runHub.start");
  assert.ok(lock < begin && begin < launch && launch < running && running < hubStart);
  const onEnd = body.slice(firstIndex(body, "onEnd:"), running);
  assert.ok(firstIndex(onEnd, "finishAgentRun") < firstIndex(onEnd, "finishClarification"));
  assert.ok(firstIndex(onEnd, "finishClarification") < firstIndex(onEnd, "runHub.end"));
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
