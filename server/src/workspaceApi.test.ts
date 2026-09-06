import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { handleWorkspaceApi } from "./workspaceApi.ts";
import { workspaces } from "./workspaces.ts";

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${seq}`;
}

/** Drives a route the way the HTTP server would, without opening a socket. */
async function call(method: string, path: string, payload?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = Readable.from(payload === undefined ? [] : [JSON.stringify(payload)]) as unknown as IncomingMessage;
  req.method = method;
  req.headers = { "content-type": "application/json" };
  let status = 0;
  let raw = "";
  const res = Object.assign(new EventEmitter(), {
    writeHead(code: number) { status = code; return res; },
    end(chunk?: string) { raw = chunk ?? ""; return res; },
    setHeader() { return res; },
    writableEnded: false,
  }) as unknown as ServerResponse;
  const url = new URL(path, "http://127.0.0.1");
  const handled = await handleWorkspaceApi(req, res, url);
  assert.equal(handled, true, `${method} ${path} was not routed`);
  return { status, body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>) };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "api-"));
  const workspace = workspaces.create({ name: unique("ws"), description: "", workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: unique("prog"), overview: "" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: unique("suite"), overview: "" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: unique("p0"), content: "do it" }) as PromptRecord;
  const pipeline = workspaces.createPipeline({ workspaceId: workspace.id, name: unique("pipe"), suiteIds: [suite.id] });
  workspaces.addNamedPipelineStep(pipeline.id, prompt.id, { provider: "claude" });
  return {
    workspace, suite, prompt, pipeline,
    cleanup() { workspaces.remove(workspace.id); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("patching a step rule needs no suiteId, but deleting one still does", async () => {
  const ctx = fixture();
  try {
    // A rule patch is addressed by prompt id alone — the client never sends a
    // suite, and requiring one broke every model change on the board.
    const patched = await call("PATCH", `/api/pipelines/${ctx.pipeline.id}/flowchart/steps/${ctx.prompt.id}`, { provider: "codex", model: "gpt-x" });
    assert.equal(patched.status, 200);
    assert.deepEqual((patched.body.rule as Record<string, unknown>).provider, "codex");
    assert.equal(workspaces.pipelineRule(ctx.prompt.id, ctx.pipeline.id).model, "gpt-x");

    // The delete reply carries a rebuilt stage flowchart, so it keeps the guard.
    const missing = await call("DELETE", `/api/pipelines/${ctx.pipeline.id}/flowchart/steps/${ctx.prompt.id}`);
    assert.equal(missing.status, 400);
    assert.equal(workspaces.pipelineRule(ctx.prompt.id, ctx.pipeline.id).enabled, true);

    const removed = await call("DELETE", `/api/pipelines/${ctx.pipeline.id}/flowchart/steps/${ctx.prompt.id}?suiteId=${ctx.suite.id}`);
    assert.equal(removed.status, 200);
    assert.equal(workspaces.pipelineRule(ctx.prompt.id, ctx.pipeline.id).enabled, false);
  } finally {
    ctx.cleanup();
  }
});

test("a sub-step is patched and reset over the same routes as a station", async () => {
  const ctx = fixture();
  try {
    const runId = `run-${randomUUID()}`;
    const credentialFreeStart = () => {
      workspaces.beginAgentRun({
        runId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id,
        provider: "claude", model: null, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 60000).toISOString(), role: "execute",
      });
      workspaces.markAgentRunRunning(runId);
    };
    credentialFreeStart();
    const decomposed = workspaces.decomposePrompt(runId, {
      requestId: randomUUID(),
      resumeBrief: "Two slices remain.",
      children: [{ title: unique("a"), content: "a" }, { title: unique("b"), content: "b" }],
    }) as { children: Array<{ id: number }> };
    const child = decomposed.children[0]!.id;

    const activity = await call("GET", `/api/prompts/${child}/activity`);
    assert.equal(activity.status, 200);
    assert.equal(((activity.body.item as Record<string, unknown>).prompt as Record<string, unknown>).id, child);

    const patched = await call("PATCH", `/api/pipelines/${ctx.pipeline.id}/flowchart/steps/${child}`, { provider: "codex" });
    assert.equal(patched.status, 200);
    assert.equal(workspaces.pipelineRule(child, ctx.pipeline.id).provider, "codex");
    assert.equal(workspaces.namedPipelineSubStepRules(ctx.pipeline.id, ctx.suite.id).find((entry) => entry.promptId === child)?.inherited, false);

    const reset = await call("DELETE", `/api/pipelines/${ctx.pipeline.id}/flowchart/steps/${child}?suiteId=${ctx.suite.id}`);
    assert.equal(reset.status, 200);
    assert.equal(workspaces.pipelineRule(child, ctx.pipeline.id).provider, "claude");
    // Resetting a sub-step must not unseat the station it hangs off.
    assert.deepEqual(
      workspaces.enabledNamedPipelineSteps(ctx.pipeline.id, ctx.suite.id).map((step) => step.promptId),
      [ctx.prompt.id],
    );
  } finally {
    ctx.cleanup();
  }
});

/*
 * The scenario this route exists for: a run is interrupted between finishing
 * the work and reporting it, boot-time recovery parks the station BLOCKED, and
 * the operator has the agent's own evidence in hand. Re-running the agent just
 * to re-report finished work is the expensive way out.
 */
function seedInterruptedRun(workspaceId: number, promptId: number): string {
  const runId = `run_${randomUUID()}`;
  workspaces.beginAgentRun({
    runId,
    workspaceId,
    promptId,
    provider: "claude",
    model: null,
    tokenHash: randomUUID(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    role: "execute",
  });
  workspaces.markAgentRunRunning(runId);
  // How the real one arises: the server restarts while the agent is still
  // working, and boot-time recovery parks the station it can no longer see.
  workspaces.recoverAbandonedRuns();
  return runId;
}

test("a blocked station whose work is done can be completed without another run", async () => {
  const ctx = fixture();
  try {
    const runId = seedInterruptedRun(ctx.workspace.id, ctx.prompt.id);
    const before = workspaces.resolvePrompt(ctx.workspace.id, ctx.prompt.id);
    // The server restarted mid-run, so nothing ever recorded how it ended.
    assert.equal(before.status, "UNREPORTED");
    assert.equal(before.recoverable, true, "recovery is offered, but it would re-run the work");

    const summary = "Build 0 warnings; 25/25 route replay green; burndown +6.";
    const response = await call("POST", `/api/prompts/${ctx.prompt.id}/complete`, { verificationSummary: summary });
    assert.equal(response.status, 200);
    // `status` says what was actually stored. An override is always honoured,
    // but with a definition of done in play a close can land short of DONE, and
    // the caller has to be able to tell those apart.
    assert.deepEqual(response.body, { completed: true, status: "DONE" });

    const after = workspaces.resolvePrompt(ctx.workspace.id, ctx.prompt.id);
    assert.equal(after.status, "DONE");
    assert.equal(after.recoverable, false, "a completed station must stop offering recovery");

    // The audit reads the status event, so the evidence has to land there too,
    // attributed to the run that actually did the work.
    const history = workspaces.promptHistory(ctx.prompt.id);
    const done = (history.events as Array<{ newStatus: string; runId: string | null; actorType: string }>)
      .find((event) => event.newStatus === "DONE");
    assert.equal(done?.runId, runId, "provenance of the run that did the work is kept");
    assert.equal(done?.actorType, "USER");
    // WARNING, not VERIFIED, and deliberately so: the evidence is recorded, but
    // the run behind it ended interrupted and the audit must keep saying so.
    // An operator override is not a way to launder a station into looking clean.
    const audited = workspaces.recordSuiteAudit(ctx.suite.id).items[0];
    assert.equal(audited?.check, "WARNING");
    assert.match(audited?.evidence ?? "", /25\/25 route replay green/);
    assert.match(audited?.evidence ?? "", /ended interrupted after posting DONE/);
  } finally {
    ctx.cleanup();
  }
});

test("completing a station requires evidence and refuses terminal or live stations", async () => {
  const ctx = fixture();
  try {
    seedInterruptedRun(ctx.workspace.id, ctx.prompt.id);
    // An empty summary would audit as "Marked DONE with no recorded
    // verification summary" — the same hole the agent's DONE path refuses.
    const blank = await call("POST", `/api/prompts/${ctx.prompt.id}/complete`, { verificationSummary: "  " });
    assert.equal(blank.status, 422);
    assert.equal(workspaces.resolvePrompt(ctx.workspace.id, ctx.prompt.id).status, "UNREPORTED");

    await call("POST", `/api/prompts/${ctx.prompt.id}/complete`, { verificationSummary: "done and verified" });
    const again = await call("POST", `/api/prompts/${ctx.prompt.id}/complete`, { verificationSummary: "done and verified" });
    assert.equal(again.status, 409);
    assert.equal((again.body.error as { code: string }).code, "already_complete");
  } finally {
    ctx.cleanup();
  }
});
