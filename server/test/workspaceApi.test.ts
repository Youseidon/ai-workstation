import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { handleWorkspaceApi, isWorkspaceApiPath } from "../src/workspaceApi.ts";
import { workspaces } from "../src/workspaces.ts";

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

test("session list omits transcripts; detail and prompt activity keep a capped copy", async () => {
  const ctx = fixture();
  try {
    const runId = `run-${randomUUID()}`;
    workspaces.beginAgentRun({
      runId,
      workspaceId: ctx.workspace.id,
      promptId: ctx.prompt.id,
      provider: "claude",
      model: null,
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      role: "execute",
    });
    workspaces.markAgentRunRunning(runId);
    for (let i = 0; i < 3; i += 1) {
      workspaces.recordAgentEvent(runId, {
        id: `evt-${i}`,
        runId,
        provider: "claude",
        model: null,
        timestamp: new Date().toISOString(),
        type: "assistant_text",
        payload: { blockId: `b${i}`, delta: false, kind: "message", text: `line ${i}` },
      });
    }
    workspaces.finishAgentRun(runId, "done");

    const listed = await call("GET", "/api/sessions");
    assert.equal(listed.status, 200);
    const sessions = listed.body.sessions as Array<{ id: string; events: unknown[] }>;
    const listedSession = sessions.find((session) => session.id === runId);
    assert.ok(listedSession);
    assert.equal(listedSession.events.length, 0);

    const detail = await call("GET", `/api/sessions/${runId}`);
    assert.equal(detail.status, 200);
    const session = detail.body.session as { id: string; events: unknown[] };
    assert.equal(session.id, runId);
    assert.equal(session.events.length, 3);

    const activity = await call("GET", `/api/prompts/${ctx.prompt.id}/activity`);
    assert.equal(activity.status, 200);
    const activitySessions = activity.body.sessions as Array<{ id: string; events: unknown[] }>;
    assert.equal(activitySessions.length, 1);
    assert.equal(activitySessions[0]!.id, runId);
    assert.equal(activitySessions[0]!.events.length, 3);
  } finally {
    ctx.cleanup();
  }
});

test("a chat-box execute persists and activity keeps the typed prompt", async () => {
  const ctx = fixture();
  try {
    const runId = `run-${randomUUID()}`;
    workspaces.beginCustomExecuteRun({
      runId,
      workspaceId: ctx.workspace.id,
      provider: "claude",
      model: null,
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      displayText: "rewrite the login form\nuse the existing theme",
    });
    workspaces.markAgentRunRunning(runId);
    workspaces.recordAgentEvent(runId, {
      id: "evt-0",
      runId,
      provider: "claude",
      model: null,
      timestamp: new Date().toISOString(),
      type: "assistant_text",
      payload: { blockId: "b0", delta: false, kind: "message", text: "working on it" },
    });
    workspaces.finishAgentRun(runId, "done");

    const listed = await call("GET", "/api/sessions");
    assert.equal(listed.status, 200);
    const sessions = listed.body.sessions as Array<{
      id: string;
      promptId: number | null;
      promptTitle: string;
      displayText: string | null;
      events: unknown[];
    }>;
    const listedSession = sessions.find((session) => session.id === runId);
    assert.ok(listedSession);
    assert.equal(listedSession.promptId, null);
    assert.equal(listedSession.promptTitle, "rewrite the login form");
    assert.equal(listedSession.displayText, "rewrite the login form\nuse the existing theme");
    assert.equal(listedSession.events.length, 0);

    const detail = await call("GET", `/api/sessions/${runId}`);
    assert.equal(detail.status, 200);
    const session = detail.body.session as {
      id: string;
      promptTitle: string;
      displayText: string | null;
      events: unknown[];
    };
    assert.equal(session.id, runId);
    assert.equal(session.promptTitle, "rewrite the login form");
    assert.equal(session.displayText, "rewrite the login form\nuse the existing theme");
    assert.equal(session.events.length, 1);
    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "TODO");
  } finally {
    ctx.cleanup();
  }
});

