import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workspaceGitContext } from "../src/workspaceGit.ts";

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("reports a live branch and whether its working tree has changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-git-"));
  try {
    git(dir, "init", "-b", "feature/beacon");
    writeFileSync(join(dir, "tracked.txt"), "first\n");
    git(dir, "add", "tracked.txt");
    git(dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial");

    const clean = workspaceGitContext(dir);
    assert.equal(clean.state, "ready");
    assert.equal(clean.branch, "feature/beacon");
    assert.match(clean.head ?? "", /^[0-9a-f]{8}$/);
    assert.equal(clean.dirty, false);

    writeFileSync(join(dir, "untracked.txt"), "change\n");
    assert.equal(workspaceGitContext(dir).dirty, true);

    git(dir, "checkout", "--detach");
    const detached = workspaceGitContext(dir);
    assert.equal(detached.state, "detached");
    assert.equal(detached.branch, null);
    assert.equal(detached.head, clean.head);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("distinguishes a plain directory from an unavailable one", () => {
  const dir = mkdtempSync(join(tmpdir(), "workspace-no-git-"));
  try {
    assert.equal(workspaceGitContext(dir).state, "not_repository");
    assert.equal(workspaceGitContext(join(dir, "missing")).state, "unavailable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
