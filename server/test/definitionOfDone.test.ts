/**
 * What "done" is allowed to mean.
 *
 * Every test here corresponds to a promise the app now makes on screen: that a
 * work item does not close until the things the operator said had to be true
 * are true, that the check was done by running something rather than by asking
 * an agent whether it was happy with its own work, and that a refusal says
 * exactly which criterion failed and shows its real output.
 *
 * The one thing deliberately *not* protected here is the operator's authority.
 * A human override is meant to get through, and there is a test for that too —
 * the gate exists to stop the pipeline concluding something it has not
 * established, not to stop the person who owns the work from saying so.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DOD_COMMAND_TIMEOUT_MAX_MS, clampDodTimeout, dodUnmetEvidence, unmetCriteria } from "@agent-console/shared";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { capOutput, commandPassed, resolveCommandCwd, runDodCommand } from "../src/dodCommands.ts";
import { runDefinitionOfDoneCommands } from "../src/definitionOfDone.ts";
import { newId } from "../src/lib/ids.ts";
import { runContexts } from "../src/runContext.ts";
import { workspaces, WorkspaceError } from "../src/workspaces.ts";

let seq = 0;
const unique = (prefix: string): string => `${prefix}-${process.pid}-${Date.now()}-${(seq += 1)}`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dod-"));
  const workspace = workspaces.create({ name: unique("ws"), description: "", workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: unique("prog"), overview: "" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: unique("suite"), overview: "" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: unique("p"), content: "do work" }) as PromptRecord;
  return {
    workspace, program, suite, prompt, dir,
    cleanup() {
      workspaces.remove(workspace.id);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A criterion at the work item's own scope, returning its id. */
function criterion(promptId: number, patch: Record<string, unknown>): number {
  const saved = workspaces.saveDodCriterion({ scope: "prompt", scopeId: promptId, patch });
  return saved.criteria[saved.criteria.length - 1]!.id;
}

const statusOf = (promptId: number) => workspaces.promptOutcome(promptId).status;
const latestEvent = (promptId: number) =>
  (workspaces.promptHistory(promptId).events as Array<{
    newStatus: string; reason: string; trigger?: string | null; ruleId?: string | null;
    evidence?: Record<string, unknown> | null;
  }>)[0]!;

/* ------------------------------------------------------------------ */
/* The promise: a work item does not close on an unmet criterion       */
/* ------------------------------------------------------------------ */

test("a work item with no definition of done closes exactly as it always did", async () => {
  // The gate must be invisible until someone writes a criterion. An upgrade
  // that quietly started refusing every close would be worse than no gate.
  const ctx = fixture();
  try {
    workspaces.completePrompt(ctx.prompt.id, "USER", { verificationSummary: "checked by hand" });
    assert.equal(statusOf(ctx.prompt.id), "DONE");
  } finally { ctx.cleanup(); }
});

test("a failing command refuses the close, and the item is held for review", async () => {
  const ctx = fixture();
  try {
    criterion(ctx.prompt.id, { kind: "COMMAND", text: "the tests pass", command: "exit 3" });
    await runDefinitionOfDoneCommands(ctx.prompt.id, null);

    // A reviewer closing the station, which is the unattended path.
    const written = workspaces.completePrompt(ctx.prompt.id, "SYSTEM", { verificationSummary: "the reviewer was satisfied" });
    assert.equal(written, "NEEDS_REVIEW", "a reviewer's say-so closed an item over a failing command");
    assert.equal(statusOf(ctx.prompt.id), "NEEDS_REVIEW");
    assert.notEqual(statusOf(ctx.prompt.id), "DONE");
  } finally { ctx.cleanup(); }
});

