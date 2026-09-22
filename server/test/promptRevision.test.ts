import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { runContexts } from "../src/runContext.ts";
import { workspaces } from "../src/workspaces.ts";

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${seq}`;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "rev-"));
  const workspace = workspaces.create({ name: unique("ws"), description: "", workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: unique("prog"), overview: "" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: unique("suite"), overview: "" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: unique("p0"), content: "original text" }) as PromptRecord;
  return {
    workspace, suite, prompt,
    cleanup() { workspaces.remove(workspace.id); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe("prompt content versioning", () => {
  test("an edit records the text it replaced, and a restore brings it back byte for byte", () => {
    const ctx = fixture();
    try {
      assert.equal(workspaces.promptRevisions(ctx.prompt.id).length, 0, "a fresh prompt has no prior text");

      workspaces.updateChild("prompt", ctx.prompt.id, { content: "rewritten by the bulk pass", reason: "corpus normalisation" });
      const afterFirst = workspaces.promptRevisions(ctx.prompt.id);
      assert.equal(afterFirst.length, 1);
      assert.equal(afterFirst[0]!.content, "original text", "the revision holds the outgoing text");
      assert.equal(afterFirst[0]!.reason, "corpus normalisation");

      const restored = workspaces.restorePromptRevision(ctx.prompt.id, afterFirst[0]!.id as number) as Record<string, unknown>;
      assert.equal(restored.content, "original text");
      // The restore is itself an edit, so the text it displaced is kept too —
      // undo has to be undoable or it is just a different way to lose work.
      const afterRestore = workspaces.promptRevisions(ctx.prompt.id);
      assert.equal(afterRestore.length, 2);
      assert.equal(afterRestore[0]!.content, "rewritten by the bulk pass");
    } finally { ctx.cleanup(); }
  });

  test("a no-op write records nothing", () => {
    const ctx = fixture();
    try {
      workspaces.updateChild("prompt", ctx.prompt.id, { content: "original text" });
      assert.equal(workspaces.promptRevisions(ctx.prompt.id).length, 0);
    } finally { ctx.cleanup(); }
  });

  test("restoring a revision that belongs to another prompt is refused", () => {
    const a = fixture();
    const b = fixture();
    try {
      workspaces.updateChild("prompt", a.prompt.id, { content: "changed" });
      const foreign = workspaces.promptRevisions(a.prompt.id)[0]!.id as number;
      assert.throws(() => workspaces.restorePromptRevision(b.prompt.id, foreign), /Revision not found/);
    } finally { a.cleanup(); b.cleanup(); }
  });
});

describe("context history is bounded", () => {
  test("an agent's context carries the newest remarks, not every one ever posted", () => {
    const ctx = fixture();
    try {
      const runId = unique("run");
      const credential = runContexts.create(runId, ctx.workspace.id, ctx.prompt.id);
      workspaces.beginAgentRun({
        runId,
        workspaceId: ctx.workspace.id,
        promptId: ctx.prompt.id,
        provider: "claude",
        model: null,
        tokenHash: credential.tokenHash,
        expiresAt: credential.expiresAt,
        role: "execute",
      });
      for (let index = 0; index < 30; index += 1) {
        workspaces.addAgentRemark(runId, { requestId: `remark-request-${index}`, kind: "PROGRESS", content: `verified slice ${index}` });
      }
      const full = workspaces.promptHistory(ctx.prompt.id).remarks;
      const bounded = workspaces.promptHistory(ctx.prompt.id, 8).remarks;
      assert.equal(full.length, 30, "the record itself stays complete for the UI");
      assert.equal(bounded.length, 8, "what reaches the model does not");
      assert.deepEqual(bounded, full.slice(0, 8), "and it is the newest that survive");
    } finally { ctx.cleanup(); }
  });
});
