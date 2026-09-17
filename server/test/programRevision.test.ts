/**
 * Changing a program that already exists, end to end without a provider.
 *
 * The claims under test: a revision draft starts as an exact copy of the
 * program; an agent's changes land in the draft and nowhere else; apply writes
 * only what the draft changed, in place, keeping each item's status and
 * history; and an edit made to the program after the draft was opened is a
 * refusal, never something silently overwritten.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { diffProgramRevision } from "@agent-console/shared";
import { newId } from "../src/lib/ids.ts";
import { programRevisionPrompt, programRevisionStateMarkdown } from "../src/programAuthor.ts";
import { programBriefMarkdown, programConsultMarkdown } from "../src/programBrief.ts";
import { runContexts } from "../src/runContext.ts";
import { handleWorkspaceApi } from "../src/workspaceApi.ts";
import { WorkspaceError, workspaces } from "../src/workspaces.ts";

let seq = 0;
const unique = (prefix: string) => `${prefix}-${process.pid}-${Date.now()}-${(seq += 1)}`;
const VERIFY = "Do the thing.\n\n## Verify\n\n```sh\nnpm test\n```";

/** A workspace with an applied three-item program on a pipeline. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "revision-"));
  const workspace = workspaces.create({ name: unique("ws"), description: "Use npm.", workDirectory: dir });
  const draft = workspaces.createProgramDraft({ workspaceId: workspace.id, goal: "Plan it." });
  const runId = beginAuthor(workspace.id, draft.id);
  workspaces.proposeProgram(runId, {
    requestId: unique("req"), name: "Backend transition", overview: "Move the API.",
    suites: [{ name: "Foundations" }, { name: "Endpoints" }],
  });
  workspaces.proposeSuite(runId, {
    requestId: unique("req"), suite: "S1",
    prompts: [{ title: "Add the middleware", content: VERIFY }, { title: "Wire it up", content: VERIFY, dependsOn: ["S1-01"] }],
  });
  workspaces.proposeSuite(runId, {
    requestId: unique("req"), suite: "S2",
    prompts: [{ title: "Port the handlers", content: "Port them.", dependsOn: ["S1-02"] }],
  });
  workspaces.finishAgentRun(runId, "done");
  const applied = workspaces.applyProgramDraft(draft.id, { withPipeline: true });
  const program = () => workspaces.tree(workspace.id).programs.find((entry) => entry.id === applied.programId)!;
  const item = (key: string) => program().suites.flatMap((suite) => suite.prompts).find((prompt) => prompt.externalKey === key)!;
  return {
    workspace,
    programId: applied.programId,
    pipelineId: applied.pipelineId!,
    program,
    item,
    cleanup() {
      workspaces.remove(workspace.id);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function beginAuthor(workspaceId: number, draftId: number): string {
  const runId = newId("run");
  const credential = runContexts.create(runId, workspaceId, null);
  workspaces.beginAuthorRun({
    runId, workspaceId, provider: "claude", model: null,
    tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, displayText: "revise",
  });
  workspaces.attachDraftRun(draftId, runId);
  return runId;
}

function refusal(fn: () => unknown): WorkspaceError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof WorkspaceError, String(error));
    return error;
  }
  assert.fail("expected a refusal");
}

test("a revision opens as an exact copy, keyed by the library's own keys", () => {
  const f = fixture();
  try {
    const draft = workspaces.createProgramRevision({ workspaceId: f.workspace.id, programId: f.programId, goal: "Add linting." });
    assert.equal(draft.targetProgramId, f.programId);
    assert.deepEqual(draft.body, draft.baseline);
    assert.deepEqual(draft.body.suites.flatMap((suite) => suite.prompts.map((prompt) => prompt.key)), ["S1-01", "S1-02", "S2-01"]);
    assert.deepEqual(draft.body.suites[1]!.prompts[0]!.dependsOn, ["S1-02"]);
    assert.equal(draft.body.suites[0]!.prompts[0]!.sourceId, f.item("S1-01").id);
    assert.deepEqual(diffProgramRevision(draft.baseline!, draft.body), []);
  } finally {
    f.cleanup();
  }
});

test("an agent's changes land in the draft, and the program is untouched until apply", () => {
  const f = fixture();
  try {
    const before = f.program();
    const draft = workspaces.createProgramRevision({ workspaceId: f.workspace.id, programId: f.programId, goal: "Add linting." });
    const runId = beginAuthor(f.workspace.id, draft.id);

    // The wholesale doors stay shut on a revision: they would drop identities.
    assert.equal(refusal(() => workspaces.proposeProgram(runId, { requestId: unique("req"), name: "x", suites: ["a"] })).code, "revision_draft");

    const reply = workspaces.reviseProgram(runId, {
      requestId: unique("req"),
      changes: [
        { op: "replace-text", find: "npm test", replace: "npm test\nnpm run lint" },
        { op: "add-item", suite: "S2", title: "Roll back safely", content: VERIFY, dependsOn: ["S2-01"] },
      ],
    }) as { applied: string[]; pendingChanges: number };
    assert.match(reply.applied[1]!, /Added S2-02/);
    assert.equal(reply.pendingChanges, 3);

    assert.deepEqual(f.program(), before);
    const context = programRevisionStateMarkdown(workspaces.programDraft(draft.id), workspaces.programBrief(f.programId));
    assert.match(context, /added item S2-02 — Roll back safely/);
    assert.match(context, /npm run lint/);
  } finally {
    f.cleanup();
  }
});

test("apply writes the changes in place: status, history and untouched items survive", () => {
  const f = fixture();
  try {
    const first = f.item("S1-01");
    // Give the item a real history: a run that started and ended.
    const executeId = newId("run");
    const credential = runContexts.create(executeId, f.workspace.id, first.id);
    workspaces.beginAgentRun({ runId: executeId, workspaceId: f.workspace.id, promptId: first.id, provider: "claude", model: null, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt });
    workspaces.finishAgentRun(executeId, "done");
    const statusBefore = f.item("S1-01").status;
    assert.notEqual(statusBefore, "TODO");
    const draft = workspaces.createProgramRevision({ workspaceId: f.workspace.id, programId: f.programId, goal: "Rework." });
    const runId = beginAuthor(f.workspace.id, draft.id);
    workspaces.reviseProgram(runId, {
      requestId: unique("req"),
      changes: [
        { op: "update-item", item: "S1-01", content: VERIFY.replace("npm test", "npm test\nnpm run lint"), gate: { name: "Middleware in", description: "" } },
        { op: "move-item", item: "S1-02", suite: "S2", after: null },
        { op: "update-item", item: "S2-01", title: "Port every handler" },
        { op: "add-item", suite: "S2", title: "Roll back safely", content: VERIFY, dependsOn: ["S2-01"] },
        { op: "update-program", overview: "Move the API, safely." },
      ],
    });
    workspaces.finishAgentRun(runId, "done");

    const applied = workspaces.applyProgramDraft(draft.id, { withPipeline: true });
    assert.deepEqual(
      { ...applied.revision!, newPromptIds: applied.revision!.newPromptIds.length },
      { added: 1, updated: 2, removed: 0, moved: 1, newPromptIds: 1, pipelineSteps: 1 },
    );
    assert.equal(workspaces.programDraft(draft.id).state, "APPLIED");

    const program = f.program();
    assert.equal(program.overview, "Move the API, safely.");
    assert.deepEqual(program.suites.map((suite) => suite.prompts.map((prompt) => prompt.externalKey)), [["S1-01"], ["S1-02", "S2-01", "S2-03"]]);
    // Same rows: the ids did not change, so nothing attached to them was lost.
    assert.equal(f.item("S1-01").id, first.id);
    assert.equal(f.item("S1-01").status, statusBefore);
    assert.equal(workspaces.sessionsForPrompt(first.id).length, 1);
    assert.equal(f.item("S1-01").isGate, true);
    assert.equal(f.item("S2-01").title, "Port every handler");

    // The edit is in the revision history, like an operator's.
    const revisions = workspaces.promptRevisions(first.id);
    assert.equal(revisions[0]!.reason, `Applied program revision draft ${draft.id}`);
    assert.equal(revisions[0]!.content, VERIFY);

    // Verify-block criteria followed the new text.
    const commands = workspaces.resolvedDefinitionOfDone(first.id).criteria.filter((entry) => entry.kind === "COMMAND").map((entry) => entry.command);
    assert.deepEqual(commands, ["npm test", "npm run lint"]);

    // The new item waits on S2-01, and was put on the pipeline that runs its suite.
    const added = workspaces.promptOptions(f.workspace.id).find((option) => option.externalKey === "S2-03")!;
    assert.deepEqual(added.blockedBy, ["S2-01"]);
    const suiteId = program.suites[1]!.id;
    assert.ok(workspaces.enabledNamedPipelineSteps(f.pipelineId, suiteId).some((step) => step.promptId === added.id));
  } finally {
    f.cleanup();
  }
});

test("removing an item deletes it and the edges to it", () => {
  const f = fixture();
  try {
    const draft = workspaces.createProgramRevision({ workspaceId: f.workspace.id, programId: f.programId, goal: "Trim." });
    const edited = structuredClone(draft.body);
    edited.suites[0]!.prompts.splice(1, 1);
    edited.suites[1]!.prompts[0]!.dependsOn = [];
    workspaces.saveProgramDraft(draft.id, edited);
    const applied = workspaces.applyProgramDraft(draft.id);
    assert.equal(applied.revision!.removed, 1);
    assert.deepEqual(f.program().suites[0]!.prompts.map((prompt) => prompt.externalKey), ["S1-01"]);
    assert.deepEqual(workspaces.promptOptions(f.workspace.id).find((option) => option.externalKey === "S2-01")!.blockedBy, []);
  } finally {
    f.cleanup();
  }
});

test("an edit made to the program after the draft was opened is a conflict, not overwritten", () => {
  const f = fixture();
  try {
    const draft = workspaces.createProgramRevision({ workspaceId: f.workspace.id, programId: f.programId, goal: "Retitle." });
    const edited = structuredClone(draft.body);
    edited.suites[0]!.prompts[0]!.title = "Draft title";
    edited.suites[0]!.prompts[1]!.content = "Draft instructions.";
    workspaces.saveProgramDraft(draft.id, edited);

    // Someone edits the same item by hand in the meantime, and another one the
    // draft did not touch.
    workspaces.updateChild("prompt", f.item("S1-01").id, { title: "Hand title" });
    workspaces.updateChild("prompt", f.item("S2-01").id, { content: "Hand instructions." });

    const error = refusal(() => workspaces.applyProgramDraft(draft.id));
    assert.equal(error.code, "revision_conflict");
    assert.match(JSON.stringify(error.details), /S1-01's title was changed/);
    assert.equal(workspaces.programDraft(draft.id).state, "PENDING");

    // Resolving it by agreeing with the hand edit lets the rest through, and
    // the untouched item keeps the hand edit.
    edited.suites[0]!.prompts[0]!.title = "Hand title";
    workspaces.saveProgramDraft(draft.id, edited);
    workspaces.applyProgramDraft(draft.id);
    assert.equal(f.item("S1-02").content, "Draft instructions.");
    assert.equal(f.item("S2-01").content, "Hand instructions.");
  } finally {
    f.cleanup();
  }
});

test("a revision is not applied while its agent is still writing it", () => {
  const f = fixture();
  try {
    const draft = workspaces.createProgramRevision({ workspaceId: f.workspace.id, programId: f.programId, goal: "x" });
    beginAuthor(f.workspace.id, draft.id);
    assert.equal(refusal(() => workspaces.applyProgramDraft(draft.id)).code, "draft_busy");
  } finally {
    f.cleanup();
  }
});

test("the brief an agent reads names the order, rules and pipelines it would run under", () => {
  const f = fixture();
  try {
    const brief = workspaces.programBrief(f.programId);
    const markdown = programConsultMarkdown(brief, "What runs after S1-02?", "");
    assert.match(markdown, /## Question\n\nWhat runs after S1-02\?/);
    assert.match(markdown, /### Backend transition/);
    assert.match(markdown, /1\. S1-01 — Add the middleware · default agent · on done: continue · unfinished: continue/);
    assert.match(markdown, /Depends on: S1-02 — Wire it up \[TODO\]/);
    assert.match(markdown, /COMMAND: npm test/);
    assert.match(programBriefMarkdown(brief, { item: "s2-01" }), /#### S2-01 — Port the handlers/);

    const draft = workspaces.createProgramRevision({ workspaceId: f.workspace.id, programId: f.programId, goal: "Add linting." });
    const prompt = programRevisionPrompt({
      workspace: { name: f.workspace.name, workDirectory: f.workspace.workDirectory, description: "" },
      draft, brief, shimPath: "/tmp/agent-step", runId: "run-x", token: "t", port: 1, feedback: null,
    });
    assert.match(prompt, /agent-step" revise --file changes\.json/);
    assert.match(prompt, /Add linting\./);
  } finally {
    f.cleanup();
  }
});

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

test("the program routes open a revision by hand and refuse an empty question", async () => {
  const f = fixture();
  try {
    const opened = await call("POST", `/api/programs/${f.programId}/revisions`, { goal: "Tidy it." });
    assert.equal(opened.status, 201);
    const draft = opened.body.draft as { id: number; targetProgramId: number };
    assert.equal(draft.targetProgramId, f.programId);
    assert.equal(opened.body.runId, null);

    const listed = await call("GET", `/api/workspaces/${f.workspace.id}/program-drafts`);
    assert.ok((listed.body.drafts as Array<{ draft: { id: number } }>).some((entry) => entry.draft.id === draft.id));

    const empty = await call("POST", `/api/programs/${f.programId}/ask`, { provider: "claude", question: "  " });
    assert.equal(empty.status, 422);
  } finally {
    f.cleanup();
  }
});
