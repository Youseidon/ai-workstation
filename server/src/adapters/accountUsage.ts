import { renameSync, writeFileSync } from "node:fs";
import type {
  ProviderId,
  ProviderUsage,
  ProviderUsageCredits,
  ProviderUsageWindow,
  UsageWindowKind,
} from "@agent-console/shared";

/**
 * Classify a quota window by the length the provider reported.
 *
 * Claude and Codex's short window is typically five hours (session), not a
 * calendar day. A daily kind is only used for ~24h windows.
 */
export function classifyUsageWindow(durationMinutes: number | null | undefined): UsageWindowKind | null {
  if (durationMinutes == null || !Number.isFinite(durationMinutes) || durationMinutes <= 0) return null;
  if (durationMinutes <= 12 * 60) return "session";
  if (durationMinutes <= 36 * 60) return "daily";
  if (durationMinutes <= 10 * 24 * 60) return "weekly";
  return "monthly";
}

export function providerUsageUnavailable(provider: ProviderId, reason: string): ProviderUsage {
  return {
    provider,
    available: false,
    reason,
    plan: null,
    fetchedAt: null,
    windows: [],
    credits: null,
  };
}

export function providerUsageOk(
  provider: ProviderId,
  parts: {
    plan?: string | null;
    windows: ProviderUsageWindow[];
    credits?: ProviderUsageCredits | null;
    fetchedAt?: string;
  },
): ProviderUsage {
  const windows = parts.windows.filter((window) => window.usedPercent !== null || window.resetsAt !== null);
  const credits = hasCreditFigures(parts.credits ?? null) ? parts.credits! : null;
  if (windows.length === 0 && credits === null) {
    return providerUsageUnavailable(provider, "No usage windows reported");
  }
  return {
    provider,
    available: true,
    reason: null,
    plan: parts.plan ?? null,
    fetchedAt: parts.fetchedAt ?? new Date().toISOString(),
    windows,
    credits,
  };
}

function hasCreditFigures(credits: ProviderUsageCredits | null): boolean {
  if (credits === null) return false;
  return credits.balance !== null || credits.used !== null || credits.limit !== null;
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Claude's OAuth usage endpoint sometimes returns 0–1 fractions. */
export function claudePercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return clampPercent(value <= 1 ? value * 100 : value);
}

export function usedPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return clampPercent(value);
}

export function isoFromUnixSeconds(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  // Codex has used both seconds and milliseconds historically.
  const ms = value > 1e12 ? value : value * 1000;
  return new Date(ms).toISOString();
}

