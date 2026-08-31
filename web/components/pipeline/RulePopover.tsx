"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { OnBlockedAction, OnDoneAction, PromptPipelineRule, ProviderId, ProviderInfo } from "@agent-console/shared";
import { PROVIDER_IDS, modelLabel } from "@agent-console/shared";
import { ModelMenu } from "@/components/ModelMenu";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/lib/providerTheme";
import { useIsClient } from "@/lib/useIsClient";
import type { ModelSelection } from "@/lib/useModelSelection";
import { onBlockedChip, onDoneChip } from "./status";

export type RuleKind = "done" | "blocked" | "provider";

export interface RulePatch extends Partial<Omit<PromptPipelineRule, "promptId">> {}

interface Props {
  kind: RuleKind;
  rule: PromptPipelineRule;
  providers: ProviderInfo[];
  models: ModelSelection;
  fallbackProvider: ProviderId;
  anchor: DOMRect;
  onChange(patch: RulePatch): void;
  onClose(): void;
}

const DONE: OnDoneAction[] = ["continue", "stop", "skip_rest"];
const BLOCKED: OnBlockedAction[] = ["wait", "retry", "recover", "skip"];

/**
 * In-place editor for a station's outcome chips. Desktop: anchored popover.
 * Below xl: a bottom sheet so it is not clipped by the scrolling rail.
 */
export function RulePopover({
  kind,
  rule,
  providers,
  models,
  fallbackProvider,
  anchor,
  onChange,
  onClose,
}: Props) {
  const mounted = useIsClient();
  const ref = useRef<HTMLDivElement>(null);
  const [modelFor, setModelFor] = useState<ProviderId | null>(null);
  const desktop = mounted && window.matchMedia("(min-width: 1280px)").matches;

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  if (!mounted) return null;

  const left = Math.min(anchor.left, window.innerWidth - 304);
  const top = anchor.bottom + 6;

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={kind === "done" ? "On DONE" : kind === "blocked" ? "On BLOCKED" : "Execute provider"}
      style={desktop ? { top, left } : undefined}
      className={cn(
        "glass z-40 animate-slide-up shadow-xl",
        desktop
          ? "fixed w-72 overflow-visible rounded-md"
          : "fixed inset-x-0 bottom-0 max-w-full rounded-t-xl rounded-b-none",
      )}
    >
      <div className="border-b border-line px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-fg-dim">
        {kind === "done" ? "On DONE" : kind === "blocked" ? "On BLOCKED" : "Execute as"}
      </div>

      {kind === "done" && (
        <div className="flex flex-wrap gap-1 p-2">
          {DONE.map((action) => (
            <OptionChip
              key={action}
              active={rule.onDone === action}
              onClick={() => onChange({ onDone: action })}
            >
              {onDoneChip(action)}
            </OptionChip>
          ))}
        </div>
      )}

      {kind === "blocked" && (
        <div className="space-y-2 p-2">
          <div className="flex flex-wrap gap-1">
            {BLOCKED.map((action) => (
              <OptionChip
                key={action}
                active={rule.onBlocked === action}
                onClick={() => {
                  if (action === "recover") {
                    onChange({
                      onBlocked: "recover",
                      recoverProvider: rule.recoverProvider ?? fallbackProvider,
                      recoverModel: rule.recoverModel,
                    });
                    return;
                  }
                  onChange({ onBlocked: action });
                }}
              >
                {action === "retry" ? onBlockedChip({ ...rule, onBlocked: "retry" }) : action === "recover" ? "recover" : action}
              </OptionChip>
            ))}
          </div>

          {rule.onBlocked === "retry" && (
            <div className="flex items-center gap-2 text-xs text-fg-muted">
              <span className="text-[10px] uppercase tracking-wider text-fg-dim">attempts</span>
              <button
                type="button"
                className="rounded-md px-2 py-0.5 ring-1 ring-inset ring-line hover:bg-surface-3"
                disabled={rule.retryLimit <= 1}
                onClick={() => onChange({ retryLimit: Math.max(1, rule.retryLimit - 1) })}
              >
                −
              </button>
              <span className="numeric text-fg">{rule.retryLimit}</span>
              <button
                type="button"
                className="rounded-md px-2 py-0.5 ring-1 ring-inset ring-line hover:bg-surface-3"
                disabled={rule.retryLimit >= 5}
                onClick={() => onChange({ retryLimit: Math.min(5, rule.retryLimit + 1) })}
              >
                +
              </button>
            </div>
          )}

          {rule.onBlocked === "recover" && (
            <ProviderPicks
              selected={rule.recoverProvider}
              model={rule.recoverModel}
              providers={providers}
              models={models}
              modelFor={modelFor}
              setModelFor={setModelFor}
              allowInherit={false}
              onPick={(provider, model) =>
                onChange({ onBlocked: "recover", recoverProvider: provider, recoverModel: model })
              }
            />
          )}
        </div>
      )}

      {kind === "provider" && (
        <div className="p-2">
          <ProviderPicks
            selected={rule.provider}
            model={rule.model}
            providers={providers}
            models={models}
            modelFor={modelFor}
            setModelFor={setModelFor}
            allowInherit
            onPick={(provider, model) => onChange({ provider, model })}
          />
        </div>
      )}
    </div>,
    document.body,
  );
}

function OptionChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset transition-colors",
        active ? "bg-accent/15 text-accent ring-accent/40" : "text-fg-muted ring-line hover:bg-surface-3 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function ProviderPicks({
  selected,
  model,
  providers,
  models,
  modelFor,
  setModelFor,
  allowInherit,
  onPick,
}: {
  selected: ProviderId | null;
  model: string | null;
  providers: ProviderInfo[];
  models: ModelSelection;
  modelFor: ProviderId | null;
  setModelFor(value: ProviderId | null): void;
  allowInherit: boolean;
  onPick(provider: ProviderId | null, model: string | null): void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {allowInherit && (
        <button
          type="button"
          onClick={() => onPick(null, null)}
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset",
            selected === null ? "bg-surface-3 text-fg ring-line-strong" : "text-fg-dim ring-line hover:text-fg",
          )}
        >
          inherit
        </button>
      )}
      {PROVIDER_IDS.map((id) => {
        const info = providers.find((entry) => entry.id === id);
        const theme = providerTheme[id];
        const active = selected === id;
        return (
          <div key={id} className="relative">
            <button
              type="button"
              onClick={() => {
                onPick(id, model !== null && selected === id ? model : models.resolve(id));
                setModelFor(modelFor === id ? null : id);
              }}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset",
                active ? theme.chip : "text-fg-muted ring-line hover:bg-surface-3",
              )}
            >
              {id}
              {active && model !== null && (
                <span className="ml-1 opacity-70">{modelLabel(id, model)}</span>
              )}
            </button>
            {modelFor === id && info !== undefined && (
              <ModelMenu
                provider={id}
                selected={active ? model : models.resolve(id)}
                configured={info.model}
                pinned={models.isPinned(id)}
                onSelect={(value) => {
                  onPick(id, value);
                  setModelFor(null);
                }}
                onClear={() => {
                  onPick(id, info.model);
                  setModelFor(null);
                }}
                onClose={() => setModelFor(null)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
