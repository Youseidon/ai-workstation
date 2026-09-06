/**
 * The one door, and the wall around it.
 *
 * The app has always told agents "never open or modify SQLite directly" — in a
 * Markdown block, while leaving the file inside the directory it gave them
 * write access to. These tests cover the two things that turn that instruction
 * into a fact: the database living somewhere an agent cannot reach, and a
 * command that makes reporting easier than not reporting.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { progressApiMarkdown } from "./agentContext.ts";
import { createAgentShim, removeAgentShim } from "./agentShim.ts";
import { workspaces } from "./workspaces.ts";

const SHIM = resolve(fileURLToPath(import.meta.url), "../../bin/agent-step.mjs");

function run(args: string[], env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync(process.execPath, [SHIM, ...args], {
      env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out: stdout, err: "" };
  } catch (error) {
    const e = error as { status: number; stdout: string; stderr: string };
    return { code: e.status, out: e.stdout ?? "", err: e.stderr ?? "" };
  }
}

/* ------------------------------------------------------------------ */
/* The wall                                                            */
/* ------------------------------------------------------------------ */

test("the database is not inside any workspace an agent can write to", () => {
  // The guarantee, asserted against the real resolved path. A prompt asking an
  // agent not to touch the file is an instruction a model may drop; a file it
  // cannot reach is a fact.
  workspaces.assertDatabaseOutOfReach();
});

test("a database inside a workspace stops the server rather than warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-door-"));
  try {
    // Point a workspace at the directory the database is actually in. By the
    // time an agent has opened the file, a status set behind the API's back —
    // no ledger row, no recorded cause — is indistinguishable from a real one,
    // so this has to be refused up front rather than detected later.
    const workspace = workspaces.create({
      name: `door-${process.pid}-${Date.now()}`, description: "",
      workDirectory: dirname(workspaces.databasePath),
    });
    try {
      assert.throws(() => workspaces.assertDatabaseOutOfReach(), /inside workspace/i);
    } finally {
      workspaces.remove(workspace.id);
    }
    // With it gone, the check passes again — the guard tracks the workspaces
    // that exist rather than a one-time decision made at boot.
    workspaces.assertDatabaseOutOfReach();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* The door                                                            */
/* ------------------------------------------------------------------ */

test("the launcher carries this run's credentials and nothing else does", () => {
  const path = createAgentShim({ runId: "run-door-1", token: "tok-abc", port: 4999 });
  assert.ok(path !== null);
  try {
    const script = readFileSync(path, "utf8");
    assert.match(script, /tok-abc/);
    assert.match(script, /run-door-1/);
    // Not world-readable: it holds a live run credential.
    assert.equal(statSync(path).mode & 0o077, 0, "the launcher is readable by other users");
    // Credentials must not reach process.env — the Claude adapter runs the SDK
    // in this process, so a per-run variable there would be shared by every
    // concurrent run, and an agent could post against another run's work item.
    assert.equal(process.env.AGENT_CONSOLE_RUN_TOKEN, undefined);
  } finally {
    removeAgentShim("run-door-1");
  }
});

test("a finished run's launcher is removed", () => {
  const path = createAgentShim({ runId: "run-door-2", token: "tok-xyz", port: 4999 });
  assert.ok(path !== null);
  removeAgentShim("run-door-2");
  assert.throws(() => statSync(path), /ENOENT/);
});

test("the command refuses a claim with no evidence, before spending a round trip", () => {
  const env = { AGENT_CONSOLE_RUN_URL: "http://127.0.0.1:1/x", AGENT_CONSOLE_RUN_TOKEN: "t" };
  const done = run(["done"], env);
  assert.equal(done.code, 1);
  assert.match(done.err, /--verification/);

  // A blocker without the action a human must take is not a blocker, it is a
  // shrug. Caught locally so the run learns immediately rather than after a
  // 422 it might not read.
  const blocked = run(["blocked", "--reason", "the thing is down"], env);
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /--action/);
});

test("without credentials it says so instead of failing obscurely", () => {
  const result = run(["done", "--verification", "x"], { AGENT_CONSOLE_RUN_URL: "", AGENT_CONSOLE_RUN_TOKEN: "" });
  assert.equal(result.code, 1);
  assert.match(result.err, /only works inside a run/i);
});

test("help is available and exits cleanly", () => {
  assert.equal(run(["help"]).code, 0);
  // Bare invocation prints usage but is still a failure: the agent asked for
  // nothing, so nothing was recorded.
  assert.equal(run([]).code, 1);
});

/* ------------------------------------------------------------------ */
/* What the agent is told                                              */
/* ------------------------------------------------------------------ */

test("the contract leads with the command, not a curl to assemble", () => {
  const markdown = progressApiMarkdown({
    runId: "r1", token: "secret-token", port: 4000, canDecompose: true, shimPath: "/tmp/x/agent-step",
  });
  assert.match(markdown, /\/tmp\/x\/agent-step" remark/);
  assert.match(markdown, /\/tmp\/x\/agent-step" done/);
  // Four things a model can get wrong between it and a status post — the URL,
  // the header, the JSON, and a unique id — are gone from the happy path.
  assert.doesNotMatch(markdown, /curl/);
  assert.doesNotMatch(markdown, /secret-token/);
  assert.doesNotMatch(markdown, /requestId/);
  // It must say what happens if it does not report, or the incentive is invisible.
  assert.match(markdown, /unreported/i);
  assert.match(markdown, /outside this working directory/i);
});

test("with no launcher the raw contract is still there", () => {
  // A model that cannot run the command must still have a way to report.
  // Silently having none is the exact failure all of this guards against.
  const markdown = progressApiMarkdown({ runId: "r1", token: "tok", port: 4000, canDecompose: true, shimPath: null });
  assert.match(markdown, /curl/);
  assert.match(markdown, /expectedStatus/);
  assert.match(markdown, /outside this working directory/i);
});

test("a sub-step at maximum depth is not offered decompose", () => {
  const deep = progressApiMarkdown({ runId: "r1", token: "t", port: 4000, canDecompose: false, shimPath: "/tmp/x/agent-step" });
  assert.doesNotMatch(deep, /decompose --file/);
  assert.match(deep, /cannot be decomposed/);
});
