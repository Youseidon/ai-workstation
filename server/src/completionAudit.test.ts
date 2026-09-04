import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CompletionAuditCheck, ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { auditMarkdown, parseReport, reconcileVerdict, scheduleCompletionAudit, verificationText } from "./completionAudit.ts";
import { newId } from "./lib/ids.ts";
import { pipelineScheduler, setPipelineStationStarter } from "./pipelineScheduler.ts";
import { runContexts } from "./runContext.ts";
import { resetSettings, updateSettings } from "./settings.ts";
import { workspaces } from "./workspaces.ts";

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${seq}`;
}

function check(overrides: Partial<CompletionAuditCheck> = {}): CompletionAuditCheck {
  return { criterion: "the endpoint exists", result: "PASSED", evidence: "curl returned 200", command: "curl -s localhost/health", ...overrides };
}

function fixture(count = 2) {
  const dir = mkdtempSync(join(tmpdir(), "completion-audit-"));
  const workspace = workspaces.create({ name: unique("ws"), description: "", workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: unique("prog"), overview: "" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: unique("suite"), overview: "" }) as SuiteRecord;
  const prompts: PromptRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const prompt = workspaces.createChild("prompt", suite.id, { title: unique("p"), content: "## Objective\n\nShip it.\n\n## Verification\n\n```bash\nnpm test\n```" }) as PromptRecord;
    workspaces.addPipelineStep(prompt.id, { provider: "claude" });
    prompts.push(prompt);
  }
  return {
    workspace,
    suite,
    prompts,
    cleanup() {
      setPipelineStationStarter(null);
      resetSettings(["pipeline.auditOnBlocked"]);
      workspaces.remove(workspace.id);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function stubStarts(): string[] {
  const started: string[] = [];
  setPipelineStationStarter(async (args) => {
    const runId = newId("run");
    const promptId = args.promptId;
    if (promptId === undefined) throw new Error("stub requires promptId");
    const credential = runContexts.create(runId, args.workspaceId, promptId);
    workspaces.beginAgentRun({ runId, workspaceId: args.workspaceId, promptId, provider: args.provider, model: args.model, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute" });
    workspaces.markAgentRunRunning(runId);
    started.push(runId);
    return { runId };
  });
  return started;
}

/**
 * The exact shape this feature exists for: the agent did the work and its
 * process ended without ever posting DONE, so the orchestrator had to record a
 * SYSTEM block. Setup keeps the audit off so no real read-only agent launches;
 * the tests then drive the verdict in by hand.
 */
async function stationBlockedWithoutStatus(ctx: ReturnType<typeof fixture>): Promise<{ runId: string; pipelineRunId: string }> {
  updateSettings({ "pipeline.auditOnBlocked": "off" });
  const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
  const runId = playing.currentRunId!;
  workspaces.finishAgentRun(runId, "error");
  await pipelineScheduler.onExecuteEnded({ runId, workspaceId: ctx.workspace.id, promptId: ctx.prompts[0]!.id, processState: "error" });
  // Stand in for the park the audit gate itself would have done.
  workspaces.updatePipelineRun(playing.id, { waitReason: "audit_running" });
  return { runId, pipelineRunId: playing.id };
}

/* ------------------------------------------------------------------ */
/* Verdict reconciliation                                              */
/* ------------------------------------------------------------------ */

test("a COMPLETE that contradicts its own checks is not honoured", () => {
  assert.equal(reconcileVerdict("COMPLETE", [check(), check({ result: "FAILED" })]), "INCOMPLETE");
  assert.equal(reconcileVerdict("COMPLETE", [check(), check({ result: "UNVERIFIED" })]), "UNVERIFIABLE");
  // Nothing checked is not a pass. This is the shape a model produces when it
  // read the transcript, believed the previous agent, and inspected nothing.
  assert.equal(reconcileVerdict("COMPLETE", []), "UNVERIFIABLE");
  assert.equal(reconcileVerdict("COMPLETE", [check(), check()]), "COMPLETE");
  // Only COMPLETE is second-guessed; the cautious verdicts are taken as given.
  assert.equal(reconcileVerdict("INCOMPLETE", [check()]), "INCOMPLETE");
  assert.equal(reconcileVerdict("UNVERIFIABLE", [check()]), "UNVERIFIABLE");
});

test("a report is parsed out of a fenced block, and an unknown verdict is not a pass", () => {
  const parsed = parseReport("Here you go:\n```json\n" + JSON.stringify({
    verdict: "complete",
    confidence: "high",
    checks: [{ criterion: "tests pass", result: "passed", evidence: "42 passing", command: "npm test" }],
    remainingWork: [],
    verificationSummary: "npm test: 42 passing, 0 failing.",
    reasoning: "Every criterion is satisfied in the tree.",
  }) + "\n```");
  assert.equal(parsed.verdict, "COMPLETE");
  assert.equal(parsed.confidence, "HIGH");
  assert.equal(parsed.checks[0]?.result, "PASSED");

  const vague = parseReport(JSON.stringify({ verdict: "probably fine", checks: [{ criterion: "x", result: "PASSED", evidence: "y" }] }));
  assert.equal(vague.verdict, "UNVERIFIABLE");
  assert.equal(vague.confidence, "LOW", "an unstated confidence is the lowest one, not the highest");
});

