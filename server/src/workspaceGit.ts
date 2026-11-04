import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { WorkspaceGitContext } from "@agent-console/shared";

const EMPTY: Pick<WorkspaceGitContext, "branch" | "head" | "dirty" | "ahead" | "behind"> = {
  branch: null,
  head: null,
  dirty: false,
  ahead: 0,
  behind: 0,
};

/**
 * Reads branch, revision and working-tree state in one Git process. Porcelain
 * v2 is intended for machines, so this stays stable across Git versions and
 * avoids scraping the human-facing `git status` text.
 */
export function workspaceGitContext(workDirectory: string): WorkspaceGitContext {
  if (!existsSync(workDirectory)) return { state: "unavailable", ...EMPTY };

  const result = spawnSync(
    "git",
    ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
    {
      cwd: workDirectory,
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    },
  );

  // Some process sandboxes attach a warning to `error` even when Git ran and
  // returned usable output, so a successful exit status remains authoritative.
  if (result.status !== 0) {
    const stderr = result.stderr ?? "";
    return stderr.includes("not a git repository")
      ? { state: "not_repository", ...EMPTY }
      : { state: "unavailable", ...EMPTY };
  }

  let branch: string | null = null;
  let head: string | null = null;
  let ahead = 0;
  let behind = 0;
  let dirty = false;

  for (const line of (result.stdout ?? "").split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      branch = value === "(detached)" ? null : value;
    } else if (line.startsWith("# branch.oid ")) {
      const value = line.slice("# branch.oid ".length).trim();
      head = value === "(initial)" ? null : value.slice(0, 8);
    } else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match !== null) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (line !== "" && !line.startsWith("# ")) {
      dirty = true;
    }
  }

  return { state: branch === null ? "detached" : "ready", branch, head, dirty, ahead, behind };
}