test("the refusal names the criterion and carries the command's real output", async () => {
  // The operator has to be able to see *why* without going to look for it, and
  // what they see has to be the command's own words rather than a summary of
  // them. This is the whole difference between a verdict and an assertion.
  const ctx = fixture();
  try {
    criterion(ctx.prompt.id, { kind: "COMMAND", text: "the build is clean", command: "echo 'TS2322: Type mismatch on line 4' >&2; exit 2" });
    await runDefinitionOfDoneCommands(ctx.prompt.id, null);
    workspaces.completePrompt(ctx.prompt.id, "SYSTEM", { verificationSummary: "looks fine to me" });

    const event = latestEvent(ctx.prompt.id);
    assert.equal(event.newStatus, "NEEDS_REVIEW");
    assert.equal(event.ruleId, "dod-unmet", "the rule that decided is not recorded");
    assert.equal(event.trigger, "dod_command_failed");
    assert.match(event.reason, /the build is clean/);

    const evaluation = workspaces.definitionOfDoneEvaluation(ctx.prompt.id);
    const failing = unmetCriteria(evaluation)[0]!;
    assert.equal(failing.result, "FAILED");
    assert.equal(failing.exitCode, 2, "the exit code the command actually returned is not recorded");
    assert.match(failing.output, /TS2322/, "the command's own output is not kept as evidence");
    assert.equal(failing.source, "RUNNER", "the result must be attributed to the server that ran it");
  } finally { ctx.cleanup(); }
});

test("a passing command closes the item, with the exit code recorded", async () => {
  const ctx = fixture();
  try {
    criterion(ctx.prompt.id, { kind: "COMMAND", text: "the tests pass", command: "exit 0" });
    await runDefinitionOfDoneCommands(ctx.prompt.id, null);

    const evaluation = workspaces.definitionOfDoneEvaluation(ctx.prompt.id);
    assert.equal(evaluation.satisfied, true);
    // Checked rather than taken on trust: "it passed" and "we recorded that
    // something ran and returned 0" are different claims, and only the second
    // is evidence.
    assert.equal(evaluation.criteria[0]!.exitCode, 0);
    assert.equal(evaluation.criteria[0]!.source, "RUNNER");

    assert.equal(workspaces.completePrompt(ctx.prompt.id, "SYSTEM", { verificationSummary: "done" }), "DONE");
  } finally { ctx.cleanup(); }
});

test("a command nobody ran is unverified, and unverified closes nothing", async () => {
  // The same rule as a run that ends without reporting: absence of evidence is
  // not evidence. A criterion that has never been checked must not pass by
  // default, or the gate is decorative.
  const ctx = fixture();
  try {
    criterion(ctx.prompt.id, { kind: "COMMAND", text: "the tests pass", command: "exit 0" });
    const evaluation = workspaces.definitionOfDoneEvaluation(ctx.prompt.id);
    assert.equal(evaluation.criteria[0]!.result, "UNVERIFIED");
    assert.equal(evaluation.satisfied, false);
    assert.equal(workspaces.completePrompt(ctx.prompt.id, "SYSTEM", { verificationSummary: "trust me" }), "NEEDS_REVIEW");
  } finally { ctx.cleanup(); }
});

test("a prose criterion no reviewer has judged does not close the item either", async () => {
  const ctx = fixture();
  try {
    criterion(ctx.prompt.id, { kind: "PROSE", text: "the API returns 404 for a missing record" });
    assert.equal(workspaces.completePrompt(ctx.prompt.id, "SYSTEM", { verificationSummary: "done" }), "NEEDS_REVIEW");
  } finally { ctx.cleanup(); }
});

test("an optional criterion is reported but never blocks a close", async () => {
  const ctx = fixture();
  try {
    criterion(ctx.prompt.id, { kind: "COMMAND", text: "the linter is happy", command: "exit 1", required: false });
    await runDefinitionOfDoneCommands(ctx.prompt.id, null);
    const evaluation = workspaces.definitionOfDoneEvaluation(ctx.prompt.id);
    assert.equal(evaluation.criteria[0]!.result, "FAILED", "an optional criterion is still checked and reported");
    assert.equal(evaluation.satisfied, true);
    assert.equal(workspaces.completePrompt(ctx.prompt.id, "SYSTEM", { verificationSummary: "done" }), "DONE");
  } finally { ctx.cleanup(); }
});

/* ------------------------------------------------------------------ */
/* Who is allowed past it                                              */
/* ------------------------------------------------------------------ */

