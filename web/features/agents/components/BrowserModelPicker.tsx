"use client";

import { useState } from "react";
import {
  classifyModel,
  modelLabel,
  MODEL_ACCESS_TIER_INFO,
  type ProviderInfo,
} from "@hydra/shared";
import { providerTheme } from "@/features/providers/lib/providerTheme";
import { cn } from "@/lib/cn";

export function BrowserModelPicker({
  provider,
  selected,
  pinned,
  onSelect,
  onClear,
}: {
  provider: ProviderInfo;
  selected: string | null;
  pinned: boolean;
  onSelect(model: string | null): void;
  onClear(): void;
}) {
  const [custom, setCustom] = useState(
    selected !== null &&
      !provider.models.some((option) => option.id === selected)
      ? selected
      : "",
  );
  const [filter, setFilter] = useState("");
  const theme = providerTheme[provider.id];
  const needle = filter.trim().toLowerCase();
  const options =
    needle === ""
      ? provider.models
      : provider.models.filter((option) =>
          `${option.id ?? ""} ${option.label} ${option.hint}`
            .toLowerCase()
            .includes(needle),
        );

  if (provider.modelSelectionMode === "auto") {
    return (
      <div>
        <div className="mb-2 flex items-center gap-2 text-xs text-fg-dim">
          <span className="rounded bg-accent/10 px-1.5 py-0.5 font-medium text-accent">
            Auto Select
          </span>
          <span>{MODEL_ACCESS_TIER_INFO[provider.modelAccessTier].label}</span>
        </div>
        <div
          className={cn(
            "rounded-md px-2.5 py-2 text-xs ring-1 ring-inset",
            theme.chip,
          )}
        >
          <div className="font-medium">
            {modelLabel(provider.id, provider.model, provider.models) ??
              "No eligible model"}
          </div>
          <p className="mt-1 text-xs leading-snug text-fg-dim">
            Selected by the server. Change Model choice to Manual in the policy
            controls to choose a model.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-xs text-fg-dim">
        <span className="rounded bg-surface-3 px-1.5 py-0.5 text-fg-muted">
          {MODEL_ACCESS_TIER_INFO[provider.modelAccessTier].label}
        </span>
        {provider.id === "cursor" && (
          <span className="rounded bg-surface-3 px-1.5 py-0.5 capitalize text-fg-muted">
            {provider.reasoningEffort} effort
          </span>
        )}
        <span>
          {provider.models.length}
          {provider.totalModels !== provider.models.length
            ? ` of ${provider.totalModels}`
            : ""}{" "}
          models
        </span>
      </div>
      {provider.models.length > 8 && (
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          aria-label="Search models"
          placeholder="Search model, family, or capability…"
          spellCheck={false}
          className="mb-2 w-full rounded border border-line bg-surface-0 px-2 py-1.5 text-xs text-fg placeholder:text-fg-dim focus:outline-none"
        />
      )}
      <div className="flex flex-wrap gap-1">
        {options.map((option) => {
          const isSelected = option.id === selected;
          return (
            <button
              key={option.id ?? "__default__"}
              type="button"
              title={`${option.id === null ? "provider default" : (classifyModel(provider.id, option.id) ?? "unclassified")} · ${option.hint}`}
              onClick={() => onSelect(option.id)}
              className={cn(
                "rounded-md px-2 py-1 text-xs transition-colors ring-1 ring-inset",
                isSelected
                  ? theme.chip
                  : "text-fg-muted ring-line hover:bg-surface-2 hover:text-fg",
              )}
            >
              {option.label}
              {option.id === provider.tierDefaultModel ? " · recommended" : ""}
            </button>
          );
        })}
        {options.length === 0 && (
          <p className="py-2 text-xs text-fg-dim">No matching models.</p>
        )}
      </div>
      {provider.modelAccessTier === "all" && (
        <div className="mt-1.5 flex gap-1.5">
          <input
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              const value = custom.trim();
              if (value !== "") onSelect(value);
            }}
            aria-label="Custom model id"
            placeholder="custom model id…"
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-line bg-surface-0 px-2 py-1 text-xs text-fg placeholder:text-fg-dim focus:outline-none"
          />
          <button
            type="button"
            onClick={() => {
              const value = custom.trim();
              if (value !== "") onSelect(value);
            }}
            disabled={custom.trim() === ""}
            className="shrink-0 rounded border border-line bg-surface-2 px-2 text-xs text-fg-muted disabled:opacity-40"
          >
            use
          </button>
        </div>
      )}
      {provider.modelAccessTier !== "all" && (
        <p className="mt-2 text-xs text-fg-dim">
          {MODEL_ACCESS_TIER_INFO[provider.modelAccessTier].description} Custom
          IDs are available under All models.
        </p>
      )}
      {pinned && (
        <button
          type="button"
          onClick={onClear}
          className="mt-1 w-full rounded px-2 py-1 text-left text-xs text-fg-dim hover:text-fg-muted"
        >
          Clear browser pin · follow effective settings
          {provider.model === null ? "" : ` (${provider.model})`}
        </button>
      )}
    </div>
  );
}
