import type { StepDisplayStatus } from "../models/statusModel.ts";
import type { ProviderId } from "./providers.ts";
import type { PipelinePolicy } from "../policies/pipelineRules.ts";
import type { PromptStatus } from "./workspaces.ts";

export type PromptOperationalState = StepDisplayStatus;

export const ON_DONE_ACTIONS = ["continue", "stop", "skip_rest"] as const;
export type OnDoneAction = (typeof ON_DONE_ACTIONS)[number];
export function isOnDoneAction(value: unknown): value is OnDoneAction {
  return typeof value === "string" && (ON_DONE_ACTIONS as readonly string[]).includes(value);
}

export const ON_UNFINISHED_ACTIONS = ["continue", "skip", "wait"] as const;
export type OnUnfinishedAction = (typeof ON_UNFINISHED_ACTIONS)[number];
export function isOnUnfinishedAction(value: unknown): value is OnUnfinishedAction {
  return typeof value === "string" && (ON_UNFINISHED_ACTIONS as readonly string[]).includes(value);
}

export const PIPELINE_STATES = ["PLAYING", "WAITING_HUMAN", "PAUSED", "COMPLETE", "STOPPED", "INTERRUPTED"] as const;
export type PipelineState = (typeof PIPELINE_STATES)[number];
export function isPipelineState(value: unknown): value is PipelineState {
  return typeof value === "string" && (PIPELINE_STATES as readonly string[]).includes(value);
}

export interface PromptPipelineRule {
  promptId: number;
  provider: ProviderId | null;
  model: string | null;
  fallbackProviders: ProviderId[];
  onDone: OnDoneAction;
  onUnfinished: OnUnfinishedAction;
  enabled: boolean;
  stepOrder: number;
}

export function defaultPromptPipelineRule(
  promptId: number,
  policy?: Pick<PipelinePolicy, "defaultOnDone" | "defaultOnUnfinished">,
): PromptPipelineRule {
  return {
    promptId,
    provider: null,
    model: null,
    fallbackProviders: [],
    onDone: policy?.defaultOnDone ?? "continue",
    onUnfinished: policy?.defaultOnUnfinished ?? "continue",
    enabled: false,
    stepOrder: 0,
  };
}

export interface PipelineAvailablePrompt {
  id: number;
  title: string;
  externalKey: string | null;
  status: PromptStatus;
}

export interface SuitePipelineDefaults {
  suiteId: number;
  defaultProvider: ProviderId | null;
  defaultModel: string | null;
  defaultFallbackProviders: ProviderId[];
}

export interface SuitePipelineRun {
  id: string;
  suiteId: number;
  workspaceId: number;
  state: PipelineState;
  currentPromptId: number | null;
  currentRunId: string | null;
  playProvider: ProviderId | null;
  playModel: string | null;
  startedAt: string;
  endedAt: string | null;
  stopReason: string | null;
  waitReason: string | null;
  pipelineRunId: string | null;
}

export interface PipelineStage {
  suiteId: number;
  sortOrder: number;
  programId: number;
  programName: string;
  programKey: string | null;
  suiteName: string;
  suiteKey: string | null;
  promptCount: number;
  stepCount: number;
  agentProviders: ProviderId[];
}

export interface PipelineRun {
  id: string;
  pipelineId: number;
  workspaceId: number;
  state: PipelineState;
  currentSuiteId: number | null;
  currentSuiteRunId: string | null;
  playProvider: ProviderId | null;
  playModel: string | null;
  startedAt: string;
  endedAt: string | null;
  stopReason: string | null;
  waitReason: string | null;
}

export interface PipelineRecord {
  id: number;
  workspaceId: number;
  workspaceName: string;
  name: string;
  description: string;
  autoReassign: boolean;
  createdAt: string;
  updatedAt: string;
  stages: PipelineStage[];
  active: PipelineRun | null;
  latest: PipelineRun | null;
}

export interface PipelineRunStage {
  suiteId: number;
  suiteName: string;
  programName: string;
  sortOrder: number;
  suiteRun: SuitePipelineRun | null;
}

export interface PipelineRunDetail extends PipelineRun {
  pipelineName: string;
  stages: PipelineRunStage[];
}

export interface PipelineSubStepRule {
  promptId: number;
  parentPromptId: number;
  depth: number;
  inherited: boolean;
  rule: PromptPipelineRule;
}

export interface PipelineFlowchartView {
  pipelineId: number;
  suiteId: number;
  defaults: SuitePipelineDefaults;
  steps: PromptPipelineRule[];
  available: PipelineAvailablePrompt[];
  rules: PromptPipelineRule[];
  subSteps: PipelineSubStepRule[];
  active: SuitePipelineRun | null;
  latest: SuitePipelineRun | null;
}

export interface PipelineDashboardSummary {
  pipelineCount: number;
  activePipelineCount: number;
  totalSteps: number;
  completedSteps: number;
  pendingSteps: number;
  attentionCount: number;
  runsLast7Days: number;
  avgRunDurationMs: number | null;
}

export interface PipelineDashboardItem {
  pipeline: PipelineRecord;
  completedSteps: number;
  totalSteps: number;
  attentionCount: number;
  lastRunDurationMs: number | null;
}

export interface PipelineBlockedStation {
  pipelineId: number;
  pipelineName: string;
  suiteId: number;
  suiteName: string;
  promptId: number;
  promptKey: string | null;
  promptTitle: string;
  operationalState: PromptOperationalState;
  latestIntervention: string | null;
}

export interface PipelineThroughputDay {
  date: string;
  complete: number;
  stopped: number;
  total: number;
}

export interface PipelineDashboard {
  generatedAt: string;
  summary: PipelineDashboardSummary;
  pipelines: PipelineDashboardItem[];
  blockedStations: PipelineBlockedStation[];
  throughput: PipelineThroughputDay[];
}
