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
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { progressApiMarkdown } from "../src/agentContext.ts";
import { createAgentShim, removeAgentShim } from "../src/agentShim.ts";
import { newId } from "../src/lib/ids.ts";
import { runContexts } from "../src/runContext.ts";
import { workspaces } from "../src/workspaces.ts";

const SHIM = resolve(fileURLToPath(import.meta.url), "../../bin/agent-step.mjs");

let seq = 0;
const uniqueName = (prefix: string): string => `${prefix}-${process.pid}-${Date.now()}-${(seq += 1)}`;

/** A work item with a live execute run against it, for the status-post tests. */
function ledgerFixture() {
  const dir = mkdtempSync(join(tmpdir(), "agent-door-item-"));
  const workspace = workspaces.create({ name: uniqueName("ws"), description: "", workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: uniqueName("prog"), overview: "" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: uniqueName("suite"), overview: "" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: uniqueName("p"), content: "do work" }) as PromptRecord;
  return {
    workspace,
    prompt,
    cleanup() {
      workspaces.remove(workspace.id);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function beginExecute(promptId: number, workspaceId: number): string {
  const runId = newId("run");
  const credential = runContexts.create(runId, workspaceId, promptId);
  workspaces.beginAgentRun({
    runId, workspaceId, promptId, provider: "claude", model: null,
    tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute",
  });
  return runId;
}

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

/* ------------------------------------------------------------------ */
/* Handing over instead of stopping                                    */
/* ------------------------------------------------------------------ */

test("the command refuses a handover that does not say what remains", () => {
  const env = { AGENT_CONSOLE_RUN_URL: "http://127.0.0.1:1/x", AGENT_CONSOLE_RUN_TOKEN: "t" };
  const result = run(["continue"], env);
  assert.equal(result.code, 1);
  assert.match(result.err, /--remaining/);
  // The brief is the whole point of a continuation: an empty one costs the next
  // run everything this one learned.
  assert.match(result.err, /instructions for the run that picks this up/);
});

test("continue is offered beside done and blocked, not buried", () => {
  // A command an agent is not told about is a command it does not use, and
  // "work remains" would go back to being reported as BLOCKED.
  const usage = run(["help"]).out;
  assert.match(usage, /agent-step continue --remaining/);
  assert.match(usage, /exactly one of 'done', 'continue' or 'blocked'/);
  assert.match(usage, /'blocked' is for a concrete external dependency/);
});

test("the door accepts CONTINUE and turns it into a brief and a TODO", () => {
  const ctx = ledgerFixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    workspaces.updateAgentStatus(runId, {
      requestId: `req-${Date.now()}`, expectedStatus: "IN_PROGRESS", status: "CONTINUE",
      reason: "Ports 3-8 of src/api are untouched; copy the shape of port 2.",
    });

    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "TODO");
    const history = workspaces.promptHistory(ctx.prompt.id);
    const event = (history.events as Array<Record<string, unknown>>)[0]!;
    assert.equal(event.newStatus, "TODO");
    assert.equal(event.trigger, "agent_continue");
    assert.equal(event.ruleId, "agent-continue");
    assert.equal(event.actorType, "AGENT");
    // The evidence carries both halves the next run is entitled to: what is
    // left, and whatever this run managed to verify before it ran out.
    assert.match(String((event.evidence as Record<string, unknown>).remaining), /Ports 3-8/);
    const brief = (history.remarks as Array<{ kind: string; content: string }>).find((r) => r.kind === "CONTINUATION");
    assert.match(brief?.content ?? "", /Ports 3-8/);
  } finally {
    ctx.cleanup();
  }
});

test("CONTINUE is not a status anything can be left in", () => {
  const ctx = ledgerFixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    // A handover with nothing in it is not a handover. The next run would get
    // a work item back on TODO with an empty brief and no idea what happened.
    assert.throws(
      () => workspaces.updateAgentStatus(runId, {
        requestId: `req-empty-${Date.now()}`, expectedStatus: "IN_PROGRESS", status: "CONTINUE", reason: "",
      }),
      /remaining/i,
    );
    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "IN_PROGRESS");
  } finally {
    ctx.cleanup();
  }
});

