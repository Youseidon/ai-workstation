"use client";

import { useState } from "react";
import type { ProviderId, ProviderInfo } from "@agent-console/shared";
import { modelLabel } from "@agent-console/shared";
import { providerTheme } from "@/lib/providerTheme";
import type { ModelSelection } from "@/lib/useModelSelection";
import { ModelMenu } from "./ModelMenu";

interface Props {
  providers: ProviderInfo[];
  selected: ProviderId;
  disabled: boolean;
  models: ModelSelection;
  onSelect(provider: ProviderId): void;
  onRefresh(): void;
}

/**
 * Each provider is a split pill: the left half picks the provider, the right
 * half opens that provider's model list. The model is visible without opening
 * anything, which is the point — you can see at a glance what a run will use.
 */
export function ProviderSwitcher({
  providers,
  selected,
  disabled,
  models,
  onSelect,
  onRefresh,
}: Props) {
  const [openMenu, setOpenMenu] = useState<ProviderId | null>(null);

  return (
    <div className="flex items-center gap-2">
      <div className="flex flex-wrap items-center gap-1 rounded-md border border-line bg-surface-1 p-1">
        {providers.map((provider) => {
          const isSelected = provider.id === selected;
          const isDisabled = disabled || !provider.available;
          const theme = providerTheme[provider.id];
          const model = models.resolve(provider.id);
          const label = modelLabel(provider.id, model) ?? "default";
          const pinned = models.isPinned(provider.id);

          return (
            <div key={provider.id} className="relative">
              <div
                className={[
                  "flex items-stretch rounded ring-1 ring-inset transition-colors",
                  isSelected ? theme.active : "text-fg-muted ring-transparent",
                  isDisabled ? "opacity-45" : "",
                ].join(" ")}
              >
                <button
                  type="button"
                  disabled={isDisabled}
                  onClick={() => onSelect(provider.id)}
                  title={tooltipFor(provider)}
                  className={[
                    "flex items-center gap-2 rounded-l py-1.5 pl-3 pr-2 text-xs transition-colors",
                    isDisabled ? "cursor-not-allowed" : "cursor-pointer",
                    isSelected ? "" : "hover:text-fg",
                  ].join(" ")}
                >
                  <span
                    aria-hidden
                    className={[
                      "size-1.5 rounded-full",
                      provider.available ? "bg-success" : "bg-line-strong",
                    ].join(" ")}
                  />
                  {provider.label}
                </button>

                <span aria-hidden className="my-1 w-px bg-current opacity-20" />

                <button
                  type="button"
                  // The model is pickable even mid-run and even for an
                  // unavailable provider: it only takes effect on the next run,
                  // and pre-picking while something else streams is normal use.
                  onClick={() => setOpenMenu((current) => (current === provider.id ? null : provider.id))}
                  title={
                    model === null
                      ? `${provider.id}: provider default — click to choose a model`
                      : `${provider.id}: ${model}${pinned ? "" : " (from settings)"}`
                  }
                  aria-haspopup="listbox"
                  aria-expanded={openMenu === provider.id}
                  className={[
                    "flex max-w-[13ch] cursor-pointer items-center gap-1 rounded-r py-1.5 pl-2 pr-2 text-[11px] transition-colors",
                    isSelected ? "" : "hover:text-fg",
                    pinned ? "" : "opacity-70",
                  ].join(" ")}
                >
                  <span className="truncate">{label}</span>
                  <span className="shrink-0 text-[8px] opacity-60">▾</span>
                </button>
              </div>

              {openMenu === provider.id && (
                <ModelMenu
                  provider={provider.id}
                  selected={model}
                  configured={provider.model}
                  pinned={pinned}
                  onSelect={(value) => {
                    models.select(provider.id, value);
                    setOpenMenu(null);
                  }}
                  onClear={() => {
                    models.clear(provider.id);
                    setOpenMenu(null);
                  }}
                  onClose={() => setOpenMenu(null)}
                />
              )}
            </div>
          );
        })}
        {providers.length === 0 && (
          <span className="px-3 py-1.5 text-xs text-fg-muted">detecting providers…</span>
        )}
      </div>
      <button
        type="button"
        onClick={onRefresh}
        title="Re-run provider detection"
        className="rounded border border-line px-2 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
      >
        ↻
      </button>
    </div>
  );
}

function tooltipFor(provider: ProviderInfo): string {
  if (!provider.available) return provider.reason ?? "not detected";
  const parts = [provider.version ?? "installed", provider.permissionMode];
  if (provider.binary !== null) parts.push(provider.binary);
  return parts.join(" · ");
}
