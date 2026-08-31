/**
 * The single source of truth for everything that crosses the WebSocket boundary.
 *
 * Provider-specific shapes (SDKMessage, codex JSONL items, cursor-agent JSON, ...)
 * must be normalized into these types inside `server/src/adapters/*` and must never
 * leak into the transport layer or the frontend.
 */

export const PROVIDER_IDS = ["claude", "codex", "cursor", "grok"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

export const RUN_ROLES = ["execute", "consult"] as const;
export type RunRole = (typeof RUN_ROLES)[number];

export function isRunRole(value: unknown): value is RunRole {
  return typeof value === "string" && (RUN_ROLES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Model catalog                                                               */
/* -------------------------------------------------------------------------- */

export interface ModelOption {
  /**
   * Exactly what gets handed to the provider (`options.model` for the Agent
   * SDK, `-m <id>` for the CLIs). `null` means "send nothing and let the
   * provider pick", which is what an unset CLAUDE_MODEL/CODEX_MODEL/... does.
   */
  id: string | null;
  /** Short name for the chip that sits next to the provider label. */
  label: string;
  /** One-phrase positioning, shown in the dropdown. */
  hint: string;
}

/**
 * Curated per provider rather than probed: `codex` and `cursor-agent` have no
 * reliable "list models" command, and detection is on the hot path for every
 * provider refresh. Anything missing here can still be typed in as a custom id,
 * so a model released after this list was written is never unreachable.
 */
export const MODEL_CATALOG: Record<ProviderId, ModelOption[]> = {
  claude: [
    { id: null, label: "default", hint: "whatever the Agent SDK picks" },
    { id: "claude-opus-5", label: "opus 5", hint: "flagship" },
    { id: "claude-sonnet-5", label: "sonnet 5", hint: "balanced" },
    { id: "claude-haiku-4-5", label: "haiku 4.5", hint: "fast and cheap" },
    { id: "claude-opus-4-8", label: "opus 4.8", hint: "previous flagship" },
    { id: "claude-fable-5", label: "fable 5", hint: "most capable, priciest" },
  ],
  // Slugs taken from the codex CLI's own model cache (~/.codex/models_cache.json).
  codex: [
    { id: null, label: "default", hint: "whatever `codex exec` picks" },
    { id: "gpt-5.6-sol", label: "5.6 sol", hint: "frontier agentic coding" },
    { id: "gpt-5.6-terra", label: "5.6 terra", hint: "balanced everyday work" },
    { id: "gpt-5.6-luna", label: "5.6 luna", hint: "fast and affordable" },
    { id: "gpt-5.5", label: "5.5", hint: "previous frontier" },
    { id: "gpt-5.4", label: "5.4", hint: "strong everyday coding" },
    { id: "gpt-5.4-mini", label: "5.4 mini", hint: "small, cheap, simple tasks" },
  ],
  // cursor-agent exposes no model list; these are its documented short names.
  // Anything else goes through the custom field.
  cursor: [
    { id: null, label: "default", hint: "whatever cursor-agent picks" },
    { id: "auto", label: "auto", hint: "Cursor routes the request" },
    { id: "sonnet-4.5", label: "sonnet 4.5", hint: "Anthropic" },
    { id: "opus-4.1", label: "opus 4.1", hint: "Anthropic, slower" },
    { id: "gpt-5", label: "gpt-5", hint: "OpenAI" },
    { id: "grok", label: "grok", hint: "xAI" },
  ],
  // Reported by `grok models` on a logged-in CLI.
  grok: [
    { id: null, label: "default", hint: "whatever the grok CLI picks" },
    { id: "grok-4.6", label: "grok 4.6", hint: "current default" },
    { id: "grok-4.5", label: "grok 4.5", hint: "previous generation" },
  ],
};

/**
 * Display name for a model id: the catalog label when we know it, otherwise the
 * raw id (a custom entry the user typed in), and `null` when nothing is set.
 */
export function modelLabel(provider: ProviderId, modelId: string | null): string | null {
  if (modelId === null) return null;
  const known = MODEL_CATALOG[provider].find((option) => option.id === modelId);
  return known?.label ?? modelId;
}

/** True when `modelId` is not one of the catalog entries for that provider. */
export function isCustomModel(provider: ProviderId, modelId: string | null): boolean {
  if (modelId === null) return false;
  return !MODEL_CATALOG[provider].some((option) => option.id === modelId);
}

/* -------------------------------------------------------------------------- */
/* Provider detection                                                          */
/* -------------------------------------------------------------------------- */

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Whether a run can actually be started with this provider right now. */
  available: boolean;
  /** Human-readable reason shown in a tooltip when `available` is false. */
  reason: string | null;
  /** Version string when cheaply obtainable, else null. */
  version: string | null;
  /** How the provider is driven, for display purposes. */
  transport: "sdk" | "spawn";
  /** Resolved binary path for spawn-based providers, when found. */
  binary: string | null;
  /** Whether this provider reports token usage in its stream. */
  reportsTokens: boolean;
  /** Effective permission/approval mode for this provider (from config). */
  permissionMode: string;
  /** Effective model for this provider, when configured. */
  model: string | null;
}

/* -------------------------------------------------------------------------- */
/* Token usage                                                                 */
/* -------------------------------------------------------------------------- */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  /** inputTokens + outputTokens (cached input is already counted in inputTokens). */
  totalTokens: number;
}

export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Normalized event schema                                                     */
/* -------------------------------------------------------------------------- */

export type RunState = "starting" | "running" | "done" | "interrupted" | "error";

export interface AssistantTextPayload {
  /** Stable id of the text block this belongs to, so deltas can be appended. */
  blockId: string;
  /** When true, `text` is an incremental chunk to append to `blockId`. */
  delta: boolean;
  text: string;
  /** Reasoning/thinking output is rendered differently from final answer text. */
  kind: "message" | "thinking";
}

export interface ToolUsePayload {
  toolUseId: string;
  name: string;
  /** One-line human summary of the input, for the collapsed row. */
  summary: string;
  /** Full input, shown when the row is expanded. */
  input: unknown;
}

export interface ToolResultPayload {
  /** Links back to the `tool_use` event with the same id. */
  toolUseId: string;
  name: string | null;
  isError: boolean;
  /** One-line human summary of the output, for the collapsed row. */
  summary: string;
  /** Full output, shown when the row is expanded. */
  output: string;
  exitCode: number | null;
}

export interface StatusPayload {
  state: RunState;
  elapsedMs: number;
  /** Null when the provider does not report usage (never a fabricated number). */
  usage: TokenUsage | null;
  detail: string | null;
}

export interface ResultPayload {
  state: Extract<RunState, "done" | "interrupted" | "error">;
  elapsedMs: number;
  usage: TokenUsage | null;
  /** Final assistant message, when the provider distinguishes one. */
  text: string | null;
  exitCode: number | null;
}

export interface ErrorPayload {
  message: string;
  /** Fatal errors end the run; non-fatal ones are logged and the run continues. */
  fatal: boolean;
  detail: string | null;
}

interface EventBase {
  /** Unique per event, used as a React key. */
  id: string;
  runId: string;
  provider: ProviderId;
  /**
   * The model this run is actually using, or null when the provider was left on
   * its own default. Stamped by the runner so the log can label an entry with
   * the model that produced it, even after the selection has moved on.
   */
  model: string | null;
  /** ISO 8601. */
  timestamp: string;
}

export type NormalizedEvent =
  | (EventBase & { type: "assistant_text"; payload: AssistantTextPayload })
  | (EventBase & { type: "tool_use"; payload: ToolUsePayload })
  | (EventBase & { type: "tool_result"; payload: ToolResultPayload })
  | (EventBase & { type: "status"; payload: StatusPayload })
  | (EventBase & { type: "result"; payload: ResultPayload })
  | (EventBase & { type: "error"; payload: ErrorPayload });

export type NormalizedEventType = NormalizedEvent["type"];

/**
 * What adapters yield: everything except the fields the runner stamps on
 * (`id`, `runId`, `provider`, `model`, `timestamp`).
 */
export type AdapterEvent =
  | { type: "assistant_text"; payload: AssistantTextPayload }
  | { type: "tool_use"; payload: ToolUsePayload }
  | { type: "tool_result"; payload: ToolResultPayload }
  | { type: "status"; payload: Partial<StatusPayload> & { state?: RunState } }
  | { type: "result"; payload: Partial<ResultPayload> }
  | { type: "error"; payload: { message: string; fatal?: boolean; detail?: string | null } };


/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export type SettingType = "string" | "password" | "boolean" | "number" | "select" | "path";

export type SettingValue = string | number | boolean;

export interface SettingOption {
  value: string;
  label: string;
  hint: string | null;
  /** Loosens a sandbox or permission check; rendered with a warning. */
  danger: boolean;
}

export interface SettingField {
  key: string;
  label: string;
  group: string;
  type: SettingType;
  description: string;
  /** The environment variable this field mirrors, shown for reference. */
  envVar: string;
  placeholder: string | null;
  options: SettingOption[] | null;
  /** Value from .env / built-in fallback, before any saved override. */
  defaultValue: SettingValue;
  /** Effective value. Always "" for `password` fields — secrets never leave the server. */
  value: SettingValue;
  /** True when a saved override differs from `defaultValue`. */
  overridden: boolean;
  /** For `password` fields: whether a value is currently set. */
  isSet: boolean;
  /** True when the current value loosens a sandbox or permission check. */
  danger: boolean;
  /**
   * For boolean fields: the `true` value is the dangerous one. The client uses
   * this to warn on unsaved drafts, because `danger` only reflects the saved value.
   */
  dangerWhenTrue: boolean;
  /** Changing this only takes effect after a server restart. */
  requiresRestart: boolean;
}

export interface SettingsSnapshot {
  fields: SettingField[];
  /** Group names in display order. */
  groups: string[];
  /** Where overrides are persisted on the server. */
  storagePath: string;
  /** Resolved AGENT_WORKDIR and whether it exists on disk. */
  workdir: string;
  workdirExists: boolean;
}

/** Patch sent to `PUT /api/settings`. Omitted keys are left unchanged. */
export type SettingsPatch = Record<string, SettingValue>;

/* -------------------------------------------------------------------------- */
/* Workspaces                                                                  */
/* -------------------------------------------------------------------------- */

export interface PromptRecord {
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
}

export type PromptStatus = "TODO" | "IN_PROGRESS" | "DONE" | "BLOCKED" | "SKIPPED";

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
}