test("an operator can always close over an unmet definition of done, and it is recorded", async () => {
  const ctx = fixture();
  try {
    criterion(ctx.prompt.id, { kind: "COMMAND", text: "the tests pass", command: "exit 1" });
    await runDefinitionOfDoneCommands(ctx.prompt.id, null);

    assert.equal(workspaces.completePrompt(ctx.prompt.id, "USER", { reason: "the test is wrong, not the code", verificationSummary: "verified by hand" }), "DONE");
    const event = latestEvent(ctx.prompt.id);
    assert.equal(event.trigger, "operator_override");
    // Honoured is not the same as unremarked. Anyone reading this later has to
    // be able to see that it was closed over a red criterion.
    assert.match(JSON.stringify(event.evidence), /closed this work item anyway/);
    assert.match(JSON.stringify(event.evidence), /the tests pass/);
  } finally { ctx.cleanup(); }
});

test("enforcement 'warn' closes the item and still records what did not pass", async () => {
  const ctx = fixture();
  try {
    criterion(ctx.prompt.id, { kind: "COMMAND", text: "the tests pass", command: "exit 1" });
    workspaces.setDodEnforcement("prompt", ctx.prompt.id, "warn");
    await runDefinitionOfDoneCommands(ctx.prompt.id, null);

    assert.equal(workspaces.completePrompt(ctx.prompt.id, "SYSTEM", { verificationSummary: "done" }), "DONE");
    assert.match(JSON.stringify(latestEvent(ctx.prompt.id).evidence), /the tests pass/);
  } finally { ctx.cleanup(); }
});

test("enforcement 'off' checks nothing at all", async () => {
  const ctx = fixture();
  try {
    criterion(ctx.prompt.id, { kind: "COMMAND", text: "the tests pass", command: "exit 1" });
    workspaces.setDodEnforcement("prompt", ctx.prompt.id, "off");
    // Nothing is even offered to the runner, so a switched-off definition of
    // done costs no time as well as blocking nothing.
    assert.deepEqual(workspaces.dodCommandPlan(ctx.prompt.id).criteria, []);
    assert.equal(workspaces.definitionOfDoneEvaluation(ctx.prompt.id).satisfied, true);
    assert.equal(workspaces.completePrompt(ctx.prompt.id, "SYSTEM", { verificationSummary: "done" }), "DONE");
  } finally { ctx.cleanup(); }
});

/* ------------------------------------------------------------------ */
/* Inheritance                                                         */
/* ------------------------------------------------------------------ */

test("a work item inherits the nearest definition of done above it", () => {
  const ctx = fixture();
  try {
    workspaces.saveDodCriterion({ scope: "workspace", scopeId: ctx.workspace.id, patch: { kind: "COMMAND", text: "the workspace builds", command: "exit 0" } });
    let resolved = workspaces.resolvedDefinitionOfDone(ctx.prompt.id);
    assert.equal(resolved.criteria.length, 1);
    assert.deepEqual(resolved.inheritedFrom, { scope: "workspace", scopeId: ctx.workspace.id });

    // A nearer scope replaces the inherited set rather than adding to it, so an
    // item can drop a house rule that does not apply to it. Accumulating would
    // read well right up to the point where something needs to opt out.
    workspaces.saveDodCriterion({ scope: "suite", scopeId: ctx.suite.id, patch: { kind: "PROSE", text: "the suite's own rule" } });
    resolved = workspaces.resolvedDefinitionOfDone(ctx.prompt.id);
    assert.equal(resolved.criteria.length, 1);
    assert.equal(resolved.criteria[0]!.text, "the suite's own rule");
    assert.deepEqual(resolved.inheritedFrom, { scope: "suite", scopeId: ctx.suite.id });
  } finally { ctx.cleanup(); }
});

test("enforcement resolves on its own, so a suite can soften a rule it did not write", () => {
  const ctx = fixture();
  try {
    workspaces.saveDodCriterion({ scope: "workspace", scopeId: ctx.workspace.id, patch: { kind: "PROSE", text: "the workspace rule" } });
    workspaces.setDodEnforcement("suite", ctx.suite.id, "warn");
    const resolved = workspaces.resolvedDefinitionOfDone(ctx.prompt.id);
    assert.equal(resolved.enforcement, "warn");
    assert.equal(resolved.criteria[0]!.text, "the workspace rule", "softening enforcement must not drop the inherited criteria");
  } finally { ctx.cleanup(); }
});

