import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INSTRUCTION_FILE_NAMES, type InstructionProposalRecord, type WorkspaceInstructionField, type WorkspaceRecord } from "@agent-console/shared";
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
 * rewritten before every run. An edit a run makes to one is not read back into
 * the workspace: it becomes a proposal the operator applies.
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

/** Where a workspace's instruction file lives in its working tree. */
export function instructionFilePath(workDirectory: string, field: WorkspaceInstructionField): string {
  return join(workDirectory, INSTRUCTION_FILE_NAMES[field]);
}

/** The file as it is on disk, or null when there is none. */
export function readInstructionFile(workDirectory: string, field: WorkspaceInstructionField): string | null {
  const path = instructionFilePath(workDirectory, field);
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch (error) {
    log.warn(`could not read ${INSTRUCTION_FILE_NAMES[field]}`, error);
    return null;
  }
}

/** Puts the file back the way it was: rewritten, or removed if there was none. */
function restoreInstructionFile(workDirectory: string, field: WorkspaceInstructionField, before: string | null): void {
  const path = instructionFilePath(workDirectory, field);
  try {
    if (before === null) {
      if (existsSync(path)) unlinkSync(path);
    } else if (!existsSync(path) || readFileSync(path, "utf8") !== before) {
      writeFileSync(path, before, "utf8");
    }
  } catch (error) {
    log.warn(`could not restore ${INSTRUCTION_FILE_NAMES[field]}`, error);
  }
}

/**
 * Turns a run's edits to the instruction files into proposals.
 *
 * A run that rewrites CLAUDE.md changes what every later run is told, so the
 * edit is held for the operator the way any other proposal is, and the stored
 * text goes back on disk. Two cases leave the file alone rather than restore it:
 * a field with no stored text (the file may be the user's own, and materialize
 * never deletes one), and a file that was deleted or emptied (see below).
 *
 * The same text is not proposed twice: a proposal with identical content, in
 * any state, means the operator has already seen it — including one they
 * discarded.
 */
export function proposeFromWorkingTree(workspaceId: number, runId: string | null): InstructionProposalRecord[] {
  let workspace: WorkspaceRecord;
  try {
    workspace = workspaces.get(workspaceId);
  } catch {
    return [];
  }
  if (!existsSync(workspace.workDirectory)) return [];
  const proposed: InstructionProposalRecord[] = [];
  for (const file of FILES) {
    const onDisk = readInstructionFile(workspace.workDirectory, file.field);
    // A deleted or blanked file is not a proposal to empty the workspace's
    // instructions: an agent that removes CLAUDE.md has almost certainly not
    // decided every later run should go without it.
    if (onDisk === null || onDisk.trim() === "") continue;
    const content = onDisk.trim();
    const stored = workspace[file.field];
    if (content === stored) continue;
    try {
      if (workspaces.latestInstructionProposalWithContent(workspaceId, file.field, content) === null) {
        proposed.push(workspaces.createInstructionProposal({
          workspaceId,
          field: file.field,
          goal: stored === "" ? `${file.name} found in the working tree` : `${file.name} was edited during a run`,
          origin: "run",
          runId,
          content,
        }));
        log.info(`held an edit to ${file.name} in ${workspace.workDirectory} as a proposal`);
      }
    } catch (error) {
      log.warn(`could not propose the edit to ${file.name}`, error);
      continue;
    }
    if (stored !== "") restoreInstructionFile(workspace.workDirectory, file.field, `${stored}\n`);
  }
  return proposed;
}

/**
 * Stores what an instruction run left in its file, then puts the file back.
 *
 * `before` is the file as it was just before the run started. The run edits the
 * real file because that is the one it can read in context and edit with its
 * ordinary tools; the working tree is not where the proposal lives, so it is
 * returned to exactly what it was.
 */
export function captureInstructionRun(proposalId: number, workDirectory: string, field: WorkspaceInstructionField, before: string | null): void {
  const after = readInstructionFile(workDirectory, field);
  if (after !== null && after.trim() !== "" && after !== before) {
    try {
      workspaces.recordInstructionRunResult(proposalId, after);
    } catch (error) {
      log.warn(`could not store proposal ${proposalId}`, error);
    }
  }
  restoreInstructionFile(workDirectory, field, before);
}
