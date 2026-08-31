/**
 * Theme and motion preferences.
 *
 * Both live on `<html>` as data attributes (`data-theme`, `data-effects`) and
 * are mirrored into localStorage. The attributes are written before first paint
 * by `ThemeScript`, so a reload never flashes the wrong theme.
 */

export const THEMES = ["midnight", "deep", "daylight"] as const;
export type Theme = (typeof THEMES)[number];

export const EFFECTS = ["full", "reduced"] as const;
export type Effects = (typeof EFFECTS)[number];

export const DEFAULT_THEME: Theme = "midnight";
export const DEFAULT_EFFECTS: Effects = "full";

export const THEME_STORAGE_KEY = "agent-console.theme";
export const EFFECTS_STORAGE_KEY = "agent-console.effects";

export const THEME_META: Record<Theme, { label: string; description: string }> = {
  midnight: { label: "Midnight", description: "Layered dark. The default." },
  deep: { label: "Deep", description: "Near-black, maximum contrast." },
  daylight: { label: "Daylight", description: "Light theme." },
};

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

export function isEffects(value: unknown): value is Effects {
  return typeof value === "string" && (EFFECTS as readonly string[]).includes(value);
}

/** Applies to the document and persists. Safe to call during an event handler. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private mode or blocked storage: the choice still applies for this page.
  }
  notify();
}

export function applyEffects(effects: Effects): void {
  document.documentElement.dataset.effects = effects;
  try {
    localStorage.setItem(EFFECTS_STORAGE_KEY, effects);
  } catch {
    // As above.
  }
  notify();
}

export function readStoredTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(value)) return value;
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_THEME;
}

export function readStoredEffects(): Effects {
  try {
    const value = localStorage.getItem(EFFECTS_STORAGE_KEY);
    if (isEffects(value)) return value;
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_EFFECTS;
}

/* -------------------------------------------------------------------------- */
/* Subscription                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The theme lives on `<html>` and in localStorage — genuinely external state,
 * written before React starts. Components read it with `useSyncExternalStore`
 * rather than copying it into state inside an effect, which renders one frame
 * of the wrong value and trips React's cascading-render rule.
 */
const listeners = new Set<() => void>();

export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Reads what is actually on the document, falling back to storage. */
export function getThemeSnapshot(): Theme {
  const attribute = document.documentElement.dataset.theme;
  return isTheme(attribute) ? attribute : readStoredTheme();
}

export function getEffectsSnapshot(): Effects {
  const attribute = document.documentElement.dataset.effects;
  return isEffects(attribute) ? attribute : readStoredEffects();
}

/** The server has no document, so it always renders the default. */
export const getServerThemeSnapshot = (): Theme => DEFAULT_THEME;
export const getServerEffectsSnapshot = (): Effects => DEFAULT_EFFECTS;