test("the recorded evidence names the auditor rather than implying the worker confirmed it", () => {
  const report = parseReport(JSON.stringify({ verdict: "COMPLETE", checks: [{ criterion: "tests pass", result: "PASSED", evidence: "42 passing", command: "npm test" }], verificationSummary: "npm test: 42 passing." }));
  const text = verificationText(report, "codex");
  assert.match(text, /read-only codex completion audit/);
  assert.match(text, /ended without posting a status/);
  assert.match(text, /42 passing/);
  // The markdown has to survive evidence containing a table delimiter.
  const rendered = auditMarkdown({ ...report, checks: [check({ evidence: "a | b\nc" })] }, "codex", "run_1");
  assert.equal(rendered.split("\n").filter((line) => line.startsWith("| the endpoint exists")).length, 1);
});

/* ------------------------------------------------------------------ */
/* What may be audited                                                 */
/* ------------------------------------------------------------------ */

test("a station the agent itself reported BLOCKED is never audited past", async () => {
  const ctx = fixture(1);
  stubStarts();
  try {
    updateSettings({ "pipeline.auditOnBlocked": "autocomplete" });
    const playing = await pipelineScheduler.play(ctx.suite.id, { provider: "claude" });
    const runId = playing.currentRunId!;
    workspaces.updateAgentStatus(runId, {
      requestId: randomUUID(),
      expectedStatus: "IN_PROGRESS",
      status: "BLOCKED",
      reason: "the staging database credential is missing",
      verificationSummary: "Put STAGING_DSN in the workspace .env",
    });
    workspaces.finishAgentRun(runId, "done");
    await pipelineScheduler.onExecuteEnded({ runId, workspaceId: ctx.workspace.id, promptId: ctx.prompts[0]!.id, processState: "done" });

    // The station asked a specific question. Reading the tree cannot answer it,
    // and an auditor that closed it would be overruling a request for a human.
    assert.equal(workspaces.endedWithoutAgentStatus(ctx.prompts[0]!.id), false);
    const parked = workspaces.activePipeline(ctx.suite.id);
    assert.equal(parked?.waitReason, null, "no audit was summoned");
    assert.equal(workspaces.completionAuditsForPrompt(ctx.prompts[0]!.id).length, 0);

    const refused = await scheduleCompletionAudit({ workspaceId: ctx.workspace.id, promptId: ctx.prompts[0]!.id, sourceRunId: runId, sourceProvider: "claude", automatic: false });
    assert.equal(refused.started, false);
    assert.equal(refused.started === false ? refused.block : "", "not_auditable");
  } finally {
    ctx.cleanup();
  }
});

