"use client";

import { useState } from "react";
import type { ProviderId, ProviderInfo } from "@agent-console/shared";
import { modelLabel } from "@agent-console/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ModelMenu } from "@/components/ModelMenu";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/lib/providerTheme";
import { useModelSelection } from "@/lib/useModelSelection";

/** The agent and model a request runs with. */
export interface AgentChoice {
  provider: ProviderId | "";
  /** The model to send; `null` lets the provider use its own default. */
  model: string | null;
}

/**
 * Holds an agent + model choice. Until the operator picks, it follows the
 * first available provider and the model that provider would run with
 * anywhere else (the pin from Agents/chat, else settings) — the same default
 * a new pipeline station gets.
 */
export function useAgentChoice(providers: ProviderInfo[]) {
  const models = useModelSelection(providers);
  const [picked, setPicked] = useState<{ provider: ProviderId; model?: string | null } | null>(null);
  const firstAvailable = providers.find((entry) => entry.available)?.id ?? "";
  const provider: ProviderId | "" = picked?.provider ?? firstAvailable;
  const info = providers.find((entry) => entry.id === provider);
  // A server-selected ("auto") model always wins, as it does for pipelines.
  const model =
    provider === ""
      ? null
      : info?.modelSelectionMode === "auto" || picked?.model === undefined
        ? models.resolve(provider)
        : picked.model;
  const choice: AgentChoice = { provider, model };
  return {
    choice,
    /** True when the model was picked here rather than inherited. */
    pinned: picked?.model !== undefined && info?.modelSelectionMode !== "auto",
    pickProvider: (id: ProviderId) => setPicked((current) => (current?.provider === id ? current : { provider: id })),
    pickModel: (id: ProviderId, value: string | null | undefined) => setPicked({ provider: id, model: value }),
  };
}

interface Props {
  providers: ProviderInfo[];
  state: ReturnType<typeof useAgentChoice>;
  label?: string;
  /** Why a provider cannot take this request, or null. */
  blockedReason?(provider: ProviderId): string | null;
  placement?: "below" | "above";
  className?: string;
}

/**
 * Provider pills with a model menu behind the active one — the picker the
 * pipeline uses for a station, for one-off agent requests.
 */
export function ProviderModelPicker({ providers, state, label = "Agent", blockedReason, placement = "below", className }: Props) {
  const [menuFor, setMenuFor] = useState<ProviderId | null>(null);
  const { choice, pinned, pickProvider, pickModel } = state;

  return (
    <div className={className}>
      <div className="mb-1.5 text-xs font-medium text-fg-muted">{label}</div>
      {providers.length === 0 ? (
        <p className="text-[11px] text-fg-dim">No agent detected on this server.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {providers.map((info) => {
            const id = info.id;
            const active = choice.provider === id;
            const blocked = !info.available ? "Not available on this server" : blockedReason?.(id) ?? null;
            const shownModel = active ? modelLabel(id, choice.model, info.models) : null;
            return (
              <div
                key={id}
                className="relative"
                // The menu listens for Escape on the document, which would also
                // close the surrounding modal. Close just the menu here instead.
                onKeyDown={(event) => {
                  if (event.key === "Escape" && menuFor === id) {
                    event.stopPropagation();
                    setMenuFor(null);
                  }
                }}
              >
                <button
                  type="button"
                  disabled={blocked !== null}
                  title={blocked ?? (active ? "Choose the model" : `Use ${id}`)}
                  aria-pressed={active}
                  aria-haspopup="listbox"
                  aria-expanded={menuFor === id}
                  // The open menu closes itself on any outside mousedown; keep
                  // that from firing here so this click toggles it shut.
                  onMouseDown={(event) => {
                    if (menuFor === id) event.stopPropagation();
                  }}
                  onClick={() => {
                    pickProvider(id);
                    setMenuFor(active && menuFor !== id ? id : null);
                  }}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[11px] ring-1 ring-inset transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                    active ? providerTheme[id].chip : "text-fg-muted ring-line hover:bg-surface-3",
                  )}
                >
                  <AgentAvatar provider={id} size={16} activity={active ? "idle" : "offline"} />
                  {id}
                  {active && (
                    <span className="flex items-center gap-1 opacity-75">
                      <span className="opacity-50">·</span>
                      {shownModel ?? "default"}
                      <svg viewBox="0 0 12 12" className="size-2.5" aria-hidden><path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    </span>
                  )}
                </button>
                {menuFor === id && (
                  <ModelMenu
                    provider={id}
                    options={info.models}
                    accessTier={info.modelAccessTier}
                    selectionMode={info.modelSelectionMode}
                    recommended={info.tierDefaultModel}
                    totalModels={info.totalModels}
                    selected={choice.model}
                    configured={info.model}
                    pinned={pinned}
                    placement={placement}
                    onSelect={(value) => {
                      pickModel(id, value);
                      setMenuFor(null);
                    }}
                    onClear={() => {
                      pickModel(id, undefined);
                      setMenuFor(null);
                    }}
                    onClose={() => setMenuFor(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