test("a deleted work item's criteria do not come back attached to the next one", () => {
  // SQLite hands out a deleted row's INTEGER PRIMARY KEY again, and this table
  // is keyed by (scope, scope_id) rather than by a foreign key. Without the
  // sweep, a work item nobody had ever configured would refuse to close because
  // of a criterion written for a different one that happened to share its id —
  // a work item held up for reasons nobody wrote.
  const first = fixture();
  const promptId = first.prompt.id;
  criterion(promptId, { kind: "PROSE", text: "a rule from a work item that no longer exists" });
  first.cleanup();

  assert.deepEqual(workspaces.definitionOfDone("prompt", promptId).criteria, []);
});

/* ------------------------------------------------------------------ */
/* Children                                                            */
/* ------------------------------------------------------------------ */

test("a children-closed criterion is read off the children, not asked of anyone", () => {
  const ctx = fixture();
  try {
    criterion(ctx.prompt.id, { kind: "CHILDREN_CLOSED", text: "every sub-step is closed" });
    // No sub-steps: nothing is open, so nothing is outstanding.
    assert.equal(workspaces.definitionOfDoneEvaluation(ctx.prompt.id).criteria[0]!.result, "PASSED");
  } finally { ctx.cleanup(); }
});

/* ------------------------------------------------------------------ */
/* The command runner's bounds                                         */
/* ------------------------------------------------------------------ */

test("a command runs in the workspace, not wherever the server happens to be", async () => {
  const ctx = fixture();
  try {
    writeFileSync(join(ctx.dir, "marker.txt"), "here");
    const outcome = await runDodCommand({ command: "cat marker.txt", workDirectory: ctx.dir, cwd: null, timeoutMs: 10_000 });
    assert.equal(outcome.exitCode, 0);
    assert.match(outcome.output, /here/);
  } finally { ctx.cleanup(); }
});

test("a command cannot be pointed outside the workspace", () => {
  // The command itself is the operator's to write, but the directory it starts
  // in is a boundary: a criterion that verifies a tree it was not scoped to is
  // not verifying anything the operator asked about.
  assert.throws(() => resolveCommandCwd("/tmp/ws", "../elsewhere"), /inside the workspace/);
  assert.throws(() => resolveCommandCwd("/tmp/ws", "/etc"), /relative to the workspace/);
  assert.equal(resolveCommandCwd("/tmp/ws", "packages/api"), "/tmp/ws/packages/api");
  assert.equal(resolveCommandCwd("/tmp/ws", null), "/tmp/ws");
});

test("a command that hangs is killed, and its criterion does not pass", async () => {
  // A criterion that waits forever would hold a work item open forever, which
  // looks exactly like a pipeline that has silently stopped.
  const outcome = await runDodCommand({ command: "sleep 30", workDirectory: tmpdir(), cwd: null, timeoutMs: 1_000 });
  assert.equal(outcome.timedOut, true);
  assert.equal(commandPassed(outcome, 0), false, "a timed-out command must never count as a pass");
  assert.ok(outcome.durationMs < 15_000, "the timeout did not actually stop it");
});

test("a command that does not exist fails with the reason, rather than throwing", async () => {
  const outcome = await runDodCommand({ command: "definitely-not-a-real-command-xyz", workDirectory: tmpdir(), cwd: null, timeoutMs: 5_000 });
  assert.equal(commandPassed(outcome, 0), false);
  assert.notEqual(outcome.output, "", "an operator needs to be told what went wrong");
});

test("a non-zero expected exit code is honoured", async () => {
  // "This must still fail" is a real criterion — a regression test that has not
  // been fixed yet, a command that must reject bad input.
  const outcome = await runDodCommand({ command: "exit 7", workDirectory: tmpdir(), cwd: null, timeoutMs: 5_000 });
  assert.equal(commandPassed(outcome, 7), true);
  assert.equal(commandPassed(outcome, 0), false);
});

