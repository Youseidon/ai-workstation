import type { ProviderId, ProviderInfo } from "@agent-console/shared";
import { PROVIDER_IDS } from "@agent-console/shared";
import { ClaudeAdapter } from "./claude.ts";
import { CodexAdapter } from "./codex.ts";
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
};

const DETECTION_TTL_MS = 15_000;

let cache: { at: number; providers: ProviderInfo[] } | null = null;

export function getAdapter(id: ProviderId): AgentAdapter {
  return adapters[id];
}

export async function detectProviders(force = false): Promise<ProviderInfo[]> {
  if (!force && cache !== null && Date.now() - cache.at < DETECTION_TTL_MS) {
    return cache.providers;
  }
  const providers = await Promise.all(
    PROVIDER_IDS.map((id) => toProviderInfo(adapters[id])),
  );
  cache = { at: Date.now(), providers };
  return providers;
}

export async function getProviderInfo(id: ProviderId): Promise<ProviderInfo> {
  const providers = await detectProviders();
  const found = providers.find((provider) => provider.id === id);
  if (found) return found;
  return toProviderInfo(adapters[id]);
}
