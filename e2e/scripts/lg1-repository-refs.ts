import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const remote = process.argv[2];
if (!remote) throw new Error("usage: npx tsx e2e/scripts/lg1-repository-refs.ts <repository-url>");
const root = mkdtempSync(join(tmpdir(), "ai-workstation-lg1-"));
const ref = `refs/aw/lg1/${Date.now()}`;
const handover = `refs/heads/aw/handover/lg1-${Date.now()}`;

try {
  const a = join(root, "a");
  const b = join(root, "b");
  git(root, "clone", "-q", remote, a);
  git(root, "clone", "-q", remote, b);
  for (const dir of [a, b]) {
    git(dir, "config", "user.name", "ai-workstation LG-1");
    git(dir, "config", "user.email", "lg1@example.invalid");
  }
  commit(a, "a.txt", "A\n", "LG-1 initial");
  git(a, "push", "origin", `HEAD:${ref}`);
  git(b, "fetch", "-q", "origin", ref);
  commit(b, "b.txt", "B\n", "LG-1 divergent");
  const divergent = run(b, ["push", "origin", `HEAD:${ref}`]);
  if (divergent.status === 0) throw new Error("non-fast-forward custom ref update was accepted");
  git(a, "push", "origin", `HEAD:${handover}`);
  console.log(JSON.stringify({ result: "PASS", ref, handover, nonFastForwardRejected: true }));
} finally {
  const cleanup = run(root, ["git", "push", remote, `:${ref}`, `:${handover}`]);
  if (cleanup.status !== 0) console.error(`LG-1 cleanup failed for ${ref} and ${handover}`);
  rmSync(root, { recursive: true, force: true });
}

function commit(dir: string, path: string, content: string, message: string): void {
  writeFileSync(join(dir, path), content);
  git(dir, "add", path);
  git(dir, "commit", "-q", "-m", message);
}

function git(dir: string, ...args: string[]): void {
  const result = run(dir, ["git", ...args]);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function run(dir: string, args: string[]) {
  return spawnSync(args[0]!, args.slice(1), { cwd: dir, encoding: "utf8" });
}
