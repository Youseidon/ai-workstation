/** Public package boundary. Internal modules import their dependencies directly. */
export type { UserIdentity, IdentitySession } from "./contracts/identity.ts";
export {
  PROVIDER_IDS,
  isProviderId,
  RUN_ROLES,
  isRunRole,
  USAGE_WINDOW_KINDS,
} from "./contracts/providers.ts";
export type {
  ProviderId,
  RunRole,
  ProviderInfo,
  ProviderUpdateResult,
  UsageWindowKind,
  ProviderUsageWindow,
  ProviderUsageCredits,
  ProviderUsage,
} from "./contracts/providers.ts";
export {
  MODEL_ACCESS_TIERS,
  MODEL_SELECTION_MODES,
  REASONING_EFFORTS,
  isReasoningEffort,
  isModelSelectionMode,
  MODEL_ACCESS_TIER_INFO,
  isModelAccessTier,
  classifyModel,
  modelFamily,
  modelAllowedInTier,
  bakedModelEffort,
  modelMatchesEffort,
  eligibleModels,
  recommendedModel,
  automaticModel,
  MODEL_POOLS,
  MODEL_POOL_LABEL,
  MODEL_CATALOG,
  modelLabel,
  modelPool,
  isCustomModel,
} from "./models/modelCatalog.ts";
export type {
  ModelOption,
  ModelAccessTier,
  ClassifiedModelTier,
  ModelSelectionMode,
  ReasoningEffort,
  ModelAccessTierInfo,
  BakedModelEffort,
  ModelPool,
} from "./models/modelCatalog.ts";
export { emptyUsage, isMeaningfulUsage, mergeUsage, usageFromEvents } from "./models/tokenUsage.ts";
export type { TokenUsage } from "./models/tokenUsage.ts";
export {
  ratesForModel,
  estimateCost,
  billableInputTokens,
  inputTokenAllowance,
  formatUsd,
  USAGE_REPORT_PRICING_NOTE,
  emptyUsageTotals,
  addUsageToTotals,
} from "./models/cost.ts";
export type { TokenRates, CostEstimate, UsageTotals } from "./models/cost.ts";
export type { SessionUsageRow, TaskUsageRow, SuiteUsageRow, UsageReport } from "./contracts/usageReport.ts";
export type {
  RunState,
  AssistantTextPayload,
  ToolUsePayload,
  ToolResultPayload,
  StatusPayload,
  ResultPayload,
  ErrorPayload,
  DbAccessPayload,
  AgentQuestionKind,
  AgentQuestionOption,
  AgentQuestion,
  AgentInputRequestPayload,
  AgentInputAnswer,
  AgentInputResponsePayload,
  RunMessageDelivery,
  RunMessageState,
  RunMessage,
  OperatorMessagePayload,
  AgentMessagePayload,
  NormalizedEvent,
  NormalizedEventType,
  AdapterEvent,
} from "./contracts/events.ts";
export type {
  SettingType,
  SettingValue,
  SettingOption,
  SettingUnit,
  SettingScale,
  SettingField,
  SettingsSnapshot,
  SettingsPatch,
} from "./contracts/settings.ts";
export { formatSettingValue } from "./utils/settings.ts";
export type {
  PromptRecord,
  PromptStatus,
  SuiteRecord,
  ProgramRecord,
  WorkspaceRecord,
  WorkspaceGitContext,
  WorkspaceInstructionField,
  WorkspaceRevision,
  WorkspaceTree,
  PromptOption,
  PromptDependency,
  ProgramGate,
  RemarkKind,
  ActorType,
  PromptRemark,
  PromptStatusEvent,
  HumanInputRequest,
  ClarificationExchange,
} from "./contracts/workspaces.ts";
export type { PromptRunSummary, AgentRunActivity, AgentSession } from "./contracts/runs.ts";
export { RUN_CHANGE_STATES } from "./contracts/changes.ts";
export type {
  RunChangeState,
  RunChangeSummary,
  RunCommit,
  RunChangedFile,
  RunChangeDetail,
  RunFileDiff,
} from "./contracts/changes.ts";
export type { ChatThread, ChatThreadPage, ChatHistoryPage, ChatThreadPatch } from "./contracts/chat.ts";
export { conversationTitle } from "./utils/conversation.ts";
export {
  ON_DONE_ACTIONS,
  isOnDoneAction,
  ON_UNFINISHED_ACTIONS,
  isOnUnfinishedAction,
  PIPELINE_STATES,
  isPipelineState,
  defaultPromptPipelineRule,
} from "./contracts/pipeline.ts";
export type {
  PromptOperationalState,
  OnDoneAction,
  OnUnfinishedAction,
  PipelineState,
  PromptPipelineRule,
  PipelineAvailablePrompt,
  SuitePipelineDefaults,
  SuitePipelineRun,
  PipelineStage,
  PipelineRun,
  PipelineRecord,
  PipelineRunStage,
  PipelineRunDetail,
  PipelineSubStepRule,
  PipelineFlowchartView,
  PipelineDashboardSummary,
  PipelineDashboardItem,
  PipelineBlockedStation,
  PipelineThroughputDay,
  PipelineDashboard,
} from "./contracts/pipeline.ts";
export type {
  OperationsPrompt,
  HumanInterventionStep,
  OperationsSuite,
  OperationsSession,
  OperationsSnapshot,
} from "./contracts/operations.ts";
export type {
  SuiteVerificationVerdict,
  SuiteVerificationCheck,
  SuiteVerificationKind,
  SuiteVerificationState,
  SuiteVerificationItem,
  SuiteVerificationSummary,
  SuiteVerificationStats,
  SuiteVerificationRecord,
  SuiteVerificationDetail,
  SuiteVerificationBadge,
  SuiteVerificationContext,
  PromptActivity,
} from "./contracts/verification.ts";
export {
  COMPLETION_AUDIT_STATES,
  COMPLETION_VERDICTS,
  AUDIT_CHECK_RESULTS,
} from "./contracts/completionAudit.ts";
export type {
  CompletionAuditState,
  CompletionVerdict,
  AuditCheckResult,
  CompletionAuditCheck,
  CompletionAuditReport,
  CompletionAuditRecord,
} from "./contracts/completionAudit.ts";
export type { PromptImportPreview } from "./contracts/promptImport.ts";
export type { ApiErrorBody } from "./contracts/api.ts";
export type {
  ClientRunMessage,
  ClientInterruptMessage,
  ClientRefreshProvidersMessage,
  ClientPingMessage,
  ClientInputResponseMessage,
  ClientVerifySuiteMessage,
  ClientMessage,
  ServerHelloMessage,
  ServerProvidersMessage,
  ServerEventMessage,
  RunSource,
  ServerRunStartedMessage,
  RunSnapshot,
  ServerRunEndedMessage,
  ServerRunRejectedMessage,
  ServerPongMessage,
  ServerSettingsUpdatedMessage,
  ServerOperationsChangedMessage,
  ServerMessage,
} from "./contracts/websocket.ts";
export { formatElapsed, formatResetIn, formatTokens, oneLine } from "./utils/format.ts";

