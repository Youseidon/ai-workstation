"use client";

import { cn } from "@/lib/cn";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange(next: boolean): void;
  disabled?: boolean;
  id?: string;
  /** Accessible name when no visible label is associated via `htmlFor`. */
  "aria-label"?: string;
  className?: string;
}

/**
 * Small on/off control. Colours come from theme tokens so the knob stays
 * legible when the page flips between light and dark.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  id,
  "aria-label": ariaLabel,
  className,
}: SwitchProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors",
        "disabled:pointer-events-none disabled:opacity-40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        checked ? "bg-accent" : "bg-surface-3",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none size-5 rounded-full bg-surface-0 shadow-sm transition-transform",
          checked ? "translate-x-5" : "translate-x-0",
        )}
      />
    </button>
  );
}
