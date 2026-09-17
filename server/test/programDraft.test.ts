/**
 * Agent-authored programs, end to end without a provider.
 *
 * The claim under test is the one the design rests on: an author run can fill
 * in a draft and cannot touch the library, and only an operator's apply turns a
 * draft into rows in `program`, `suite` and `prompt`.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleWorkspaceApi } from "../src/workspaceApi.ts";
import { newId } from "../src/lib/ids.ts";
import { runContexts } from "../src/runContext.ts";
import { WorkspaceError, workspaces } from "../src/workspaces.ts";

let seq = 0;
const unique = (prefix: string) => `${prefix}-${process.pid}-${Date.now()}-${(seq += 1)}`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "draft-"));
  const workspace = workspaces.create({ name: unique("ws"), description: "", workDirectory: dir });
  return {
    workspace,
    cleanup() {
      workspaces.remove(workspace.id);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** An author run, without starting a provider. */
function beginAuthor(workspaceId: number, draftId: number): string {
  const runId = newId("run");
  const credential = runContexts.create(runId, workspaceId, null);
  workspaces.beginAuthorRun({
    runId, workspaceId, provider: "claude", model: null,
    tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, displayText: "draft a program",
  });
  workspaces.attachDraftRun(draftId, runId);
  return runId;
}

const VERIFY = "Do the thing.\n\n## Verify\n\n```sh\nnpm test\n```\n";

function proposeWholeProgram(runId: string): void {
  workspaces.proposeProgram(runId, {
    requestId: unique("req"),
    name: "Backend transition",
    overview: "Move the API off the legacy host.",
    notes: "Read server/src and the tests.",
    suites: [{ name: "Foundations", overview: "Groundwork." }, { name: "Endpoints" }],
  });
  workspaces.proposeSuite(runId, {
    requestId: unique("req"),
    suite: "S1",
    prompts: [
      { title: "Add the middleware", content: VERIFY },
      { title: "Wire it up", content: "Do it.", dependsOn: ["S1-01"] },
    ],
  });
  workspaces.proposeSuite(runId, {
    requestId: unique("req"),
    suite: "S2",
    prompts: [
      { title: "Port the handlers", content: "Do it.", dependsOn: ["S1-02"], gate: { name: "Handlers ported", description: "Nothing after this starts first." } },
    ],
  });
}

test("an author run fills in a draft and the library is untouched until it is applied", () => {
  const f = fixture();
  try {
    const draft = workspaces.createProgramDraft({ workspaceId: f.workspace.id, goal: "Plan the backend transition." });
    const runId = beginAuthor(f.workspace.id, draft.id);
    proposeWholeProgram(runId);

    // Nothing has been created yet. This is the whole guarantee.
    assert.deepEqual(workspaces.tree(f.workspace.id).programs, []);

    const filled = workspaces.programDraft(draft.id);
    assert.equal(filled.state, "PENDING");
    assert.equal(filled.runId, runId);
    assert.deepEqual(filled.body.suites.map((suite) => suite.key), ["S1", "S2"]);
    assert.deepEqual(filled.body.suites[0]!.prompts.map((prompt) => prompt.key), ["S1-01", "S1-02"]);

    const applied = workspaces.applyProgramDraft(draft.id);
    assert.equal(applied.prompts, 3);
    const program = workspaces.tree(f.workspace.id).programs.find((entry) => entry.id === applied.programId)!;
    assert.equal(program.name, "Backend transition");
    assert.equal(program.externalKey, "BT");
    assert.deepEqual(program.suites.map((suite) => suite.name), ["Foundations", "Endpoints"]);
    assert.deepEqual(program.suites[0]!.prompts.map((prompt) => prompt.externalKey), ["S1-01", "S1-02"]);
    assert.deepEqual(program.suites.flatMap((suite) => suite.prompts).map((prompt) => prompt.status), ["TODO", "TODO", "TODO"]);

    // The dependency edges came with it: S1-02 is not ready until S1-01 is done.
    const options = workspaces.promptOptions(f.workspace.id);
    const second = options.find((option) => option.externalKey === "S1-02")!;
    assert.deepEqual(second.blockedBy, ["S1-01"]);
    assert.equal(options.find((option) => option.externalKey === "S1-01")!.ready, true);
    assert.equal(second.ready, false);

    // And a `## Verify` block became the item's command criteria, exactly as it
    // does on the import path.
    const first = options.find((option) => option.externalKey === "S1-01")!;
    const definition = workspaces.resolvedDefinitionOfDone(first.id);
    assert.deepEqual(definition.criteria.filter((entry) => entry.kind === "COMMAND").map((entry) => entry.command), ["npm test"]);

    assert.equal(workspaces.programDraft(draft.id).state, "APPLIED");
    assert.equal(workspaces.programDraft(draft.id).appliedProgramId, applied.programId);
  } finally {
    f.cleanup();
  }
});

