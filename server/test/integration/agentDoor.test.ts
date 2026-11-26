import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@hydra/shared";
import { progressApiMarkdown } from "../../src/services/agents/agentContext.ts";
import { programAuthorPrompt } from "../../src/services/programs/programAuthor.ts";
import { createAgentShim, removeAgentShim } from "../../src/services/agents/agentShim.ts";
import { newId } from "../../src/utils/ids.ts";
import { runContexts } from "../../src/services/runs/runContext.ts";
import { workspaces } from "../../src/repositories/workspaces.ts";

const SHIM = resolve(fileURLToPath(import.meta.url), "../../../bin/agent-step.mjs");

let seq = 0;
const uniqueName = (prefix: string): string => `${prefix}-${process.pid}-${Date.now()}-${(seq += 1)}`;

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

test("the database is not inside any workspace an agent can write to", () => {
  workspaces.assertDatabaseOutOfReach();
});

test("a database inside a workspace stops the server rather than warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-door-"));
  try {
    const workspace = workspaces.create({
      name: `door-${process.pid}-${Date.now()}`, description: "",
      workDirectory: dirname(workspaces.databasePath),
    });
    try {
      assert.throws(() => workspaces.assertDatabaseOutOfReach(), /inside workspace/i);
    } finally {
      workspaces.remove(workspace.id);
    }
    workspaces.assertDatabaseOutOfReach();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the launcher carries this run's credentials and nothing else does", () => {
  const path = createAgentShim({ runId: "run-door-1", token: "tok-abc", port: 4999 });
  assert.ok(path !== null);
  try {
    const script = readFileSync(path, "utf8");
    assert.match(script, /tok-abc/);
    assert.match(script, /run-door-1/);
    assert.equal(statSync(path).mode & 0o077, 0, "the launcher is readable by other users");
    assert.equal(process.env.HYDRA_RUN_TOKEN, undefined);
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
  const env = { HYDRA_RUN_URL: "http://127.0.0.1:1/x", HYDRA_RUN_TOKEN: "t" };
  const done = run(["done"], env);
  assert.equal(done.code, 1);
  assert.match(done.err, /--verification/);

  const blocked = run(["blocked", "--reason", "the thing is down"], env);
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /--action/);
});

test("the command refuses a handover that does not say what remains", () => {
  const env = { HYDRA_RUN_URL: "http://127.0.0.1:1/x", HYDRA_RUN_TOKEN: "t" };
  const result = run(["continue"], env);
  assert.equal(result.code, 1);
  assert.match(result.err, /--remaining/);
  assert.match(result.err, /instructions for the run that picks this up/);
});

test("continue is offered beside done and blocked, not buried", () => {
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
    assert.deepEqual(post(), first);
    const history = workspaces.promptHistory(ctx.prompt.id);
    assert.equal((history.remarks as Array<{ kind: string }>).filter((r) => r.kind === "CONTINUATION").length, 1);
    assert.equal((history.events as Array<{ newStatus: string }>).filter((e) => e.newStatus === "TODO").length, 1);
  } finally {
    ctx.cleanup();
  }
});

test("without credentials it says so instead of failing obscurely", () => {
  const result = run(["done", "--verification", "x"], { HYDRA_RUN_URL: "", HYDRA_RUN_TOKEN: "" });
  assert.equal(result.code, 1);
  assert.match(result.err, /only works inside a run/i);
});

test("help is available and exits cleanly", () => {
  assert.equal(run(["help"]).code, 0);
  assert.equal(run([]).code, 1);
});

