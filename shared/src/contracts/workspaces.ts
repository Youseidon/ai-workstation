import type { StationPolicy } from "../policies/stationPolicy.ts";
import type { StatusTrigger, StepStatus } from "../models/statusModel.ts";
import type { AgentRunActivity, PromptRunSummary } from "./runs.ts";

/* -------------------------------------------------------------------------- */
/* Workspaces                                                                  */
/* -------------------------------------------------------------------------- */

export interface PromptRecord {
  stationPolicy?: StationPolicy | null;
  id: number;
  suiteId: number;
  title: string;
  content: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  externalKey: string | null;
  status: PromptStatus;
  completedAt: string | null;
  result: string;
  isGate: boolean;
  /** Set when this prompt was spawned by another prompt's decompose call. */
  parentPromptId: number | null;
  /** Run order among siblings under the same parent. Meaningless without a parent. */
  childOrder: number;
}

/**
 * The stored status of a work item.
 *
 * Defined in `statusModel`, which owns the whole vocabulary — the catalog that
 * gives each value a label and a set of consequences, the triggers that record
 * what caused a change, and the transition table that decides them. Aliased
 * here because most of the app knows this name.
 */
export type PromptStatus = StepStatus;

export interface SuiteRecord {
  id: number;
  programId: number;
  name: string;
  overview: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  prompts: PromptRecord[];
  externalKey: string | null;
}

export interface ProgramRecord {
  id: number;
  workspaceId: number;
  name: string;
  overview: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  suites: SuiteRecord[];
  externalKey: string | null;
}

export interface WorkspaceRecord {
  id: number;
  name: string;
  description: string;
  workDirectory: string;
  workDirectoryExists: boolean;
  createdAt: string;
  updatedAt: string;
  /**
   * Repo-level agent instruction files, owned by the workspace and written into
   * the working tree for every run. Claude Code reads only CLAUDE.md; codex,
   * cursor and grok read only AGENTS.md, so both are kept.
   */
  claudeMd: string;
  agentsMd: string;
}

/** Live Git identity for a workspace. This is read from disk, never persisted. */
export interface WorkspaceGitContext {
  state: "ready" | "detached" | "not_repository" | "unavailable";
  branch: string | null;
  /** The current commit, abbreviated by Git. Null for a repository with no commits yet. */
  head: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

export type WorkspaceInstructionField = "claudeMd" | "agentsMd";

export interface WorkspaceRevision {
  id: number;
  workspaceId: number;
  field: WorkspaceInstructionField | "description";
  content: string;
  actorType: string;
  reason: string;
  createdAt: string;
}

export interface WorkspaceTree extends WorkspaceRecord {
  programs: ProgramRecord[];
}

export interface PromptOption {
  id: number;
  title: string;
  content: string;
  suiteId: number;
  suiteName: string;
  programId: number;
  programName: string;
  externalKey: string | null;
  status: PromptStatus;
  ready: boolean;
  blockedBy: string[];
  currentRun: PromptRunSummary | null;
  recoverable: boolean;
  parentPromptId: number | null;
  childOrder: number;
}

export interface PromptDependency {
  promptId: number;
  dependsOnPromptId: number;
}

export interface ProgramGate {
  id: number;
  programId: number;
  promptId: number;
  code: string;
  name: string;
  description: string;
  sortOrder: number;
}

/**
 * `CONTINUATION` is written by the server, not posted by an agent: it is the
 * brief a run left for the run that resumes the same work item on the same
 * working tree, recorded from an `agent-step continue`.
 */
export type RemarkKind = "PROGRESS" | "FINDING" | "DECISION_NEEDED" | "BLOCKER" | "VERIFICATION" | "COMPLETION" | "CONTINUATION" | "HUMAN_RESPONSE" | "AGENT_RESPONSE" | "OPERATOR_BRIEFING";
/**
 * Who caused a change. Named rather than repeated inline: it is the field that
 * separates "the agent said so" from "the system concluded it" from "you did
 * it", which is the first thing an operator asks of a status they distrust.
 */
export type ActorType = "IMPORT" | "SYSTEM" | "AGENT" | "USER";

export interface PromptRemark { id:number; promptId:number; runId:string|null; kind:RemarkKind; content:string; actorType:ActorType; createdAt:string }
export interface PromptStatusEvent {
  id:number; promptId:number; runId:string|null;
  previousStatus:PromptStatus; newStatus:PromptStatus;
  reason:string; verificationSummary:string;
  actorType:ActorType; createdAt:string;
  /** What caused this change. Null only on rows written before the ledger existed. */
  trigger:StatusTrigger|null;
  /** The transition row that decided, when a rule did rather than a person. */
  ruleId:string|null;
  /** What backs the decision: verdicts, exit codes, failing criteria, child ids. */
  evidence:Record<string,unknown>|null;
}

export interface HumanInputRequest {
  prompt: PromptOption;
  workspace: Pick<WorkspaceRecord, "id" | "name" | "workDirectory" | "workDirectoryExists">;
  latestBlocker: PromptRemark | null;
  remarks: PromptRemark[];
  events: PromptStatusEvent[];
  clarifications: ClarificationExchange[];
  currentRun: AgentRunActivity | null;
}

export interface ClarificationExchange { id:number; promptId:number; question:string; answer:string|null; provider:string; model:string|null; state:"RUNNING"|"DONE"|"INTERRUPTED"|"ERROR"; createdAt:string; answeredAt:string|null }