test("a second CONTINUE with the same requestId is the same handover, not another one", () => {
  const ctx = ledgerFixture();
  try {
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    const requestId = `req-replay-${Date.now()}`;
    const post = () => workspaces.updateAgentStatus(runId, {
      requestId, expectedStatus: "IN_PROGRESS", status: "CONTINUE", reason: "Finish the migration.",
    });
    const first = post();
    // Idempotent exactly as done and blocked are: a retried command must not
    // file a second brief or a second ledger row.
    assert.deepEqual(post(), first);
    const history = workspaces.promptHistory(ctx.prompt.id);
    assert.equal((history.remarks as Array<{ kind: string }>).filter((r) => r.kind === "CONTINUATION").length, 1);
    assert.equal((history.events as Array<{ newStatus: string }>).filter((e) => e.newStatus === "TODO").length, 1);
  } finally {
    ctx.cleanup();
  }
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
  // requestId is named only to say the launcher owns it.
  assert.match(markdown, /requestId must be unique/);
  assert.ok(Buffer.byteLength(markdown) < 1024);
});

test("with no launcher the raw contract is still there", () => {
  // A model that cannot run the command must still have a way to report.
  // Silently having none is the exact failure all of this guards against.
  const markdown = progressApiMarkdown({ runId: "r1", token: "tok", port: 4000, canDecompose: true, shimPath: null });
  assert.match(markdown, /curl/);
  assert.match(markdown, /expectedStatus/);
  assert.match(markdown, /requestId must be unique/);
});

test("a sub-step at maximum depth is not offered decompose", () => {
  const deep = progressApiMarkdown({ runId: "r1", token: "t", port: 4000, canDecompose: false, shimPath: "/tmp/x/agent-step" });
  assert.doesNotMatch(deep, /decompose --file/);
});

/* ------------------------------------------------------------------ */
/* Server-verified done                                                */
/* ------------------------------------------------------------------ */

test("agent-step prints each failing Verify command on verification_failed", () => {
  // The 409 body is useless if the shim collapses it to one line the model
  // skims past. One block per command is what the prompt requires.
  const source = readFileSync(SHIM, "utf8");
  assert.match(source, /verification_failed/);
  assert.match(source, /formatVerificationFailures/);
  assert.match(source, /error\?\.failures/);
});

test("a refused done leaves the item IN_PROGRESS with a SYSTEM VERIFICATION remark", async () => {
  const { runDefinitionOfDoneCommands } = await import("../src/definitionOfDone.ts");
  const ctx = ledgerFixture();
  try {
    workspaces.updateChild("prompt", ctx.prompt.id, {
      content: "## Verify\n```sh\necho refused-output >&2; exit 7\n```\n",
    });
    const runId = beginExecute(ctx.prompt.id, ctx.workspace.id);
    workspaces.markAgentRunRunning(runId);
    await runDefinitionOfDoneCommands(ctx.prompt.id, runId);
    const failures = workspaces.agentDoneVerificationFailures(ctx.prompt.id);
    assert.ok(failures !== null);
    assert.equal(failures![0]!.exitCode, 7);
    workspaces.recordVerificationFailureRemark(ctx.prompt.id, runId, failures!);
    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "IN_PROGRESS");
    const remark = (workspaces.promptHistory(ctx.prompt.id).remarks as Array<{ kind: string; actorType: string; content: string }>)
      .find((row) => row.kind === "VERIFICATION" && row.actorType === "SYSTEM");
    assert.match(remark?.content ?? "", /refused-output/);
    assert.match(remark?.content ?? "", /exit 7/);
  } finally {
    ctx.cleanup();
  }
});
