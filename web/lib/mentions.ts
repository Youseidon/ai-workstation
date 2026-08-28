import type { ProviderId, ProviderInfo } from "@agent-console/shared";
import { MODEL_CATALOG, modelLabel } from "@agent-console/shared";
import type { ModelSelection } from "./useModelSelection";

/** One selectable provider+model pair in the `@` popover. */
export interface MentionTarget {
  provider: ProviderId;
  model: string | null;
  /** Short right-hand note: the catalog hint, or why the provider is unusable. */
  hint: string;
  available: boolean;
  /** Pre-normalized haystack, so filtering does no work per keystroke. */
  search: string;
}

/** Lowercase and drop separators so `@claude:opus` matches "claude · opus 5". */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function target(
  provider: ProviderInfo,
  model: string | null,
  hint: string,
): MentionTarget {
  const label = modelLabel(provider.id, model) ?? "default";
  return {
    provider: provider.id,
    model,
    hint: provider.available ? hint : (provider.reason ?? "not detected"),
    available: provider.available,
    search: normalize(`${provider.id} ${provider.label} ${label} ${model ?? "default"}`),
  };
}

/**
 * One row per provider, showing the model it would run with right now. This is
 * what an empty `@` offers: the common case is switching provider, not model.
 */
export function currentTargets(
  providers: ProviderInfo[],
  models: ModelSelection,
): MentionTarget[] {
  return providers.map((provider) => {
    const model = models.resolve(provider.id);
    return target(provider, model, model === null ? "provider default" : "current model");
  });
}

/** Every provider × every catalogued model — the pool an actual query filters. */
export function allTargets(providers: ProviderInfo[]): MentionTarget[] {
  return providers.flatMap((provider) =>
    MODEL_CATALOG[provider.id].map((option) => target(provider, option.id, option.hint)),
  );
}

export function filterTargets(targets: MentionTarget[], query: string): MentionTarget[] {
  const needle = normalize(query);
  if (needle === "") return targets;
  const matches = targets.filter((entry) => entry.search.includes(needle));
  // Usable providers first; detection failures stay visible but out of the way.
  return matches.sort((a, b) => Number(b.available) - Number(a.available));
}

export interface MentionQuery {
  /** Text between the `@` and the caret. */
  query: string;
  /** Index of the `@`, so a selection can splice the token out. */
  start: number;
  /** Caret index — the end of the token being replaced. */
  end: number;
}

/**
 * Reads the `@token` the caret currently sits in, if any. The `@` must start a
 * word so an email address or a decorator mid-sentence never opens the popover.
 */
export function findMention(text: string, caret: number): MentionQuery | null {
  for (let index = caret - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === undefined) return null;
    if (char === "@") {
      const before = index === 0 ? " " : text[index - 1];
      if (before !== undefined && !/\s/.test(before)) return null;
      return { query: text.slice(index + 1, caret), start: index, end: caret };
    }
    // Model ids contain dots, dashes and digits; a colon lets you type
    // `@claude:opus`. Anything else ends the token.
    if (!/[A-Za-z0-9.:_-]/.test(char)) return null;
  }
  return null;
}
