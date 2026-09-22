/**
 * One way to ask an agent for something in a workspace.
 *
 * Every request is a target (what the agent should look at or change) and a
 * mode (what it is allowed to do about it). Which modes make sense depends on
 * the target, and that table lives here so the request bar and the server
 * refuse exactly the same combinations.
 *
 * Nothing a request produces changes the workspace by itself: `ask` is a
 * read-only consult, and every other mode opens a proposal the operator applies.
 */

import type { WorkspaceInstructionField } from "./index";

export const INSTRUCTION_FILE_NAMES: Record<WorkspaceInstructionField, string> = {
  claudeMd: "CLAUDE.md",
  agentsMd: "AGENTS.md",
};

export function isInstructionField(value: unknown): value is WorkspaceInstructionField {
  return value === "claudeMd" || value === "agentsMd";
}

/* -------------------------------------------------------------------------- */
/* Instruction proposals                                                      */
/* -------------------------------------------------------------------------- */

export const INSTRUCTION_PROPOSAL_STATES = ["PENDING", "APPLIED", "DISCARDED"] as const;
export type InstructionProposalState = (typeof INSTRUCTION_PROPOSAL_STATES)[number];

/**
 * Where a proposal came from.
 *
 * `request` was asked for from the request bar. `run` was found in the working
 * tree after a run edited the file on its own; it is held for review the same
 * way instead of being written into the workspace silently.
 */
export type InstructionProposalOrigin = "request" | "run";

/** Same bound the workspace fields have. */
export const INSTRUCTION_CONTENT_MAX = 64000;