export interface PromptRunSummary {
  id: string;
  provider: string;
  model: string | null;
  role: RunRole;
  state: string;
  startedAt: string;
  endedAt: string | null;
  processActive: boolean;
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

export type RemarkKind = "PROGRESS" | "FINDING" | "DECISION_NEEDED" | "BLOCKER" | "VERIFICATION" | "COMPLETION" | "HUMAN_RESPONSE" | "AGENT_RESPONSE";
export interface PromptRemark { id:number; promptId:number; runId:string|null; kind:RemarkKind; content:string; actorType:"IMPORT"|"SYSTEM"|"AGENT"|"USER"; createdAt:string }
export interface PromptStatusEvent { id:number; promptId:number; runId:string|null; previousStatus:PromptStatus; newStatus:PromptStatus; reason:string; verificationSummary:string; actorType:"IMPORT"|"SYSTEM"|"AGENT"|"USER"; createdAt:string }

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
export interface AgentRunActivity { id:string; provider:string; model:string|null; role:RunRole; state:string; startedAt:string; endedAt:string|null; events:NormalizedEvent[] }
export interface AgentSession extends AgentRunActivity { workspaceId:number; workspaceName:string; workDirectory:string; promptId:number; promptKey:string|null; promptTitle:string; promptStatus:PromptStatus; programName:string; suiteName:string }

export type PromptOperationalState = "WORKING" | "AWAITING_RESPONSE" | "RECOVERY_NEEDED" | "FAILED" | "READY" | "WAITING_DEPENDENCY" | "COMPLETE" | "SKIPPED";
export interface OperationsPrompt {
  prompt: PromptOption;
  workspace: Pick<WorkspaceRecord,"id"|"name"|"workDirectory"|"workDirectoryExists">;
  programKey: string|null;
  suiteKey: string|null;
  operationalState: PromptOperationalState;
  attention: boolean;
  latestIntervention: string|null;
  lastActivityAt: string;
  sessionCount: number;
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
}
export interface OperationsSession { id:string; workspaceId:number; promptId:number; promptKey:string|null; promptTitle:string; provider:string; model:string|null; role:RunRole; state:string; startedAt:string; endedAt:string|null }
export interface OperationsSnapshot { generatedAt:string; suites:OperationsSuite[] }
export type SuiteVerificationVerdict = "PASS" | "WARNING" | "FAIL";
/** UNVERIFIED is a real outcome: the agent looked and could not establish it. */
export type SuiteVerificationCheck = "VERIFIED" | "WARNING" | "FAILED" | "UNVERIFIED";
/** AGENT re-runs the checks; AUDIT only reads back what was already recorded. */
export type SuiteVerificationKind = "AGENT" | "AUDIT";
export type SuiteVerificationState = "RUNNING" | "DONE" | "INTERRUPTED" | "ERROR" | "RECORDED";

export interface SuiteVerificationItem {
  promptId: number | null;
  promptKey: string | null;
  title: string;
  check: SuiteVerificationCheck;
  evidence: string;
  /** The decisive commands the agent says it ran for this item. */
  commands: string;
}

export interface SuiteVerificationSummary {
  total: number;
  verified: number;
  warnings: number;
  failed: number;
  unverified: number;
}

export interface SuiteVerificationStats {
  workItems: number;
  sourceCharacters: number;
  dossierCharacters: number;
  uniqueCommands: number;
}

/**
 * A verification that happened, kept forever.
 *
 * Verifications used to leave nothing behind: the agent kind ran as an
 * anonymous custom prompt whose events were never persisted, and the audit kind
 * was recomputed on every request. Both vanished on navigation or reload, so
 * "was this suite ever verified, and what did it find?" had no answer.
 */
export interface SuiteVerificationRecord {
  id: number;
  suite: { id: number; key: string | null; name: string; programName: string; workspaceName: string; workspaceId: number };
  kind: SuiteVerificationKind;
  /** The agent run that produced it, for AGENT verifications. */
  runId: string | null;
  provider: string | null;
  model: string | null;
  state: SuiteVerificationState;
  /** Null while an agent verification is still running. */
  verdict: SuiteVerificationVerdict | null;
  summary: SuiteVerificationSummary;
  /** The agent's full written report, kept verbatim even if parsing fails. */
  reportMarkdown: string;
  stats: SuiteVerificationStats | null;
  startedAt: string;
  endedAt: string | null;
  items: SuiteVerificationItem[];
}

/** A record plus the transcript of the run that produced it. */
export interface SuiteVerificationDetail extends SuiteVerificationRecord {
  events: NormalizedEvent[];
}

/** The badge on a suite: what the last verification concluded, and when. */
export interface SuiteVerificationBadge {
  id: number;
  kind: SuiteVerificationKind;
  state: SuiteVerificationState;
  verdict: SuiteVerificationVerdict | null;
  startedAt: string;
  endedAt: string | null;
}

export interface SuiteVerificationContext {
  suiteId:number; prompt:string;
  stats:SuiteVerificationStats;
}
export interface PromptActivity {
  item: OperationsPrompt;
  remarks: PromptRemark[];
  events: PromptStatusEvent[];
  clarifications: ClarificationExchange[];
  sessions: AgentSession[];
}

export interface PromptImportPreview {
  programKey: string;
  programName: string;
  suites: number;
  prompts: number;
  dependencies: number;
  gates: number;
  statuses: Record<PromptStatus, number>;
  workspaceDescriptionCharacters: number;
  warnings: string[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; fields?: Record<string, string> };
}

/* -------------------------------------------------------------------------- */
/* WebSocket protocol                                                          */
/* -------------------------------------------------------------------------- */

export interface ClientRunMessage {
  kind: "run";
  provider: ProviderId;
  workspaceId: number;
  /** Exactly one of prompt and promptId must be supplied. */
  prompt?: string;
  promptId?: number;
  /**
   * Per-run model override. `null` (or omitted) falls back to the provider's
   * configured model in settings, so switching models in the header never
   * rewrites saved configuration.
   */
  model?: string | null;
  /** Ask about a blocked work item without reopening or executing it. */
  mode?: "execute" | "clarify";
  question?: string;
  /** Default "execute". Unknown values are a malformed frame. */
  role?: RunRole;
}

export interface ClientInterruptMessage {
  kind: "interrupt";
  runId: string;
}

export interface ClientRefreshProvidersMessage {
  kind: "refresh_providers";
}

export interface ClientPingMessage {
  kind: "ping";
}

/**
 * Starts an agent verification of a whole suite.
 *
 * Server-initiated on purpose: the browser used to build the dossier itself and
 * fire it as an anonymous custom prompt, which is why the run was never
 * recorded and its report was lost the moment the page changed.
 */
export interface ClientVerifySuiteMessage {
  kind: "verify_suite";
  suiteId: number;
  provider: ProviderId;
  model: string | null;
}

export type ClientMessage =
  | ClientVerifySuiteMessage
  | ClientRunMessage
  | ClientInterruptMessage
  | ClientRefreshProvidersMessage
  | ClientPingMessage;

export interface ServerHelloMessage {
  kind: "hello";
  workdir: string;
  providers: ProviderInfo[];
  /** Every run in flight right now, with its transcript, for replay. */
  activeRuns: RunSnapshot[];
}

export interface ServerProvidersMessage {
  kind: "providers";
  providers: ProviderInfo[];
}

export interface ServerEventMessage {
  kind: "event";
  event: NormalizedEvent;
}

/** What a run was asked to do. Named, because a run snapshot carries it too. */
export type RunSource =
  | { type: "custom"; displayText: string }
  | { type: "saved"; promptId: number; promptKey: string | null; title: string; programName: string; suiteName: string }
  | { type: "clarification"; promptId: number; promptKey: string | null; title: string; question: string }
  | { type: "verification"; verificationId: number; suiteId: number; suiteKey: string | null; suiteName: string };

export interface ServerRunStartedMessage {
  kind: "run_started";
  runId: string;
  provider: ProviderId;
  /** The model the run resolved to, after the override/settings fallback. */
  model: string | null;
  workspace: Pick<WorkspaceRecord, "id" | "name" | "workDirectory">;
  source: RunSource;
  role: RunRole;
}

/**
 * A run as the server currently sees it, including every event it has emitted.
 *
 * Runs belong to the server, not to the socket that started them. This is what
 * lets a page opened mid-run — a new tab, a reload, or a navigation to another
 * page in the app — rebuild the transcript and the live status instead of
 * showing an empty log and claiming the agent is idle.
 */
export interface RunSnapshot {
  runId: string;
  provider: ProviderId;
  model: string | null;
  workspace: Pick<WorkspaceRecord, "id" | "name" | "workDirectory">;
  source: RunSource;
  role: RunRole;
  state: RunState;
  startedAt: string;
  elapsedMs: number;
  usage: TokenUsage | null;
  detail: string | null;
  /** Replay buffer, oldest first. */
  events: NormalizedEvent[];
  /** True when the buffer overflowed and the oldest events were dropped. */
  truncated: boolean;
  /**
   * Forced permission/sandbox the process actually started with, for the
   * status bar. Null means "inherited global settings".
   */
  permissionMode: string | null;
}

export interface ServerRunEndedMessage {
  kind: "run_ended";
  runId: string;
  state: Extract<RunState, "done" | "interrupted" | "error">;
}

export interface ServerPongMessage {
  kind: "pong";
}

/** Broadcast to every tab when settings change, so open panels stay in sync. */
export interface ServerSettingsUpdatedMessage {
  kind: "settings_updated";
  workdir: string;
  providers: ProviderInfo[];
}

/**
 * Tells snapshot-backed views that durable operational data changed.
 *
 * The frame deliberately carries no partial record: the REST snapshot remains
 * the single projection of the database, while the socket makes refreshing it
 * event-driven instead of periodic.
 */
export interface ServerOperationsChangedMessage {
  kind: "operations_changed";
}

export type ServerMessage =
  | ServerHelloMessage
  | ServerProvidersMessage
  | ServerEventMessage
  | ServerRunStartedMessage
  | ServerRunEndedMessage
  | ServerSettingsUpdatedMessage
  | ServerOperationsChangedMessage
  | ServerPongMessage;

/* -------------------------------------------------------------------------- */
/* Small shared helpers                                                        */
/* -------------------------------------------------------------------------- */

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

/** Collapse arbitrary text to a single line suitable for a collapsed log row. */
export function oneLine(value: string, max = 160): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
