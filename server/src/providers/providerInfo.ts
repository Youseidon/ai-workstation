import { MODEL_CATALOG, type ProviderInfo } from "@hydra/shared";
import type { AgentAdapter } from "../contracts/agentAdapter.ts";
import { discoverModels } from "./modelDiscovery.ts";

export async function toProviderInfo(adapter: AgentAdapter): Promise<ProviderInfo> {
  const report = await adapter.checkAvailability();
  const models = report.available
    ? await discoverModels(adapter.id, report.binary)
    : MODEL_CATALOG[adapter.id];
  return {
    id: adapter.id,
    commandEnforcement: "cooperative",
    label: adapter.label,
    available: report.available,
    reason: report.reason,
    version: report.version,
    transport: adapter.transport,
    binary: report.binary,
    cooling: null,
    reportsTokens: adapter.reportsTokens,
    permissionMode: adapter.permissionMode,
    model: adapter.model,
    configuredModel: adapter.model,
    modelAccessTier: "all",
    reasoningEffort: "medium",
    modelSelectionMode: "manual",
    tierDefaultModel: null,
    totalModels: models.length,
    models,
  };
}