test("the contract leads with the command, not a curl to assemble", () => {
  const markdown = progressApiMarkdown({
    runId: "r1", token: "secret-token", port: 4000, canDecompose: true, shimPath: "/tmp/x/agent-step",
  });
  assert.match(markdown, /\/tmp\/x\/agent-step" remark/);
  assert.match(markdown, /\/tmp\/x\/agent-step" done/);
  assert.doesNotMatch(markdown, /curl/);
  assert.doesNotMatch(markdown, /secret-token/);
  assert.match(markdown, /requestId must be unique/);
  assert.ok(Buffer.byteLength(markdown) < 1024);
});

test("with no launcher the raw contract is still there", () => {
  const markdown = progressApiMarkdown({ runId: "r1", token: "tok", port: 4000, canDecompose: true, shimPath: null });
  assert.match(markdown, /curl/);
  assert.match(markdown, /expectedStatus/);
  assert.match(markdown, /requestId must be unique/);
});

test("a sub-step at maximum depth is not offered decompose", () => {
  const deep = progressApiMarkdown({ runId: "r1", token: "t", port: 4000, canDecompose: false, shimPath: "/tmp/x/agent-step" });
  assert.doesNotMatch(deep, /decompose --file/);
});

test("the authoring commands are offered, and only to author runs", () => {
  const usage = run(["help"]).out;
  assert.match(usage, /agent-step propose-program --file/);
  assert.match(usage, /agent-step propose-suite --file/);
  assert.match(usage, /Author runs \(drafting a program\) have their own two commands/);
});

test("a proposal with no file is refused locally rather than posted empty", () => {
  const env = { HYDRA_RUN_URL: "http://127.0.0.1:1/x", HYDRA_RUN_TOKEN: "t" };
  const program = run(["propose-program"], env);
  assert.equal(program.code, 1);
  assert.match(program.err, /--file program\.json/);
  const suite = run(["propose-suite"], env);
  assert.equal(suite.code, 1);
  assert.match(suite.err, /--file suite\.json/);
});

test("a suite proposal with no suite key is refused before the round trip", () => {
  const directory = mkdtempSync(join(tmpdir(), "propose-"));
  try {
    const file = join(directory, "suite.json");
    writeFileSync(file, JSON.stringify({ prompts: [{ title: "T", content: "c" }] }));
    const result = run(["propose-suite", "--file", file], {
      HYDRA_RUN_URL: "http://127.0.0.1:1/x", HYDRA_RUN_TOKEN: "t",
    });
    assert.equal(result.code, 1);
    assert.match(result.err, /--suite S1/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a refused proposal names the field, so the next attempt is different", () => {
  const source = readFileSync(SHIM, "utf8");
  assert.match(source, /formatFields/);
  assert.match(source, /error\?\.fields/);
});

test("the author brief says what a work item is and how to post one", () => {
  const brief = programAuthorPrompt({
    workspace: { name: "Console", workDirectory: "/tmp/ws", description: "" },
    draft: {
      id: 7, workspaceId: 1, runId: "run_1", state: "PENDING", goal: "Plan the transition.",
      body: { name: "", overview: "", notes: "", suites: [] },
      appliedProgramId: null, targetProgramId: null, baseline: null, createdAt: "now", updatedAt: "now",
    },
    shimPath: "/tmp/x/agent-step", runId: "run_1", token: "secret-token", port: 4000, feedback: null,
  });
  assert.match(brief, /Plan the transition\./);
  assert.match(brief, /\/tmp\/x\/agent-step" propose-program --file program\.json/);
  assert.match(brief, /\/tmp\/x\/agent-step" propose-suite --file suite\.json/);
  assert.match(brief, /## Verify/);
  assert.match(brief, /One session's worth/);
  assert.match(brief, /Read the working tree, do not change it/);
  assert.match(brief, /Nothing you post here starts any work/);
  assert.doesNotMatch(brief, /secret-token/);
});

test("a revise run is shown the draft it is changing, not a blank page", () => {
  const brief = programAuthorPrompt({
    workspace: { name: "Console", workDirectory: "/tmp/ws", description: "" },
    draft: {
      id: 7, workspaceId: 1, runId: "run_2", state: "PENDING", goal: "Plan it.",
      body: {
        name: "Transition", overview: "", notes: "",
        suites: [
          { key: "S1", name: "Foundations", overview: "", filled: true, prompts: [{ key: "S1-01", title: "First", content: "x", dependsOn: [], gate: null }] },
          { key: "S2", name: "Endpoints", overview: "", filled: false, prompts: [] },
        ],
      },
      appliedProgramId: null, targetProgramId: null, baseline: null, createdAt: "now", updatedAt: "now",
    },
    shimPath: null, runId: "run_2", token: "t", port: 4000, feedback: "Split S1; it is too big.",
  });
  assert.match(brief, /What this draft already says/);
  assert.match(brief, /S1-01 — First/);
  assert.match(brief, /\(no work items yet\)/);
  assert.match(brief, /Split S1; it is too big\./);
  assert.match(brief, /curl/);
});

test("agent-step prints each failing Verify command on verification_failed", () => {
  const source = readFileSync(SHIM, "utf8");
  assert.match(source, /verification_failed/);
  assert.match(source, /formatVerificationFailures/);
  assert.match(source, /error\?\.failures/);
});

test("a refused done leaves the item IN_PROGRESS with a SYSTEM VERIFICATION remark", async () => {
  const { runDefinitionOfDoneCommands } = await import("../../src/services/verification/definitionOfDone.ts");
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
