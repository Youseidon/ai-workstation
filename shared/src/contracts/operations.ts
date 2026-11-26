import type { ExecutionStatus } from "../models/executionPlan.ts";
import type { PromptOption, WorkspaceRecord } from "./workspaces.ts";
import type { PromptOperationalState, PromptPipelineRule, SuitePipelineDefaults, SuitePipelineRun } from "./pipeline.ts";
import type { CompletionAuditRecord } from "./completionAudit.ts";
import type { StatusDefinition, StepDisplayStatus } from "../models/statusModel.ts";
import type { SuiteVerificationBadge } from "./verification.ts";
import type { RunRole } from "./providers.ts";
import type { PipelinePolicy } from "../policies/pipelineRules.ts";

export interface OperationsPrompt {
  execution?: import("../models/executionPlan.ts").ExecutionStatus | null;
  prompt: PromptOption;
  workspace: Pick<WorkspaceRecord,"id"|"name"|"workDirectory"|"workDirectoryExists">;
  programKey: string|null;
  suiteKey: string|null;
  operationalState: PromptOperationalState;
  attention: boolean;
  latestIntervention: string|null;
  /** Dynamically created when an agent posts BLOCKED with a required human action. */
  humanIntervention: HumanInterventionStep | null;
  lastActivityAt: string;
  sessionCount: number;
  /** Newest completion audit for this station, when one has ever run. */
  latestAudit: CompletionAuditRecord | null;
  /**
   * Latest continuation attempt for this station since the operator last
   * intervened, from the ledger's `continuation` evidence. Null when none.
   */
  continuation: { attempt: number; of: number } | null;
  /** Always present; missing DB rows are filled with defaults. */
  pipelineRule: PromptPipelineRule;
  /**
   * Sub-steps this prompt spawned by decomposing itself, in run order. Empty
   * for an ordinary prompt; a sub-step may decompose once more, so this nests
   * at most two levels below a station. Never a pipeline "step" on its own —
   * the outer flowchart never lists these, though a pipeline can still pin an
   * agent on one (see `PipelineSubStepRule`).
   */
  children: OperationsPrompt[];
  /**
   * The worst outcome among this item's descendants, or null when none of them
   * needs anything.
   *
   * Derived on every read, never stored. A parent's own status is deliberately
   * left alone: after a decompose, once every sub-step is done, a fresh run
   * resumes the *parent* to do final integration and post its own outcome.
   * Overwriting the parent's status from its children would take that decision
   * away from the agent that is about to make it — and would put a status on
   * the item that nothing had actually established about it.
   *
   * So this is a separate signal. It answers "is there trouble underneath me"
   * without claiming anything about the parent's own work. Without it a parent
   * with a failed child sits at "Waiting", which is true and useless.
   */
  childAttention: StepDisplayStatus | null;
  /** How many descendants are in that state, so the badge can say "2 failed". */
  childAttentionCount: number;
}

export interface HumanInterventionStep {
  id: string;
  promptId: number;
  requiredAction: string;
  status: "PENDING" | "COMPLETE";
  requestedAt: string;
  response: string | null;
  completedAt: string | null;
}
export interface OperationsSuite {
  id: number;
  key: string|null;
  name: string;
  programId: number;
  programKey: string|null;
  programName: string;
  workspaceId: number;
  workspaceName: string;
  counts: Record<PromptOperationalState,number>;
  attentionCount: number;
  prompts: OperationsPrompt[];
  sessions: OperationsSession[];
  /** The most recent verification of this suite, for the badge. Null if never. */
  latestVerification: SuiteVerificationBadge | null;
  pipeline: {
    defaults: SuitePipelineDefaults;
    active: SuitePipelineRun | null;
    latest: SuitePipelineRun | null;
  } | null;
}
export interface OperationsSession { id:string; workspaceId:number; promptId:number|null; promptKey:string|null; promptTitle:string; provider:string; model:string|null; role:RunRole; state:string; startedAt:string; endedAt:string|null }
export interface OperationsSnapshot {
  generatedAt:string;
  suites:OperationsSuite[];
  policy:PipelinePolicy;
  /**
   * The status catalog as the operator has it: shipped defaults with their
   * edits applied. Shipped with the snapshot for the same reason `policy` is —
   * so the board and the server decide what a state is called, and what it
   * means, from the same values.
   */
  statusCatalog:StatusDefinition[];
  /** The operator's sentence for each cause, over the shipped defaults. */
  triggerSentences:Record<string,string>;
}
