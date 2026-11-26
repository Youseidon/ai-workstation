import type { StationPolicy } from "../policies/stationPolicy.ts";
import type { StatusTrigger, StepStatus } from "../models/statusModel.ts";
import type { AgentRunActivity, PromptRunSummary } from "./runs.ts";

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
  parentPromptId: number | null;
  childOrder: number;
}

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
  claudeMd: string;
  agentsMd: string;
}

export interface WorkspaceGitContext {
  state: "ready" | "detached" | "not_repository" | "unavailable";
  branch: string | null;
  head: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

/** One level of the server's filesystem, for picking a workspace directory. */
export interface DirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  home: string;
  entries: DirectoryEntry[];
  /** True when the listing was cut at the server's entry cap. */
  truncated: boolean;
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

export type RemarkKind = "PROGRESS" | "FINDING" | "DECISION_NEEDED" | "BLOCKER" | "VERIFICATION" | "COMPLETION" | "CONTINUATION" | "HUMAN_RESPONSE" | "AGENT_RESPONSE" | "OPERATOR_BRIEFING";
export type ActorType = "IMPORT" | "SYSTEM" | "AGENT" | "USER";

export interface PromptRemark { id:number; promptId:number; runId:string|null; kind:RemarkKind; content:string; actorType:ActorType; createdAt:string }
export interface PromptStatusEvent {
  id:number; promptId:number; runId:string|null;
  previousStatus:PromptStatus; newStatus:PromptStatus;
  reason:string; verificationSummary:string;
  actorType:ActorType; createdAt:string;
  trigger:StatusTrigger|null;
  ruleId:string|null;
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
