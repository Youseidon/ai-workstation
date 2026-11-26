import type { ModelAccessTier, ModelOption, ModelSelectionMode, ReasoningEffort } from "../models/modelCatalog.ts";

/**
 * The single source of truth for everything that crosses the WebSocket boundary.
 *
 * Provider-specific shapes (SDKMessage, codex JSONL items, cursor-agent JSON, ...)
 * must be normalized into these types inside `server/src/providers/adapters/*` and must never
 * leak into the transport layer or the frontend.
 */

export const PROVIDER_IDS = ["claude", "codex", "cursor", "grok", "copilot", "kilocode"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

export const RUN_ROLES = ["execute", "consult", "handoff", "author"] as const;
export type RunRole = (typeof RUN_ROLES)[number];

export function isRunRole(value: unknown): value is RunRole {
  return typeof value === "string" && (RUN_ROLES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Provider detection                                                          */
/* -------------------------------------------------------------------------- */

export interface ProviderInfo {
  commandEnforcement?: "brokered" | "cooperative";
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
  /** Effective default after the global model-access policy is applied. */
  model: string | null;
  /** Raw per-provider setting, retained so the UI can explain an inactive choice. */
  configuredModel: string | null;
  /** Global access ceiling applied to this provider and every run role. */
  modelAccessTier: ModelAccessTier;
  /** Effective reasoning effort used to filter Cursor's effort-suffixed ids. */
  reasoningEffort: ReasoningEffort;
  /** Whether callers may choose a model or the server always resolves one. */
  modelSelectionMode: ModelSelectionMode;
  /** Recommended account-available model at the current tier. */
  tierDefaultModel: string | null;
  /** Total discovered count before the access-tier filter. */
  totalModels: number;
  /**
   * Models this account can currently select. Refreshed from the provider at
   * server startup (and on provider re-detection), with the bundled catalog as
   * a fallback when the provider cannot enumerate models while offline.
   */
  models: ModelOption[];
  /**
   * Set when the scheduler recently saw a transient failure from this provider
   * (capacity, quota, …). The header pill shows a small badge; the tooltip
   * carries `because`. Null when the provider is not cooling.
   */
  cooling: { until: string; because: string } | null;
}

/** Outcome of updating one provider's SDK or CLI from the Agents page. */
export interface ProviderUpdateResult {
  provider: ProviderId;
  /** False when the installed version was already the latest. */
  updated: boolean;
  before: string | null;
  after: string | null;
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