test("captured output is capped, and says so where it was cut", async () => {
  const capped = capOutput("a".repeat(5000) + "NEEDLE" + "b".repeat(5000), 1000);
  assert.ok(capped.length < 2000, "the cap did not apply");
  assert.match(capped, /bytes omitted/, "a silent truncation reads as the whole output");
  assert.match(capped, /^a+/, "the head is what a compiler puts its first error in");
  assert.match(capped, /b+$/, "the tail is what a test runner puts its summary in");
});

test("a timeout cannot be set beyond what the server will honour", () => {
  assert.equal(clampDodTimeout(Number.MAX_SAFE_INTEGER), DOD_COMMAND_TIMEOUT_MAX_MS);
  assert.equal(clampDodTimeout(0), 1_000);
  assert.equal(clampDodTimeout(Number.NaN), 120_000);
});

/* ------------------------------------------------------------------ */
/* The editor refuses what the runner could not honour                 */
/* ------------------------------------------------------------------ */

test("a criterion that could never be run is refused when it is written, not when it matters", () => {
  // Discovering at 3am that a work item can never close because the command
  // field was left empty is the failure this is here to prevent.
  const ctx = fixture();
  try {
    assert.throws(
      () => workspaces.saveDodCriterion({ scope: "prompt", scopeId: ctx.prompt.id, patch: { kind: "COMMAND", text: "the tests pass" } }),
      (error: unknown) => error instanceof WorkspaceError && error.status === 422,
    );
    assert.throws(
      () => workspaces.saveDodCriterion({ scope: "prompt", scopeId: ctx.prompt.id, patch: { kind: "COMMAND", text: "x", command: "npm test", cwd: "../elsewhere" } }),
      (error: unknown) => error instanceof WorkspaceError && error.status === 422,
    );
    assert.throws(
      () => workspaces.saveDodCriterion({ scope: "prompt", scopeId: ctx.prompt.id, patch: { kind: "NONSENSE", text: "x" } }),
      (error: unknown) => error instanceof WorkspaceError && error.status === 422,
    );
  } finally { ctx.cleanup(); }
});

test("a criterion cannot be edited or deleted through a scope it does not belong to", () => {
  const ctx = fixture();
  try {
    const id = criterion(ctx.prompt.id, { kind: "PROSE", text: "the item's own rule" });
    assert.throws(
      () => workspaces.removeDodCriterion("suite", ctx.suite.id, id),
      (error: unknown) => error instanceof WorkspaceError && error.status === 404,
    );
    assert.equal(workspaces.definitionOfDone("prompt", ctx.prompt.id).criteria.length, 1);
  } finally { ctx.cleanup(); }
});

/* ------------------------------------------------------------------ */
/* Verify blocks on the work item itself                               */
/* ------------------------------------------------------------------ */

test("saving a ## Verify block writes prompt-scope COMMAND criteria and keeps ids", () => {
  const ctx = fixture();
  try {
    workspaces.updateChild("prompt", ctx.prompt.id, {
      content: "## Task\nDo it.\n\n## Verify\n```sh\necho one\necho two\n```\n",
    });
    const first = workspaces.definitionOfDone("prompt", ctx.prompt.id).criteria;
    assert.equal(first.length, 2);
    assert.equal(first[0]!.kind, "COMMAND");
    assert.equal(first[0]!.command, "echo one");
    assert.equal(first[1]!.command, "echo two");
    const idOne = first[0]!.id;
    const idTwo = first[1]!.id;

    workspaces.updateChild("prompt", ctx.prompt.id, {
      content: "## Task\nDo it.\n\n## Verify\n```sh\necho one\necho three\n```\n",
    });
    const second = workspaces.definitionOfDone("prompt", ctx.prompt.id).criteria;
    assert.equal(second.length, 2);
    assert.equal(second.find((row) => row.command === "echo one")?.id, idOne, "unchanged line must keep its id");
    assert.equal(second.find((row) => row.command === "echo two"), undefined);
    assert.ok(second.find((row) => row.command === "echo three")?.id !== idTwo);

    workspaces.updateChild("prompt", ctx.prompt.id, { content: "## Task\nDo it.\n" });
    assert.deepEqual(workspaces.definitionOfDone("prompt", ctx.prompt.id).criteria.filter((row) => row.kind === "COMMAND"), []);
  } finally { ctx.cleanup(); }
});

