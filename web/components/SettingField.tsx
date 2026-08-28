"use client";

import type { SettingField as Field, SettingValue } from "@agent-console/shared";

interface Props {
  field: Field;
  /** Pending (unsaved) value, or undefined when untouched. */
  draft: SettingValue | undefined;
  onChange(key: string, value: SettingValue): void;
  onRevert(key: string): void;
  disabled: boolean;
}

const inputClass =
  "w-full rounded border border-[#242a33] bg-[#0b0d10] px-2.5 py-1.5 text-[12px] text-[#e7ecf2] placeholder:text-[#4e5661] focus:border-[#3a4450] focus:outline-none disabled:opacity-50";

export function SettingRow({ field, draft, onChange, onRevert, disabled }: Props) {
  const value = draft ?? field.value;
  const dirty = draft !== undefined && draft !== field.value;
  const selectedOption = field.options?.find((option) => option.value === String(value));
  const dangerous =
    selectedOption?.danger === true || (field.type === "boolean" && value === true && field.dangerWhenTrue);

  return (
    <div className="grid grid-cols-1 gap-2 border-b border-[#161b21] py-3 last:border-b-0 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <label htmlFor={field.key} className="text-[12px] text-[#c3cbd6]">
            {field.label}
          </label>
          {dirty && (
            <span className="rounded bg-amber-500/15 px-1 text-[9px] uppercase tracking-wider text-amber-300">
              unsaved
            </span>
          )}
          {!dirty && field.overridden && (
            <button
              type="button"
              onClick={() => onRevert(field.key)}
              disabled={disabled}
              title="Revert to the value from .env"
              className="rounded bg-[#1b2129] px-1 text-[9px] uppercase tracking-wider text-[#7d8794] hover:text-[#d7dde5] disabled:opacity-50"
            >
              overridden ✕
            </button>
          )}
        </div>
        <div className="mt-0.5 font-mono text-[10px] text-[#4e5661]">{field.envVar}</div>
      </div>

      <div className="min-w-0">
        {field.type === "boolean" ? (
          <button
            id={field.key}
            type="button"
            role="switch"
            aria-checked={value === true}
            disabled={disabled}
            onClick={() => onChange(field.key, !(value === true))}
            className={[
              "flex h-6 w-11 items-center rounded-full border px-0.5 transition-colors disabled:opacity-50",
              value === true
                ? dangerous
                  ? "border-amber-500/40 bg-amber-500/25"
                  : "border-emerald-500/40 bg-emerald-500/25"
                : "border-[#242a33] bg-[#141920]",
            ].join(" ")}
          >
            <span
              className={[
                "size-4 rounded-full bg-[#c3cbd6] transition-transform",
                value === true ? "translate-x-5" : "translate-x-0",
              ].join(" ")}
            />
          </button>
        ) : field.type === "select" ? (
          <select
            id={field.key}
            value={String(value)}
            disabled={disabled}
            onChange={(event) => onChange(field.key, event.target.value)}
            className={`${inputClass} ${dangerous ? "border-amber-500/50 text-amber-200" : ""}`}
          >
            {field.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
                {option.hint === null ? "" : ` — ${option.hint}`}
              </option>
            ))}
          </select>
        ) : field.type === "number" ? (
          <input
            id={field.key}
            type="number"
            value={String(value)}
            disabled={disabled}
            onChange={(event) => onChange(field.key, Number(event.target.value))}
            className={inputClass}
          />
        ) : (
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
            onChange={(event) => onChange(field.key, event.target.value)}
            className={inputClass}
          />
        )}

        <p className="mt-1 text-[11px] leading-snug text-[#5b636e]">{field.description}</p>

        {dangerous && (
          <p className="mt-1 text-[11px] text-amber-400/90">
            ⚠ This value removes a safety check — the agent can act outside its sandbox.
          </p>
        )}
        {field.requiresRestart && (
          <p className="mt-1 text-[11px] text-[#7d8794]">Takes effect after a server restart.</p>
        )}
      </div>
    </div>
  );
}
