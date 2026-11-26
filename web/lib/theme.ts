export const THEMES = ["midnight", "deep", "daylight"] as const;
export type Theme = (typeof THEMES)[number];

export const EFFECTS = ["full", "reduced"] as const;
export type Effects = (typeof EFFECTS)[number];

export const DEFAULT_THEME: Theme = "midnight";
export const DEFAULT_EFFECTS: Effects = "full";

export const THEME_STORAGE_KEY = "hydra.theme";
export const EFFECTS_STORAGE_KEY = "hydra.effects";

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

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
  }
  notify();
}

export function applyEffects(effects: Effects): void {
  document.documentElement.dataset.effects = effects;
  try {
    localStorage.setItem(EFFECTS_STORAGE_KEY, effects);
  } catch {
  }
  notify();
}

export function readStoredTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(value)) return value;
  } catch {
  }
  return DEFAULT_THEME;
}

export function readStoredEffects(): Effects {
  try {
    const value = localStorage.getItem(EFFECTS_STORAGE_KEY);
    if (isEffects(value)) return value;
  } catch {
  }
  return DEFAULT_EFFECTS;
}

const listeners = new Set<() => void>();

export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function getThemeSnapshot(): Theme {
  const attribute = document.documentElement.dataset.theme;
  return isTheme(attribute) ? attribute : readStoredTheme();
}

export function getEffectsSnapshot(): Effects {
  const attribute = document.documentElement.dataset.effects;
  return isEffects(attribute) ? attribute : readStoredEffects();
}

export const getServerThemeSnapshot = (): Theme => DEFAULT_THEME;
export const getServerEffectsSnapshot = (): Effects => DEFAULT_EFFECTS;