test("a depth-2 child with no Verify block inherits suite-level COMMAND criteria", () => {
  const ctx = fixture();
  try {
    workspaces.saveDodCriterion({
      scope: "suite", scopeId: ctx.suite.id,
      patch: { kind: "COMMAND", text: "suite check", command: "exit 0" },
    });
    const parent = workspaces.createChild("prompt", ctx.suite.id, {
      title: unique("parent"), content: "split me",
    }) as PromptRecord;
    const runId = newId("run");
    const credential = runContexts.create(runId, ctx.workspace.id, parent.id);
    workspaces.beginAgentRun({
      runId, workspaceId: ctx.workspace.id, promptId: parent.id, provider: "claude", model: null,
      tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute",
    });
    workspaces.markAgentRunRunning(runId);
    const decomposed = workspaces.decomposePrompt(runId, {
      requestId: unique("dec"),
      resumeBrief: "finish the children",
      children: [
        { title: "a", content: "child a\n" },
        { title: "b", content: "child b\n" },
      ],
    }) as { children: Array<{ id: number }> };
    const midRun = newId("run");
    const midCred = runContexts.create(midRun, ctx.workspace.id, decomposed.children[0]!.id);
    workspaces.beginAgentRun({
      runId: midRun, workspaceId: ctx.workspace.id, promptId: decomposed.children[0]!.id,
      provider: "claude", model: null, tokenHash: midCred.tokenHash, expiresAt: midCred.expiresAt, role: "execute",
    });
    workspaces.markAgentRunRunning(midRun);
    const deeper = workspaces.decomposePrompt(midRun, {
      requestId: unique("dec2"),
      resumeBrief: "deeper",
      children: [
        { title: "a.1", content: "leaf\n" },
        { title: "a.2", content: "leaf\n" },
      ],
    }) as { children: Array<{ id: number }> };
    const resolved = workspaces.resolvedDefinitionOfDone(deeper.children[0]!.id);
    assert.equal(resolved.inheritedFrom?.scope, "suite");
    assert.equal(resolved.criteria[0]?.command, "exit 0");
  } finally { ctx.cleanup(); }
});

/* ------------------------------------------------------------------ */
/* The agent is told the truth about its own post                      */
/* ------------------------------------------------------------------ */

test("a failing Verify on agent done is a refusal, not a status change", async () => {
  // The agent door runs the commands, then refuses with the output while the
  // item stays IN_PROGRESS. Writing NEEDS_REVIEW would end the run; the agent
  // still has the provider session and can fix the failure in place.
  const ctx = fixture();
  try {
    workspaces.updateChild("prompt", ctx.prompt.id, {
      content: "## Task\ndo it\n\n## Verify\n```sh\necho boom >&2; exit 1\n```\n",
    });
    await runDefinitionOfDoneCommands(ctx.prompt.id, null);

    const failures = workspaces.agentDoneVerificationFailures(ctx.prompt.id);
    assert.ok(failures !== null);
    assert.equal(failures![0]!.exitCode, 1);
    assert.match(failures![0]!.output, /boom/);

    const runId = newId("run");
    const credential = runContexts.create(runId, ctx.workspace.id, ctx.prompt.id);
    workspaces.beginAgentRun({
      runId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null,
      tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute",
    });
    workspaces.markAgentRunRunning(runId);
    workspaces.recordVerificationFailureRemark(ctx.prompt.id, runId, failures!);

    assert.equal(statusOf(ctx.prompt.id), "IN_PROGRESS");
    const remark = (workspaces.promptHistory(ctx.prompt.id).remarks as Array<{ kind: string; content: string; actorType: string }>)
      .find((row) => row.kind === "VERIFICATION");
    assert.equal(remark?.actorType, "SYSTEM");
    assert.match(remark?.content ?? "", /boom/);
    assert.match(remark?.content ?? "", /post `done` again/);
  } finally { ctx.cleanup(); }
});