export {
  resolveStationPolicy,
  validateStationPolicy,
  stationPolicyMarkdown,
  type StationPolicy,
} from "./policies/stationPolicy.ts";

/*
 * The transport interlocking. Re-exported by name rather than with `export *`,
 * so the package's public surface is explicit and a new symbol has to be
 * declared here on purpose.
 */
export {
  CONTROL_LABEL,
  DEFAULT_PIPELINE_POLICY,
  PAUSE_MODES,
  PIPELINE_CONTROLS,
  STOP_REASON,
  TRANSITIONS,
  describeStopReason,
  matchTransition,
  onUnfinishedConsequence,
  onDoneConsequence,
  isRestartPolicy,
  RESTART_POLICIES,
} from "./policies/pipelineRules.ts";

export {
  COOLING_MINUTES,
  TRANSIENT_PATTERNS,
  classifyFailure,
  coolingMinutesFor,
} from "./policies/providerFailure.ts";

export type { FailureClass } from "./policies/providerFailure.ts";

export { exhaustedUsageWindow, quotaCoolingMinutes } from "./policies/providerFailure.ts";

/*
 * Re-exported by name rather than with `export *`.
 *
 * Node's ESM linker resolves the named exports of a `.ts` barrel before tsx has
 * transpiled the module it stars from, so `export *` links but exposes nothing —
 * every importer fails at runtime with "does not provide an export named …"
 * while `tsc` stays perfectly happy. Every other re-export in this file is
 * explicit for the same reason; keep it that way.
 */
export {
  DEFAULT_STATUS_CATALOG,
  DEFAULT_TRIGGER_SENTENCES,
  DOD_COMMAND_MAX_LENGTH,
  DOD_COMMAND_OUTPUT_MAX_BYTES,
  DOD_COMMAND_TIMEOUT_DEFAULT_MS,
  DOD_COMMAND_TIMEOUT_MAX_MS,
  DOD_COMMAND_TIMEOUT_MIN_MS,
  DOD_CRITERION_KINDS,
  DOD_ENFORCEMENTS,
  DOD_ENFORCEMENT_LABEL,
  DOD_KIND_HINT,
  DOD_KIND_LABEL,
  DOD_RESULTS,
  DOD_RESULT_SOURCES,
  DOD_SCOPES,
  DOD_SCOPE_LABEL,
  clampDodTimeout,
  dodUnmetEvidence,
  dodUnmetReason,
  isDodCriterionKind,
  isDodEnforcement,
  isDodResult,
  isDodResultSource,
  isDodScope,
  unmetCriteria,
  OVERLAY_STATUSES,
  STATUS_ICONS,
  STATUS_ON_ENTER,
  STATUS_TONES,
  STATUS_TRIGGERS,
  STEP_DISPLAY_STATUSES,
  STEP_NEXT_ACTIONS,
  STEP_SIGNALS,
  STEP_STATUSES,
  STEP_TRANSITIONS,
  defaultStatusDefinition,
  describeTrigger,
  isStatusIcon,
  isStatusOnEnter,
  isStatusTone,
  isStatusTrigger,
  isStepDisplayStatus,
  isStepSignal,
  isStepStatus,
  isTerminalDisplayStatus,
  matchStepTransition,
  needsAttention,
  rollupStatus,
  satisfiesDependency,
  statusDefinition,
  statusFieldEditable,
} from "./models/statusModel.ts";

