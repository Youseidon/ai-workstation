"use client";

import { useState } from "react";
import type { ProviderId, ProviderInfo } from "@agent-console/shared";
import { modelLabel, PROVIDER_IDS } from "@agent-console/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ModelMenu } from "@/components/ModelMenu";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/lib/providerTheme";
import type { useModelSelection } from "@/lib/useModelSelection";

export type AgentChoice = { provider: ProviderId | null; model: string | null };

/**
 * The one agent + model picker. Suite defaults, prompt overrides and sub-step
 * pins all use it, so choosing an agent looks and behaves the same at every
 * level: a row of provider chips, the active chip names its model, and
 * clicking the active chip opens the model menu.
 *
 * `inherit` adds a leading chip meaning "no choice here; follow the level
 * above" — it is selected while `value.provider` is null.
 */
export function AgentModelPicker({
  label,
  value,
  providers,
  models,
  inherit,
  disabled = false,
  size = "md",
  onChange,
}: {
  /** Accessible name of the group, e.g. "Suite agent" or "Agent for S1-02". */
  label: string;
  value: AgentChoice;
  providers: ProviderInfo[];
  models?: ReturnType<typeof useModelSelection>;
  inherit?: { label: string; provider?: ProviderId | null };
  disabled?: boolean;
  size?: "sm" | "md";
  onChange(choice: AgentChoice): void;
}) {
  const [menuFor, setMenuFor] = useState<ProviderId | null>(null);
  const chip = size === "sm" ? "px-2 py-0.5 gap-1" : "px-2.5 py-1 gap-1.5";

  return (
    <div role="group" aria-label={label} className="agent-picker flex max-w-full flex-wrap gap-1.5">
      {inherit !== undefined && (
        <button
          type="button"
          disabled={disabled}
          aria-pressed={value.provider === null}
          onClick={() => { setMenuFor(null); if (value.provider !== null) onChange({ provider: null, model: null }); }}
          className={cn(
            "inline-flex min-w-0 max-w-full items-center rounded-full text-xs ring-1 ring-inset transition-colors disabled:opacity-50",
            chip,
            value.provider === null ? "bg-accent/12 text-accent ring-accent/40" : "border-dashed text-fg-dim ring-line hover:bg-surface-3 hover:text-fg",
          )}
        >
          <span aria-hidden>↳</span>
          {inherit.provider != null && <AgentAvatar provider={inherit.provider} size={size === "sm" ? 14 : 16} activity="offline" />}
          <span className="truncate">{inherit.label}</span>
        </button>
      )}
      {PROVIDER_IDS.map((id) => {
        const info = providers.find((entry) => entry.id === id);
        const active = value.provider === id;
        const auto = info?.modelSelectionMode === "auto";
        const shownModel = active ? (auto ? info?.model ?? null : value.model) : null;
        const staleModel = active && value.model !== null && info !== undefined
          && (auto || (info.modelAccessTier !== "all" && !info.models.some((option) => option.id === value.model)));
        const unavailable = info !== undefined && !info.available;
        return (
          <div key={id} className="relative min-w-0 max-w-full" onKeyDown={(event) => { if (event.key === "Escape" && menuFor === id) event.stopPropagation(); }}>
            <button
              type="button"
              disabled={disabled}
              aria-pressed={active}
              aria-haspopup={info !== undefined ? "listbox" : undefined}
              title={unavailable ? `${id} is unavailable right now` : active ? "Change model" : `Use ${id}`}
              onClick={() => {
                // Clicking the active agent only opens its model menu; it does
                // not round-trip an unchanged choice.
                if (!active) onChange({ provider: id, model: models?.resolve(id) ?? info?.model ?? null });
                setMenuFor(menuFor === id || info === undefined ? null : id);
              }}
              className={cn(
                "inline-flex min-w-0 max-w-full items-center rounded-full text-xs ring-1 ring-inset transition-colors disabled:opacity-50",
                chip,
                active ? providerTheme[id].chip : "text-fg-muted ring-line hover:bg-surface-3 hover:text-fg",
                unavailable && !active && "opacity-55",
              )}
            >
              <AgentAvatar provider={id} size={size === "sm" ? 14 : 16} activity={active ? "idle" : "offline"} />
              <span>{id}</span>
              {shownModel !== null && (
                <span className="min-w-0 truncate opacity-75" aria-hidden>· {modelLabel(id, shownModel, info?.models)}</span>
              )}
              {active && <span className="opacity-60" aria-hidden>▾</span>}
              {staleModel && (
                <span className="rounded bg-caution/15 px-1 text-[0.65rem] uppercase tracking-wide text-caution" aria-hidden>
                  {auto ? "auto" : "tier default"}
                </span>
              )}
            </button>
            {menuFor === id && info !== undefined && (
              <ModelMenu
                provider={id}
                options={info.models}
                accessTier={info.modelAccessTier}
                selectionMode={info.modelSelectionMode}
                recommended={info.tierDefaultModel}
                totalModels={info.totalModels}
                selected={auto ? info.model : active && !staleModel ? value.model : (models?.resolve(id) ?? info.model)}
                configured={info.model}
                pinned={models?.isPinned(id) ?? false}
                onSelect={(model) => { onChange({ provider: id, model }); setMenuFor(null); }}
                onClear={() => { onChange({ provider: id, model: info.model }); setMenuFor(null); }}
                onClose={() => setMenuFor(null)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Ordered relief agents. Click to append, click again to remove; the badge is
 * the position. Shared by suite defaults and station rules.
 */
export function FallbackOrderPicker({
  label,
  value,
  exclude,
  disabled = false,
  onChange,
}: {
  label: string;
  value: ProviderId[];
  /** The primary agent, which cannot also be its own fallback. */
  exclude: ProviderId | null;
  disabled?: boolean;
  onChange(next: ProviderId[]): void;
}) {
  return (
    <div role="group" aria-label={label} className="flex max-w-full flex-wrap gap-1.5">
      {PROVIDER_IDS.filter((id) => id !== exclude).map((id) => {
        const index = value.indexOf(id);
        const on = index >= 0;
        return (
          <button
            key={id}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            title={on ? `Fallback #${index + 1}. Click to remove; re-add to move it to the end` : "Add to fallback order"}
            onClick={() => onChange(on ? value.filter((entry) => entry !== id) : [...value, id])}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ring-1 ring-inset transition-colors disabled:opacity-50",
              on ? providerTheme[id].chip : "text-fg-muted ring-line hover:bg-surface-3 hover:text-fg",
            )}
          >
            <AgentAvatar provider={id} size={16} activity={on ? "idle" : "offline"} />
            {id}
            {on && <span className="numeric rounded-full bg-surface-0 px-1.5 text-[0.65rem] font-semibold">{index + 1}</span>}
          </button>
        );
      })}
    </div>
  );
}
