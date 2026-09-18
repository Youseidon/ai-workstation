import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import { captureInstructionRun, materialize, proposeFromWorkingTree, readInstructionFile } from "../src/workspaceInstructions.ts";
import { workspaces } from "../src/workspaces.ts";

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${seq}`;
}

function fixture(fields: { claudeMd?: string; agentsMd?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "instr-"));
  const workspace = workspaces.create({ name: unique("ws"), description: "", workDirectory: dir });
  const updated = Object.keys(fields).length === 0 ? workspace : workspaces.update(workspace.id, fields);
  return {
    workspace: updated,
    dir,
    claude: join(dir, "CLAUDE.md"),
    agents: join(dir, "AGENTS.md"),
    ignore: join(dir, ".gitignore"),
    reload: () => workspaces.get(workspace.id),
    cleanup() { workspaces.remove(workspace.id); rmSync(dir, { recursive: true, force: true }); },
  };
}

describe("materialising instruction files", () => {
  test("both fields are written into the working tree", () => {
    const ctx = fixture({ claudeMd: "# Claude rules", agentsMd: "# Agents rules" });
    try {
      materialize(ctx.workspace);
      assert.equal(readFileSync(ctx.claude, "utf8"), "# Claude rules\n");
      assert.equal(readFileSync(ctx.agents, "utf8"), "# Agents rules\n");
    } finally { ctx.cleanup(); }
  });

  test("an empty field writes no file, and never deletes one already there", () => {
    const ctx = fixture({ claudeMd: "# Claude rules" });
    try {
      writeFileSync(ctx.agents, "someone else put this here\n");
      materialize(ctx.reload());
      assert.ok(existsSync(ctx.claude));
      assert.equal(readFileSync(ctx.agents, "utf8"), "someone else put this here\n", "a foreign file is left alone");
    } finally { ctx.cleanup(); }
  });

  test("the written files are gitignored, so they never show up as uncommitted work", () => {
    const ctx = fixture({ claudeMd: "# rules" });
    try {
      materialize(ctx.workspace);
      const ignored = readFileSync(ctx.ignore, "utf8");
      assert.match(ignored, /^\/CLAUDE\.md$/m);
      assert.match(ignored, /^\/AGENTS\.md$/m);
    } finally { ctx.cleanup(); }
  });

  test("an existing .gitignore is appended to, not replaced, and only once", () => {
    const ctx = fixture({ claudeMd: "# rules" });
    try {
      writeFileSync(ctx.ignore, "node_modules\ndist\n");
      materialize(ctx.workspace);
      const first = readFileSync(ctx.ignore, "utf8");
      assert.match(first, /^node_modules$/m, "existing entries survive");
      workspaces.update(ctx.workspace.id, { claudeMd: "# rules changed" });
      materialize(ctx.reload());
      const second = readFileSync(ctx.ignore, "utf8");
      assert.equal(second.match(/\/CLAUDE\.md/g)?.length, 1, "the block is not appended twice");
    } finally { ctx.cleanup(); }
  });

  test("a workspace whose directory is gone is skipped rather than throwing", () => {
    const ctx = fixture({ claudeMd: "# rules" });
    ctx.cleanup();
    assert.doesNotThrow(() => materialize({ workDirectory: ctx.dir, claudeMd: "# rules", agentsMd: "" }));
  });
});

describe("instruction edits made during a run", () => {
  test("an agent's edit on disk becomes a proposal, and the stored text goes back on disk", () => {
    const ctx = fixture({ claudeMd: "# original" });
    try {
      materialize(ctx.workspace);
      writeFileSync(ctx.claude, "# rewritten by the agent\n");
      const proposed = proposeFromWorkingTree(ctx.workspace.id, "run-1");

      assert.equal(proposed.length, 1);
      assert.equal(proposed[0]!.field, "claudeMd");
      assert.equal(proposed[0]!.origin, "run");
      assert.equal(proposed[0]!.runId, "run-1");
      assert.equal(proposed[0]!.baseline, "# original");
      assert.equal(proposed[0]!.content, "# rewritten by the agent");
      // Nothing a run writes reaches the workspace until someone applies it.
      assert.equal(ctx.reload().claudeMd, "# original");
      assert.equal(readFileSync(ctx.claude, "utf8"), "# original\n");
    } finally { ctx.cleanup(); }
  });

  test("the same edit is not proposed twice, even after it was discarded", () => {
    const ctx = fixture({ claudeMd: "# original" });
    try {
      materialize(ctx.workspace);
      writeFileSync(ctx.claude, "# same edit\n");
      const [first] = proposeFromWorkingTree(ctx.workspace.id, null);
      workspaces.discardInstructionProposal(first!.id);
      writeFileSync(ctx.claude, "# same edit\n");
      assert.equal(proposeFromWorkingTree(ctx.workspace.id, null).length, 0);
      assert.equal(workspaces.instructionProposals(ctx.workspace.id).length, 1);
    } finally { ctx.cleanup(); }
  });

  test("an unchanged file proposes nothing", () => {
    const ctx = fixture({ claudeMd: "# original" });
    try {
      materialize(ctx.workspace);
      assert.equal(proposeFromWorkingTree(ctx.workspace.id, null).length, 0);
    } finally { ctx.cleanup(); }
  });

  test("a deleted or blanked file proposes nothing and leaves the stored value alone", () => {
    const ctx = fixture({ claudeMd: "# original", agentsMd: "# agents" });
    try {
      materialize(ctx.workspace);
      unlinkSync(ctx.claude);
      writeFileSync(ctx.agents, "   \n");
      // Proposing an empty file would invite the operator to disarm every later
      // run in this workspace, which is never what deleting one file meant.
      assert.equal(proposeFromWorkingTree(ctx.workspace.id, null).length, 0);
      assert.equal(ctx.reload().claudeMd, "# original");
    } finally { ctx.cleanup(); }
  });

  test("a file found where the workspace has no text is proposed but not removed", () => {
    const ctx = fixture();
    try {
      writeFileSync(ctx.claude, "# the user's own file\n");
      const [proposal] = proposeFromWorkingTree(ctx.workspace.id, null);
      assert.equal(proposal!.content, "# the user's own file");
      assert.equal(readFileSync(ctx.claude, "utf8"), "# the user's own file\n", "materialize never deletes a file, and neither does this");
    } finally { ctx.cleanup(); }
  });

  test("a restore brings back a previous version and keeps the one it displaced", () => {
    const ctx = fixture({ claudeMd: "# v1" });
    try {
      workspaces.update(ctx.workspace.id, { claudeMd: "# v2" });
      const [first] = workspaces.workspaceRevisions(ctx.workspace.id, "claudeMd");
      workspaces.restoreWorkspaceRevision(ctx.workspace.id, first!.id);
      assert.equal(ctx.reload().claudeMd, "# v1");
      assert.equal(workspaces.workspaceRevisions(ctx.workspace.id, "claudeMd")[0]!.content, "# v2");
    } finally { ctx.cleanup(); }
  });
});

describe("instruction proposals", () => {
  test("applying writes the proposed text and keeps the replaced text as a revision", () => {
    const ctx = fixture({ agentsMd: "# before" });
    try {
      const opened = workspaces.createInstructionProposal({ workspaceId: ctx.workspace.id, field: "agentsMd", goal: "tighten it" });
      assert.equal(opened.content, "# before", "a new proposal starts as the stored text");
      workspaces.saveInstructionProposal(opened.id, { content: "# after\n" });
      const applied = workspaces.applyInstructionProposal(opened.id);

      assert.equal(applied.proposal.state, "APPLIED");
      assert.equal(ctx.reload().agentsMd, "# after");
      const [revision] = workspaces.workspaceRevisions(ctx.workspace.id, "agentsMd");
      assert.equal(revision!.content, "# before");
      assert.match(revision!.reason, /Applied proposal/);
      assert.throws(() => workspaces.saveInstructionProposal(opened.id, { content: "again" }), /already applied/);
    } finally { ctx.cleanup(); }
  });

  test("applying over a file that changed since is refused unless forced", () => {
    const ctx = fixture({ claudeMd: "# v1" });
    try {
      const proposal = workspaces.createInstructionProposal({ workspaceId: ctx.workspace.id, field: "claudeMd", goal: "g" });
      workspaces.saveInstructionProposal(proposal.id, { content: "# proposed" });
      workspaces.update(ctx.workspace.id, { claudeMd: "# someone else's v2" });
      assert.throws(() => workspaces.applyInstructionProposal(proposal.id), (error: Error & { code?: string }) => error.code === "instructions_changed");
      assert.equal(ctx.reload().claudeMd, "# someone else's v2");
      workspaces.applyInstructionProposal(proposal.id, { force: true });
      assert.equal(ctx.reload().claudeMd, "# proposed");
    } finally { ctx.cleanup(); }
  });

  test("a proposal that would empty a file is refused", () => {
    const ctx = fixture({ claudeMd: "# rules" });
    try {
      const proposal = workspaces.createInstructionProposal({ workspaceId: ctx.workspace.id, field: "claudeMd", goal: "g" });
      workspaces.saveInstructionProposal(proposal.id, { content: "" });
      assert.throws(() => workspaces.applyInstructionProposal(proposal.id), (error: Error & { code?: string }) => error.code === "proposal_empty");
    } finally { ctx.cleanup(); }
  });

  test("a requested run's edit is captured into its proposal and the file is put back", () => {
    const ctx = fixture({ claudeMd: "# stored" });
    try {
      materialize(ctx.workspace);
      const before = readInstructionFile(ctx.dir, "claudeMd");
      const proposal = workspaces.createInstructionProposal({ workspaceId: ctx.workspace.id, field: "claudeMd", goal: "add a rule" });
      writeFileSync(ctx.claude, "# stored\n\n- new rule\n");
      captureInstructionRun(proposal.id, ctx.dir, "claudeMd", before);

      assert.equal(workspaces.instructionProposal(proposal.id).content, "# stored\n\n- new rule");
      assert.equal(readFileSync(ctx.claude, "utf8"), "# stored\n");
      assert.equal(ctx.reload().claudeMd, "# stored");
    } finally { ctx.cleanup(); }
  });

  test("a file a requested run created from nothing is removed again once captured", () => {
    const ctx = fixture();
    try {
      const proposal = workspaces.createInstructionProposal({ workspaceId: ctx.workspace.id, field: "agentsMd", goal: "write one" });
      writeFileSync(ctx.agents, "# brand new\n");
      captureInstructionRun(proposal.id, ctx.dir, "agentsMd", null);
      assert.equal(workspaces.instructionProposal(proposal.id).content, "# brand new");
      assert.equal(existsSync(ctx.agents), false);
    } finally { ctx.cleanup(); }
  });
});

describe("git-tracked projections", () => {
  test("a tracked file is reported rather than silently polluting git status", () => {
    const ctx = fixture({ claudeMd: "# rules" });
    const warnings: string[] = [];
    const original = console.error;
    try {
      execFileSync("git", ["init", "-q"], { cwd: ctx.dir });
      writeFileSync(ctx.claude, "committed version\n");
      execFileSync("git", ["add", "CLAUDE.md"], { cwd: ctx.dir });
      console.error = (...args: unknown[]) => { warnings.push(args.join(" ")); };
      materialize(ctx.workspace);
      // .gitignore cannot hide a tracked file, so the only honest move is to
      // say so and name the command — untracking is a change to the user's index.
      assert.ok(warnings.some((line) => /tracked by git/.test(line) && /git rm --cached CLAUDE\.md/.test(line)), warnings.join("\n"));
    } finally { console.error = original; ctx.cleanup(); }
  });

  test("an untracked file in a git repo is not reported", () => {
    const ctx = fixture({ claudeMd: "# rules" });
    const warnings: string[] = [];
    const original = console.error;
    try {
      execFileSync("git", ["init", "-q"], { cwd: ctx.dir });
      console.error = (...args: unknown[]) => { warnings.push(args.join(" ")); };
      materialize(ctx.workspace);
      assert.equal(warnings.filter((line) => /tracked by git/.test(line)).length, 0);
    } finally { console.error = original; ctx.cleanup(); }
  });
});
