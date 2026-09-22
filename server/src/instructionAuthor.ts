/**
 * What an instruction run is told.
 *
 * The run edits one file and nothing else. Most of the guarantee is not in this
 * text — the file is captured and restored when the run ends, so the workspace
 * only changes when the operator applies the proposal — but an agent that
 * understands that writes a better proposal: it edits the whole file into its
 * final shape rather than leaving notes for later.
 */

import { INSTRUCTION_FILE_NAMES, type WorkspaceInstructionField } from "@agent-console/shared";

export interface InstructionAuthorPromptArgs {
  workspace: { name: string; workDirectory: string; description: string };
  field: WorkspaceInstructionField;
  goal: string;
  /** False when the file does not exist yet and the agent creates it. */
  exists: boolean;
  /** The file on disk is an earlier proposal, not the stored text. */
  reworking: boolean;
  feedback: string | null;
}

const READERS: Record<WorkspaceInstructionField, string> = {
  claudeMd: "Claude Code loads it",
  agentsMd: "Codex, Cursor and Grok load it",
};

export function instructionAuthorPrompt(args: InstructionAuthorPromptArgs): string {
  const file = INSTRUCTION_FILE_NAMES[args.field];
  const other = INSTRUCTION_FILE_NAMES[args.field === "claudeMd" ? "agentsMd" : "claudeMd"];
  const state = !args.exists
    ? `./${file} does not exist yet. Create it.`
    : args.reworking
      ? `./${file} holds an earlier proposal for this same request, not the version currently in use. Improve it.`
      : `./${file} holds the version currently in use.`;
  return [
    `You are editing ${file} for the workspace "${args.workspace.name}" at ${args.workspace.workDirectory}.`,
    "",
    `${file} is the repository's standing instructions: ${READERS[args.field]} at the start of every agent run in this directory, and every subagent sees it.`,
    args.workspace.description.trim() === "" ? "" : `\n## About this workspace\n\n${args.workspace.description.trim()}\n`,
    "## What the operator asked for",
    "",
    args.goal === "" ? "(nothing recorded)" : args.goal,
    args.feedback === null ? "" : `\n## Feedback on the last proposal\n\n${args.feedback}\n`,
    "## How to do it",
    "",
    `- ${state}`,
    `- Edit ./${file} directly with your file tools. Read the repository as much as you need to get it right.`,
    `- Change only ./${file}. Do not create, edit or delete any other file, and do not run commands that modify the repository. ${other} is the counterpart for other agents; do not edit it — if the same change belongs there, say so at the end.`,
    "- Keep what is still true. Change what the request is about, and fix anything the request makes wrong elsewhere in the file. Do not pad it: every line costs every future run context.",
    `- When you stop, whatever ./${file} contains becomes a proposal that the operator reads as a diff and applies or discards. The file is then put back as it was, so leave it in its finished form, not half-edited.`,
    "- Finish with a short summary: what you changed, and why.",
    "",
  ].join("\n");
}
