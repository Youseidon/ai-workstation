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
  /** Continue a provider-native custom chat session instead of starting cold. */
  resumeSessionId?: string;
  /** Provider-neutral Chat thread containing this custom turn. */
  threadId?: string;
  pipelineRunId?: string;
  /**
   * "Interrupt & deliver now": continue this saved item's interrupted provider
   * session with the operator's note instead of re-sending the whole context.
   */
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
  /** Ask about a whole program: its items, order, rules and pipelines. */
  programId?: number;
  threadId?: string;
}

export interface StartProgramAuthorArgs {
  clientRequestId?: string;
  freshContext?: boolean;
  workspaceId: number;
  provider: string;
  model: string | null;
  /** What the operator wants planned. Required for a new draft. */
  goal?: string;
  /** Revise an existing draft instead of opening one. */
  draftId?: number;
  /** Open a revision of this existing program instead of a new-program draft. */
  programId?: number;
  /** What the operator wants changed about that draft. */
  feedback?: string;
}

export interface StartInstructionAuthorArgs {
  clientRequestId?: string;
  freshContext?: boolean;
  workspaceId: number;
  provider: string;
  model: string | null;
  /** Open a new proposal for this file. */
  field?: WorkspaceInstructionField;
  /** What the operator wants changed. Required for a new proposal. */
  goal?: string;
  /** Rework an existing proposal instead of opening one. */
  proposalId?: number;
  /** What the operator wants changed about that proposal. */
  feedback?: string;
}

export interface StartVerifySuiteArgs {
  suiteId: number;
  provider: string;
  model: string | null;
  /** When set, verify only this work item inside the suite. */
  promptId?: number | null;
}
