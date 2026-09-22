/**
 * Re-decompose appends children; title collisions refuse without inserting.
 * Claims from docs/pipeline-redesign/prompts/07-decompose.md.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newId } from "../src/lib/ids.ts";
import { runContexts } from "../src/runContext.ts";
import type { ImportedProgram } from "../src/promptImport.ts";
import { WorkspaceError, workspaces } from "../src/workspaces.ts";

let seq = 0;
const unique = (prefix: string) => `${prefix}-${process.pid}-${Date.now()}-${(seq += 1)}`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "decompose-"));
  const workspace = workspaces.create({ name: unique("ws"), description: "", workDirectory: dir });
  const pack: ImportedProgram = {
    key: unique("P").replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "P1",
    name: "Program",
    overview: "",
    workspaceDescription: "",
    suites: [{
      key: "S6",
      name: "Modules",
      prompts: [{
        key: "S6-08",
        title: unique("parent"),
        content: "Split the remaining endpoints.",
        status: "TODO",
        completedAt: null,
        result: "",
        isGate: false,
      }],
    }],
    dependencies: [],
    gates: [],
    warnings: [],
  };
  workspaces.importProgram(workspace.id, pack);
  const prompt = workspaces.tree(workspace.id).programs[0]!.suites[0]!.prompts[0]!;
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
  workspaces.markAgentRunRunning(runId);
  return runId;
}

function childrenOf(workspaceId: number, parentId: number) {
  return workspaces.promptOptions(workspaceId)
    .filter((p) => p.parentPromptId === parentId)
    .sort((a, b) => a.childOrder - b.childOrder);
}

test("re-decompose appends .8 and .9; existing children stay put", () => {
  const ctx = fixture();
  try {
    const firstRun = beginExecute(ctx.prompt.id, ctx.workspace.id);
    const firstTitles = Array.from({ length: 7 }, (_, i) => unique(`slice-${i + 1}`));
    workspaces.decomposePrompt(firstRun, {
      requestId: unique("dec"),
      resumeBrief: "first batch",
      children: firstTitles.map((title) => ({ title, content: `do ${title}` })),
    });
    workspaces.finishAgentRun(firstRun, "done");

    const firstBatch = childrenOf(ctx.workspace.id, ctx.prompt.id);
    assert.equal(firstBatch.length, 7);
    assert.deepEqual(
      firstBatch.map((c) => c.externalKey),
      ["S6-08.1", "S6-08.2", "S6-08.3", "S6-08.4", "S6-08.5", "S6-08.6", "S6-08.7"],
    );

    // Mix DONE and SKIPPED so openChildren treats them as closed.
    for (let i = 0; i < firstBatch.length; i += 1) {
      const child = firstBatch[i]!;
      if (i % 2 === 0) {
        const childRun = beginExecute(child.id, ctx.workspace.id);
        workspaces.updateAgentStatus(childRun, {
          requestId: unique("done"),
          expectedStatus: "IN_PROGRESS",
          status: "DONE",
          reason: "done",
          verificationSummary: `verified ${child.title}`,
        });
        workspaces.finishAgentRun(childRun, "done");
      } else {
        workspaces.skipPrompt(child.id, "USER", `not needed: ${child.title}`);
      }
    }

    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "TODO");
    const resumeRun = beginExecute(ctx.prompt.id, ctx.workspace.id);
    const append = workspaces.decomposePrompt(resumeRun, {
      requestId: unique("dec2"),
      resumeBrief: "two more slices",
      children: [
        { title: unique("slice-8"), content: "eighth" },
        { title: unique("slice-9"), content: "ninth" },
      ],
    }) as { children: Array<{ id: number; externalKey: string | null; title: string }> };

    assert.deepEqual(
      append.children.map((c) => c.externalKey),
      ["S6-08.8", "S6-08.9"],
    );
    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "TODO");
    assert.equal(workspaces.latestStatusTrigger(ctx.prompt.id), "agent_decompose");

    const all = childrenOf(ctx.workspace.id, ctx.prompt.id);
    assert.equal(all.length, 9);
    // First seven untouched: same ids, keys, titles, and closed statuses.
    for (let i = 0; i < 7; i += 1) {
      assert.equal(all[i]!.id, firstBatch[i]!.id);
      assert.equal(all[i]!.externalKey, firstBatch[i]!.externalKey);
      assert.equal(all[i]!.title, firstBatch[i]!.title);
      assert.ok(all[i]!.status === "DONE" || all[i]!.status === "SKIPPED");
    }
    assert.equal(all[7]!.externalKey, "S6-08.8");
    assert.equal(all[8]!.externalKey, "S6-08.9");
    assert.equal(all[7]!.childOrder, 7);
    assert.equal(all[8]!.childOrder, 8);
  } finally {
    ctx.cleanup();
  }
});

test("title conflict refuses with decompose_title_conflict and inserts nothing", () => {
  const ctx = fixture();
  try {
    const firstRun = beginExecute(ctx.prompt.id, ctx.workspace.id);
    const existingTitle = unique("already");
    workspaces.decomposePrompt(firstRun, {
      requestId: unique("dec"),
      resumeBrief: "first",
      children: [
        { title: existingTitle, content: "one" },
        { title: unique("other"), content: "two" },
        { title: unique("third"), content: "three" },
      ],
    });
    workspaces.finishAgentRun(firstRun, "done");

    for (const child of childrenOf(ctx.workspace.id, ctx.prompt.id)) {
      workspaces.skipPrompt(child.id, "USER", "close for parent resume");
    }

    const resumeRun = beginExecute(ctx.prompt.id, ctx.workspace.id);
    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "IN_PROGRESS");

    let caught: unknown;
    try {
      workspaces.decomposePrompt(resumeRun, {
        requestId: unique("dec-conflict"),
        resumeBrief: "should refuse",
        children: [
          { title: existingTitle, content: "duplicate" },
          { title: unique("fresh"), content: "new" },
        ],
      });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof WorkspaceError);
    const err = caught as WorkspaceError;
    assert.equal(err.status, 422);
    assert.equal(err.code, "decompose_title_conflict");
    assert.match(err.message, /Rename these sub-steps/);
    assert.ok(Array.isArray(err.details?.conflicts));
    const conflicts = err.details!.conflicts as Array<{ index: number; title: string; existing: string }>;
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.index, 0);
    assert.equal(conflicts[0]!.title, existingTitle);
    assert.match(conflicts[0]!.existing, new RegExp(`${existingTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(`));
    assert.match(conflicts[0]!.existing, /S6-08\.1/);

    // Nothing inserted; parent stays IN_PROGRESS.
    assert.equal(childrenOf(ctx.workspace.id, ctx.prompt.id).length, 3);
    assert.equal(workspaces.promptOutcome(ctx.prompt.id).status, "IN_PROGRESS");
  } finally {
    ctx.cleanup();
  }
});

test("depth refusal points at continue, not BLOCKED", () => {
  const ctx = fixture();
  try {
    const parentRun = beginExecute(ctx.prompt.id, ctx.workspace.id);
    const mid = workspaces.decomposePrompt(parentRun, {
      requestId: unique("dec"),
      resumeBrief: "mid",
      children: [
        { title: unique("mid-a"), content: "a" },
        { title: unique("mid-b"), content: "b" },
      ],
    }) as { children: Array<{ id: number }> };
    workspaces.finishAgentRun(parentRun, "done");

    const midRun = beginExecute(mid.children[0]!.id, ctx.workspace.id);
    workspaces.decomposePrompt(midRun, {
      requestId: unique("dec2"),
      resumeBrief: "leaf",
      children: [
        { title: unique("leaf-a"), content: "a" },
        { title: unique("leaf-b"), content: "b" },
      ],
    });
    workspaces.finishAgentRun(midRun, "done");

    const leaf = childrenOf(ctx.workspace.id, mid.children[0]!.id)[0]!;
    const leafRun = beginExecute(leaf.id, ctx.workspace.id);
    let caught: unknown;
    try {
      workspaces.decomposePrompt(leafRun, {
        requestId: unique("dec3"),
        resumeBrief: "too deep",
        children: [
          { title: unique("x"), content: "x" },
          { title: unique("y"), content: "y" },
        ],
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof WorkspaceError);
    const err = caught as WorkspaceError;
    assert.equal(err.code, "decompose_depth_exceeded");
    assert.match(err.message, /post `continue`/);
    assert.doesNotMatch(err.message, /report BLOCKED/);
  } finally {
    ctx.cleanup();
  }
});
