import type { ProviderId, ProviderInfo } from "@hydra/shared";
import { modelLabel } from "@hydra/shared";
import type { ModelSelection } from "../../providers/hooks/useModelSelection";

export interface MentionTarget {
  provider: ProviderId;
  model: string | null;
  hint: string;
  available: boolean;
  search: string;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function target(
  provider: ProviderInfo,
  model: string | null,
  hint: string,
): MentionTarget {
  const label = modelLabel(provider.id, model, provider.models) ?? "default";
  return {
    provider: provider.id,
    model,
    hint: provider.available ? hint : (provider.reason ?? "not detected"),
    available: provider.available,
    search: normalize(`${provider.id} ${provider.label} ${label} ${model ?? "default"}`),
  };
}

export function currentTargets(
  providers: ProviderInfo[],
  models: ModelSelection,
): MentionTarget[] {
  return providers.map((provider) => {
    const model = models.resolve(provider.id);
    return target(provider, model, model === null ? "provider default" : "current model");
  });
}

export function allTargets(providers: ProviderInfo[]): MentionTarget[] {
  return providers.flatMap((provider) =>
    provider.modelSelectionMode === "auto"
      ? [target(provider, provider.model, "Auto Select")]
      : provider.models.map((option) => target(provider, option.id, option.hint)),
  );
}

export function filterTargets(targets: MentionTarget[], query: string): MentionTarget[] {
  const needle = normalize(query);
  if (needle === "") return targets;
  const matches = targets.filter((entry) => entry.search.includes(needle));
  return matches.sort((a, b) => Number(b.available) - Number(a.available));
}

export interface MentionQuery {
  query: string;
  start: number;
  end: number;
}

export function findMention(text: string, caret: number): MentionQuery | null {
  for (let index = caret - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === undefined) return null;
    if (char === "@") {
      const before = index === 0 ? " " : text[index - 1];
      if (before !== undefined && !/\s/.test(before)) return null;
      return { query: text.slice(index + 1, caret), start: index, end: caret };
    }
    if (!/[A-Za-z0-9.:_-]/.test(char)) return null;
  }
  return null;
}
