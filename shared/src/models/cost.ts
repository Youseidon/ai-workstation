import { isProviderId } from "../contracts/providers.ts";
import type { ProviderId } from "../contracts/providers.ts";
import type { TokenUsage } from "./tokenUsage.ts";

export interface TokenRates {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok: number;
}

export interface CostEstimate {
  usd: number | null;
  rates: TokenRates | null;
  rateSource: "model" | "provider_default" | "none";
}

const PROVIDER_DEFAULT_RATES: Record<ProviderId, TokenRates> = {
  claude: { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
  codex: { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.125 },
  cursor: { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
  grok: { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.75 },
  copilot: { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.125 },
  kilocode: { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.125 },
};

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
  { provider: "copilot", match: /opus/i, rates: { inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5 } },
  { provider: "copilot", match: /sonnet/i, rates: { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 } },
  { provider: "copilot", match: /haiku|mini|flash|luna/i, rates: { inputPerMTok: 0.25, outputPerMTok: 2, cachedInputPerMTok: 0.025 } },
  { provider: "copilot", match: /gpt|gemini|auto/i, rates: { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.125 } },
  { provider: "kilocode", match: /opus|fable/i, rates: { inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5 } },
  { provider: "kilocode", match: /sonnet/i, rates: { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 } },
  { provider: "kilocode", match: /haiku|mini|flash|luna|deepseek/i, rates: { inputPerMTok: 0.25, outputPerMTok: 2, cachedInputPerMTok: 0.025 } },
  { provider: "kilocode", match: /gpt|gemini|grok|glm|kimi/i, rates: { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.125 } },
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
  const usd =
    (uncached * rates.inputPerMTok +
      cached * rates.cachedInputPerMTok +
      usage.outputTokens * rates.outputPerMTok) /
    1_000_000;
  return { usd, rates, rateSource: source };
}

export function billableInputTokens(usage: TokenUsage | null, provider: string, modelId: string | null): number {
  if (usage === null) return 0;
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncached = Math.max(0, usage.inputTokens - cached);
  const rates = ratesForModel(provider, modelId)?.rates ?? null;
  if (rates === null || rates.inputPerMTok <= 0) return usage.inputTokens;
  return Math.round(uncached + cached * (rates.cachedInputPerMTok / rates.inputPerMTok));
}

export function inputTokenAllowance(spendUsd: number | null, provider: string, modelId: string | null): number | null {
  if (spendUsd === null || spendUsd <= 0) return null;
  const rates = ratesForModel(provider, modelId)?.rates ?? null;
  if (rates === null || rates.inputPerMTok <= 0) return null;
  return Math.round((spendUsd / rates.inputPerMTok) * 1_000_000);
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
