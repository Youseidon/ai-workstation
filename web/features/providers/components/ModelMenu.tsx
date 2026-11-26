"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ModelAccessTier, ModelOption, ModelSelectionMode, ProviderId } from "@hydra/shared";
import { classifyModel, MODEL_ACCESS_TIER_INFO, modelFamily, modelLabel } from "@hydra/shared";
import { providerTheme } from "@/features/providers/lib/providerTheme";

interface Props {
  boundaryRef?: RefObject<HTMLElement | null>;
  provider: ProviderId;
  options: ModelOption[];
  accessTier: ModelAccessTier;
  selectionMode: ModelSelectionMode;
  recommended: string | null;
  totalModels: number;
  selected: string | null;
  configured: string | null;
  pinned: boolean;
  onSelect(model: string | null): void;
  onClear(): void;
  onClose(): void;
  placement?: "below" | "above";
}

function groupByFamily(options: ModelOption[]): Array<{ family: string | null; options: ModelOption[] }> {
  if (options.length <= 12) return [{ family: null, options }];
  const sections: Array<{ family: string | null; options: ModelOption[] }> = [];
  for (const option of options) {
    const family = modelFamily(option.id);
    const existing = sections.find((section) => section.family === family);
    if (existing === undefined) sections.push({ family, options: [option] });
    else existing.options.push(option);
  }
  return sections;
}

export function ModelMenu({
  boundaryRef,
  provider,
  options,
  accessTier,
  selectionMode,
  recommended,
  totalModels,
  selected,
  configured,
  pinned,
  onSelect,
  onClear,
  onClose,
  placement = "below",
}: Props) {
  const isCustom = selected !== null && !options.some((option) => option.id === selected);
  const [custom, setCustom] = useState(isCustom ? (selected ?? "") : "");
  const [filter, setFilter] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const theme = providerTheme[provider];

  const sections = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched = needle === ""
      ? options
      : options.filter((option) =>
          `${option.id ?? ""} ${option.label} ${option.hint}`.toLowerCase().includes(needle),
        );
    return groupByFamily(matched);
  }, [options, filter]);

  const matchCount = sections.reduce((total, section) => total + section.options.length, 0);
  const filterable = options.length > 12;

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node) && !boundaryRef?.current?.contains(event.target as Node)) onClose();
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
  }, [onClose,boundaryRef]);

  const submitCustom = () => {
    const value = custom.trim();
    if (value === "") return;
    onSelect(value);
  };

  if (selectionMode === "auto") {
    return (
      <div
        ref={containerRef}
        className={`absolute left-0 z-30 ${placement === "above" ? "bottom-full mb-1" : "top-full mt-1"} w-64 overflow-hidden rounded-md border border-line bg-surface-1 p-2.5 shadow-xl shadow-black/50`}
      >
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-fg-dim">
          <span>{provider} model</span>
          <span className="rounded bg-accent/10 px-1.5 py-0.5 normal-case tracking-normal text-accent">Auto Select</span>
        </div>
        <div className={`mt-2 rounded px-2 py-1.5 text-xs ${theme.chip}`}>
          {modelLabel(provider, selected, options) ?? "No eligible model"}
        </div>
        <p className="mt-2 text-xs leading-snug text-fg-dim">
          The server selects the model within the {MODEL_ACCESS_TIER_INFO[accessTier].label} tier. Switch to Manual on Agents to override it.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      role="listbox"
      aria-label={`${provider} model`}
      className={`absolute left-0 z-30 ${placement === "above" ? "bottom-full mb-1" : "top-full mt-1"} w-64 overflow-hidden rounded-md border border-line bg-surface-1 shadow-xl shadow-black/50`}
    >
      <div className="flex items-baseline gap-2 border-b border-line px-2.5 py-1.5 text-xs uppercase tracking-wider text-fg-dim">
        <span>{provider} model</span>
        <span className="rounded bg-surface-3 px-1.5 py-0.5 normal-case tracking-normal text-fg-muted">
          {MODEL_ACCESS_TIER_INFO[accessTier].shortLabel}
        </span>
        <span className="ml-auto normal-case tracking-normal">
          {options.length}{totalModels !== options.length ? ` of ${totalModels}` : ""} available
        </span>
      </div>

      {filterable && (
        <div className="border-b border-line p-1.5">
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="filter…"
            spellCheck={false}
            className="w-full rounded border border-line bg-surface-1 px-2 py-1 text-xs text-fg placeholder:text-fg-dim focus:border-line focus:outline-none"
          />
        </div>
      )}

      <div className="max-h-72 overflow-y-auto py-1">
        {matchCount === 0 && (
          <div className="px-2.5 py-2 text-xs text-fg-dim">
            no model matches “{filter.trim()}” — type it below to use it anyway
          </div>
        )}
        {sections.map((section) => (
          <div key={section.family ?? "__ungrouped__"}>
            {section.family !== null && (
              <div className="sticky top-0 z-10 flex items-baseline gap-2 bg-surface-1 px-2.5 py-1 text-xs uppercase tracking-wider text-fg-dim">
                <span>{section.family}</span>
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
                  {option.id === recommended && (
                    <span className="shrink-0 rounded bg-accent/10 px-1 text-xs uppercase tracking-wide text-accent">
                      recommended
                    </span>
                  )}
                  <span className="ml-auto shrink-0 truncate pl-2 text-right text-xs text-fg-dim">
                    {isConfigured && !isSelected
                      ? "from settings"
                      : option.id === null
                        ? option.hint
                        : `${classifyModel(provider, option.id) ?? "unclassified"} · ${option.hint}`}
                  </span>
                </button>
              );
            })}
          </div>
        ))}

        {isCustom && (
          <div className={`mx-2 my-1 rounded px-1.5 py-1 text-xs ${theme.chip}`}>
            custom · {selected}
          </div>
        )}
      </div>

      <div className="border-t border-line p-2">
        {accessTier !== "all" && (
          <p className="mb-1.5 text-xs leading-snug text-fg-dim">
            Showing models allowed by {MODEL_ACCESS_TIER_INFO[accessTier].label}. Change the global tier on Agents to see more.
          </p>
        )}
        {accessTier === "all" && (
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
            className="min-w-0 flex-1 rounded border border-line bg-surface-1 px-2 py-1 text-xs text-fg placeholder:text-fg-dim focus:border-line focus:outline-none"
          />
          <button
            type="button"
            onClick={submitCustom}
            disabled={custom.trim() === ""}
            className="shrink-0 rounded border border-line bg-surface-2 px-2 text-xs text-fg-muted transition-colors hover:bg-surface-3 disabled:opacity-40"
          >
            use
          </button>
        </div>
        )}
        {pinned && (
          <button
            type="button"
            onClick={onClear}
            className="mt-1.5 w-full rounded px-2 py-1 text-left text-xs text-fg-dim transition-colors hover:text-fg-muted"
          >
            ↺ follow settings{configured === null ? "" : ` (${configured})`}
          </button>
        )}
      </div>
    </div>
  );
}
