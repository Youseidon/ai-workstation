import { PROVIDER_IDS } from "../contracts/providers.ts";
import type { ProviderId } from "../contracts/providers.ts";

export interface ModelOption {
  id: string | null;
  label: string;
  hint: string;
  pool?: ModelPool;
}

export const MODEL_ACCESS_TIERS = ["free", "efficient", "professional", "frontier", "all"] as const;
export type ModelAccessTier = (typeof MODEL_ACCESS_TIERS)[number];
export type ClassifiedModelTier = Exclude<ModelAccessTier, "all">;

export const MODEL_SELECTION_MODES = ["manual", "auto"] as const;
export type ModelSelectionMode = (typeof MODEL_SELECTION_MODES)[number];

export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export function isModelSelectionMode(value: unknown): value is ModelSelectionMode {
  return typeof value === "string" && (MODEL_SELECTION_MODES as readonly string[]).includes(value);
}

export interface ModelAccessTierInfo {
  label: string;
  shortLabel: string;
  description: string;
  creditUse: string;
}

export const MODEL_ACCESS_TIER_INFO: Record<ModelAccessTier, ModelAccessTierInfo> = {
  free: {
    label: "Free",
    shortLabel: "Free",
    description: "Only models explicitly identified as free or zero-credit.",
    creditUse: "No paid credits",
  },
  efficient: {
    label: "Efficient",
    shortLabel: "Efficient",
    description: "Fast, economical models for routine work.",
    creditUse: "Low credit use",
  },
  professional: {
    label: "Professional",
    shortLabel: "Pro",
    description: "Strong coding models for everyday production work.",
    creditUse: "Balanced credit use",
  },
  frontier: {
    label: "Frontier",
    shortLabel: "Frontier",
    description: "The strongest curated models, including high-reasoning variants.",
    creditUse: "High credit use",
  },
  all: {
    label: "All models",
    shortLabel: "All",
    description: "Every discovered model, provider defaults, and custom model IDs.",
    creditUse: "No model limit",
  },
};

export function isModelAccessTier(value: unknown): value is ModelAccessTier {
  return typeof value === "string" && (MODEL_ACCESS_TIERS as readonly string[]).includes(value);
}

const MODEL_TIER_RANK: Record<ClassifiedModelTier, number> = {
  free: 0,
  efficient: 1,
  professional: 2,
  frontier: 3,
};

export function classifyModel(provider: ProviderId, modelId: string | null): ClassifiedModelTier | null {
  if (modelId === null) return null;
  const id = modelId.toLowerCase();
  if (provider === "kilocode") {
    if (id === "kilo-auto/free") return "free";
    if (id === "kilo-auto/efficient") return "efficient";
    if (id === "kilo-auto/frontier") return "frontier";
  }
  if (/(?:^|[-_/:.])free(?:$|[-_/:.])|zero[-_ ]?credit/.test(id)) return "free";

  if (/opus|fable|gpt[-_.]?sol|\bsol\b/.test(id)) return "frontier";
  if (/haiku|gpt[-_.]?luna|\bluna\b|mini|flash|deepseek|\bglm\b|\bkimi\b|small|lite/.test(id)) {
    return "efficient";
  }
  if (/sonnet|gpt[-_.]?terra|\bterra\b|composer|codex|gpt|gemini[-_/.:]?pro|grok|auto/.test(id)) {
    if (/xhigh|extra[-_ ]?high|\bmax\b|thinking[-_/.:]?high/.test(id)) return "frontier";
    return "professional";
  }

  void provider;
  return null;
}

export function modelFamily(modelId: string | null): string {
  if (modelId === null) return "Provider default";
  const id = modelId.toLowerCase();
  if (/claude|anthropic|opus|sonnet|haiku|fable/.test(id)) return "Claude";
  if (/composer|cursor-/.test(id)) return "Cursor";
  if (/gpt|openai|codex|\bsol\b|\bterra\b|\bluna\b/.test(id)) return "GPT & Codex";
  if (/gemini|google/.test(id)) return "Gemini";
  if (/grok|x-ai/.test(id)) return "Grok";
  if (/deepseek/.test(id)) return "DeepSeek";
  if (/kimi|moonshot/.test(id)) return "Kimi";
  if (/glm|z-ai/.test(id)) return "GLM";
  return "Other";
}

export function modelAllowedInTier(provider: ProviderId, modelId: string | null, tier: ModelAccessTier): boolean {
  if (tier === "all") return true;
  const classified = classifyModel(provider, modelId);
  return classified !== null && MODEL_TIER_RANK[classified] <= MODEL_TIER_RANK[tier];
}

export type BakedModelEffort = ReasoningEffort | "xhigh" | "max" | "none";

