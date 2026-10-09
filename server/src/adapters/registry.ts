import type { ProviderId, ProviderInfo, ProviderUsage } from "@agent-console/shared";
import { automaticModel, eligibleModels, modelAllowedInTier, modelMatchesEffort, PROVIDER_IDS, recommendedModel } from "@agent-console/shared";
import { settings } from "../settings.ts";
import { providerUsageUnavailable } from "./accountUsage.ts";
import { ClaudeAdapter } from "./claude.ts";
import { CodexAdapter } from "./codex.ts";
import { CopilotAdapter } from "./copilot.ts";
import { CursorAdapter } from "./cursor.ts";
import { GrokAdapter } from "./grok.ts";
import { KiloAdapter } from "./kilocode.ts";
import { toProviderInfo, type AgentAdapter } from "./types.ts";

/**
 * Adding a provider means adding one adapter file and one line here — the
 * transport layer and the frontend do not change.
 */
const adapters: Record<ProviderId, AgentAdapter> = {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
  cursor: new CursorAdapter(),
  grok: new GrokAdapter(),
  copilot: new CopilotAdapter(),
  kilocode: new KiloAdapter(),
};

const DETECTION_TTL_MS = 15_000;

let cache: { at: number; providers: ProviderInfo[] } | null = null;
let detectionInflight: Promise<ProviderInfo[]> | null = null;

/**
 * Stand-in adapters, for tests that need a real run — real runner, real
 * database, real status ledger — without spawning a CLI or depending on which
 * ones happen to be installed. `setPipelineStationStarter` is the same seam one
 * layer up. Nothing in the server sets these.
 */
const overrides = new Map<ProviderId, AgentAdapter>();

export function setAdapterOverride(id: ProviderId, adapter: AgentAdapter | null): void {
  if (adapter === null) overrides.delete(id);
  else overrides.set(id, adapter);
  // Detection is cached, and a cached answer about the adapter that was just
  // replaced is an answer about something else.
  cache = null;
}

export function getAdapter(id: ProviderId): AgentAdapter {
  return overrides.get(id) ?? adapters[id];
}

/** Settings toggles override detection so a disabled agent never starts a run. */
function applyEnabledGate(info: ProviderInfo): ProviderInfo {
  const tier = settings.modelAccessTier;
  const effort = settings.reasoningEffortFor(info.id);
  const selectionMode = settings.modelSelectionMode;
  const models = eligibleModels(info.id, info.models, tier, effort);
  const tierDefaultModel = recommendedModel(info.id, models, tier);
  const autoModel = selectionMode === "auto" ? automaticModel(info.id, models, tier) : null;
  const configuredModel = getAdapter(info.id).model;
  const configuredAllowed = configuredModel !== null
    && modelMatchesEffort(info.id, configuredModel, effort)
    && (tier === "all" || (
      info.models.some((model) => model.id === configuredModel)
      && modelAllowedInTier(info.id, configuredModel, tier)
    ));
  const model = selectionMode === "auto"
    ? autoModel
    : configuredAllowed
      ? configuredModel
      : tierDefaultModel;
  const common = {
    ...info,
    configuredModel,
    modelAccessTier: tier,
    reasoningEffort: effort,
    modelSelectionMode: selectionMode,
    tierDefaultModel,
    totalModels: info.models.length,
    model,
    models,
  };
  if (!settings[info.id].enabled) {
    return { ...common, available: false, reason: "Turned off on the Agents page" };
  }
  if ((selectionMode === "auto" && autoModel === null) || (selectionMode === "manual" && tier !== "all" && tierDefaultModel === null)) {
    return {
      ...common,
      available: false,
      reason: selectionMode === "auto"
        ? `No models are available for Auto Select under ${tier}`
        : `No ${tier} models are available for this account`,
    };
  }
  return common;
}

/**
 * Resolve a browser/API request against the already filtered account catalog.
 * Restricted tiers never accept a custom or stale id; All models retains the
 * old custom-id behaviour.
 */
export function resolveProviderModel(info: ProviderInfo, requested: string | null): string | null {
  if (info.modelSelectionMode === "auto") return info.model;
  if (requested === null) return info.model;
  if (info.models.some((model) => model.id === requested)) return requested;
  // All models still accepts typed custom ids, but not Cursor variants that
  // the effort filter already removed from the picker.
  if (info.modelAccessTier === "all" && modelMatchesEffort(info.id, requested, info.reasoningEffort)) {
    return requested;
  }
  return info.model;
}

export async function detectProviders(force = false): Promise<ProviderInfo[]> {
  if (!force && cache !== null && Date.now() - cache.at < DETECTION_TTL_MS) {
    return cache.providers.map(applyEnabledGate);
  }
  if (detectionInflight !== null) return (await detectionInflight).map(applyEnabledGate);
  detectionInflight = Promise.all(
    PROVIDER_IDS.map((id) => toProviderInfo(getAdapter(id))),
  ).then((providers) => {
    cache = { at: Date.now(), providers };
    return providers;
  }).finally(() => {
    detectionInflight = null;
  });
  const providers = await detectionInflight;
  return providers.map(applyEnabledGate);
}

export async function getProviderInfo(id: ProviderId): Promise<ProviderInfo> {
  const providers = await detectProviders();
  const found = providers.find((provider) => provider.id === id);
  if (found) return found;
  return applyEnabledGate(await toProviderInfo(getAdapter(id)));
}

const USAGE_TTL_MS = 60_000;

let usageCache: { at: number; usage: ProviderUsage[] } | null = null;
let usageInflight: Promise<ProviderUsage[]> | null = null;

export async function collectAccountUsage(force = false): Promise<ProviderUsage[]> {
  if (!force && usageCache !== null && Date.now() - usageCache.at < USAGE_TTL_MS) {
    return usageCache.usage;
  }
  if (usageInflight !== null) return usageInflight;
  usageInflight = (async () => {
    const providers = await detectProviders();
    const usage = await Promise.all(
      providers.map(async (info) => {
        if (!info.available) {
          return providerUsageUnavailable(info.id, info.reason ?? "provider unavailable");
        }
        try {
          return await getAdapter(info.id).getAccountUsage();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return providerUsageUnavailable(info.id, message);
        }
      }),
    );
    usageCache = { at: Date.now(), usage };
    return usage;
  })().finally(() => {
    usageInflight = null;
  });
  return usageInflight;
}
