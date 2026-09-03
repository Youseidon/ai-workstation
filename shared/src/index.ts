import type { PipelinePolicy } from "./pipelineRules";
/**
 * The single source of truth for everything that crosses the WebSocket boundary.
 *
 * Provider-specific shapes (SDKMessage, codex JSONL items, cursor-agent JSON, ...)
 * must be normalized into these types inside `server/src/adapters/*` and must never
 * leak into the transport layer or the frontend.
 */

export const PROVIDER_IDS = ["claude", "codex", "cursor", "grok", "copilot"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

export const RUN_ROLES = ["execute", "consult", "handoff"] as const;
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
    { id: "claude-sonnet-5-medium", label: "sonnet 5", hint: "Anthropic, balanced" },
    { id: "claude-opus-4-8-high", label: "opus 4.8", hint: "Anthropic, high effort" },
    { id: "gpt-5.6-terra-medium", label: "5.6 terra", hint: "OpenAI, balanced" },
    { id: "cursor-grok-4.5-medium", label: "grok 4.5", hint: "xAI, balanced" },
  ],
  // Reported by `grok models` on a logged-in CLI.
  grok: [
    { id: null, label: "default", hint: "whatever the grok CLI picks" },
    { id: "grok-4.6", label: "grok 4.6", hint: "current default" },
    { id: "grok-4.5", label: "grok 4.5", hint: "previous generation" },
  ],
  // Copilot's model list is per-account: `--model` rejects anything the plan's
  // picker does not expose, and a free plan exposes nothing but `auto`. Only the
  // two entries every account has are listed; the ids a paid plan adds (and the
  // routed model changes between releases) go through the custom field.
  copilot: [
    { id: null, label: "default", hint: "whatever the copilot CLI picks" },
    { id: "auto", label: "auto", hint: "Copilot routes the request" },
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
/* Account usage credits                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Quota windows a provider's own account API actually reports.
 *
 * Names follow the window, not a wish: Claude and Codex expose a short session
 * window (typically 5 hours) and a weekly cap, not a calendar day. Grok's
 * billing API is weekly-only. Cursor reports a billing-cycle (typically monthly)
 * included allowance. Callers must skip kinds the provider omitted rather than
 * inventing a daily figure.
 */
export const USAGE_WINDOW_KINDS = ["session", "daily", "weekly", "monthly"] as const;
export type UsageWindowKind = (typeof USAGE_WINDOW_KINDS)[number];

export interface ProviderUsageWindow {
  kind: UsageWindowKind;
  /** Length of the window in minutes, when the provider reports it. */
  durationMinutes: number | null;
  /** Percent used in 0–100. Null when the window exists but has no figure. */
  usedPercent: number | null;
  /** ISO 8601 instant the window resets, when the provider reports one. */
  resetsAt: string | null;
}

export interface ProviderUsageCredits {
  /** Prepaid/overage balance remaining, when the provider reports one. */
  balance: number | null;
  used: number | null;
  limit: number | null;
  currency: string | null;
  /** False when extra usage exists as a setting but is switched off. */
  enabled: boolean | null;
}

/**
 * Account-level usage for one provider, taken from that provider's own API.
 *
 * `available` is true only when at least one window or credit figure arrived.
 * `reason` explains a gap (no login, API key instead of a plan, the CLI has
 * no usage endpoint). Never fabricate numbers to fill a missing kind.
 */
export interface ProviderUsage {
  provider: ProviderId;
  available: boolean;
  reason: string | null;
  plan: string | null;
  fetchedAt: string | null;
  windows: ProviderUsageWindow[];
  credits: ProviderUsageCredits | null;
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

/** True when a usage object carries a non-zero token count. */
export function isMeaningfulUsage(usage: TokenUsage | null | undefined): usage is TokenUsage {
  return usage !== null && usage !== undefined && usage.totalTokens > 0;
}

/**
 * Combine two usage snapshots. Empty/zero payloads never clobber a real count;
 * when both are meaningful, keep the larger total (handles incremental vs final).
 */
export function mergeUsage(current: TokenUsage | null, next: TokenUsage | null): TokenUsage | null {
  if (!isMeaningfulUsage(next)) return current;
  if (!isMeaningfulUsage(current)) return next;
  return next.totalTokens >= current.totalTokens ? next : current;
}

/* -------------------------------------------------------------------------- */
/* Cost estimation (API list-price proxy)                                      */
/* -------------------------------------------------------------------------- */

/** USD per million tokens for one price tier. */
export interface TokenRates {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Cache-read input; defaults to ~10% of input when omitted in lookup tables. */
  cachedInputPerMTok: number;
}

export interface CostEstimate {
  /** Null when the session has no reported usage. */
  usd: number | null;
  rates: TokenRates | null;
  /** How the rates were chosen. */
  rateSource: "model" | "provider_default" | "none";
}

/**
 * Approximate public API list prices ($ / MTok). Subscription plans (Max,
 * Plus, Cursor Pro, …) are not metered this way — treat figures as a relative
 * spend signal, not an invoice.
 */
const PROVIDER_DEFAULT_RATES: Record<ProviderId, TokenRates> = {
  claude: { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
  codex: { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.125 },
  cursor: { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
  grok: { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.75 },
  // Copilot bills premium requests, not tokens; this is a spend signal only.
  copilot: { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.125 },
};

/** Model-id substrings → rates. First match wins; order matters (more specific first). */
const MODEL_RATE_RULES: Array<{ provider?: ProviderId; match: RegExp; rates: TokenRates }> = [
  { provider: "claude", match: /opus|fable/i, rates: { inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5 } },
  { provider: "claude", match: /sonnet/i, rates: { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 } },
  { provider: "claude", match: /haiku/i, rates: { inputPerMTok: 1, outputPerMTok: 5, cachedInputPerMTok: 0.1 } },
  { provider: "codex", match: /mini|luna/i, rates: { inputPerMTok: 0.25, outputPerMTok: 2, cachedInputPerMTok: 0.025 } },
  { provider: "codex", match: /terra|5\.4(?!-mini)/i, rates: { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.125 } },
  { provider: "codex", match: /sol|5\.5|5\.6/i, rates: { inputPerMTok: 2.5, outputPerMTok: 15, cachedInputPerMTok: 0.25 } },
  { provider: "cursor", match: /opus/i, rates: { inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5 } },
  { provider: "cursor", match: /sonnet/i, rates: { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 } },
  { provider: "cursor", match: /gpt|auto/i, rates: { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.125 } },
  { provider: "cursor", match: /grok/i, rates: { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.75 } },
  { provider: "grok", match: /4\.6|4\.5|grok/i, rates: { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.75 } },
  // Copilot routes to whichever vendor the plan allows; price by the routed model.
  { provider: "copilot", match: /opus/i, rates: { inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5 } },
  { provider: "copilot", match: /sonnet/i, rates: { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 } },
  { provider: "copilot", match: /haiku|mini|flash|luna/i, rates: { inputPerMTok: 0.25, outputPerMTok: 2, cachedInputPerMTok: 0.025 } },
  { provider: "copilot", match: /gpt|gemini|auto/i, rates: { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.125 } },
];

export function ratesForModel(provider: string, modelId: string | null): { rates: TokenRates; source: "model" | "provider_default" } | null {
  if (!isProviderId(provider)) return null;
  if (modelId !== null && modelId !== "") {
    for (const rule of MODEL_RATE_RULES) {
      if (rule.provider !== undefined && rule.provider !== provider) continue;
      if (rule.match.test(modelId)) return { rates: rule.rates, source: "model" };
    }
  }
  return { rates: PROVIDER_DEFAULT_RATES[provider], source: "provider_default" };
}

export function estimateCost(usage: TokenUsage | null, provider: string, modelId: string | null): CostEstimate {
  if (usage === null) return { usd: null, rates: null, rateSource: "none" };
  const resolved = ratesForModel(provider, modelId);
  if (resolved === null) return { usd: null, rates: null, rateSource: "none" };
  const { rates, source } = resolved;
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncached = Math.max(0, usage.inputTokens - cached);
  // Reasoning is reported separately for display; most providers already fold it
  // into outputTokens, so we do not add it again.
  const usd =
    (uncached * rates.inputPerMTok +
      cached * rates.cachedInputPerMTok +
      usage.outputTokens * rates.outputPerMTok) /
    1_000_000;
  return { usd, rates, rateSource: source };
}

export function formatUsd(amount: number, digits = 2): string {
  if (!Number.isFinite(amount)) return "—";
  if (amount === 0) return "$0";
  if (amount > 0 && amount < 0.01) return "<$0.01";
  return `$${amount.toFixed(digits)}`;
}

export const USAGE_REPORT_PRICING_NOTE =
  "Estimated from public API list rates ($/MTok). Plan subscriptions are not billed this way — use the numbers to compare relative spend.";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  estimatedUsd: number;
  sessionCount: number;
  sessionsWithUsage: number;
  sessionsWithoutUsage: number;
}

export function emptyUsageTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedUsd: 0,
    sessionCount: 0,
    sessionsWithUsage: 0,
    sessionsWithoutUsage: 0,
  };
}

export function addUsageToTotals(totals: UsageTotals, usage: TokenUsage | null, usd: number | null): void {
  totals.sessionCount += 1;
  if (usage === null) {
    totals.sessionsWithoutUsage += 1;
    return;
  }
  totals.sessionsWithUsage += 1;
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  totals.cachedInputTokens += usage.cachedInputTokens;
  totals.reasoningOutputTokens += usage.reasoningOutputTokens;
  totals.totalTokens += usage.totalTokens;
  if (usd !== null) totals.estimatedUsd += usd;
}

export interface SessionUsageRow {
  id: string;
  workspaceId: number;
  workspaceName: string;
  promptId: number | null;
  promptKey: string | null;
  promptTitle: string;
  suiteId: number | null;
  suiteName: string;
  programId: number | null;
  programName: string;
  provider: string;
  model: string | null;
  role: RunRole;
  state: string;
  startedAt: string;
  endedAt: string | null;
  usage: TokenUsage | null;
  cost: CostEstimate;
}

export interface TaskUsageRow {
  promptId: number;
  promptKey: string | null;
  promptTitle: string;
  suiteId: number;
  suiteName: string;
  programId: number;
  programName: string;
  workspaceId: number;
  workspaceName: string;
  totals: UsageTotals;
  sessionIds: string[];
}

export interface SuiteUsageRow {
  suiteId: number;
  suiteName: string;
  programId: number;
  programName: string;
  workspaceId: number;
  workspaceName: string;
  totals: UsageTotals;
  tasks: TaskUsageRow[];
}

export interface UsageReport {
  generatedAt: string;
  pricingNote: string;
  totals: UsageTotals;
  byProvider: Array<{ provider: string; totals: UsageTotals }>;
  suites: SuiteUsageRow[];
  unassigned: { totals: UsageTotals; sessionIds: string[] };
  sessions: SessionUsageRow[];
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

/** Best usage from a run's status/result events (ignores zeroed terminal noise). */
export function usageFromEvents(events: readonly NormalizedEvent[]): TokenUsage | null {
  let usage: TokenUsage | null = null;
  for (const event of events) {
    if ((event.type === "status" || event.type === "result") && event.payload.usage !== null) {
      usage = mergeUsage(usage, event.payload.usage);
    }
  }
  return usage;
}

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
  /** Set when this prompt was spawned by another prompt's decompose call. */
  parentPromptId: number | null;
  /** Run order among siblings under the same parent. Meaningless without a parent. */
  childOrder: number;
}

export type PromptStatus = "TODO" | "IN_PROGRESS" | "DONE" | "BLOCKED" | "SKIPPED";

/** Terminal stations have no remaining work to summarize for a successor. */
export function promptNeedsHandoff(status: PromptStatus): boolean {
  return status !== "DONE" && status !== "SKIPPED";
}

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
export interface AgentSession extends AgentRunActivity { workspaceId:number; workspaceName:string; workDirectory:string; promptId:number|null; promptKey:string|null; promptTitle:string; promptStatus:PromptStatus|null; programName:string; suiteName:string }

export type PromptOperationalState = "WORKING" | "AWAITING_RESPONSE" | "RECOVERY_NEEDED" | "FAILED" | "READY" | "WAITING_DEPENDENCY" | "COMPLETE" | "SKIPPED";

export const ON_DONE_ACTIONS = ["continue", "stop", "skip_rest"] as const;
export type OnDoneAction = (typeof ON_DONE_ACTIONS)[number];
export function isOnDoneAction(value: unknown): value is OnDoneAction {
  return typeof value === "string" && (ON_DONE_ACTIONS as readonly string[]).includes(value);
}

export const ON_BLOCKED_ACTIONS = ["wait", "retry", "recover", "skip"] as const;
export type OnBlockedAction = (typeof ON_BLOCKED_ACTIONS)[number];
export function isOnBlockedAction(value: unknown): value is OnBlockedAction {
  return typeof value === "string" && (ON_BLOCKED_ACTIONS as readonly string[]).includes(value);
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
  onDone: OnDoneAction;
  onBlocked: OnBlockedAction;
  /** Used only when onBlocked === "retry". Inclusive, 1..5, default 1. */
  retryLimit: number;
  /** Required when onBlocked === "recover". */
  recoverProvider: ProviderId | null;
  recoverModel: string | null;
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
  policy?: Pick<PipelinePolicy, "defaultOnDone" | "defaultOnBlocked">,
): PromptPipelineRule {
  return {
    promptId,
    provider: null,
    model: null,
    onDone: policy?.defaultOnDone ?? "continue",
    onBlocked: policy?.defaultOnBlocked ?? "wait",
    retryLimit: 1,
    recoverProvider: null,
    recoverModel: null,
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
}

export interface SuitePipelineRun {
  id: string;
  suiteId: number;
  workspaceId: number;
  state: PipelineState;
  currentPromptId: number | null;
  currentRunId: string | null;
  /** 0 before the first try of the current station; increments on retry/recover. */
  attempt: number;
  /** Whether the current attempt is the recover pass (one-shot). */
  recovering: boolean;
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

export interface SuitePipelineView {
  defaults: SuitePipelineDefaults;
  /** Enabled flowchart steps, ordered by stepOrder. */
  steps: PromptPipelineRule[];
  /** Suite prompts that are not on the flowchart. */
  available: PipelineAvailablePrompt[];
  rules: PromptPipelineRule[];
  active: SuitePipelineRun | null;
  latest: SuitePipelineRun | null;
}

/**
 * A saved pipeline: an ordered set of suites in one workspace, played in
 * sequence. Distinct from a suite flowchart (`SuitePipelineView`) and from a
 * single execution (`PipelineRun`).
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

export interface OperationsPrompt {
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
  latestHandoff: HandoffRecord | null;
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
export interface OperationsSnapshot { generatedAt:string; suites:OperationsSuite[]; policy:PipelinePolicy }
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
  /** When set, the verification covered one work item rather than the whole suite. */
  scopePromptId: number | null;
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
  suiteId: number;
  prompt: string;
  stats: SuiteVerificationStats;
  scopePromptId: number | null;
  scopePromptKey: string | null;
}
export interface PromptActivity {
  item: OperationsPrompt;
  remarks: PromptRemark[];
  events: PromptStatusEvent[];
  clarifications: ClarificationExchange[];
  sessions: AgentSession[];
  handoffs: HandoffRecord[];
  /** True when the latest execute run failed before meaningful work; pipeline resume can skip handoff. */
  directRetry: boolean;
  /** True when the latest developer run made at least one tool call. */
  producedWork: boolean;
}

export const HANDOFF_STATES = ["QUEUED", "RUNNING", "READY", "FAILED", "SUPERSEDED"] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];
export const HANDOFF_RECOMMENDATIONS = ["CONTINUE", "WAIT_FOR_HUMAN", "RETRY_LATER", "DO_NOT_CONTINUE"] as const;
export type HandoffRecommendation = (typeof HANDOFF_RECOMMENDATIONS)[number];

export interface HandoffBrief {
  version: 1;
  originalObjective: string;
  terminationReason: string;
  completedWork: string[];
  pendingWork: string[];
  verificationPassed: string[];
  verificationFailed: string[];
  blockers: Array<{ description: string; requiresHuman: boolean; requiredAction: string | null }>;
  importantFiles: string[];
  decisionsAndAssumptions: string[];
  recommendation: HandoffRecommendation;
  successorInstructions: string;
}

export interface HandoffRecord {
  id: string;
  workspaceId: number;
  promptId: number;
  sourceRunId: string;
  handoffRunId: string | null;
  successorRunId: string | null;
  provider: ProviderId;
  model: string | null;
  state: HandoffState;
  recommendation: HandoffRecommendation | null;
  brief: HandoffBrief | null;
  briefMarkdown: string;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
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
  /** When set, verify only this work item inside the suite. */
  promptId?: number | null;
}

export type ClientMessage =
  | ClientVerifySuiteMessage
  | ClientRunMessage
  | ClientInterruptMessage
  | ClientRefreshProvidersMessage
  | ClientPingMessage;

export interface ServerHelloMessage {
  kind: "hello";
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
  | { type: "verification"; verificationId: number; suiteId: number; suiteKey: string | null; suiteName: string; promptKey: string | null }
  | { type: "consult"; promptId: number | null; promptKey: string | null; title: string | null; question: string }
  | { type: "handoff"; handoffId: string; promptId: number; promptKey: string | null; title: string; sourceRunId: string };

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

/** Broadcast to every tab when provider settings change, so open panels stay in sync. */
export interface ServerSettingsUpdatedMessage {
  kind: "settings_updated";
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

/**
 * Compact countdown to a reset instant. Null when the timestamp is missing
 * or unparseable. Omits seconds: "3h 12m", "4d 8h", or "soon".
 */
export function formatResetIn(iso: string | null, now = Date.now()): string | null {
  if (iso === null) return null;
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return null;
  const totalSeconds = Math.max(0, Math.floor((target - now) / 1000));
  if (totalSeconds < 60) return "soon";
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
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

/*
 * The transport interlocking. Re-exported by name rather than with `export *`,
 * so the package's public surface is explicit and a new symbol has to be
 * declared here on purpose.
 */
export {
  CONTROL_LABEL,
  DEFAULT_PIPELINE_POLICY,
  HANDOFF_REQUIREMENTS,
  PAUSE_MODES,
  PIPELINE_CONTROLS,
  STOP_REASON,
  TRANSITIONS,
  describeStopReason,
  handoffRequired,
  matchTransition,
  onBlockedConsequence,
  onDoneConsequence,
  RESTART_POLICIES,
} from "./pipelineRules";
export type {
  HandoffRequirement,
  PauseMode,
  PipelineControl,
  PipelinePolicy,
  PolicyKey,
  RestartPolicy,
  RuleContext,
  RulePolicy,
  StatusTone,
  TransitionRow,
} from "./pipelineRules";