test("a gate on a drafted work item becomes a program gate", () => {
  const f = fixture();
  try {
    const draft = workspaces.createProgramDraft({ workspaceId: f.workspace.id, goal: "g" });
    proposeWholeProgram(beginAuthor(f.workspace.id, draft.id));
    const applied = workspaces.applyProgramDraft(draft.id);
    const gated = workspaces.tree(f.workspace.id).programs
      .find((program) => program.id === applied.programId)!
      .suites.flatMap((suite) => suite.prompts)
      .find((prompt) => prompt.externalKey === "S2-01")!;
    assert.equal(gated.isGate, true);
  } finally {
    f.cleanup();
  }
});

test("a suite posted before the program is refused with what to do instead", () => {
  const f = fixture();
  try {
    const draft = workspaces.createProgramDraft({ workspaceId: f.workspace.id, goal: "g" });
    const runId = beginAuthor(f.workspace.id, draft.id);
    assert.throws(
      () => workspaces.proposeSuite(runId, { requestId: unique("req"), suite: "S1", prompts: [{ title: "T", content: "c" }] }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "no_program_yet",
    );
  } finally {
    f.cleanup();
  }
});

test("an execute run cannot propose a program, and an author run cannot post a status", () => {
  const f = fixture();
  try {
    const program = workspaces.createChild("program", f.workspace.id, { name: unique("p"), overview: "" }) as { id: number };
    const suite = workspaces.createChild("suite", program.id, { name: unique("s"), overview: "" }) as { id: number };
    const prompt = workspaces.createChild("prompt", suite.id, { title: unique("t"), content: "do it" }) as { id: number };
    const executeRunId = newId("run");
    const credential = runContexts.create(executeRunId, f.workspace.id, prompt.id);
    workspaces.beginAgentRun({
      runId: executeRunId, workspaceId: f.workspace.id, promptId: prompt.id, provider: "claude", model: null,
      tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute",
    });
    assert.throws(
      () => workspaces.proposeProgram(executeRunId, { requestId: unique("req"), name: "X", suites: [{ name: "A" }] }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "author_only",
    );

    const draft = workspaces.createProgramDraft({ workspaceId: f.workspace.id, goal: "g" });
    const authorRunId = beginAuthor(f.workspace.id, draft.id);
    assert.throws(
      () => workspaces.updateAgentStatus(authorRunId, { requestId: unique("req"), expectedStatus: "IN_PROGRESS", status: "DONE", verificationSummary: "x" }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "author_only",
    );
    assert.throws(
      () => workspaces.addAgentRemark(authorRunId, { requestId: unique("req"), kind: "PROGRESS", content: "x" }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "author_only",
    );
  } finally {
    f.cleanup();
  }
});

test("a proposal is idempotent: the same requestId does not post the suite twice", () => {
  const f = fixture();
  try {
    const draft = workspaces.createProgramDraft({ workspaceId: f.workspace.id, goal: "g" });
    const runId = beginAuthor(f.workspace.id, draft.id);
    workspaces.proposeProgram(runId, { requestId: unique("req"), name: "P", suites: [{ name: "A" }] });
    const requestId = unique("req");
    const first = workspaces.proposeSuite(runId, { requestId, suite: "S1", prompts: [{ title: "One", content: "c" }] });
    const second = workspaces.proposeSuite(runId, { requestId, suite: "S1", prompts: [{ title: "Different", content: "c" }] });
    assert.deepEqual(first, second);
    assert.deepEqual(workspaces.programDraft(draft.id).body.suites[0]!.prompts.map((prompt) => prompt.title), ["One"]);
  } finally {
    f.cleanup();
  }
});

test("a draft with an empty suite cannot be applied, and says which suite", () => {
  const f = fixture();
  try {
    const draft = workspaces.createProgramDraft({ workspaceId: f.workspace.id, goal: "g" });
    const runId = beginAuthor(f.workspace.id, draft.id);
    workspaces.proposeProgram(runId, { requestId: unique("req"), name: "P", suites: [{ name: "A" }, { name: "B" }] });
    workspaces.proposeSuite(runId, { requestId: unique("req"), suite: "S1", prompts: [{ title: "One", content: "c" }] });
    assert.throws(
      () => workspaces.applyProgramDraft(draft.id),
      (error: unknown) => error instanceof WorkspaceError
        && error.code === "draft_incomplete"
        && JSON.stringify(error.details).includes("S2 (B) has no work items"),
    );
    assert.deepEqual(workspaces.tree(f.workspace.id).programs, []);
  } finally {
    f.cleanup();
  }
});

test("a settled draft cannot be applied twice, written to, or re-run", () => {
  const f = fixture();
  try {
    const draft = workspaces.createProgramDraft({ workspaceId: f.workspace.id, goal: "g" });
    const runId = beginAuthor(f.workspace.id, draft.id);
    proposeWholeProgram(runId);
    workspaces.applyProgramDraft(draft.id);
    assert.throws(
      () => workspaces.applyProgramDraft(draft.id),
      (error: unknown) => error instanceof WorkspaceError && error.code === "draft_settled",
    );
    assert.throws(
      () => workspaces.proposeSuite(runId, { requestId: unique("req"), suite: "S1", prompts: [{ title: "Late", content: "c" }] }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "draft_settled",
    );
    assert.throws(
      () => workspaces.saveProgramDraft(draft.id, { name: "P", suites: [] }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "draft_settled",
    );
  } finally {
    f.cleanup();
  }
});

test("a discarded draft is kept as a record and refuses further proposals", () => {
  const f = fixture();
  try {
    const draft = workspaces.createProgramDraft({ workspaceId: f.workspace.id, goal: "g" });
    const runId = beginAuthor(f.workspace.id, draft.id);
    workspaces.proposeProgram(runId, { requestId: unique("req"), name: "P", suites: [{ name: "A" }] });
    assert.equal(workspaces.discardProgramDraft(draft.id).state, "DISCARDED");
    assert.throws(
      () => workspaces.proposeSuite(runId, { requestId: unique("req"), suite: "S1", prompts: [{ title: "One", content: "c" }] }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "draft_settled",
    );
    assert.equal(workspaces.programDrafts(f.workspace.id).length, 1);
  } finally {
    f.cleanup();
  }
});

test("two author runs cannot fill in the same draft at once", () => {
  const f = fixture();
  try {
    const draft = workspaces.createProgramDraft({ workspaceId: f.workspace.id, goal: "g" });
    beginAuthor(f.workspace.id, draft.id);
    assert.throws(
      () => beginAuthor(f.workspace.id, draft.id),
      (error: unknown) => error instanceof WorkspaceError && error.code === "draft_busy",
    );
  } finally {
    f.cleanup();
  }
});

test("a revise run may take over a draft once the earlier run has ended", () => {
  const f = fixture();
  try {
    const draft = workspaces.createProgramDraft({ workspaceId: f.workspace.id, goal: "g" });
    const first = beginAuthor(f.workspace.id, draft.id);
    workspaces.proposeProgram(first, { requestId: unique("req"), name: "P", suites: [{ name: "A" }] });
    workspaces.finishAgentRun(first, "done");
    const second = beginAuthor(f.workspace.id, draft.id);
    // The second run sees what the first wrote rather than starting over.
    assert.deepEqual(workspaces.programDraftForRun(second)!.body.suites.map((suite) => suite.name), ["A"]);
    assert.equal(workspaces.programDraftForRun(first), null);
  } finally {
    f.cleanup();
  }
});

test("applying with a pipeline stages every suite and every work item", () => {
  const f = fixture();
  try {
    const draft = workspaces.createProgramDraft({ workspaceId: f.workspace.id, goal: "g" });
    proposeWholeProgram(beginAuthor(f.workspace.id, draft.id));
    const applied = workspaces.applyProgramDraft(draft.id, { withPipeline: true });
    assert.equal(applied.pipelineError, null);
    assert.notEqual(applied.pipelineId, null);
    const pipeline = workspaces.getPipeline(applied.pipelineId!);
    assert.deepEqual(pipeline.stages.map((stage) => stage.suiteName), ["Foundations", "Endpoints"]);
    const suites = workspaces.tree(f.workspace.id).programs.find((program) => program.id === applied.programId)!.suites;
    assert.deepEqual(
      workspaces.enabledNamedPipelineSteps(applied.pipelineId!, suites[0]!.id).map((step) => step.stepOrder),
      [0, 1],
    );
    assert.equal(workspaces.enabledNamedPipelineSteps(applied.pipelineId!, suites[1]!.id).length, 1);
  } finally {
    f.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* The REST surface                                                    */
/* ------------------------------------------------------------------ */

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
  const handled = await handleWorkspaceApi(req, res, new URL(path, "http://127.0.0.1"));
  assert.equal(handled, true, `${method} ${path} was not routed`);
  return { status, body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>) };
}

test("the draft routes open, edit, preview, apply and discard a program", async () => {
  const f = fixture();
  try {
    // No provider: open an empty draft to write by hand.
    const opened = await call("POST", `/api/workspaces/${f.workspace.id}/program-drafts`, { goal: "Plan it." });
    assert.equal(opened.status, 201);
    assert.equal((opened.body.runId as string | null), null);
    const draftId = (opened.body.draft as { id: number }).id;

    const edited = await call("PATCH", `/api/program-drafts/${draftId}`, {
      name: "Hand written",
      overview: "By the operator.",
      suites: [{ name: "Only", prompts: [{ title: "One", content: VERIFY }] }],
    });
    assert.equal(edited.status, 200);
    assert.equal((edited.body.preview as { prompts: number }).prompts, 1);
    assert.equal((edited.body.preview as { verifiable: number }).verifiable, 1);
    assert.deepEqual((edited.body.preview as { issues: string[] }).issues, []);

    const listed = await call("GET", `/api/workspaces/${f.workspace.id}/program-drafts`);
    assert.equal((listed.body.drafts as unknown[]).length, 1);

    const applied = await call("POST", `/api/program-drafts/${draftId}/apply`, {});
    assert.equal(applied.status, 201);
    assert.equal(applied.body.prompts, 1);
    assert.equal(applied.body.pipelineId, null);
    const tree = applied.body.workspace as { programs: Array<{ id: number; name: string }> };
    assert.equal(tree.programs.some((program) => program.name === "Hand written"), true);

    const again = await call("POST", `/api/program-drafts/${draftId}/apply`, {});
    assert.equal(again.status, 409);

    const second = await call("POST", `/api/workspaces/${f.workspace.id}/program-drafts`, { goal: "Another." });
    const discarded = await call("POST", `/api/program-drafts/${(second.body.draft as { id: number }).id}/discard`, {});
    assert.equal(discarded.status, 200);
    assert.equal((discarded.body.draft as { state: string }).state, "DISCARDED");

    const removed = await call("DELETE", `/api/program-drafts/${(second.body.draft as { id: number }).id}`);
    assert.equal(removed.status, 204);
  } finally {
    f.cleanup();
  }
});

test("a draft route refuses an unknown provider rather than starting a run", async () => {
  const f = fixture();
  try {
    const result = await call("POST", `/api/workspaces/${f.workspace.id}/program-drafts`, { goal: "g", provider: "nope" });
    assert.equal(result.status, 422);
    assert.equal(workspaces.programDrafts(f.workspace.id).length, 0);
  } finally {
    f.cleanup();
  }
});

test("deleting a workspace takes its drafts with it", () => {
  const f = fixture();
  const draft = workspaces.createProgramDraft({ workspaceId: f.workspace.id, goal: "g" });
  f.cleanup();
  assert.throws(
    () => workspaces.programDraft(draft.id),
    (error: unknown) => error instanceof WorkspaceError && error.code === "not_found",
  );
});