export type {
  DefinitionOfDone,
  DodCriterion,
  DodCriterionKind,
  DodCriterionResult,
  DodEnforcement,
  DodEvaluation,
  DodResult,
  DodResultSource,
  DodScope,
  StatusDefinition,
  StatusEditableKey,
  StatusIcon,
  StatusOnEnter,
  StatusPolicy,
  StatusPolicyKey,
  StatusPresentation,
  StatusTrigger,
  StepDisplayStatus,
  StepNextAction,
  StepSignal,
  StepStatus,
  StepTransitionRow,
} from "./models/statusModel.ts";

export { parseVerifyBlock } from "./utils/verifyBlock.ts";

export type { VerifyBlockParse, VerifyCommand } from "./utils/verifyBlock.ts";

export {
  DRAFT_CONTENT_MAX,
  DRAFT_GOAL_MAX,
  DRAFT_KEY_PATTERN,
  DRAFT_MAX_PROMPTS,
  DRAFT_MAX_PROMPTS_PER_SUITE,
  DRAFT_MAX_SUITES,
  DRAFT_MIN_SUITES,
  DRAFT_NAME_MAX,
  DRAFT_NOTES_MAX,
  DRAFT_OVERVIEW_MAX,
  DRAFT_TITLE_MAX,
  PROGRAM_DRAFT_STATES,
  allPrompts,
  bodyFromProgramProposal,
  canApplyProgramDraft,
  countPrompts,
  draftLimits,
  emptyProgramDraftBody,
  isProgramDraftState,
  normalizeProgramDraftBody,
  normalizeProgramProposal,
  normalizeSuiteProposal,
  programDraftIssues,
  programDraftPreview,
  programKeyFrom,
  promptKeyAt,
  resolvedDependencies,
  suiteKeyAt,
  withSuiteProposal,
} from "./models/programDraft.ts";

export type {
  DraftLimits,
  DraftValidation,
  ProgramDraftBody,
  ProgramDraftGate,
  ProgramDraftPreview,
  ProgramDraftPrompt,
  ProgramDraftRecord,
  ProgramDraftState,
  ProgramDraftSuite,
  ProgramProposal,
  SuiteProposal,
} from "./models/programDraft.ts";

export {
  REVISION_MAX_CHANGES,
  REVISION_OPERATIONS,
  applyRevisionChanges,
  diffProgramRevision,
} from "./models/programRevision.ts";

export type {
  ProgramRevisionChange,
  RevisionChangeKind,
  RevisionOperation,
  RevisionResult,
} from "./models/programRevision.ts";

export {
  AGENT_REQUEST_MODES,
  AGENT_REQUEST_MODE_LABELS,
  AGENT_REQUEST_TEXT_MAX,
  INSTRUCTION_CONTENT_MAX,
  INSTRUCTION_FILE_NAMES,
  INSTRUCTION_PROPOSAL_STATES,
  agentRequestModeBlock,
  allowedAgentRequestModes,
  diffLineCounts,
  diffLines,
  isInstructionField,
  normalizeAgentRequest,
} from "./contracts/agentRequest.ts";

export type {
  AgentRequest,
  AgentRequestMode,
  AgentRequestTarget,
  DiffLine,
  InstructionProposalOrigin,
  InstructionProposalRecord,
  InstructionProposalState,
} from "./contracts/agentRequest.ts";

export type {
  PauseMode,
  PipelineControl,
  PipelinePolicy,
  PolicyKey,
  RestartPolicy,
  RuleContext,
  RulePolicy,
  StatusTone,
  TransitionRow,
} from "./policies/pipelineRules.ts";

export { validateExecutionPlan, validateExecutionPolicy } from "./models/executionPlan.ts";

export type {
  ExecutionPhase,
  ExecutionDesiredState,
  ExecutionPolicy,
  ContractCriterion,
  ExecutionUnit,
  ExecutionPlan,
  ExecutionStatus,
} from "./models/executionPlan.ts";
