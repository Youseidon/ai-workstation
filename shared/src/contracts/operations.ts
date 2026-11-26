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
  humanIntervention: HumanInterventionStep | null;
  lastActivityAt: string;
  sessionCount: number;
  latestAudit: CompletionAuditRecord | null;
  continuation: { attempt: number; of: number } | null;
  pipelineRule: PromptPipelineRule;
  children: OperationsPrompt[];
  childAttention: StepDisplayStatus | null;
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
  statusCatalog:StatusDefinition[];
  triggerSentences:Record<string,string>;
}