export function bakedModelEffort(modelId: string | null): BakedModelEffort | null {
  if (modelId === null || modelId === "") return null;
  const body = modelId
    .toLowerCase()
    .replace(/\[.*$/, "")
    .replace(/-fast$/, "")
    .replace(/-thinking$/, "");
  const match = /(?:^|-)(?:thinking-)?(none|low|medium|extra-high|xhigh|high|max)$/.exec(body);
  if (match === null) return null;
  const token = match[1];
  if (token === "extra-high") return "xhigh";
  return token as BakedModelEffort;
}

export function modelMatchesEffort(
  provider: ProviderId,
  modelId: string | null,
  effort: ReasoningEffort,
): boolean {
  if (provider !== "cursor") return true;
  const baked = bakedModelEffort(modelId);
  if (baked === null) return true;
  if (baked === "none") return effort === "low";
  if (effort === "high") return baked === "high" || baked === "xhigh" || baked === "max";
  return baked === effort;
}

export function eligibleModels(
  provider: ProviderId,
  models: readonly ModelOption[],
  tier: ModelAccessTier,
  effort?: ReasoningEffort,
): ModelOption[] {
  const byTier = tier === "all"
    ? [...models]
    : models.filter((model) => model.id !== null && modelAllowedInTier(provider, model.id, tier));
  if (effort === undefined) return byTier;
  return byTier.filter((model) => modelMatchesEffort(provider, model.id, effort));
}

const MODEL_DEFAULT_PREFERENCES: Record<ClassifiedModelTier, Record<ProviderId, RegExp[]>> = {
  free: Object.fromEntries(PROVIDER_IDS.map((provider) => [provider, [/free|zero[-_ ]?credit/i]])) as Record<ProviderId, RegExp[]>,
  efficient: {
    claude: [/haiku/i],
    codex: [/luna/i, /mini/i],
    cursor: [/luna/i, /mini/i, /flash/i],
    grok: [/mini|fast|light/i],
    copilot: [/mini|flash|haiku|luna/i],
    kilocode: [/luna/i, /mini/i, /flash/i, /haiku/i, /deepseek/i],
  },
  professional: {
    claude: [/sonnet/i],
    codex: [/terra/i, /5\.4(?!-mini)/i],
    cursor: [/composer/i, /sonnet/i, /terra/i, /codex/i],
    grok: [/grok/i],
    copilot: [/^auto$/i, /sonnet|gpt/i],
    kilocode: [/sonnet/i, /terra/i, /gemini[-_/.:]?pro/i, /grok/i],
  },
  frontier: {
    claude: [/opus/i, /fable/i],
    codex: [/sol/i, /5\.6/i, /5\.5/i],
    cursor: [/opus/i, /sol.*(?:xhigh|max|high)/i, /fable/i],
    grok: [/xhigh|max|high/i, /grok/i],
    copilot: [/opus/i, /sol/i],
    kilocode: [/opus/i, /sol/i, /fable/i],
  },
};

export function recommendedModel(
  provider: ProviderId,
  models: readonly ModelOption[],
  tier: ModelAccessTier,
): string | null {
  if (tier === "all") return null;
  const allowed = eligibleModels(provider, models, tier).filter((model): model is ModelOption & { id: string } => model.id !== null);
  if (allowed.length === 0) return null;
  const ownPool = allowed.filter((model) => model.pool === "cursor");
  if (ownPool.length > 0) return pickRecommended(provider, ownPool, tier);
  return pickRecommended(provider, allowed, tier);
}

function pickRecommended(
  provider: ProviderId,
  allowed: ReadonlyArray<ModelOption & { id: string }>,
  tier: ModelAccessTier,
): string | null {
  const targetBands: ClassifiedModelTier[] = tier === "frontier"
    ? ["frontier", "professional", "efficient", "free"]
    : tier === "professional"
      ? ["professional", "efficient", "free"]
      : tier === "efficient"
        ? ["efficient", "free"]
        : ["free"];
  for (const band of targetBands) {
    const inBand = allowed.filter((model) => classifyModel(provider, model.id) === band);
    if (inBand.length === 0) continue;
    for (const preference of MODEL_DEFAULT_PREFERENCES[band][provider]) {
      const match = inBand.find((model) => preference.test(`${model.id} ${model.label}`));
      if (match !== undefined) return match.id;
    }
    return inBand[0]!.id;
  }
  return null;
}

export function automaticModel(
  provider: ProviderId,
  models: readonly ModelOption[],
  tier: ModelAccessTier,
): string | null {
  const has = (id: string): boolean => models.some((model) => model.id === id);
  if (provider === "cursor" && has("auto") && modelAllowedInTier("cursor", "auto", tier)) return "auto";
  if (provider === "kilocode") {
    const native = tier === "free"
      ? "kilo-auto/free"
      : tier === "efficient"
        ? "kilo-auto/efficient"
        : tier === "frontier" || tier === "all"
          ? "kilo-auto/frontier"
          : null;
    if (native !== null && has(native)) return native;
  }
  return recommendedModel(provider, models, tier === "all" ? "frontier" : tier);
}

export const MODEL_POOLS = ["cursor", "vendor"] as const;
export type ModelPool = (typeof MODEL_POOLS)[number];

export const MODEL_POOL_LABEL: Record<ModelPool, string> = {
  cursor: "Cursor pool",
  vendor: "Vendor pool",
};

export const MODEL_CATALOG: Record<ProviderId, ModelOption[]> = {
  claude: [
    { id: null, label: "default", hint: "whatever the Agent SDK picks" },
    { id: "claude-opus-5", label: "opus 5", hint: "flagship" },
    { id: "claude-sonnet-5", label: "sonnet 5", hint: "balanced" },
    { id: "claude-haiku-4-5", label: "haiku 4.5", hint: "fast and cheap" },
    { id: "claude-opus-4-8", label: "opus 4.8", hint: "previous flagship" },
    { id: "claude-fable-5", label: "fable 5", hint: "most capable, priciest" },
  ],
  codex: [
    { id: null, label: "default", hint: "whatever `codex exec` picks" },
    { id: "gpt-5.6-sol", label: "5.6 sol", hint: "frontier agentic coding" },
    { id: "gpt-5.6-terra", label: "5.6 terra", hint: "balanced everyday work" },
    { id: "gpt-5.6-luna", label: "5.6 luna", hint: "fast and affordable" },
    { id: "gpt-5.5", label: "5.5", hint: "previous frontier" },
    { id: "gpt-5.4", label: "5.4", hint: "strong everyday coding" },
    { id: "gpt-5.4-mini", label: "5.4 mini", hint: "small, cheap, simple tasks" },
  ],
  cursor: [
    { id: null, label: "default", hint: "whatever cursor-agent picks" },
    { id: "auto", label: "auto", hint: "Auto (default)", pool: "cursor" },
    { id: "composer-2.5", label: "composer 2.5", hint: "Composer 2.5", pool: "cursor" },
    { id: "cursor-grok-4.5-high", label: "grok 4.5 high", hint: "Grok 4.5", pool: "cursor" },
    { id: "cursor-grok-4.5-high-fast", label: "grok 4.5 high fast", hint: "Grok 4.5 Fast", pool: "cursor" },
    { id: "cursor-grok-4.6-low", label: "grok 4.6 low", hint: "Grok 4.6 Low", pool: "cursor" },
    { id: "cursor-grok-4.6-low-fast", label: "grok 4.6 low fast", hint: "Grok 4.6 Low Fast", pool: "cursor" },
    { id: "cursor-grok-4.6-medium", label: "grok 4.6 medium", hint: "Grok 4.6 Medium", pool: "cursor" },
    { id: "cursor-grok-4.6-medium-fast", label: "grok 4.6 medium fast", hint: "Grok 4.6 Medium Fast", pool: "cursor" },
    { id: "cursor-grok-4.6-high", label: "grok 4.6 high", hint: "Grok 4.6", pool: "cursor" },
    { id: "cursor-grok-4.6-high-fast", label: "grok 4.6 high fast", hint: "Grok 4.6 Fast", pool: "cursor" },
    { id: "cursor-grok-4.6-xhigh", label: "grok 4.6 xhigh", hint: "Grok 4.6 Extra High", pool: "cursor" },
    { id: "cursor-grok-4.6-xhigh-fast", label: "grok 4.6 xhigh fast", hint: "Grok 4.6 Extra High Fast", pool: "cursor" },
    { id: "composer-2.5-fast", label: "composer 2.5 fast", hint: "Composer 2.5 Fast", pool: "cursor" },
    { id: "cursor-grok-4.5-low", label: "grok 4.5 low", hint: "Grok 4.5 Low", pool: "cursor" },
    { id: "cursor-grok-4.5-low-fast", label: "grok 4.5 low fast", hint: "Grok 4.5 Low Fast", pool: "cursor" },
    { id: "cursor-grok-4.5-medium", label: "grok 4.5 medium", hint: "Grok 4.5 Medium", pool: "cursor" },
    { id: "cursor-grok-4.5-medium-fast", label: "grok 4.5 medium fast", hint: "Grok 4.5 Medium Fast", pool: "cursor" },
    { id: "gpt-5.3-codex-low", label: "5.3 codex low", hint: "Codex 5.3 Low", pool: "vendor" },
    { id: "gpt-5.3-codex-low-fast", label: "5.3 codex low fast", hint: "Codex 5.3 Low Fast", pool: "vendor" },
    { id: "gpt-5.3-codex", label: "5.3 codex", hint: "Codex 5.3", pool: "vendor" },
    { id: "gpt-5.3-codex-fast", label: "5.3 codex fast", hint: "Codex 5.3 Fast", pool: "vendor" },
    { id: "gpt-5.3-codex-high", label: "5.3 codex high", hint: "Codex 5.3 High", pool: "vendor" },
    { id: "gpt-5.3-codex-high-fast", label: "5.3 codex high fast", hint: "Codex 5.3 High Fast", pool: "vendor" },
    { id: "gpt-5.3-codex-xhigh", label: "5.3 codex xhigh", hint: "Codex 5.3 Extra High", pool: "vendor" },
    { id: "gpt-5.3-codex-xhigh-fast", label: "5.3 codex xhigh fast", hint: "Codex 5.3 Extra High Fast", pool: "vendor" },
    { id: "gpt-5.2", label: "5.2", hint: "GPT-5.2", pool: "vendor" },
    { id: "claude-opus-5-thinking-high", label: "opus 5 thinking high", hint: "Claude Opus 5 1M Thinking", pool: "vendor" },
    { id: "claude-opus-5-thinking-high-fast", label: "opus 5 thinking high fast", hint: "Claude Opus 5 1M Thinking Fast", pool: "vendor" },
    { id: "gpt-5.6-sol-high", label: "5.6 sol high", hint: "GPT-5.6 Sol 1M High", pool: "vendor" },
    { id: "gpt-5.6-sol-high-fast", label: "5.6 sol high fast", hint: "GPT-5.6 Sol 1M High Fast", pool: "vendor" },
    { id: "gpt-5.6-sol-xhigh", label: "5.6 sol xhigh", hint: "GPT-5.6 Sol 1M Extra High", pool: "vendor" },
    { id: "gpt-5.6-sol-xhigh-fast", label: "5.6 sol xhigh fast", hint: "GPT-5.6 Sol 1M Extra High Fast", pool: "vendor" },
    { id: "claude-fable-5-thinking-high", label: "fable 5 thinking high", hint: "Claude Fable 5 1M Thinking (NO ZDR)", pool: "vendor" },
    { id: "claude-fable-5-thinking-xhigh", label: "fable 5 thinking xhigh", hint: "Claude Fable 5 1M Extra High Thinking (NO ZDR)", pool: "vendor" },
    { id: "gemini-3.7-flash-high", label: "gemini 3.7 flash high", hint: "Gemini 3.7 Flash", pool: "vendor" },
    { id: "claude-sonnet-5-thinking-high", label: "sonnet 5 thinking high", hint: "Claude Sonnet 5 1M Thinking", pool: "vendor" },
    { id: "claude-sonnet-5-thinking-xhigh", label: "sonnet 5 thinking xhigh", hint: "Claude Sonnet 5 1M Extra High Thinking", pool: "vendor" },
    { id: "gpt-5.6-luna-high", label: "5.6 luna high", hint: "GPT-5.6 Luna 1M High", pool: "vendor" },
    { id: "grok-4.7-low", label: "grok 4.7 low", hint: "Grok 4.7  Low", pool: "vendor" },
    { id: "grok-4.7-low-fast", label: "grok 4.7 low fast", hint: "Grok 4.7  Low Fast​​", pool: "vendor" },
    { id: "grok-4.7-medium", label: "grok 4.7 medium", hint: "Grok 4.7  Medium", pool: "vendor" },
    { id: "grok-4.7-medium-fast", label: "grok 4.7 medium fast", hint: "Grok 4.7  Medium Fast​​", pool: "vendor" },
    { id: "grok-4.7-high", label: "grok 4.7 high", hint: "Grok 4.7  High", pool: "vendor" },
    { id: "grok-4.7-high-fast", label: "grok 4.7 high fast", hint: "Grok 4.7  High Fast​​", pool: "vendor" },
    { id: "grok-4.7-xhigh", label: "grok 4.7 xhigh", hint: "Grok 4.7  Extra High", pool: "vendor" },
    { id: "grok-4.7-xhigh-fast", label: "grok 4.7 xhigh fast", hint: "Grok 4.7  Extra High Fast​​", pool: "vendor" },
    { id: "claude-opus-5-5-low", label: "opus 5 5 low", hint: "Claude Opus 5.5 1M Low", pool: "vendor" },
    { id: "claude-opus-5-5-low-fast", label: "opus 5 5 low fast", hint: "Claude Opus 5.5 1M Low Fast", pool: "vendor" },
    { id: "claude-opus-5-5-medium", label: "opus 5 5 medium", hint: "Claude Opus 5.5 1M", pool: "vendor" },
    { id: "claude-opus-5-5-medium-fast", label: "opus 5 5 medium fast", hint: "Claude Opus 5.5 1M Fast", pool: "vendor" },
    { id: "claude-opus-5-5-high", label: "opus 5 5 high", hint: "Claude Opus 5.5 1M High", pool: "vendor" },
    { id: "claude-opus-5-5-high-fast", label: "opus 5 5 high fast", hint: "Claude Opus 5.5 1M High Fast", pool: "vendor" },
    { id: "claude-opus-5-5-xhigh", label: "opus 5 5 xhigh", hint: "Claude Opus 5.5 1M Extra High", pool: "vendor" },
    { id: "claude-opus-5-5-xhigh-fast", label: "opus 5 5 xhigh fast", hint: "Claude Opus 5.5 1M Extra High Fast", pool: "vendor" },
    { id: "claude-opus-5-5-max", label: "opus 5 5 max", hint: "Claude Opus 5.5 1M Max", pool: "vendor" },
    { id: "claude-opus-5-5-max-fast", label: "opus 5 5 max fast", hint: "Claude Opus 5.5 1M Max Fast", pool: "vendor" },
    { id: "claude-opus-5-low", label: "opus 5 low", hint: "Claude Opus 5 1M Low", pool: "vendor" },
    { id: "claude-opus-5-low-fast", label: "opus 5 low fast", hint: "Claude Opus 5 1M Low Fast", pool: "vendor" },
    { id: "claude-opus-5-medium", label: "opus 5 medium", hint: "Claude Opus 5 1M Medium", pool: "vendor" },
    { id: "claude-opus-5-medium-fast", label: "opus 5 medium fast", hint: "Claude Opus 5 1M Medium Fast", pool: "vendor" },
    { id: "claude-opus-5-high", label: "opus 5 high", hint: "Claude Opus 5 1M", pool: "vendor" },
    { id: "claude-opus-5-high-fast", label: "opus 5 high fast", hint: "Claude Opus 5 1M Fast", pool: "vendor" },
    { id: "claude-opus-5-thinking-low", label: "opus 5 thinking low", hint: "Claude Opus 5 1M Low Thinking", pool: "vendor" },
    { id: "claude-opus-5-thinking-low-fast", label: "opus 5 thinking low fast", hint: "Claude Opus 5 1M Low Thinking Fast", pool: "vendor" },
    { id: "claude-opus-5-thinking-medium", label: "opus 5 thinking medium", hint: "Claude Opus 5 1M Medium Thinking", pool: "vendor" },
    { id: "claude-opus-5-thinking-medium-fast", label: "opus 5 thinking medium fast", hint: "Claude Opus 5 1M Medium Thinking Fast", pool: "vendor" },
    { id: "claude-opus-5-thinking-xhigh", label: "opus 5 thinking xhigh", hint: "Claude Opus 5 1M Extra High Thinking", pool: "vendor" },
    { id: "claude-opus-5-thinking-xhigh-fast", label: "opus 5 thinking xhigh fast", hint: "Claude Opus 5 1M Extra High Thinking Fast", pool: "vendor" },
    { id: "claude-opus-5-thinking-max", label: "opus 5 thinking max", hint: "Claude Opus 5 1M Max Thinking", pool: "vendor" },
    { id: "claude-opus-5-thinking-max-fast", label: "opus 5 thinking max fast", hint: "Claude Opus 5 1M Max Thinking Fast", pool: "vendor" },
    { id: "claude-opus-4-8-low", label: "opus 4 8 low", hint: "Claude Opus 4.8 1M Low", pool: "vendor" },
    { id: "claude-opus-4-8-low-fast", label: "opus 4 8 low fast", hint: "Claude Opus 4.8 1M Low Fast", pool: "vendor" },
    { id: "claude-opus-4-8-medium", label: "opus 4 8 medium", hint: "Claude Opus 4.8 1M Medium", pool: "vendor" },
    { id: "claude-opus-4-8-medium-fast", label: "opus 4 8 medium fast", hint: "Claude Opus 4.8 1M Medium Fast", pool: "vendor" },
    { id: "claude-opus-4-8-high", label: "opus 4 8 high", hint: "Claude Opus 4.8 1M", pool: "vendor" },
    { id: "claude-opus-4-8-high-fast", label: "opus 4 8 high fast", hint: "Claude Opus 4.8 1M Fast", pool: "vendor" },
    { id: "claude-opus-4-8-xhigh", label: "opus 4 8 xhigh", hint: "Claude Opus 4.8 1M Extra High", pool: "vendor" },
    { id: "claude-opus-4-8-xhigh-fast", label: "opus 4 8 xhigh fast", hint: "Claude Opus 4.8 1M Extra High Fast", pool: "vendor" },
    { id: "claude-opus-4-8-max", label: "opus 4 8 max", hint: "Claude Opus 4.8 1M Max", pool: "vendor" },
    { id: "claude-opus-4-8-max-fast", label: "opus 4 8 max fast", hint: "Claude Opus 4.8 1M Max Fast", pool: "vendor" },
    { id: "claude-opus-4-8-thinking-low", label: "opus 4 8 thinking low", hint: "Claude Opus 4.8 1M Low Thinking", pool: "vendor" },
    { id: "claude-opus-4-8-thinking-low-fast", label: "opus 4 8 thinking low fast", hint: "Claude Opus 4.8 1M Low Thinking Fast", pool: "vendor" },
    { id: "claude-opus-4-8-thinking-medium", label: "opus 4 8 thinking medium", hint: "Claude Opus 4.8 1M Medium Thinking", pool: "vendor" },
    { id: "claude-opus-4-8-thinking-medium-fast", label: "opus 4 8 thinking medium fast", hint: "Claude Opus 4.8 1M Medium Thinking Fast", pool: "vendor" },
    { id: "claude-opus-4-8-thinking-high", label: "opus 4 8 thinking high", hint: "Claude Opus 4.8 1M Thinking", pool: "vendor" },
    { id: "claude-opus-4-8-thinking-high-fast", label: "opus 4 8 thinking high fast", hint: "Claude Opus 4.8 1M Thinking Fast", pool: "vendor" },
    { id: "claude-opus-4-8-thinking-xhigh", label: "opus 4 8 thinking xhigh", hint: "Claude Opus 4.8 1M Extra High Thinking", pool: "vendor" },
    { id: "claude-opus-4-8-thinking-xhigh-fast", label: "opus 4 8 thinking xhigh fast", hint: "Claude Opus 4.8 1M Extra High Thinking Fast", pool: "vendor" },
    { id: "claude-opus-4-8-thinking-max", label: "opus 4 8 thinking max", hint: "Claude Opus 4.8 1M Max Thinking", pool: "vendor" },
    { id: "claude-opus-4-8-thinking-max-fast", label: "opus 4 8 thinking max fast", hint: "Claude Opus 4.8 1M Max Thinking Fast", pool: "vendor" },
    { id: "gpt-5.6-sol-none", label: "5.6 sol none", hint: "GPT-5.6 Sol 1M None", pool: "vendor" },
    { id: "gpt-5.6-sol-none-fast", label: "5.6 sol none fast", hint: "GPT-5.6 Sol 1M None Fast", pool: "vendor" },
    { id: "gpt-5.6-sol-low", label: "5.6 sol low", hint: "GPT-5.6 Sol 1M Low", pool: "vendor" },
    { id: "gpt-5.6-sol-low-fast", label: "5.6 sol low fast", hint: "GPT-5.6 Sol 1M Low Fast", pool: "vendor" },
    { id: "gpt-5.6-sol-medium", label: "5.6 sol medium", hint: "GPT-5.6 Sol 1M", pool: "vendor" },
    { id: "gpt-5.6-sol-medium-fast", label: "5.6 sol medium fast", hint: "GPT-5.6 Sol 1M Fast", pool: "vendor" },
    { id: "gpt-5.6-sol-max", label: "5.6 sol max", hint: "GPT-5.6 Sol 1M Max", pool: "vendor" },
    { id: "gpt-5.6-sol-max-fast", label: "5.6 sol max fast", hint: "GPT-5.6 Sol 1M Max Fast", pool: "vendor" },
    { id: "gpt-5.5-none", label: "5.5 none", hint: "GPT-5.5 1M None", pool: "vendor" },
    { id: "gpt-5.5-none-fast", label: "5.5 none fast", hint: "GPT-5.5 None Fast", pool: "vendor" },
    { id: "gpt-5.5-low", label: "5.5 low", hint: "GPT-5.5 1M Low", pool: "vendor" },
    { id: "gpt-5.5-low-fast", label: "5.5 low fast", hint: "GPT-5.5 Low Fast", pool: "vendor" },
    { id: "gpt-5.5-medium", label: "5.5 medium", hint: "GPT-5.5 1M", pool: "vendor" },
    { id: "gpt-5.5-medium-fast", label: "5.5 medium fast", hint: "GPT-5.5 Fast", pool: "vendor" },
    { id: "gpt-5.5-high", label: "5.5 high", hint: "GPT-5.5 1M High", pool: "vendor" },
    { id: "gpt-5.5-high-fast", label: "5.5 high fast", hint: "GPT-5.5 High Fast", pool: "vendor" },
    { id: "gpt-5.5-extra-high", label: "5.5 extra high", hint: "GPT-5.5 1M Extra High", pool: "vendor" },
    { id: "gpt-5.5-extra-high-fast", label: "5.5 extra high fast", hint: "GPT-5.5 Extra High Fast", pool: "vendor" },
    { id: "claude-fable-5-1-low", label: "fable 5 1 low", hint: "Claude Fable 5.1 1M Low (NO ZDR)", pool: "vendor" },
    { id: "claude-fable-5-1-medium", label: "fable 5 1 medium", hint: "Claude Fable 5.1 1M Medium (NO ZDR)", pool: "vendor" },
    { id: "claude-fable-5-1-high", label: "fable 5 1 high", hint: "Claude Fable 5.1 1M (NO ZDR)", pool: "vendor" },
    { id: "claude-fable-5-1-xhigh", label: "fable 5 1 xhigh", hint: "Claude Fable 5.1 1M Extra High (NO ZDR)", pool: "vendor" },
    { id: "claude-fable-5-1-max", label: "fable 5 1 max", hint: "Claude Fable 5.1 1M Max (NO ZDR)", pool: "vendor" },
    { id: "claude-fable-5-1-thinking-low", label: "fable 5 1 thinking low", hint: "Claude Fable 5.1 1M Low Thinking (NO ZDR)", pool: "vendor" },
    { id: "claude-fable-5-1-thinking-medium", label: "fable 5 1 thinking medium", hint: "Claude Fable 5.1 1M Medium Thinking (NO ZDR)", pool: "vendor" },
    { id: "claude-fable-5-1-thinking-high", label: "fable 5 1 thinking high", hint: "Claude Fable 5.1 1M Thinking (NO ZDR)", pool: "vendor" },
    { id: "claude-fable-5-1-thinking-xhigh", label: "fable 5 1 thinking xhigh", hint: "Claude Fable 5.1 1M Extra High Thinking (NO ZDR)", pool: "vendor" },
    { id: "claude-fable-5-1-thinking-max", label: "fable 5 1 thinking max", hint: "Claude Fable 5.1 1M Max Thinking (NO ZDR)", pool: "vendor" },
    { id: "claude-fable-5-low", label: "fable 5 low", hint: "Claude Fable 5 1M Low (NO ZDR)", pool: "vendor" },
    { id: "claude-fable-5-medium", label: "fable 5 medium", hint: "Claude Fable 5 1M Medium (NO ZDR)", pool: "vendor" },
    { id: "claude-fable-5-high", label: "fable 5 high", hint: "Claude Fable 5 1M (NO ZDR)", pool: "vendor" },
    { id: "claude-fable-5-xhigh", label: "fable 5 xhigh", hint: "Claude Fable 5 1M Extra High (NO ZDR)", pool: "vendor" },
    { id: "claude-fable-5-max", label: "fable 5 max", hint: "Claude Fable 5 1M Max (NO ZDR)", pool: "vendor" },
    { id: "claude-fable-5-thinking-low", label: "fable 5 thinking low", hint: "Claude Fable 5 1M Low Thinking (NO ZDR)", pool: "vendor" },
    { id: "claude-fable-5-thinking-medium", label: "fable 5 thinking medium", hint: "Claude Fable 5 1M Medium Thinking (NO ZDR)", pool: "vendor" },
    { id: "claude-fable-5-thinking-max", label: "fable 5 thinking max", hint: "Claude Fable 5 1M Max Thinking (NO ZDR)", pool: "vendor" },
    { id: "gemini-3.8-flash-low", label: "gemini 3.8 flash low", hint: "Gemini 3.8 Flash Low", pool: "vendor" },
    { id: "gemini-3.8-flash-medium", label: "gemini 3.8 flash medium", hint: "Gemini 3.8 Flash Medium", pool: "vendor" },
    { id: "gemini-3.8-flash-high", label: "gemini 3.8 flash high", hint: "Gemini 3.8 Flash High", pool: "vendor" },
    { id: "gemini-3.7-flash-low", label: "gemini 3.7 flash low", hint: "Gemini 3.7 Flash Low", pool: "vendor" },
    { id: "gemini-3.7-flash-medium", label: "gemini 3.7 flash medium", hint: "Gemini 3.7 Flash Medium", pool: "vendor" },
    { id: "muse-spark-1.3-minimal", label: "muse spark 1.3 minimal", hint: "Muse Spark 1.3 1M Minimal", pool: "vendor" },
    { id: "muse-spark-1.3-low", label: "muse spark 1.3 low", hint: "Muse Spark 1.3 1M Low", pool: "vendor" },
    { id: "muse-spark-1.3-medium", label: "muse spark 1.3 medium", hint: "Muse Spark 1.3 1M Medium", pool: "vendor" },
    { id: "muse-spark-1.3-high", label: "muse spark 1.3 high", hint: "Muse Spark 1.3 1M", pool: "vendor" },
    { id: "muse-spark-1.3-xhigh", label: "muse spark 1.3 xhigh", hint: "Muse Spark 1.3 1M Extra High", pool: "vendor" },
    { id: "muse-spark-1.3-max", label: "muse spark 1.3 max", hint: "Muse Spark 1.3 1M Max", pool: "vendor" },
    { id: "gpt-5.6-terra-none", label: "5.6 terra none", hint: "GPT-5.6 Terra 1M None", pool: "vendor" },
    { id: "gpt-5.6-terra-none-fast", label: "5.6 terra none fast", hint: "GPT-5.6 Terra 1M None Fast", pool: "vendor" },
    { id: "gpt-5.6-terra-low", label: "5.6 terra low", hint: "GPT-5.6 Terra 1M Low", pool: "vendor" },
    { id: "gpt-5.6-terra-low-fast", label: "5.6 terra low fast", hint: "GPT-5.6 Terra 1M Low Fast", pool: "vendor" },
    { id: "gpt-5.6-terra-medium", label: "5.6 terra medium", hint: "GPT-5.6 Terra 1M", pool: "vendor" },
    { id: "gpt-5.6-terra-medium-fast", label: "5.6 terra medium fast", hint: "GPT-5.6 Terra 1M Fast", pool: "vendor" },
    { id: "gpt-5.6-terra-high", label: "5.6 terra high", hint: "GPT-5.6 Terra 1M High", pool: "vendor" },
    { id: "gpt-5.6-terra-high-fast", label: "5.6 terra high fast", hint: "GPT-5.6 Terra 1M High Fast", pool: "vendor" },
    { id: "gpt-5.6-terra-xhigh", label: "5.6 terra xhigh", hint: "GPT-5.6 Terra 1M Extra High", pool: "vendor" },
    { id: "gpt-5.6-terra-xhigh-fast", label: "5.6 terra xhigh fast", hint: "GPT-5.6 Terra 1M Extra High Fast", pool: "vendor" },
    { id: "gpt-5.6-terra-max", label: "5.6 terra max", hint: "GPT-5.6 Terra 1M Max", pool: "vendor" },
    { id: "gpt-5.6-terra-max-fast", label: "5.6 terra max fast", hint: "GPT-5.6 Terra 1M Max Fast", pool: "vendor" },
    { id: "claude-sonnet-5-5-low", label: "sonnet 5 5 low", hint: "Claude Sonnet 5.5  Low", pool: "vendor" },
    { id: "claude-sonnet-5-5-medium", label: "sonnet 5 5 medium", hint: "Claude Sonnet 5.5  Medium", pool: "vendor" },
    { id: "claude-sonnet-5-5-high", label: "sonnet 5 5 high", hint: "Claude Sonnet 5.5  High", pool: "vendor" },
    { id: "claude-sonnet-5-5-xhigh", label: "sonnet 5 5 xhigh", hint: "Claude Sonnet 5.5  Extra High", pool: "vendor" },
    { id: "claude-sonnet-5-5-max", label: "sonnet 5 5 max", hint: "Claude Sonnet 5.5  Max", pool: "vendor" },
    { id: "claude-sonnet-5-low", label: "sonnet 5 low", hint: "Claude Sonnet 5 1M Low", pool: "vendor" },
    { id: "claude-sonnet-5-medium", label: "sonnet 5 medium", hint: "Claude Sonnet 5 1M Medium", pool: "vendor" },
    { id: "claude-sonnet-5-high", label: "sonnet 5 high", hint: "Claude Sonnet 5 1M", pool: "vendor" },
    { id: "claude-sonnet-5-xhigh", label: "sonnet 5 xhigh", hint: "Claude Sonnet 5 1M Extra High", pool: "vendor" },
    { id: "claude-sonnet-5-max", label: "sonnet 5 max", hint: "Claude Sonnet 5 1M Max", pool: "vendor" },
    { id: "claude-sonnet-5-thinking-low", label: "sonnet 5 thinking low", hint: "Claude Sonnet 5 1M Low Thinking", pool: "vendor" },
    { id: "claude-sonnet-5-thinking-medium", label: "sonnet 5 thinking medium", hint: "Claude Sonnet 5 1M Medium Thinking", pool: "vendor" },
    { id: "claude-sonnet-5-thinking-max", label: "sonnet 5 thinking max", hint: "Claude Sonnet 5 1M Max Thinking", pool: "vendor" },
    { id: "claude-4.6-sonnet-medium", label: "4.6 sonnet medium", hint: "Claude Sonnet 4.6 1M", pool: "vendor" },
    { id: "claude-4.6-sonnet-medium-thinking", label: "4.6 sonnet medium thinking", hint: "Claude Sonnet 4.6 1M Thinking", pool: "vendor" },
    { id: "claude-opus-4-7-low", label: "opus 4 7 low", hint: "Claude Opus 4.7 1M Low", pool: "vendor" },
    { id: "claude-opus-4-7-low-fast", label: "opus 4 7 low fast", hint: "Claude Opus 4.7 1M Low Fast", pool: "vendor" },
    { id: "claude-opus-4-7-medium", label: "opus 4 7 medium", hint: "Claude Opus 4.7 1M Medium", pool: "vendor" },
    { id: "claude-opus-4-7-medium-fast", label: "opus 4 7 medium fast", hint: "Claude Opus 4.7 1M Medium Fast", pool: "vendor" },
    { id: "claude-opus-4-7-high", label: "opus 4 7 high", hint: "Claude Opus 4.7 1M High", pool: "vendor" },
    { id: "claude-opus-4-7-high-fast", label: "opus 4 7 high fast", hint: "Claude Opus 4.7 1M High Fast", pool: "vendor" },
    { id: "claude-opus-4-7-xhigh", label: "opus 4 7 xhigh", hint: "Claude Opus 4.7 1M", pool: "vendor" },
    { id: "claude-opus-4-7-xhigh-fast", label: "opus 4 7 xhigh fast", hint: "Claude Opus 4.7 1M Fast", pool: "vendor" },
    { id: "claude-opus-4-7-max", label: "opus 4 7 max", hint: "Claude Opus 4.7 1M Max", pool: "vendor" },
    { id: "claude-opus-4-7-max-fast", label: "opus 4 7 max fast", hint: "Claude Opus 4.7 1M Max Fast", pool: "vendor" },
    { id: "claude-opus-4-7-thinking-low", label: "opus 4 7 thinking low", hint: "Claude Opus 4.7 1M Low Thinking", pool: "vendor" },
    { id: "claude-opus-4-7-thinking-low-fast", label: "opus 4 7 thinking low fast", hint: "Claude Opus 4.7 1M Low Thinking Fast", pool: "vendor" },
    { id: "claude-opus-4-7-thinking-medium", label: "opus 4 7 thinking medium", hint: "Claude Opus 4.7 1M Medium Thinking", pool: "vendor" },
    { id: "claude-opus-4-7-thinking-medium-fast", label: "opus 4 7 thinking medium fast", hint: "Claude Opus 4.7 1M Medium Thinking Fast", pool: "vendor" },
    { id: "claude-opus-4-7-thinking-high", label: "opus 4 7 thinking high", hint: "Claude Opus 4.7 1M High Thinking", pool: "vendor" },
    { id: "claude-opus-4-7-thinking-high-fast", label: "opus 4 7 thinking high fast", hint: "Claude Opus 4.7 1M High Thinking Fast", pool: "vendor" },
    { id: "claude-opus-4-7-thinking-xhigh", label: "opus 4 7 thinking xhigh", hint: "Claude Opus 4.7 1M Thinking", pool: "vendor" },
    { id: "claude-opus-4-7-thinking-xhigh-fast", label: "opus 4 7 thinking xhigh fast", hint: "Claude Opus 4.7 1M Thinking Fast", pool: "vendor" },
    { id: "claude-opus-4-7-thinking-max", label: "opus 4 7 thinking max", hint: "Claude Opus 4.7 1M Max Thinking", pool: "vendor" },
    { id: "claude-opus-4-7-thinking-max-fast", label: "opus 4 7 thinking max fast", hint: "Claude Opus 4.7 1M Max Thinking Fast", pool: "vendor" },
    { id: "gpt-5.4-low", label: "5.4 low", hint: "GPT-5.4 1M Low", pool: "vendor" },
    { id: "gpt-5.4-medium", label: "5.4 medium", hint: "GPT-5.4 1M", pool: "vendor" },
    { id: "gpt-5.4-medium-fast", label: "5.4 medium fast", hint: "GPT-5.4 Fast", pool: "vendor" },
    { id: "gpt-5.4-high", label: "5.4 high", hint: "GPT-5.4 1M High", pool: "vendor" },
    { id: "gpt-5.4-high-fast", label: "5.4 high fast", hint: "GPT-5.4 High Fast", pool: "vendor" },
    { id: "gpt-5.4-xhigh", label: "5.4 xhigh", hint: "GPT-5.4 1M Extra High", pool: "vendor" },
    { id: "gpt-5.4-xhigh-fast", label: "5.4 xhigh fast", hint: "GPT-5.4 Extra High Fast", pool: "vendor" },
    { id: "claude-4.6-opus-high", label: "4.6 opus high", hint: "Claude Opus 4.6 1M", pool: "vendor" },
    { id: "claude-4.6-opus-max", label: "4.6 opus max", hint: "Claude Opus 4.6 1M Max", pool: "vendor" },
    { id: "claude-4.6-opus-high-thinking", label: "4.6 opus high thinking", hint: "Claude Opus 4.6 1M Thinking", pool: "vendor" },
    { id: "claude-4.6-opus-max-thinking", label: "4.6 opus max thinking", hint: "Claude Opus 4.6 1M Max Thinking", pool: "vendor" },
    { id: "claude-4.5-opus-high", label: "4.5 opus high", hint: "Claude Opus 4.5", pool: "vendor" },
    { id: "claude-4.5-opus-high-thinking", label: "4.5 opus high thinking", hint: "Claude Opus 4.5 Thinking", pool: "vendor" },
    { id: "gpt-5.2-low", label: "5.2 low", hint: "GPT-5.2 Low", pool: "vendor" },
    { id: "gpt-5.2-low-fast", label: "5.2 low fast", hint: "GPT-5.2 Low Fast", pool: "vendor" },
    { id: "gpt-5.2-fast", label: "5.2 fast", hint: "GPT-5.2 Fast", pool: "vendor" },
    { id: "gpt-5.2-high", label: "5.2 high", hint: "GPT-5.2 High", pool: "vendor" },
    { id: "gpt-5.2-high-fast", label: "5.2 high fast", hint: "GPT-5.2 High Fast", pool: "vendor" },
    { id: "gpt-5.2-xhigh", label: "5.2 xhigh", hint: "GPT-5.2 Extra High", pool: "vendor" },
    { id: "gpt-5.2-xhigh-fast", label: "5.2 xhigh fast", hint: "GPT-5.2 Extra High Fast", pool: "vendor" },
    { id: "gpt-5.6-luna-none", label: "5.6 luna none", hint: "GPT-5.6 Luna 1M None", pool: "vendor" },
    { id: "gpt-5.6-luna-none-fast", label: "5.6 luna none fast", hint: "GPT-5.6 Luna 1M None Fast", pool: "vendor" },
    { id: "gpt-5.6-luna-low", label: "5.6 luna low", hint: "GPT-5.6 Luna 1M Low", pool: "vendor" },
    { id: "gpt-5.6-luna-low-fast", label: "5.6 luna low fast", hint: "GPT-5.6 Luna 1M Low Fast", pool: "vendor" },
    { id: "gpt-5.6-luna-medium", label: "5.6 luna medium", hint: "GPT-5.6 Luna 1M", pool: "vendor" },
    { id: "gpt-5.6-luna-medium-fast", label: "5.6 luna medium fast", hint: "GPT-5.6 Luna 1M Fast", pool: "vendor" },
    { id: "gpt-5.6-luna-high-fast", label: "5.6 luna high fast", hint: "GPT-5.6 Luna 1M High Fast", pool: "vendor" },
    { id: "gpt-5.6-luna-xhigh", label: "5.6 luna xhigh", hint: "GPT-5.6 Luna 1M Extra High", pool: "vendor" },
    { id: "gpt-5.6-luna-xhigh-fast", label: "5.6 luna xhigh fast", hint: "GPT-5.6 Luna 1M Extra High Fast", pool: "vendor" },
    { id: "gpt-5.6-luna-max", label: "5.6 luna max", hint: "GPT-5.6 Luna 1M Max", pool: "vendor" },
    { id: "gpt-5.6-luna-max-fast", label: "5.6 luna max fast", hint: "GPT-5.6 Luna 1M Max Fast", pool: "vendor" },
    { id: "gemini-3.6-flash-minimal", label: "gemini 3.6 flash minimal", hint: "Gemini 3.6 Flash Minimal", pool: "vendor" },
    { id: "gemini-3.6-flash-low", label: "gemini 3.6 flash low", hint: "Gemini 3.6 Flash Low", pool: "vendor" },
    { id: "gemini-3.6-flash-medium", label: "gemini 3.6 flash medium", hint: "Gemini 3.6 Flash Medium", pool: "vendor" },
    { id: "gemini-3.6-flash-high", label: "gemini 3.6 flash high", hint: "Gemini 3.6 Flash", pool: "vendor" },
    { id: "gemini-3.1-pro", label: "gemini 3.1 pro", hint: "Gemini 3.1 Pro", pool: "vendor" },
    { id: "gpt-5.4-mini-none", label: "5.4 mini none", hint: "GPT-5.4 Mini None", pool: "vendor" },
    { id: "gpt-5.4-mini-low", label: "5.4 mini low", hint: "GPT-5.4 Mini Low", pool: "vendor" },
    { id: "gpt-5.4-mini-medium", label: "5.4 mini medium", hint: "GPT-5.4 Mini", pool: "vendor" },
    { id: "gpt-5.4-mini-high", label: "5.4 mini high", hint: "GPT-5.4 Mini High", pool: "vendor" },
    { id: "gpt-5.4-mini-xhigh", label: "5.4 mini xhigh", hint: "GPT-5.4 Mini Extra High", pool: "vendor" },
    { id: "gpt-5.4-nano-none", label: "5.4 nano none", hint: "GPT-5.4 Nano None", pool: "vendor" },
    { id: "gpt-5.4-nano-low", label: "5.4 nano low", hint: "GPT-5.4 Nano Low", pool: "vendor" },
    { id: "gpt-5.4-nano-medium", label: "5.4 nano medium", hint: "GPT-5.4 Nano", pool: "vendor" },
    { id: "gpt-5.4-nano-high", label: "5.4 nano high", hint: "GPT-5.4 Nano High", pool: "vendor" },
    { id: "gpt-5.4-nano-xhigh", label: "5.4 nano xhigh", hint: "GPT-5.4 Nano Extra High", pool: "vendor" },
    { id: "claude-haiku-5-5-low", label: "haiku 5 5 low", hint: "Claude Haiku 5.5  Low No Thinking", pool: "vendor" },
    { id: "claude-haiku-5-5-medium", label: "haiku 5 5 medium", hint: "Claude Haiku 5.5  Medium No Thinking", pool: "vendor" },
    { id: "claude-haiku-5-5-high", label: "haiku 5 5 high", hint: "Claude Haiku 5.5  High No Thinking", pool: "vendor" },
    { id: "claude-haiku-5-5-xhigh", label: "haiku 5 5 xhigh", hint: "Claude Haiku 5.5  Extra High No Thinking", pool: "vendor" },
    { id: "claude-haiku-5-5-max", label: "haiku 5 5 max", hint: "Claude Haiku 5.5  Max No Thinking", pool: "vendor" },
    { id: "claude-haiku-5-5-thinking-low", label: "haiku 5 5 thinking low", hint: "Claude Haiku 5.5  Low", pool: "vendor" },
    { id: "claude-haiku-5-5-thinking-medium", label: "haiku 5 5 thinking medium", hint: "Claude Haiku 5.5  Medium", pool: "vendor" },
    { id: "claude-haiku-5-5-thinking-high", label: "haiku 5 5 thinking high", hint: "Claude Haiku 5.5  High", pool: "vendor" },
    { id: "claude-haiku-5-5-thinking-xhigh", label: "haiku 5 5 thinking xhigh", hint: "Claude Haiku 5.5  Extra High", pool: "vendor" },
    { id: "claude-haiku-5-5-thinking-max", label: "haiku 5 5 thinking max", hint: "Claude Haiku 5.5  Max", pool: "vendor" },
    { id: "claude-4.5-sonnet", label: "4.5 sonnet", hint: "Claude Sonnet 4.5", pool: "vendor" },
    { id: "claude-4.5-sonnet-thinking", label: "4.5 sonnet thinking", hint: "Claude Sonnet 4.5 Thinking", pool: "vendor" },
    { id: "gpt-5.1-low", label: "5.1 low", hint: "GPT-5.1 Low", pool: "vendor" },
    { id: "gpt-5.1", label: "5.1", hint: "GPT-5.1", pool: "vendor" },
    { id: "gpt-5.1-high", label: "5.1 high", hint: "GPT-5.1 High", pool: "vendor" },
    { id: "gemini-3-flash", label: "gemini 3 flash", hint: "Gemini 3 Flash", pool: "vendor" },
    { id: "gemini-3.5-flash", label: "gemini 3.5 flash", hint: "Gemini 3.5 Flash", pool: "vendor" },
    { id: "claude-4-sonnet", label: "4 sonnet", hint: "Claude Sonnet 4", pool: "vendor" },
    { id: "claude-4-sonnet-thinking", label: "4 sonnet thinking", hint: "Claude Sonnet 4 Thinking", pool: "vendor" },
    { id: "gpt-5-mini", label: "5 mini", hint: "GPT-5 Mini", pool: "vendor" },
    { id: "kimi-k3-low", label: "kimi k3 low", hint: "Kimi K3 Low", pool: "vendor" },
    { id: "kimi-k3-high", label: "kimi k3 high", hint: "Kimi K3 High", pool: "vendor" },
    { id: "kimi-k3-max", label: "kimi k3 max", hint: "Kimi K3", pool: "vendor" },
    { id: "kimi-k2.7-code", label: "kimi k2.7 code", hint: "Kimi K2.7 Code", pool: "vendor" },
    { id: "glm-5.2-high", label: "glm 5.2 high", hint: "GLM 5.2", pool: "vendor" },
    { id: "glm-5.2-max", label: "glm 5.2 max", hint: "GLM 5.2 Max", pool: "vendor" },
  ],
  grok: [
    { id: null, label: "default", hint: "whatever the grok CLI picks" },
    { id: "grok-4.6", label: "grok 4.6", hint: "current default" },
    { id: "grok-4.5", label: "grok 4.5", hint: "previous generation" },
  ],
  copilot: [
    { id: null, label: "default", hint: "whatever the copilot CLI picks" },
    { id: "auto", label: "auto", hint: "Copilot routes the request" },
  ],
  kilocode: [
    { id: null, label: "default", hint: "whatever the kilo CLI picks" },
    { id: "kilo-auto/free", label: "Auto Free", hint: "Kilo routes to the best available free model" },
    { id: "kilo-auto/efficient", label: "Auto Efficient", hint: "Kilo routes by task complexity and cost" },
    { id: "kilo-auto/frontier", label: "Auto Frontier", hint: "Kilo routes to its most capable models" },
    { id: "kilo/~anthropic/claude-opus-latest", label: "opus latest", hint: "Kilo Gateway pool" },
    { id: "kilo/~anthropic/claude-sonnet-latest", label: "sonnet latest", hint: "Kilo Gateway pool" },
    { id: "kilo/~anthropic/claude-haiku-latest", label: "haiku latest", hint: "Kilo Gateway pool" },
    { id: "kilo/~openai/gpt-sol-latest", label: "gpt sol latest", hint: "Kilo Gateway pool" },
    { id: "kilo/~openai/gpt-luna-latest", label: "gpt luna latest", hint: "Kilo Gateway pool" },
    { id: "kilo/~openai/gpt-mini-latest", label: "gpt mini latest", hint: "Kilo Gateway pool" },
    { id: "kilo/~google/gemini-pro-latest", label: "gemini pro latest", hint: "Kilo Gateway pool" },
    { id: "kilo/~google/gemini-flash-latest", label: "gemini flash latest", hint: "Kilo Gateway pool" },
    { id: "kilo/~x-ai/grok-latest", label: "grok latest", hint: "Kilo Gateway pool" },
    { id: "kilo/~z-ai/glm-latest", label: "glm latest", hint: "Kilo Gateway pool" },
    { id: "kilo/~moonshotai/kimi-latest", label: "kimi latest", hint: "Kilo Gateway pool" },
    { id: "kilo/~deepseek/deepseek-pro-latest", label: "deepseek pro latest", hint: "Kilo Gateway pool" },
  ],
};

export function modelLabel(
  provider: ProviderId,
  modelId: string | null,
  catalog: ModelOption[] = MODEL_CATALOG[provider],
): string | null {
  if (modelId === null) return null;
  const known = catalog.find((option) => option.id === modelId);
  return known?.label ?? modelId;
}

export function modelPool(provider: ProviderId, modelId: string | null): ModelPool | null {
  if (modelId === null) return null;
  return MODEL_CATALOG[provider].find((option) => option.id === modelId)?.pool ?? null;
}

export function isCustomModel(provider: ProviderId, modelId: string | null): boolean {
  if (modelId === null) return false;
  return !MODEL_CATALOG[provider].some((option) => option.id === modelId);
}
