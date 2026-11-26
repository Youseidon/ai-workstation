"use client";

import { useState, type CSSProperties } from "react";
import { formatSettingValue, type SettingScale } from "@hydra/shared";
import { cn } from "@/lib/cn";

export function ladder(scale: SettingScale, ...extra: number[]): number[] {
  const values = [...new Set([...scale.stops, ...extra])].filter((value) => Number.isFinite(value) && value >= 0);
  const sorted = values.filter((value) => value !== 0).sort((a, b) => a - b);
  if (!values.includes(0)) return sorted;
  return scale.zeroLabel === null ? [0, ...sorted] : [...sorted, 0];
}

const RAW_UNIT: Record<SettingScale["unit"], string> = {
  usd: "dollars",
  minutes: "minutes",
  ms: "ms",
  days: "days",
  bytes: "bytes",
  count: "",
};

interface Props {
  id: string;
  labelledBy: string;
  value: number;
  defaultValue: number;
  scale: SettingScale;
  disabled: boolean;
  onChange(value: number): void;
}

export function StopSlider({ id, labelledBy, value, defaultValue, scale, disabled, onChange }: Props) {
  const stops = ladder(scale, value, defaultValue);
  const last = stops.length - 1;
  const index = Math.max(0, stops.indexOf(value));
  const open = value === 0 && scale.zeroLabel !== null;
  const style = {
    "--fill": `${last === 0 ? 0 : (index / last) * 100}%`,
    ...(open ? { "--range-color": "var(--warning)" } : {}),
  } as CSSProperties;

  return (
    <div className="mt-2">
      <input
        id={id}
        type="range"
        className="ac-range"
        style={style}
        min={0}
        max={last}
        step={1}
        value={index}
        disabled={disabled}
        aria-labelledby={labelledBy}
        aria-valuetext={formatSettingValue(value, scale)}
        onChange={(event) => onChange(stops[Number(event.target.value)] ?? value)}
      />
      { }
      <div className="relative mx-2 mt-1 h-4" aria-hidden>
        {stops.map((stop, position) => (
          <button
            key={stop}
            type="button"
            tabIndex={-1}
            disabled={disabled}
            title={stop === defaultValue ? `${formatSettingValue(stop, scale)} (default)` : formatSettingValue(stop, scale)}
            onClick={() => onChange(stop)}
            style={{ left: `${last === 0 ? 0 : (position / last) * 100}%` }}
            className={cn(
              "absolute top-0 -translate-x-1/2 whitespace-nowrap rounded px-0.5 font-mono text-xs leading-4 transition-colors",
              position === index ? "text-fg" : "text-fg-dim hover:text-fg-muted",
              stop === defaultValue && position !== index && "underline decoration-dotted underline-offset-2",
            )}
          >
            {formatSettingValue(stop, scale, true)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ValueReadout({
  value,
  scale,
  disabled,
  onChange,
}: {
  value: number;
  scale: SettingScale;
  disabled: boolean;
  onChange(value: number): void;
}) {
  const [text, setText] = useState<string | null>(null);
  const open = value === 0 && scale.zeroLabel !== null;

  const commit = () => {
    if (text === null) return;
    const parsed = Number(text);
    if (text.trim() !== "" && Number.isFinite(parsed) && parsed >= 0) onChange(Math.trunc(parsed));
    setText(null);
  };

  if (text !== null) {
    const unit = scale.unit === "count" ? (scale.noun === null ? "" : `${scale.noun}s`) : RAW_UNIT[scale.unit];
    return (
      <span className="flex shrink-0 items-center gap-1.5">
        <input
          autoFocus
          type="number"
          min={0}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setText(null);
          }}
          aria-label={`Exact value${unit === "" ? "" : ` in ${unit}`}`}
          className="w-24 rounded border border-line-strong bg-surface-0 px-1.5 py-0.5 text-right font-mono text-xs text-fg focus:outline-none"
        />
        {unit !== "" && <span className="text-xs text-fg-dim">{unit}</span>}
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setText(String(value))}
      title="Type an exact value"
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 font-mono text-sm font-semibold tabular-nums transition-colors hover:bg-surface-2 disabled:opacity-50",
        open ? "text-warning" : "text-fg",
      )}
    >
      {formatSettingValue(value, scale)}
    </button>
  );
}

export function NumberStepper({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: number;
  disabled: boolean;
  onChange(value: number): void;
}) {
  const button = "grid size-6 place-items-center text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg disabled:opacity-40";
  return (
    <span className="flex shrink-0 items-center overflow-hidden rounded-md bg-surface-2 ring-1 ring-inset ring-line">
      <button type="button" aria-label="Decrease" disabled={disabled || value <= 0} onClick={() => onChange(Math.max(0, value - 1))} className={button}>
        −
      </button>
      <input
        id={id}
        type="number"
        min={0}
        value={String(value)}
        disabled={disabled}
        onChange={(event) => onChange(Math.max(0, Math.trunc(Number(event.target.value)) || 0))}
        className="w-16 bg-transparent py-0.5 text-center font-mono text-xs text-fg [appearance:textfield] focus:outline-none disabled:opacity-50 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button type="button" aria-label="Increase" disabled={disabled} onClick={() => onChange(value + 1)} className={button}>
        +
      </button>
    </span>
  );
}
