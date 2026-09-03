import type { ProviderId, ProviderInfo, ProviderUsage } from "@agent-console/shared";
import { PROVIDER_IDS } from "@agent-console/shared";
import { settings } from "../settings.ts";
import { providerUsageUnavailable } from "./accountUsage.ts";
import { ClaudeAdapter } from "./claude.ts";
import { CodexAdapter } from "./codex.ts";
import { CopilotAdapter } from "./copilot.ts";
import { CursorAdapter } from "./cursor.ts";
import { GrokAdapter } from "./grok.ts";
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
};

const DETECTION_TTL_MS = 15_000;

let cache: { at: number; providers: ProviderInfo[] } | null = null;

export function getAdapter(id: ProviderId): AgentAdapter {
  return adapters[id];
}

/** Settings toggles override detection so a disabled agent never starts a run. */
function applyEnabledGate(info: ProviderInfo): ProviderInfo {
  if (!settings[info.id].enabled) {
    return { ...info, available: false, reason: "Turned off on the Agents page" };
  }
  return info;
}

export async function detectProviders(force = false): Promise<ProviderInfo[]> {
  if (!force && cache !== null && Date.now() - cache.at < DETECTION_TTL_MS) {
    return cache.providers.map(applyEnabledGate);
  }
  const providers = await Promise.all(
    PROVIDER_IDS.map((id) => toProviderInfo(adapters[id])),
  );
  cache = { at: Date.now(), providers };
  return providers.map(applyEnabledGate);
}

export async function getProviderInfo(id: ProviderId): Promise<ProviderInfo> {
  const providers = await detectProviders();
  const found = providers.find((provider) => provider.id === id);
  if (found) return found;
  return applyEnabledGate(await toProviderInfo(adapters[id]));
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
          return await adapters[info.id].getAccountUsage();
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
