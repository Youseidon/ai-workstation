import { modelMatchesEffort, type ProviderInfo } from "@hydra/shared";

export function modelChoice(
  provider: ProviderInfo,
  pin: string | null | undefined,
) {
  const saved = pin !== undefined;
  const active =
    saved &&
    provider.modelSelectionMode !== "auto" &&
    (provider.models.some((model) => model.id === pin) ||
      (provider.modelAccessTier === "all" &&
        modelMatchesEffort(provider.id, pin, provider.reasoningEffort)));
  return {
    saved,
    active,
    configured: pin,
    effective: active ? (pin ?? provider.model) : provider.model,
  };
}