test("a run that ended without posting a status is auditable", async () => {
  const ctx = fixture(1);
  stubStarts();
  try {
    await stationBlockedWithoutStatus(ctx);
    // The process died without reporting, so the run failed — but what the
    // work item is owed is a review, not a verdict. It is emphatically not
    // BLOCKED: nobody asked the operator anything.
    assert.equal(workspaces.promptOutcome(ctx.prompts[0]!.id).status, "FAILED");
    assert.equal(workspaces.endedWithoutAgentStatus(ctx.prompts[0]!.id), true);
  } finally {
    ctx.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* What a verdict does                                                 */
/* ------------------------------------------------------------------ */

test("a COMPLETE verdict closes the station and the rail carries on by itself", async () => {
  const ctx = fixture(2);
  const started = stubStarts();
  try {
    const { runId } = await stationBlockedWithoutStatus(ctx);
    updateSettings({ "pipeline.auditOnBlocked": "autocomplete" });
    const applied = await pipelineScheduler.onAuditSettled({
      promptId: ctx.prompts[0]!.id,
      sourceRunId: runId,
      verdict: "COMPLETE",
      verificationSummary: "npm test: 42 passing, 0 failing. The migration file exists at db/0012.sql.",
    });
    assert.equal(applied, true);

    const closed = workspaces.resolvePrompt(ctx.workspace.id, ctx.prompts[0]!.id);
    assert.equal(closed.status, "DONE");
    assert.equal(closed.recoverable, false);
    // The audit trail has to say who decided, and against which run.
    const done = (workspaces.promptHistory(ctx.prompts[0]!.id).events as Array<{ newStatus: string; actorType: string; runId: string | null }>)
      .find((event) => event.newStatus === "DONE");
    assert.equal(done?.actorType, "SYSTEM");
    assert.equal(done?.runId, runId, "provenance of the run that did the work is kept");

    const playing = workspaces.activePipeline(ctx.suite.id);
    assert.equal(playing?.state, "PLAYING");
    assert.equal(playing?.currentPromptId, ctx.prompts[1]!.id, "the next station started without anyone pressing anything");
    assert.equal(started.length, 2);
  } finally {
    ctx.cleanup();
  }
});

test("an INCOMPLETE verdict leaves the station blocked and says so", async () => {
  const ctx = fixture(2);
  const started = stubStarts();
  try {
    const { runId } = await stationBlockedWithoutStatus(ctx);
    updateSettings({ "pipeline.auditOnBlocked": "autocomplete" });
    const applied = await pipelineScheduler.onAuditSettled({ promptId: ctx.prompts[0]!.id, sourceRunId: runId, verdict: "INCOMPLETE" });
    assert.equal(applied, false);
    // An INCOMPLETE verdict does not change the status — the item is still a run
    // that ended without reporting. What changes is that the pipeline now parks
    // with a reason, and the verdict is on the record.
    assert.equal(workspaces.promptOutcome(ctx.prompts[0]!.id).status, "FAILED");
    const parked = workspaces.activePipeline(ctx.suite.id);
    assert.equal(parked?.state, "WAITING_HUMAN");
    assert.equal(parked?.waitReason, "audit_incomplete");
    assert.equal(started.length, 1, "nothing was launched on the strength of a failed audit");
  } finally {
    ctx.cleanup();
  }
});

test("an auditor that itself failed hands the station back to its own rule", async () => {
  const ctx = fixture(2);
  const started = stubStarts();
  try {
    const { runId } = await stationBlockedWithoutStatus(ctx);
    // The station's rule is retry, so a lost verdict must not cost the retry.
    workspaces.upsertPipelineRule(ctx.prompts[0]!.id, { onBlocked: "retry", retryLimit: 1 });
    updateSettings({ "pipeline.auditOnBlocked": "autocomplete" });
    await pipelineScheduler.onAuditSettled({ promptId: ctx.prompts[0]!.id, sourceRunId: runId, verdict: null });
    const retrying = workspaces.activePipeline(ctx.suite.id);
    assert.equal(retrying?.state, "PLAYING");
    assert.equal(retrying?.currentPromptId, ctx.prompts[0]!.id, "the same station is retried, not skipped");
    assert.equal(started.length, 2);
  } finally {
    ctx.cleanup();
  }
});

test("the report-only policy records the verdict and still waits for the operator", async () => {
  const ctx = fixture(2);
  const started = stubStarts();
  try {
    const { runId } = await stationBlockedWithoutStatus(ctx);
    updateSettings({ "pipeline.auditOnBlocked": "report" });
    const applied = await pipelineScheduler.onAuditSettled({
      promptId: ctx.prompts[0]!.id,
      sourceRunId: runId,
      verdict: "COMPLETE",
      verificationSummary: "Everything is there.",
    });
    assert.equal(applied, false, "report mode never closes a station on its own");
    assert.equal(workspaces.promptOutcome(ctx.prompts[0]!.id).status, "FAILED");
    assert.equal(workspaces.activePipeline(ctx.suite.id)?.state, "WAITING_HUMAN");
    assert.equal(started.length, 1);
  } finally {
    ctx.cleanup();
  }
});

test("a verdict for a station no run is parked on does not move a pipeline", async () => {
  const ctx = fixture(2);
  const started = stubStarts();
  try {
    const { runId, pipelineRunId } = await stationBlockedWithoutStatus(ctx);
    // An operator asked for the audit by hand and then stopped the run.
    workspaces.updatePipelineRun(pipelineRunId, { state: "STOPPED", waitReason: null, stopReason: "operator_stop", endedAt: new Date().toISOString() });
    updateSettings({ "pipeline.auditOnBlocked": "autocomplete" });
    const applied = await pipelineScheduler.onAuditSettled({ promptId: ctx.prompts[0]!.id, sourceRunId: runId, verdict: "COMPLETE", verificationSummary: "It is all there." });
    assert.equal(applied, true, "the verdict still closes the work item it was asked about");
    assert.equal(workspaces.promptOutcome(ctx.prompts[0]!.id).status, "DONE");
    assert.equal(started.length, 1, "a stopped pipeline is not restarted by a verdict");
  } finally {
    ctx.cleanup();
  }
});
