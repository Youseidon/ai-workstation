import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceRecord } from "@agent-console/shared";
import { createLogger } from "./lib/logger.ts";
import { workspaces } from "./workspaces.ts";

const log = createLogger("instructions");

/**
 * Repo-level instruction files are owned by the workspace, but they have to
 * exist on disk to do their job.
 *
 * A provider CLI loads these itself — Claude Code resolves CLAUDE.md through
 * `--setting-sources`, codex/cursor/grok look for AGENTS.md — and only a real
 * file reaches a spawned subagent, survives a context compaction, and takes
 * part in nested per-directory loading. The same text pasted into a run's
 * prompt gets none of that: it is user-turn content that a 500-turn run will
 * summarise away and a subagent will never see.
 *
 * So the database stays the source of truth and these files are its projection,
 * rewritten before every run and read back after one that could have edited
 * them.
 *
 * Claude Code reads only CLAUDE.md; codex, cursor and grok read only AGENTS.md.
 * Neither file substitutes for the other, which is why both are kept.
 */
const FILES = [
  { field: "claudeMd", name: "CLAUDE.md" },
  { field: "agentsMd", name: "AGENTS.md" },
] as const;

const GITIGNORE_MARKER = "# Written by the agent console from the workspace record";

/**
 * Keeps the projected files out of `git status`.
 *
 * R4 makes git the user's: a run that leaves two untracked files behind would
 * show up in every `git status` an agent runs and read as uncommitted work.
 */
function ensureIgnored(workDirectory: string): void {
  const path = join(workDirectory, ".gitignore");
  try {
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (current.includes(GITIGNORE_MARKER)) return;
    const missing = FILES.map((file) => `/${file.name}`).filter((entry) => {
      const bare = entry.slice(1);
      return !current.split(/\r?\n/).some((line) => line.trim() === entry || line.trim() === bare);
    });
    if (missing.length === 0) return;
    const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
    appendFileSync(path, `${prefix}\n${GITIGNORE_MARKER}\n${missing.join("\n")}\n`);
  } catch (error) {
    log.warn(`could not update .gitignore in ${workDirectory}`, error);
  }
}

/** Warned-about paths, so a per-run check does not become a per-run log line. */
const warnedTracked = new Set<string>();

/**
 * `.gitignore` has no effect on a file git already tracks, so a projected file
 * that is still in the index shows up as a modification in every `git status`
 * an agent runs — the exact noise the ignore entry exists to prevent.
 *
 * Untracking it is a change to the user's index, and R4 makes git theirs, so
 * this reports the problem and the command rather than fixing it.
 */
function warnIfTracked(workDirectory: string, name: string): void {
  const key = join(workDirectory, name);
  if (warnedTracked.has(key)) return;
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", name], { cwd: workDirectory, stdio: "ignore" });
  if (result.status !== 0) return;
  warnedTracked.add(key);
  log.warn(`${name} is tracked by git in ${workDirectory}, so .gitignore cannot hide it and every git status will show it as modified. Untrack it with: git rm --cached ${name}`);
}

/**
 * Writes the workspace's instruction files into its working tree.
 *
 * An empty field writes nothing and never deletes: removing a file the user or
 * another tool put there is not this function's call to make.
 */
export function materialize(workspace: Pick<WorkspaceRecord, "workDirectory" | "claudeMd" | "agentsMd">): void {
  if (!existsSync(workspace.workDirectory)) return;
  let wrote = false;
  for (const file of FILES) {
    const content = workspace[file.field];
    if (content.trim() === "") continue;
    const path = join(workspace.workDirectory, file.name);
    const body = content.endsWith("\n") ? content : `${content}\n`;
    try {
      if (existsSync(path) && readFileSync(path, "utf8") === body) continue;
      writeFileSync(path, body, "utf8");
      wrote = true;
      log.info(`wrote ${file.name} (${body.length} chars)`);
      warnIfTracked(workspace.workDirectory, file.name);
    } catch (error) {
      log.warn(`could not write ${file.name}`, error);
    }
  }
  if (wrote) ensureIgnored(workspace.workDirectory);
}

/**
 * Folds an agent's edits to those files back into the workspace record.
 *
 * A deleted file is left alone rather than blanking the field: an agent that
 * removes CLAUDE.md has almost certainly not decided the workspace should have
 * no instructions, and a blank field would silently disarm every later run.
 */
export function readBack(workspaceId: number): void {
  let workspace: WorkspaceRecord;
  try {
    workspace = workspaces.get(workspaceId);
  } catch {
    return;
  }
  if (!existsSync(workspace.workDirectory)) return;
  const patch: Record<string, unknown> = {};
  for (const file of FILES) {
    const path = join(workspace.workDirectory, file.name);
    if (!existsSync(path)) continue;
    try {
      const onDisk = readFileSync(path, "utf8");
      const stored = workspace[file.field];
      const normalized = stored.endsWith("\n") || stored === "" ? stored : `${stored}\n`;
      if (onDisk === normalized || onDisk.trim() === "") continue;
      patch[file.field] = onDisk;
    } catch (error) {
      log.warn(`could not read ${file.name}`, error);
    }
  }
  if (Object.keys(patch).length === 0) return;
  try {
    workspaces.update(workspaceId, { ...patch, actorType: "AGENT", reason: "Edited in the working tree during a run" });
    log.info(`read back ${Object.keys(patch).join(", ")} from ${workspace.workDirectory}`);
  } catch (error) {
    log.warn("could not store instruction edits", error);
  }
}
