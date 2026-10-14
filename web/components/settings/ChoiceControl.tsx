"use client";

import type { KeyboardEvent } from "react";
import type { SettingOption } from "@agent-console/shared";
import { cn } from "@/lib/cn";

interface Props {
  labelledBy: string;
  value: string;
  options: SettingOption[];
  disabled: boolean;
  onChange(value: string): void;
}

/** Short enough to sit side by side as one segmented control. */
function fitsInline(options: SettingOption[]): boolean {
  return options.length <= 5 && options.reduce((total, option) => total + option.label.length, 0) <= 44;
}

/**
 * A choice between a handful of options, with every option visible. Replaces
 * the native `<select>`, which hid the alternatives behind a click and crammed
 * each one's explanation into a truncated `<option>` string.
 *
 * Only the selected option spells out its hint; the rest carry it as a tooltip.
 */
export function ChoiceControl({ labelledBy, value, options, disabled, onChange }: Props) {
  const selected = options.find((option) => option.value === value) ?? null;

  // Radio-group keyboard behaviour: arrows move the choice, not just focus.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0 || disabled) return;
    event.preventDefault();
    const current = Math.max(0, options.findIndex((option) => option.value === value));
    const next = options[(current + step + options.length) % options.length];
    if (next === undefined) return;
    onChange(next.value);
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons[options.indexOf(next)]?.focus();
  };

  if (fitsInline(options)) {
    return (
      <div className="mt-2">
        <div
          role="radiogroup"
          aria-labelledby={labelledBy}
          onKeyDown={onKeyDown}
          className="inline-flex max-w-full flex-wrap gap-0.5 rounded-lg bg-surface-2 p-0.5 ring-1 ring-inset ring-line"
        >
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={active || (selected === null && option === options[0]) ? 0 : -1}
                disabled={disabled}
                title={option.hint ?? undefined}
                onClick={() => onChange(option.value)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:opacity-50",
                  active
                    ? option.danger
                      ? "bg-warning/15 font-medium text-warning ring-1 ring-inset ring-warning/40"
                      : "bg-surface-0 font-medium text-fg shadow-sm ring-1 ring-inset ring-line-strong"
                    : "text-fg-muted hover:text-fg",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        {selected !== null && selected.hint !== null && (
          <p className="mt-1.5 text-[11px] leading-snug text-fg-dim">{selected.hint}</p>
        )}
      </div>
    );
  }

  return (
    <div role="radiogroup" aria-labelledby={labelledBy} onKeyDown={onKeyDown} className="mt-2 grid gap-1">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active || (selected === null && option === options[0]) ? 0 : -1}
            disabled={disabled}
            title={active ? undefined : (option.hint ?? undefined)}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:opacity-50",
              active
                ? option.danger
                  ? "bg-warning/10 ring-warning/40"
                  : "bg-accent/10 ring-accent/40"
                : "ring-transparent hover:bg-surface-2",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "mt-[3px] grid size-3.5 shrink-0 place-items-center rounded-full ring-1 ring-inset",
                active ? (option.danger ? "ring-warning" : "ring-accent") : "ring-line-strong",
              )}
            >
              {active && <span className={cn("size-1.5 rounded-full", option.danger ? "bg-warning" : "bg-accent")} />}
            </span>
            <span className="min-w-0">
              <span className={cn("block text-[12px]", active ? "font-medium text-fg" : "text-fg-muted", option.danger && active && "text-warning")}>
                {option.label}
              </span>
              {active && option.hint !== null && (
                <span className="mt-0.5 block text-[11px] leading-snug text-fg-dim">{option.hint}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
