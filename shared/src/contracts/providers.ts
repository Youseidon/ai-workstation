import type { ModelAccessTier, ModelOption, ModelSelectionMode, ReasoningEffort } from "../models/modelCatalog.ts";

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

export interface ProviderInfo {
  commandEnforcement?: "brokered" | "cooperative";
  id: ProviderId;
  label: string;
  installed?: boolean;
  available: boolean;
  reason: string | null;
  version: string | null;
  transport: "sdk" | "spawn";
  binary: string | null;
  reportsTokens: boolean;
  permissionMode: string;
  model: string | null;
  configuredModel: string | null;
  modelAccessTier: ModelAccessTier;
  reasoningEffort: ReasoningEffort;
  modelSelectionMode: ModelSelectionMode;
  tierDefaultModel: string | null;
  totalModels: number;
  models: ModelOption[];
  cooling: { until: string; because: string } | null;
}

export interface ProviderUpdateResult {
  provider: ProviderId;
  updated: boolean;
  before: string | null;
  after: string | null;
}

export interface ProviderSetupInfo {
  provider: ProviderId;
  installed: boolean;
  canInstall: boolean;
  reason: string | null;
  source: string;
  documentationUrl: string;
  accountUrl: string;
  loginCommand: string;
  authNote: string;
  credentialKey: string | null;
}

export interface ProviderInstallResult {
  provider: ProviderId;
  installed: boolean;
  version: string | null;
}

export const USAGE_WINDOW_KINDS = ["session", "daily", "weekly", "monthly"] as const;
export type UsageWindowKind = (typeof USAGE_WINDOW_KINDS)[number];

export interface ProviderUsageWindow {
  kind: UsageWindowKind;
  durationMinutes: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
}

export interface ProviderUsageCredits {
  balance: number | null;
  used: number | null;
  limit: number | null;
  currency: string | null;
  enabled: boolean | null;
}

export interface ProviderUsage {
  provider: ProviderId;
  available: boolean;
  reason: string | null;
  plan: string | null;
  fetchedAt: string | null;
  windows: ProviderUsageWindow[];
  credits: ProviderUsageCredits | null;
}
