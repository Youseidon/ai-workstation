"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelOption, ModelPool, ProviderId } from "@agent-console/shared";
import { MODEL_CATALOG, MODEL_POOLS, MODEL_POOL_LABEL, isCustomModel } from "@agent-console/shared";
import { providerTheme } from "@/lib/providerTheme";

interface Props {
  provider: ProviderId;
  /** Currently selected model id; `null` is the provider's own default. */
  selected: string | null;
  /** The model configured in settings, shown as the inherited value. */
  configured: string | null;
  /** False when the selection is inherited from settings rather than pinned. */
  pinned: boolean;
  onSelect(model: string | null): void;
  /** Drop the pin so this provider tracks its settings value again. */
  onClear(): void;
  onClose(): void;
}

/**
 * Groups a catalog into its pools, preserving catalog order inside each. An
 * entry without a pool (every provider but cursor, plus the `default` row) goes
 * into the leading ungrouped section so single-pool providers render as a flat
 * list exactly as before.
 */
function groupByPool(options: ModelOption[]): Array<{ pool: ModelPool | null; options: ModelOption[] }> {
  const ungrouped = options.filter((option) => option.pool === undefined);
  const sections: Array<{ pool: ModelPool | null; options: ModelOption[] }> = [];
  if (ungrouped.length > 0) sections.push({ pool: null, options: ungrouped });
  for (const pool of MODEL_POOLS) {
    const group = options.filter((option) => option.pool === pool);
    if (group.length > 0) sections.push({ pool, options: group });
  }
  return sections;
}

/**
 * The dropdown behind a provider pill's model half. Catalog entries first, then
 * a free-text row so a model newer than the catalog is still reachable.
 *
 * Cursor's catalog is generated from the CLI and runs to a couple of hundred
 * entries, so the list is filtered and split by pool. The other providers have
 * a handful each and fall through to the same code as one unlabelled section.
 */
export function ModelMenu({
  provider,
  selected,
  configured,
  pinned,
  onSelect,
  onClear,
  onClose,
}: Props) {
  const [custom, setCustom] = useState(isCustomModel(provider, selected) ? (selected ?? "") : "");
  const [filter, setFilter] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const theme = providerTheme[provider];
  const options = MODEL_CATALOG[provider];

  // Matched against id, label and hint together: "opus thinking" and "1M" and
  // "grok" all have to find the same row.
  const sections = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched = needle === ""
      ? options
      : options.filter((option) =>
          `${option.id ?? ""} ${option.label} ${option.hint}`.toLowerCase().includes(needle),
        );
    return groupByPool(matched);
  }, [options, filter]);

  const matchCount = sections.reduce((total, section) => total + section.options.length, 0);
  const filterable = options.length > 12;

  // Click-away and Escape both close, so the menu never strands the header.
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const submitCustom = () => {
    const value = custom.trim();
    if (value === "") return;
    onSelect(value);
  };

  return (
    <div
      ref={containerRef}
      role="listbox"
      aria-label={`${provider} model`}
      className="absolute left-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-md border border-line bg-surface-1 shadow-xl shadow-black/50"
    >
      <div className="flex items-baseline gap-2 border-b border-line px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-fg-dim">
        <span>{provider} model</span>
        <span className="ml-auto normal-case tracking-normal">{options.length} available</span>
      </div>

      {filterable && (
        <div className="border-b border-line p-1.5">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="filter…"
            spellCheck={false}
            className="w-full rounded border border-line bg-surface-1 px-2 py-1 text-[11px] text-fg placeholder:text-fg-dim focus:border-line focus:outline-none"
          />
        </div>
      )}

      <div className="max-h-72 overflow-y-auto py-1">
        {matchCount === 0 && (
          <div className="px-2.5 py-2 text-[11px] text-fg-dim">
            no model matches “{filter.trim()}” — type it below to use it anyway
          </div>
        )}
        {sections.map((section) => (
          <div key={section.pool ?? "__ungrouped__"}>
            {section.pool !== null && (
              <div className="sticky top-0 z-10 flex items-baseline gap-2 bg-surface-1 px-2.5 py-1 text-[10px] uppercase tracking-wider text-fg-dim">
                <span>{MODEL_POOL_LABEL[section.pool]}</span>
                <span className="ml-auto normal-case tracking-normal">{section.options.length}</span>
              </div>
            )}
            {section.options.map((option) => {
              const isSelected = option.id === selected;
              const isConfigured = option.id === configured;
              return (
                <button
                  key={option.id ?? "__default__"}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => onSelect(option.id)}
                  className={[
                    "flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-xs transition-colors",
                    isSelected ? theme.chip : "text-fg-muted hover:bg-surface-2",
                  ].join(" ")}
                >
                  <span className={isSelected ? "" : "text-fg-dim"}>{isSelected ? "●" : "○"}</span>
                  <span className="shrink-0 truncate">{option.label}</span>
                  <span className="ml-auto shrink-0 truncate pl-2 text-right text-[10px] text-fg-dim">
                    {isConfigured && !isSelected ? "from settings" : option.hint}
                  </span>
                </button>
              );
            })}
          </div>
        ))}

        {isCustomModel(provider, selected) && (
          <div className={`mx-2 my-1 rounded px-1.5 py-1 text-[10px] ${theme.chip}`}>
            custom · {selected}
          </div>
        )}
      </div>

      <div className="border-t border-line p-2">
        <div className="flex gap-1.5">
          <input
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              submitCustom();
            }}
            placeholder="custom model id…"
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-line bg-surface-1 px-2 py-1 text-[11px] text-fg placeholder:text-fg-dim focus:border-line focus:outline-none"
          />
          <button
            type="button"
            onClick={submitCustom}
            disabled={custom.trim() === ""}
            className="shrink-0 rounded border border-line bg-surface-2 px-2 text-[11px] text-fg-muted transition-colors hover:bg-surface-3 disabled:opacity-40"
          >
            use
          </button>
        </div>
        {pinned && (
          <button
            type="button"
            onClick={onClear}
            className="mt-1.5 w-full rounded px-2 py-1 text-left text-[10px] text-fg-dim transition-colors hover:text-fg-muted"
          >
            ↺ follow settings{configured === null ? "" : ` (${configured})`}
          </button>
        )}
      </div>
    </div>
  );
}
