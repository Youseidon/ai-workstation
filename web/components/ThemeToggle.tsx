"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";
import {
  applyEffects,
  applyTheme,
  getEffectsSnapshot,
  getServerEffectsSnapshot,
  getServerThemeSnapshot,
  getThemeSnapshot,
  subscribeAppearance,
  THEMES,
  THEME_META,
  type Theme,
} from "@/lib/theme";

/**
 * Appearance controls: theme, and a switch that turns off ambient motion and
 * blur for anyone who wants a calm UI without changing their OS setting.
 *
 * The current theme is read from `<html>` through `useSyncExternalStore`.
 * `ThemeScript` stamps it there before React runs, so there is nothing to copy
 * into component state and no frame where the wrong theme is shown.
 */
export function ThemeToggle() {
  const [open, setOpen] = useState(false);
  // Read straight from the document, which ThemeScript already stamped before
  // React ran — no effect, no extra frame showing the wrong theme.
  const theme = useSyncExternalStore(subscribeAppearance, getThemeSnapshot, getServerThemeSnapshot);
  const effects = useSyncExternalStore(subscribeAppearance, getEffectsSnapshot, getServerEffectsSnapshot);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const pickTheme = (next: Theme) => applyTheme(next);
  const toggleEffects = () => applyEffects(effects === "full" ? "reduced" : "full");

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Appearance"
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-fg-dim ring-1 ring-inset ring-line transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 2.75v10.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 13.25A5.25 5.25 0 0 0 8 2.75z" fill="currentColor" />
        </svg>
        <span className="hidden sm:inline">Theme</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Appearance"
          className="glass absolute bottom-full left-0 z-40 mb-2 w-60 animate-slide-up rounded-lg p-2 shadow-xl"
        >
          <p className="px-2 pb-1.5 pt-1 text-[10px] uppercase tracking-wider text-fg-dim">Theme</p>
          {THEMES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => pickTheme(option)}
              aria-pressed={theme === option}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
                theme === option ? "bg-accent/12 text-accent" : "text-fg-muted hover:bg-surface-3 hover:text-fg",
              )}
            >
              <ThemeSwatch theme={option} />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium">{THEME_META[option].label}</span>
                <span className="block truncate text-[10.5px] text-fg-dim">
                  {THEME_META[option].description}
                </span>
              </span>
              {theme === option && <span aria-hidden>✓</span>}
            </button>
          ))}

          <div className="mt-1.5 border-t border-line pt-1.5">
            <button
              type="button"
              onClick={toggleEffects}
              aria-pressed={effects === "reduced"}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg"
            >
              <span
                aria-hidden
                className={cn(
                  "relative h-4 w-7 shrink-0 rounded-full transition-colors",
                  effects === "reduced" ? "bg-accent/60" : "bg-surface-3 ring-1 ring-inset ring-line",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 size-3 rounded-full bg-fg transition-[left]",
                    effects === "reduced" ? "left-3.5" : "left-0.5",
                  )}
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium">Reduce effects</span>
                <span className="block truncate text-[10.5px] text-fg-dim">
                  Turns off ambient motion and blur.
                </span>
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A miniature of the theme: its surface, its line, and its accent. */
function ThemeSwatch({ theme }: { theme: Theme }) {
  return (
    <span
      data-theme={theme}
      aria-hidden
      className="flex size-5 shrink-0 items-center justify-center rounded-md border border-line bg-surface-0"
    >
      <span className="size-2 rounded-full bg-accent" />
    </span>
  );
}
