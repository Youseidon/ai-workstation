"use client";

import { useState, type ReactNode } from "react";
import { formatSettingValue, type SettingField as Field, type SettingValue } from "@agent-console/shared";
import { ChoiceControl } from "@/components/settings/ChoiceControl";
import { NumberStepper, StopSlider, ValueReadout } from "@/components/settings/StopSlider";
import { Switch } from "@/components/ui/Switch";
import { cn } from "@/lib/cn";

interface Props {
  field: Field;
  /** Pending (unsaved) value, or undefined when untouched. */
  draft: SettingValue | undefined;
  onChange(key: string, value: SettingValue): void;
  onRevert(key: string): void;
  disabled: boolean;
  /** Extra context under the control, e.g. what a spend cap buys per agent. */
  footer?: ReactNode;
}

const inputClass =
  "mt-2 w-full rounded-md border border-line bg-surface-0 px-2.5 py-1.5 text-[12px] text-fg placeholder:text-fg-dim focus:border-line-strong focus:outline-none disabled:opacity-50";

/**
 * One setting: its name and current value on a single line, the control under
 * it, and the long explanation folded behind "?" for the times it is wanted.
 */
export function SettingRow({ field, draft, onChange, onRevert, disabled, footer }: Props) {
  const [explained, setExplained] = useState(false);
  const value = draft ?? field.value;
  const dirty = draft !== undefined && draft !== field.value;
  const selectedOption = field.options?.find((option) => option.value === String(value));
  const dangerous =
    selectedOption?.danger === true || (field.type === "boolean" && value === true && field.dangerWhenTrue);
  const labelId = `${field.key}-label`;
  const numeric = typeof value === "number" ? value : Number(value) || 0;
  const set = (next: SettingValue) => onChange(field.key, next);

  return (
    <div className="border-b border-line py-3 last:border-b-0">
      <div className="flex min-h-6 items-center gap-2">
        <label id={labelId} htmlFor={field.key} className="min-w-0 truncate text-[12px] font-medium text-fg">
          {field.label}
        </label>
        <button
          type="button"
          aria-expanded={explained}
          aria-label={`${explained ? "Hide" : "Explain"} ${field.label}`}
          onClick={() => setExplained((current) => !current)}
          className={cn(
            "grid size-4 shrink-0 place-items-center rounded-full text-[10px] leading-none ring-1 ring-inset transition-colors",
            explained ? "bg-accent/15 text-accent ring-accent/40" : "text-fg-dim ring-line hover:text-fg",
          )}
        >
          ?
        </button>
        {dirty && (
          <span className="shrink-0 rounded bg-warning/15 px-1 text-[9px] uppercase tracking-wider text-warning">unsaved</span>
        )}
        {!dirty && field.overridden && (
          <button
            type="button"
            onClick={() => onRevert(field.key)}
            disabled={disabled}
            title="Revert to the value from .env"
            className="shrink-0 rounded bg-surface-2 px-1 text-[9px] uppercase tracking-wider text-fg-muted hover:text-fg disabled:opacity-50"
          >
            reset
          </button>
        )}
        {field.requiresRestart && (
          <span title="Takes effect after a server restart" className="shrink-0 rounded bg-surface-2 px-1 text-[9px] uppercase tracking-wider text-fg-dim">
            restart
          </span>
        )}
        <span className="flex-1" />
        {field.type === "boolean" ? (
          <Switch
            id={field.key}
            checked={value === true}
            disabled={disabled}
            onCheckedChange={set}
            className={value === true && dangerous ? "!bg-warning" : undefined}
          />
        ) : field.type === "number" && field.scale !== null ? (
          <ValueReadout value={numeric} scale={field.scale} disabled={disabled} onChange={set} />
        ) : field.type === "number" ? (
          <NumberStepper id={field.key} value={numeric} disabled={disabled} onChange={set} />
        ) : null}
      </div>

      {field.type === "select" && field.options !== null ? (
        <ChoiceControl labelledBy={labelId} value={String(value)} options={field.options} disabled={disabled} onChange={set} />
      ) : field.type === "number" && field.scale !== null ? (
        <StopSlider
          id={field.key}
          labelledBy={labelId}
          value={numeric}
          defaultValue={typeof field.defaultValue === "number" ? field.defaultValue : numeric}
          scale={field.scale}
          disabled={disabled}
          onChange={set}
        />
      ) : field.type === "boolean" || field.type === "number" ? null : (
        <input
          id={field.key}
          type={field.type === "password" ? "password" : "text"}
          value={String(value)}
          disabled={disabled}
          spellCheck={false}
          autoComplete={field.type === "password" ? "new-password" : "off"}
          placeholder={
            field.type === "password" && field.isSet
              ? "•••••••• (saved — type to replace)"
              : (field.placeholder ?? "")
          }
          onChange={(event) => set(event.target.value)}
          className={inputClass}
        />
      )}

      {footer}

      {dangerous && (
        <p className="mt-1.5 text-[11px] text-warning/90">⚠ Removes a safety check.</p>
      )}

      {explained && (
        <div className="mt-2 rounded-md bg-surface-2/60 px-2.5 py-2 text-[11px] leading-snug text-fg-muted">
          <p>{field.description}</p>
          <p className="mt-1.5 font-mono text-[10px] text-fg-dim">
            {field.envVar}
            {field.type === "number" && typeof field.defaultValue === "number" && (
              <> · default {field.scale === null ? field.defaultValue : formatSettingValue(field.defaultValue, field.scale)}</>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
