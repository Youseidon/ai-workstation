import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { resumeReadyHandoff, scheduleHandoff } from "./handoffCoordinator.ts";
import { newId } from "./lib/ids.ts";
import { setPipelineStationStarter } from "./pipelineScheduler.ts";
import { runContexts } from "./runContext.ts";
import { workspaces } from "./workspaces.ts";

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${seq}`;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "handoff-reuse-"));
  const workspace = workspaces.create({ name: unique("ws"), description: "", workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: unique("prog"), overview: "" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: unique("suite"), overview: "" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: unique("p"), content: "do work" }) as PromptRecord;
  workspaces.addPipelineStep(prompt.id, { provider: "claude" });
  const named = workspaces.createPipeline({ workspaceId: workspace.id, name: unique("named"), suiteIds: [suite.id] });
  workspaces.addNamedPipelineStep(named.id, prompt.id, { provider: "claude" });
  return {
    workspace,
    prompt,
    named,
    cleanup() {
      setPipelineStationStarter(null);
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

/** A developer run that ended badly, plus the brief a handoff agent wrote for it. */
function blockedRunWithBrief(ctx: ReturnType<typeof fixture>, recommendation: "CONTINUE" | "RETRY_LATER") {
  const runId = newId("run");
  const credential = runContexts.create(runId, ctx.workspace.id, ctx.prompt.id);
  workspaces.beginAgentRun({ runId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute" });
  workspaces.markAgentRunRunning(runId);
  workspaces.finishAgentRun(runId, "error");
  const handoff = workspaces.createHandoff({ id: newId("handoff"), workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, sourceRunId: runId, provider: "copilot", model: null });
  workspaces.updateHandoff(handoff.id, { state: "READY", recommendation, briefMarkdown: "# Handoff brief\n\nPending: finish the aggregation.", completedAt: new Date().toISOString() });
  return { runId, handoffId: handoff.id };
}

test("a ready brief blocks a second handoff and says it can be reused instead", async () => {
  const ctx = fixture();
  try {
    const { runId } = blockedRunWithBrief(ctx, "RETRY_LATER");
    const result = await scheduleHandoff({ workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, sourceRunId: runId, sourceProvider: "claude", sourceModel: null, processState: "error", handoffProvider: "copilot" });
    assert.equal(result.started, false);
    assert.equal(result.started === false ? result.block : "", "reusable");
  } finally {
    ctx.cleanup();
  }
});

// The station this reproduces sat stuck: the read-only agent said RETRY_LATER,
// so no successor ever launched, and every later attempt to continue was
// refused for having a handoff already.
test("an operator continues from a brief whose recommendation was not CONTINUE", async () => {
  const ctx = fixture();
  const started = stubStarts();
  try {
    const { runId, handoffId } = blockedRunWithBrief(ctx, "RETRY_LATER");
    const successorRunId = await resumeReadyHandoff({ handoffId, promptId: ctx.prompt.id, failedSuccessorRunId: runId, successorProvider: "claude", successorModel: null, namedPipelineId: ctx.named.id });
    assert.equal(started.includes(successorRunId), true, "the successor developer agent starts");
    assert.equal(workspaces.handoffById(handoffId)?.successorRunId, successorRunId);
    // Nothing had written the brief onto the prompt yet, so the successor would
    // otherwise start with no record of what the failed run completed.
    const remarks = workspaces.promptHistory(ctx.prompt.id).remarks as Array<{ content: string }>;
    assert.ok(remarks.some((remark) => remark.content.includes("finish the aggregation")), "the brief reaches the successor");
  } finally {
    ctx.cleanup();
  }
});

test("a brief already spent on a successor is only reusable for that failed successor", async () => {
  const ctx = fixture();
  stubStarts();
  try {
    const { runId, handoffId } = blockedRunWithBrief(ctx, "CONTINUE");
    const spent = blockedRunWithBrief(ctx, "CONTINUE");
    workspaces.updateHandoff(handoffId, { successorRunId: spent.runId });
    await assert.rejects(
      resumeReadyHandoff({ handoffId, promptId: ctx.prompt.id, failedSuccessorRunId: runId, successorProvider: "claude", successorModel: null, namedPipelineId: ctx.named.id }),
      /not available for this run/,
    );
  } finally {
    ctx.cleanup();
  }
});