test("a second done after the Verify command passes closes with RUNNER evidence", async () => {
  const ctx = fixture();
  try {
    const marker = join(ctx.dir, "ok.marker");
    workspaces.updateChild("prompt", ctx.prompt.id, {
      content: `## Verify\n\`\`\`sh\ntest -f ok.marker\n\`\`\`\n`,
    });
    await runDefinitionOfDoneCommands(ctx.prompt.id, null);
    assert.ok(workspaces.agentDoneVerificationFailures(ctx.prompt.id) !== null);

    writeFileSync(marker, "ok\n");
    await runDefinitionOfDoneCommands(ctx.prompt.id, null);
    assert.equal(workspaces.agentDoneVerificationFailures(ctx.prompt.id), null);

    const runId = newId("run");
    const credential = runContexts.create(runId, ctx.workspace.id, ctx.prompt.id);
    workspaces.beginAgentRun({
      runId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null,
      tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute",
    });
    workspaces.markAgentRunRunning(runId);
    const response = workspaces.updateAgentStatus(runId, {
      requestId: unique("req"), expectedStatus: "IN_PROGRESS", status: "DONE",
      reason: "finished", verificationSummary: "marker present",
    }) as { status: string };
    assert.equal(response.status, "DONE");
    const evaluation = workspaces.definitionOfDoneEvaluation(ctx.prompt.id);
    assert.equal(evaluation.satisfied, true);
    assert.equal(evaluation.criteria[0]?.result, "PASSED");
    assert.equal(evaluation.criteria[0]?.source, "RUNNER");
  } finally { ctx.cleanup(); }
});

test("an unmet definition of done lands on NEEDS_REVIEW with a recorded cause", async () => {
  // The status alone does not say why; the ledger trigger does. Continuation
  // treats NEEDS_REVIEW like UNREPORTED, and Resume after a park still sees
  // the failing criterion on the evidence.
  const ctx = fixture();
  try {
    criterion(ctx.prompt.id, { kind: "COMMAND", text: "the tests pass", command: "exit 1" });
    await runDefinitionOfDoneCommands(ctx.prompt.id, null);
    workspaces.completePrompt(ctx.prompt.id, "SYSTEM", { verificationSummary: "done" });
    assert.equal(statusOf(ctx.prompt.id), "NEEDS_REVIEW");
    const trigger = workspaces.latestStatusTrigger(ctx.prompt.id);
    assert.ok(trigger === "dod_unmet" || trigger === "dod_command_failed", `unexpected trigger ${trigger}`);
  } finally { ctx.cleanup(); }
});

/* ------------------------------------------------------------------ */
/* The evidence an operator reads                                      */
/* ------------------------------------------------------------------ */

test("the evidence panel gets one entry per failing criterion, with its detail", () => {
  const evaluation = {
    enforcement: "block" as const,
    satisfied: false,
    blocking: true,
    criteria: [
      { criterionId: 1, kind: "COMMAND" as const, text: "the tests pass", required: true, result: "FAILED" as const, source: "RUNNER" as const, evidence: "Exit 1, expected 0, after 4.2s.", output: "3 failing", exitCode: 1, runId: null, createdAt: null },
      { criterionId: 2, kind: "PROSE" as const, text: "the docs are updated", required: true, result: "PASSED" as const, source: "REVIEWER" as const, evidence: "README mentions it", output: "", exitCode: null, runId: null, createdAt: null },
      { criterionId: 3, kind: "PROSE" as const, text: "the changelog is written", required: true, result: "UNVERIFIED" as const, source: null, evidence: "", output: "", exitCode: null, runId: null, createdAt: null },
    ],
  };
  const evidence = dodUnmetEvidence(evaluation);
  assert.equal(evidence.definitionOfDone, "2 of 3 required criteria not met");
  assert.match(String(evidence["the tests pass"]), /Exit 1, expected 0/);
  // A criterion nobody checked says so rather than appearing as a bare token,
  // because "it failed" and "nothing looked" send the operator different places.
  assert.match(String(evidence["the changelog is written"]), /Nothing has checked this yet/);
  assert.equal(evidence["the docs are updated"], undefined, "a passing criterion is not evidence of a problem");
});