export interface InstructionProposalRecord {
  id: number;
  workspaceId: number;
  field: WorkspaceInstructionField;
  state: InstructionProposalState;
  origin: InstructionProposalOrigin;
  goal: string;
  /** The run writing it (`request`) or the run that made the edit (`run`). */
  runId: string | null;
  /** The stored text when the proposal was opened. Apply refuses if it has moved. */
  baseline: string;
  /** The proposed text. Starts equal to `baseline` until an agent or the operator edits it. */
  content: string;
  createdAt: string;
  updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

export type AgentRequestTarget =
  | { kind: "workspace" }
  | { kind: "instructions"; field: WorkspaceInstructionField }
  /** A program, optionally narrowed to one suite or work item inside it. */
  | { kind: "program"; programId: number; suiteId?: number | null; promptId?: number | null }
  | { kind: "new-program" };

export const AGENT_REQUEST_MODES = ["ask", "change", "draft", "edit"] as const;
export type AgentRequestMode = (typeof AGENT_REQUEST_MODES)[number];

export const AGENT_REQUEST_MODE_LABELS: Record<AgentRequestMode, { label: string; action: string; hint: string }> = {
  ask: { label: "Ask", action: "Ask", hint: "Read-only. The agent answers and nothing is changed." },
  change: { label: "Change", action: "Propose changes", hint: "The agent writes a proposal. Nothing changes until you apply it." },
  draft: { label: "Draft", action: "Draft it", hint: "The agent drafts a new program. Nothing is created until you apply it." },
  edit: { label: "Edit myself", action: "Open a proposal", hint: "Opens a proposal for you to edit by hand, without an agent." },
};

/**
 * Why a mode cannot be used on a target, or null when it can.
 *
 * The reason is the tooltip on a disabled mode, so it says what to pick instead.
 */
export function agentRequestModeBlock(target: AgentRequestTarget, mode: AgentRequestMode): string | null {
  switch (target.kind) {
    case "workspace":
      return mode === "ask" ? null : "Pick a file or a program to change. To do work in the repository, run a work item.";
    case "instructions":
    case "program":
      return mode === "draft" ? "Draft makes a new program. Use Change for something that already exists." : null;
    case "new-program":
      return mode === "ask" || mode === "change" ? "There is nothing to ask about or change yet. Use Draft." : null;
  }
}

export function allowedAgentRequestModes(target: AgentRequestTarget): AgentRequestMode[] {
  return AGENT_REQUEST_MODES.filter((mode) => agentRequestModeBlock(target, mode) === null);
}

export interface AgentRequest {
  target: AgentRequestTarget;
  mode: AgentRequestMode;
  text: string;
  /** Required for every mode except `edit`. */
  provider?: string;
  model?: string | null;
}

export const AGENT_REQUEST_TEXT_MAX = 16000;

const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const optionalId = (value: unknown): value is number | null | undefined => value === undefined || value === null || positiveId(value);

/** Parses a request body. Checks shape and the mode table; ids are resolved by the server. */
export function normalizeAgentRequest(input: unknown): { ok: true; value: AgentRequest } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const raw = (input ?? {}) as Record<string, unknown>;
  const rawTarget = (raw.target ?? {}) as Record<string, unknown>;
  let target: AgentRequestTarget | null = null;
  switch (rawTarget.kind) {
    case "workspace":
    case "new-program":
      target = { kind: rawTarget.kind };
      break;
    case "instructions":
      if (isInstructionField(rawTarget.field)) target = { kind: "instructions", field: rawTarget.field };
      else errors.target = "Choose CLAUDE.md or AGENTS.md";
      break;
    case "program":
      if (positiveId(rawTarget.programId) && optionalId(rawTarget.suiteId) && optionalId(rawTarget.promptId)) {
        target = { kind: "program", programId: rawTarget.programId, suiteId: rawTarget.suiteId ?? null, promptId: rawTarget.promptId ?? null };
      } else errors.target = "Program, suite and work item ids must be positive integers";
      break;
    default:
      errors.target = "Choose what the request is about";
  }
  const mode = raw.mode;
  if (!(AGENT_REQUEST_MODES as readonly unknown[]).includes(mode)) errors.mode = "Choose ask, change, draft or edit";
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (text === "") errors.text = "Say what you want";
  else if (text.length > AGENT_REQUEST_TEXT_MAX) errors.text = `At most ${AGENT_REQUEST_TEXT_MAX} characters`;
  if (target !== null && errors.mode === undefined) {
    const blocked = agentRequestModeBlock(target, mode as AgentRequestMode);
    if (blocked !== null) errors.mode = blocked;
  }
  if (mode !== "edit" && (typeof raw.provider !== "string" || raw.provider === "")) errors.provider = "Choose an agent";
  if (Object.keys(errors).length > 0 || target === null) return { ok: false, errors };
  return {
    ok: true,
    value: {
      target,
      mode: mode as AgentRequestMode,
      text,
      ...(typeof raw.provider === "string" && raw.provider !== "" ? { provider: raw.provider } : {}),
      model: typeof raw.model === "string" && raw.model !== "" ? raw.model : null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Line diff                                                                  */
/* -------------------------------------------------------------------------- */

export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
}

/** Past this many line pairs the table would be too large; the diff falls back to replace-all. */
const DIFF_CELL_LIMIT = 4_000_000;

/**
 * A line diff for reviewing a proposed instruction file.
 *
 * Longest common subsequence over lines, after trimming the shared head and
 * tail so the table only covers the region that actually changed.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ kind: "same", text }));

  if ((midA.length + 1) * (midB.length + 1) > DIFF_CELL_LIMIT) {
    for (const text of midA) out.push({ kind: "removed", text });
    for (const text of midB) out.push({ kind: "added", text });
  } else {
    const n = midA.length;
    const m = midB.length;
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * width + j] = midA[i] === midB[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { out.push({ kind: "same", text: midA[i]! }); i += 1; j += 1; }
      else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) { out.push({ kind: "removed", text: midA[i]! }); i += 1; }
      else { out.push({ kind: "added", text: midB[j]! }); j += 1; }
    }
    while (i < n) { out.push({ kind: "removed", text: midA[i]! }); i += 1; }
    while (j < m) { out.push({ kind: "added", text: midB[j]! }); j += 1; }
  }

  for (const text of a.slice(a.length - tail)) out.push({ kind: "same", text });
  return out;
}

export function diffLineCounts(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "added") added += 1;
    else if (line.kind === "removed") removed += 1;
  }
  return { added, removed };
}
