import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INSTRUCTION_FILE_NAMES, type InstructionProposalRecord, type WorkspaceInstructionField, type WorkspaceRecord } from "@hydra/shared";
import { createLogger } from "../../utils/logger.ts";
import { workspaces } from "../../repositories/workspaces.ts";

const log = createLogger("instructions");

const FILES = [
  { field: "claudeMd", name: "CLAUDE.md" },
  { field: "agentsMd", name: "AGENTS.md" },
] as const;

const GITIGNORE_MARKER = "# Written by the Hydra from the workspace record";

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

const warnedTracked = new Set<string>();

function warnIfTracked(workDirectory: string, name: string): void {
  const key = join(workDirectory, name);
  if (warnedTracked.has(key)) return;
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", name], { cwd: workDirectory, stdio: "ignore" });
  if (result.status !== 0) return;
  warnedTracked.add(key);
  log.warn(`${name} is tracked by git in ${workDirectory}, so .gitignore cannot hide it and every git status will show it as modified. Untrack it with: git rm --cached ${name}`);
}

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

export function instructionFilePath(workDirectory: string, field: WorkspaceInstructionField): string {
  return join(workDirectory, INSTRUCTION_FILE_NAMES[field]);
}

export function readInstructionFile(workDirectory: string, field: WorkspaceInstructionField): string | null {
  const path = instructionFilePath(workDirectory, field);
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch (error) {
    log.warn(`could not read ${INSTRUCTION_FILE_NAMES[field]}`, error);
    return null;
  }
}

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
