import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import { materialize, readBack } from "../src/workspaceInstructions.ts";
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

describe("reading instruction edits back", () => {
  test("an agent's edit on disk becomes the stored value, with the old text kept", () => {
    const ctx = fixture({ claudeMd: "# original" });
    try {
      materialize(ctx.workspace);
      writeFileSync(ctx.claude, "# rewritten by the agent\n");
      readBack(ctx.workspace.id);

      // Stored text is trimmed, as every text field here is; materialize
      // re-appends the newline, so the value round-trips without drifting.
      assert.equal(ctx.reload().claudeMd, "# rewritten by the agent");
      const revisions = workspaces.workspaceRevisions(ctx.workspace.id, "claudeMd");
      assert.equal(revisions[0]!.content, "# original");
      assert.equal(revisions[0]!.actorType, "AGENT");
    } finally { ctx.cleanup(); }
  });

  test("an unchanged file records nothing", () => {
    const ctx = fixture({ claudeMd: "# original" });
    try {
      materialize(ctx.workspace);
      const before = workspaces.workspaceRevisions(ctx.workspace.id).length;
      readBack(ctx.workspace.id);
      assert.equal(workspaces.workspaceRevisions(ctx.workspace.id).length, before);
    } finally { ctx.cleanup(); }
  });

  test("a deleted file leaves the stored value alone", () => {
    const ctx = fixture({ claudeMd: "# original" });
    try {
      materialize(ctx.workspace);
      unlinkSync(ctx.claude);
      readBack(ctx.workspace.id);
      // Blanking the field here would silently disarm every later run in this
      // workspace, which is never what deleting one file meant.
      assert.equal(ctx.reload().claudeMd, "# original");
    } finally { ctx.cleanup(); }
  });

  test("a file emptied to whitespace is treated as a deletion, not as new content", () => {
    const ctx = fixture({ claudeMd: "# original" });
    try {
      materialize(ctx.workspace);
      writeFileSync(ctx.claude, "   \n");
      readBack(ctx.workspace.id);
      assert.equal(ctx.reload().claudeMd, "# original");
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
