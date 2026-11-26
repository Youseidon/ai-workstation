import type { WorkspaceInstructionField } from "@hydra/shared";

export interface StartExecuteArgs {
  clientRequestId?: string;
  executionEffectId?: string;
  recoveryBrief?: string;
  reuseSavedSession?: boolean;
  freshContext?: boolean;
  workspaceId: number;
  provider: string;
  model: string | null;
  prompt?: string;
  promptId?: number;
  mode?: "execute" | "clarify";
  question?: string;
  resumeSessionId?: string;
  threadId?: string;
  pipelineRunId?: string;
  redirect?: { sessionId: string; text: string };
}

export interface StartConsultArgs {
  clientRequestId?: string;
  freshContext?: boolean;
  workspaceId: number;
  provider: string;
  model: string | null;
  prompt?: string;
  promptId?: number;
  question?: string;
  programId?: number;
  threadId?: string;
}

export interface StartProgramAuthorArgs {
  clientRequestId?: string;
  freshContext?: boolean;
  workspaceId: number;
  provider: string;
  model: string | null;
  goal?: string;
  draftId?: number;
  programId?: number;
  feedback?: string;
}

export interface StartInstructionAuthorArgs {
  clientRequestId?: string;
  freshContext?: boolean;
  workspaceId: number;
  provider: string;
  model: string | null;
  field?: WorkspaceInstructionField;
  goal?: string;
  proposalId?: number;
  feedback?: string;
}

export interface StartVerifySuiteArgs {
  suiteId: number;
  provider: string;
  model: string | null;
  promptId?: number | null;
}