export function isoFromUnknown(value: unknown): string | null {
  if (typeof value === "number") return isoFromUnixSeconds(value);
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function windowOf(
  kind: UsageWindowKind,
  used: number | null,
  resetsAt: string | null,
  durationMinutes: number | null = null,
): ProviderUsageWindow | null {
  if (used === null && resetsAt === null) return null;
  return { kind, durationMinutes, usedPercent: used, resetsAt };
}

/* -------------------------------------------------------------------------- */
/* Claude — GET https://api.anthropic.com/api/oauth/usage                      */
/* -------------------------------------------------------------------------- */

interface ClaudeLimit {
  kind?: string;
  percent?: number | null;
  utilization?: number | null;
  resets_at?: string | null;
}

export function parseClaudeUsage(payload: unknown): {
  windows: ProviderUsageWindow[];
  credits: ProviderUsageCredits | null;
} {
  const root = asRecord(payload) ?? {};
  const windows: ProviderUsageWindow[] = [];
  const limits = Array.isArray(root.limits) ? (root.limits as ClaudeLimit[]) : [];

  for (const limit of limits) {
    const kind = claudeLimitKind(limit.kind);
    if (kind === null) continue;
    const used = claudePercent(limit.percent ?? limit.utilization);
    const next = windowOf(kind, used, isoFromUnknown(limit.resets_at), kind === "session" ? 5 * 60 : 7 * 24 * 60);
    if (next) windows.push(next);
  }

  if (windows.length === 0) {
    const session = asRecord(root.five_hour);
    const weekly = asRecord(root.seven_day);
    const sessionWindow = windowOf(
      "session",
      claudePercent(session?.utilization),
      isoFromUnknown(session?.resets_at),
      5 * 60,
    );
    const weeklyWindow = windowOf(
      "weekly",
      claudePercent(weekly?.utilization),
      isoFromUnknown(weekly?.resets_at),
      7 * 24 * 60,
    );
    if (sessionWindow) windows.push(sessionWindow);
    if (weeklyWindow) windows.push(weeklyWindow);
  }

  const extra = asRecord(root.extra_usage);
  let credits: ProviderUsageCredits | null = null;
  if (extra) {
    credits = {
      balance: null,
      used: asNumber(extra.used_credits),
      limit: asNumber(extra.monthly_limit),
      currency: typeof extra.currency === "string" ? extra.currency : "USD",
      enabled: typeof extra.is_enabled === "boolean" ? extra.is_enabled : null,
    };
  }

  return { windows, credits };
}

function claudeLimitKind(kind: string | undefined): UsageWindowKind | null {
  if (kind === "session") return "session";
  if (kind === "weekly_all" || kind === "weekly") return "weekly";
  return null;
}

/* -------------------------------------------------------------------------- */
/* Codex — account/rateLimits/read                                             */
/* -------------------------------------------------------------------------- */

interface CodexWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

export function parseCodexRateLimits(payload: unknown): {
  plan: string | null;
  windows: ProviderUsageWindow[];
  credits: ProviderUsageCredits | null;
} {
  const root = asRecord(payload) ?? {};
  const byId = asRecord(root.rateLimitsByLimitId);
  const snapshot = asRecord(byId?.codex) ?? asRecord(root.rateLimits) ?? {};
  const windows: ProviderUsageWindow[] = [];

  for (const key of ["primary", "secondary"] as const) {
    const raw = asRecord(snapshot[key]) as CodexWindow | null;
    if (!raw) continue;
    const duration = asNumber(raw.windowDurationMins);
    const kind = classifyUsageWindow(duration);
    if (kind === null) continue;
    const next = windowOf(kind, usedPercent(raw.usedPercent), isoFromUnixSeconds(raw.resetsAt), duration);
    if (next) windows.push(next);
  }

  const creditsRaw = asRecord(snapshot.credits);
  let credits: ProviderUsageCredits | null = null;
  if (creditsRaw && creditsRaw.hasCredits === true) {
    credits = {
      balance: asNumber(creditsRaw.balance),
      used: null,
      limit: null,
      currency: "USD",
      enabled: true,
    };
  }

  const plan = typeof snapshot.planType === "string" ? snapshot.planType : null;
  return { plan, windows, credits };
}

/* -------------------------------------------------------------------------- */
/* Grok — GET /v1/billing?format=credits                                       */
/* -------------------------------------------------------------------------- */

export function parseGrokCredits(payload: unknown): {
  plan: string | null;
  windows: ProviderUsageWindow[];
  credits: ProviderUsageCredits | null;
} {
  const root = asRecord(payload) ?? {};
  const config = asRecord(root.config) ?? root;
  const period = asRecord(config.currentPeriod);
  const start = isoFromUnknown(period?.start ?? config.billingPeriodStart);
  const end = isoFromUnknown(period?.end ?? config.billingPeriodEnd);
  const kind = grokPeriodKind(typeof period?.type === "string" ? period.type : null, start, end);
  const used = usedPercent(config.creditUsagePercent);
  const windows: ProviderUsageWindow[] = [];
  if (kind !== null) {
    const duration = durationMinutesBetween(start, end);
    const next = windowOf(kind, used ?? (end !== null ? 0 : null), end, duration);
    if (next) windows.push(next);
  }

  const cap = grokCents(config.onDemandCap);
  const spent = grokCents(config.onDemandUsed);
  const prepaid = grokCents(config.prepaidBalance);
  let credits: ProviderUsageCredits | null = null;
  if (cap !== null || spent !== null || prepaid !== null) {
    credits = {
      balance: prepaid,
      used: spent,
      limit: cap,
      currency: "USD",
      enabled: cap !== null ? cap > 0 : null,
    };
  }

  const plan =
    (typeof config.subscriptionTierDisplay === "string" ? config.subscriptionTierDisplay : null) ??
    (typeof config.subscriptionTier === "string" ? config.subscriptionTier : null) ??
    (typeof root.subscriptionTier === "string" ? root.subscriptionTier : null);

  return { plan, windows, credits };
}

function grokPeriodKind(type: string | null, start: string | null, end: string | null): UsageWindowKind | null {
  const upper = (type ?? "").toUpperCase();
  if (upper.includes("WEEK")) return "weekly";
  if (upper.includes("MONTH")) return "monthly";
  if (upper.includes("DAY") && !upper.includes("WEEK")) return "daily";
  return classifyUsageWindow(durationMinutesBetween(start, end)) ?? "weekly";
}

function durationMinutesBetween(start: string | null, end: string | null): number | null {
  if (start === null || end === null) return null;
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.round(ms / 60_000);
}

/** Grok amounts arrive as `{ val: <cents> }` or a bare number. */
function grokCents(value: unknown): number | null {
  const record = asRecord(value);
  const raw = record ? asNumber(record.val) : asNumber(value);
  if (raw === null) return null;
  return raw / 100;
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}
