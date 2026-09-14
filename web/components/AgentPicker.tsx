"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderId, ProviderInfo, ProviderUsage } from "@agent-console/shared";
import { MODEL_CATALOG, isCustomModel, modelLabel, PROVIDER_IDS } from "@agent-console/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { agentState, ACTIVITY_LABEL } from "@/lib/agentState";
import { cn } from "@/lib/cn";
import { useAgentConsole } from "@/lib/useAgentConsole";
import { useModelSelection } from "@/lib/useModelSelection";
import { usePreferredProvider } from "@/lib/usePreferredProvider";
import { useProviderUsage } from "@/lib/providerUsage";
import { providerTheme } from "@/lib/providerTheme";

/**
 * One control for "which agent, which model". Replaces the four static split
 * pills: the trigger shows the active choice, and the popover carries status,
 * usage and the model list for every provider.
 */
export function AgentPicker({
  compact = false,
  disabled = false,
}: {
  compact?: boolean;
  disabled?: boolean;
} = {}) {
  const { providers, runs, items, lastRun, refreshProviders, connection } = useAgentConsole();
  const { selected, setPreferred } = usePreferredProvider(providers);
  const models = useModelSelection(providers);
  const { usage } = useProviderUsage(true);
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [expanded, setExpanded] = useState<ProviderId | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const selectedInfo = providers.find((provider) => provider.id === selected);
  const selectedState =
    selectedInfo === undefined ? null : agentState(selectedInfo, runs, items, lastRun);
  const busy =
    selectedState !== null &&
    selectedState.activity !== "idle" &&
    selectedState.activity !== "offline" &&
    selectedState.activity !== "done";
  const selectedModel = models.resolve(selected);
  const theme = providerTheme[selected];

  const rows = providers.filter((provider) => provider.reason !== "Turned off on the Agents page");

  const close = useCallback(() => {
    setOpen(false);
    setExpanded(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, close]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (disabled) return;
        setOpen((value) => !value);
        setFocusIndex(Math.max(0, rows.findIndex((provider) => provider.id === selected)));
        return;
      }
      if (!open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setFocusIndex((index) => (index + 1) % Math.max(rows.length, 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setFocusIndex((index) => (index - 1 + rows.length) % Math.max(rows.length, 1));
        return;
      }
      if (event.key === "Enter") {
        const target = rows[focusIndex];
        if (target === undefined || !target.available || disabled) return;
        event.preventDefault();
        setPreferred(target.id);
        setExpanded(target.id);
        return;
      }
      if (/^[1-4]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const target = event.target as HTMLElement | null;
        if (target?.closest("input, textarea, select, [contenteditable=true]") !== null) return;
        const provider = PROVIDER_IDS[Number(event.key) - 1];
        const info = rows.find((entry) => entry.id === provider);
        if (info === undefined || !info.available || disabled) return;
        event.preventDefault();
        setPreferred(info.id);
        setFocusIndex(rows.findIndex((entry) => entry.id === info.id));
        setExpanded(info.id);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close, disabled, rows, focusIndex, selected, setPreferred]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled || connection === "disconnected"}
        onClick={() => {
          setOpen((value) => !value);
          setFocusIndex(Math.max(0, rows.findIndex((provider) => provider.id === selected)));
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Choose agent (⌘K)"
        className={cn(
          "flex items-center gap-2 rounded-md ring-1 ring-inset transition-colors",
          compact ? "h-8 gap-1.5 px-2 text-xs" : "h-9 gap-2 px-2.5 text-sm",
          theme.chip,
          busy && "animate-pulse-ring",
          disabled && "opacity-50",
        )}
      >
        <AgentAvatar
          provider={selected}
          activity={selectedState?.activity ?? "idle"}
          size={compact ? 18 : 22}
          title={`${selected}: ${ACTIVITY_LABEL[selectedState?.activity ?? "idle"]}`}
        />
        <span className="font-medium">{selectedInfo?.label ?? selected}</span>
        <span className={cn("truncate text-fg-dim", compact ? "max-w-[8ch] text-[10px]" : "max-w-[12ch] text-xs")}>
          {modelLabel(selected, selectedModel) ?? "default"}
        </span>
        <span className="text-[10px] opacity-60" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Agents"
          className="absolute right-0 top-full z-40 mt-2 w-[360px] animate-slide-up overflow-hidden rounded-lg border border-line bg-surface-1 shadow-xl"
        >
          <div className="border-b border-line px-3 py-2 text-[10px] uppercase tracking-wider text-fg-dim">
            Agents · ↑↓ Enter · 1–4 · ⌘K
          </div>
          <div className="max-h-[min(70vh,28rem)] overflow-y-auto py-1">
            {rows.map((provider, index) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                focused={index === focusIndex}
                selected={provider.id === selected}
                expanded={expanded === provider.id}
                state={agentState(provider, runs, items, lastRun)}
                usage={usage?.[provider.id] ?? null}
                model={models.resolve(provider.id)}
                pinned={models.isPinned(provider.id)}
                disabled={disabled || !provider.available}
                onSelect={() => {
                  if (!provider.available) return;
                  setPreferred(provider.id);
                  setExpanded(provider.id);
                  setFocusIndex(index);
                }}
                onToggleModels={() =>
                  setExpanded((current) => (current === provider.id ? null : provider.id))
                }
                onPickModel={(value) => {
                  models.select(provider.id, value);
                  setPreferred(provider.id);
                }}
                onClearModel={() => models.clear(provider.id)}
              />
            ))}
            {rows.length === 0 && (
              <div className="px-3 py-4 text-xs text-fg-muted">Detecting providers…</div>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2">
            <button
              type="button"
              onClick={() => void refreshProviders()}
              className="rounded px-2 py-1 text-xs text-fg-dim transition-colors hover:bg-surface-2 hover:text-fg"
            >
              Re-detect providers
            </button>
            <Link
              href="/agents"
              onClick={close}
              className="rounded px-2 py-1 text-xs text-accent transition-colors hover:bg-accent/10"
            >
              Manage agents →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function ProviderRow({
  provider,
  focused,
  selected,
  expanded,
  state,
  usage,
  model,
  pinned,
  disabled,
  onSelect,
  onToggleModels,
  onPickModel,
  onClearModel,
}: {
  provider: ProviderInfo;
  focused: boolean;
  selected: boolean;
  expanded: boolean;
  state: ReturnType<typeof agentState>;
  usage: ProviderUsage | null;
  model: string | null;
  pinned: boolean;
  disabled: boolean;
  onSelect(): void;
  onToggleModels(): void;
  onPickModel(model: string | null): void;
  onClearModel(): void;
}) {
  const theme = providerTheme[provider.id];
  const window =
    usage?.windows.find((entry) => entry.kind === "session" || entry.kind === "weekly" || entry.kind === "monthly") ??
    usage?.windows[0];
  const used = window?.usedPercent ?? null;

  return (
    <div
      className={cn(
        "border-b border-line/60 last:border-b-0",
        focused && "bg-surface-2",
        selected && "bg-surface-2/80",
      )}
    >
      <div className="flex items-start gap-2 px-2 py-2">
        <button
          type="button"
          role="option"
          aria-selected={selected}
          disabled={disabled}
          onClick={onSelect}
          className={cn(
            "flex min-w-0 flex-1 items-start gap-2.5 rounded-md px-1.5 py-1 text-left transition-colors",
            disabled ? "cursor-not-allowed opacity-55" : "hover:bg-surface-3",
          )}
        >
          <AgentAvatar
            provider={provider.id}
            activity={state.activity}
            size={28}
            title={`${provider.label}: ${ACTIVITY_LABEL[state.activity]}`}
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className={cn("text-sm font-medium", selected ? theme.text : "text-fg")}>
                {provider.label}
              </span>
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  provider.available ? "bg-success" : "bg-line-strong",
                )}
                title={provider.available ? "available" : (provider.reason ?? "unavailable")}
              />
              <span className="truncate text-[11px] text-fg-dim">{state.caption}</span>
            </span>
            {used !== null && (
              <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-surface-3">
                <span
                  className={cn("block h-full rounded-full", theme.fill)}
                  style={{ width: `${used}%` }}
                />
              </span>
            )}
          </span>
        </button>
        <button
          type="button"
          onClick={onToggleModels}
          title="Models"
          className="mt-1 shrink-0 rounded px-1.5 py-1 text-[10px] text-fg-dim ring-1 ring-inset ring-line hover:text-fg"
        >
          {modelLabel(provider.id, model) ?? "default"}
          {pinned ? "" : " ·"}
        </button>
      </div>
      {expanded && (
        <ModelList
          provider={provider}
          selected={model}
          pinned={pinned}
          onSelect={onPickModel}
          onClear={onClearModel}
        />
      )}
    </div>
  );
}

function ModelList({
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
  const [custom, setCustom] = useState(isCustomModel(provider.id, selected) ? (selected ?? "") : "");
  const theme = providerTheme[provider.id];
  const options = MODEL_CATALOG[provider.id];

  return (
    <div className="border-t border-line bg-surface-0/40 px-2 py-2">
      <div className="max-h-40 overflow-y-auto">
        {options.map((option) => {
          const isSelected = option.id === selected;
          return (
            <button
              key={option.id ?? "__default__"}
              type="button"
              onClick={() => onSelect(option.id)}
              className={cn(
                "flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-xs transition-colors",
                isSelected ? theme.chip : "text-fg-muted hover:bg-surface-2",
              )}
            >
              <span className="shrink-0">{option.label}</span>
              <span className="ml-auto truncate text-[10px] text-fg-dim">{option.hint}</span>
            </button>
          );
        })}
      </div>
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
          placeholder="custom model id…"
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-line bg-surface-1 px-2 py-1 text-[11px] text-fg placeholder:text-fg-dim focus:outline-none"
        />
        <button
          type="button"
          onClick={() => {
            const value = custom.trim();
            if (value !== "") onSelect(value);
          }}
          disabled={custom.trim() === ""}
          className="shrink-0 rounded border border-line bg-surface-2 px-2 text-[11px] text-fg-muted disabled:opacity-40"
        >
          use
        </button>
      </div>
      {pinned && (
        <button
          type="button"
          onClick={onClear}
          className="mt-1 w-full rounded px-2 py-1 text-left text-[10px] text-fg-dim hover:text-fg-muted"
        >
          ↺ follow settings{provider.model === null ? "" : ` (${provider.model})`}
        </button>
      )}
    </div>
  );
}