test("every route this module answers is one the HTTP server will hand it", () => {
  // These were two lists in two files. `/api/program-drafts` was added to one of
  // them and the endpoint answered a 404 from the other — routed here, rejected
  // there. The predicate is now shared, and `index.ts` must use it rather than
  // spelling the prefixes out again.
  for (const path of [
    "/api/sessions", "/api/sessions/run_1", "/api/operations", "/api/report",
    "/api/statuses", "/api/statuses/DONE", "/api/triggers/run_started",
    "/api/definition-of-done/suite/1", "/api/workspaces", "/api/workspaces/1/tree",
    "/api/workspaces/1/program-drafts", "/api/program-drafts/1",
    "/api/program-drafts/1/apply", "/api/program-drafts/1/discard", "/api/program-drafts/1/revise",
    "/api/workspaces/1/agent-requests", "/api/workspaces/1/instruction-proposals",
    "/api/instruction-proposals/1", "/api/instruction-proposals/1/apply",
    "/api/programs/1", "/api/suites/1/prompts", "/api/prompts/1/history",
    "/api/pipelines", "/api/pipelines/1/play", "/api/runs/run_1/interrupt", "/api/verifications/1",
  ]) {
    assert.equal(isWorkspaceApiPath(path), true, path);
  }
  for (const path of ["/api/providers", "/api/health", "/api/settings", "/ws", "/api/agent/runs/r/context"]) {
    assert.equal(isWorkspaceApiPath(path), false, path);
  }
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /isWorkspaceApiPath\(url\.pathname\)/);
  assert.doesNotMatch(source, /pathname\.startsWith\("\/api\/definition-of-done\//);
});

test("the request bar refuses a mode that does not fit its target, and says which fields", async () => {
  const ctx = fixture();
  try {
    const refused = await call("POST", `/api/workspaces/${ctx.workspace.id}/agent-requests`, {
      target: { kind: "workspace" }, mode: "change", text: "rewrite everything", provider: "claude",
    });
    assert.equal(refused.status, 422);
    const fields = (refused.body.error as { fields: Record<string, string> }).fields;
    assert.ok(fields.mode, "the mode is named as the problem");

    const noText = await call("POST", `/api/workspaces/${ctx.workspace.id}/agent-requests`, {
      target: { kind: "new-program" }, mode: "edit", text: "  ",
    });
    assert.equal(noText.status, 422);
    assert.ok((noText.body.error as { fields: Record<string, string> }).fields.text);
  } finally {
    ctx.cleanup();
  }
});

test("'edit myself' opens the right kind of proposal for every target, with no agent", async () => {
  const ctx = fixture();
  try {
    const path = `/api/workspaces/${ctx.workspace.id}/agent-requests`;
    const instructions = await call("POST", path, { target: { kind: "instructions", field: "claudeMd" }, mode: "edit", text: "add a testing rule" });
    assert.equal(instructions.status, 201);
    assert.equal(instructions.body.kind, "instruction-proposal");
    assert.equal(instructions.body.runId, null);

    const revision = await call("POST", path, {
      target: { kind: "program", programId: ctx.suite.programId, suiteId: ctx.suite.id }, mode: "edit", text: "split it",
    });
    assert.equal(revision.body.kind, "program-draft");
    const draft = revision.body.draft as { targetProgramId: number; goal: string };
    assert.equal(draft.targetProgramId, ctx.suite.programId);
    assert.match(draft.goal, /^Regarding suite .+:\n\nsplit it$/, "the selection is framed into the request");

    const fresh = await call("POST", path, { target: { kind: "new-program" }, mode: "edit", text: "a new plan" });
    assert.equal((fresh.body.draft as { targetProgramId: number | null }).targetProgramId, null);

    const wrongSuite = await call("POST", path, {
      target: { kind: "program", programId: ctx.suite.programId, suiteId: 999999 }, mode: "edit", text: "x",
    });
    assert.equal(wrongSuite.status, 404);
  } finally {
    ctx.cleanup();
  }
});

test("an instruction proposal is edited, applied and listed through its routes", async () => {
  const ctx = fixture();
  try {
    workspaces.update(ctx.workspace.id, { agentsMd: "# old" });
    const opened = await call("POST", `/api/workspaces/${ctx.workspace.id}/agent-requests`, {
      target: { kind: "instructions", field: "agentsMd" }, mode: "edit", text: "modernise",
    });
    const proposalId = (opened.body.proposal as { id: number }).id;

    const saved = await call("PATCH", `/api/instruction-proposals/${proposalId}`, { content: "# new" });
    assert.equal((saved.body.proposal as { content: string }).content, "# new");

    const listed = await call("GET", `/api/workspaces/${ctx.workspace.id}/instruction-proposals`);
    assert.equal((listed.body.proposals as unknown[]).length, 1);

    const applied = await call("POST", `/api/instruction-proposals/${proposalId}/apply`, {});
    assert.equal(applied.status, 200);
    assert.equal((applied.body.workspace as { agentsMd: string }).agentsMd, "# new");

    const again = await call("POST", `/api/instruction-proposals/${proposalId}/apply`, {});
    assert.equal(again.status, 409);

    const removed = await call("DELETE", `/api/instruction-proposals/${proposalId}`);
    assert.equal(removed.status, 204);
  } finally {
    ctx.cleanup();
  }
});
