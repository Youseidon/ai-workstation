import type { StepDisplayStatus } from "../models/statusModel.ts";
import type { ProviderId } from "./providers.ts";
import type { PipelinePolicy } from "../policies/pipelineRules.ts";
import type { PromptStatus } from "./workspaces.ts";

/**
 * What a work item shows on a card: its stored status, unless a live overlay
 * (a running process, or an unmet prerequisite) describes it better.
 *
 * `AWAITING_RESPONSE` and `COMPLETE` are retained as aliases of `BLOCKED` and
 * `DONE` so that a status the operator relabels reads the same everywhere; the
 * set itself is `StepDisplayStatus`, defined in `statusModel`.
 */
export type PromptOperationalState = StepDisplayStatus;

export const ON_DONE_ACTIONS = ["continue", "stop", "skip_rest"] as const;
export type OnDoneAction = (typeof ON_DONE_ACTIONS)[number];
export function isOnDoneAction(value: unknown): value is OnDoneAction {
  return typeof value === "string" && (ON_DONE_ACTIONS as readonly string[]).includes(value);
}

/**
 * What a station rule does when a run ends without settling the work item —
 * every case the continuation loop can act on: `TODO`/`UNREPORTED`/`FAILED`/
 * `NEEDS_REVIEW`. `wait` parks immediately, `skip` marks the station SKIPPED
 * and carries on, and `continue` (the default) is the continuation loop
 * itself. An agent's own `continue` keeps re-queueing; crash / unreported /
 * verification-failed loops are capped at `pipelinePolicy.maxContinuations`
 * before a reviewer is sent and the rail parks.
 */
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
  /** Execute provider for this step. Null until the step is configured. */
  provider: ProviderId | null;
  model: string | null;
  /**
   * Ordered providers to try when the station's own provider cannot start or
   * dies before doing any work. Empty means "use the suite / house default".
   * Never includes the station's own provider.
   */
  fallbackProviders: ProviderId[];
  onDone: OnDoneAction;
  onUnfinished: OnUnfinishedAction;
  /** False until the prompt is added to the suite flowchart. */
  enabled: boolean;
  /** Sequence on the flowchart. Ignored when enabled is false. */
  stepOrder: number;
}

/**
 * The rule a station has before anyone configures it. `policy` supplies the
 * operator's chosen defaults; without it the built-in ones are used, which is
 * what a caller with no snapshot in hand (a test, a first paint) should get.
 */
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
  /** Ordered fallbacks when a station leaves its own list empty. */
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
  /**
   * Why a live run is parked on WAITING_HUMAN. Distinct from `stopReason`,
   * which means "why this run ended" — a waiting run has not ended.
   */
  waitReason: string | null;
  /** Named pipeline execution that launched this suite, when there is one. */
  pipelineRunId: string | null;
}

/**
 * A saved pipeline: an ordered set of suites in one workspace, played in
 * sequence. Distinct from a suite-stage run (`SuitePipelineRun`) and from a
 * single named execution (`PipelineRun`).
 */
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
  /** Suite lead and prompt overrides used in this pipeline stage. */
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
  /** Why a live run is parked on WAITING_HUMAN; see `SuitePipelineRun`. */
  waitReason: string | null;
}

export interface PipelineRecord {
  id: number;
  workspaceId: number;
  workspaceName: string;
  name: string;
  description: string;
  /** Opt in to switching providers when an account limit or outage is detected. */
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

/**
 * A sub-step spawned by a station decomposing itself, plus the rule the
 * scheduler will actually use for it. Sub-steps are never flowchart entries,
 * but a pipeline can still override the agent (and the blocked policy) for one
 * without touching its parent station.
 */
export interface PipelineSubStepRule {
  promptId: number;
  parentPromptId: number;
  /** Nesting depth below the station: 1 for a direct sub-step, 2 for its child. */
  depth: number;
  /** True while this sub-step has no override and simply follows its parent. */
  inherited: boolean;
  /** The effective rule — the parent's when `inherited`, the override otherwise. */
  rule: PromptPipelineRule;
}

/** Per-named-pipeline flowchart for one suite stage. */
export interface PipelineFlowchartView {
  pipelineId: number;
  suiteId: number;
  defaults: SuitePipelineDefaults;
  /** Enabled steps on this pipeline's flowchart, ordered by stepOrder. */
  steps: PromptPipelineRule[];
  /** Suite prompts not yet on this pipeline's flowchart. */
  available: PipelineAvailablePrompt[];
  rules: PromptPipelineRule[];
  /**
   * Effective rules for every sub-step under this stage's stations, in
   * depth-first order. Drives the nested sub-pipeline view.
   */
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

/** A pipeline step that needs operator attention (blocked, recovery, failed). */
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
  /** ISO date YYYY-MM-DD (UTC). */
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
