"use client";

import { useState } from "react";
import type { OperationsPrompt, PipelinePolicy, PromptPipelineRule, ProviderId } from "@agent-console/shared";
import { modelLabel, onDoneConsequence, onUnfinishedConsequence, PROVIDER_IDS } from "@agent-console/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ModelMenu } from "@/components/ModelMenu";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/lib/providerTheme";
import { useModelSelection } from "@/lib/useModelSelection";
import { onDoneChip } from "./status";

/**
 * Station / sub-step rule editor body. Embedded in the pipeline inspector
 * (and optionally wrapped in a modal elsewhere).
 */
export function StepConfigForm({
  rule,
  item,
  subStep = false,
  inherited = false,
  providers,
  models,
  policy,
  onUseStationSettings,
  onChange,
}: {
  rule: PromptPipelineRule;
  item: OperationsPrompt;
  subStep?: boolean;
  inherited?: boolean;
  providers: Parameters<typeof useModelSelection>[0];
  models: ReturnType<typeof useModelSelection>;
  policy: PipelinePolicy;
  onUseStationSettings?(): void;
  onChange(patch: Partial<Omit<PromptPipelineRule, "promptId">>): void;
}) {
  const [modelFor, setModelFor] = useState<ProviderId | null>(null);

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[10px] uppercase tracking-[0.16em] text-fg-dim">
          {subStep ? "Sub-step" : "Station"}
        </div>
        <h3 className="mt-0.5 text-sm font-medium text-fg">
          {item.prompt.externalKey ?? item.prompt.title}
        </h3>
        {item.prompt.externalKey !== null && (
          <p className="mt-0.5 truncate text-[11px] text-fg-dim">{item.prompt.title}</p>
        )}
      </div>

      {subStep && (
        <p
          className={cn(
            "rounded-md px-3 py-2 text-[11px] leading-5 ring-1 ring-inset",
            inherited ? "bg-surface-2 text-fg-dim ring-line" : "bg-violet/10 text-violet ring-violet/30",
          )}
        >
          {inherited
            ? "Currently inherited from the station. Choosing an agent below pins it to this sub-step only."
            : "Pinned to this sub-step. Use station settings to remove this override; execution status will not change."}
        </p>
      )}

      <section>
        <div className="mb-2 text-[10px] uppercase tracking-wider text-fg-dim">AI for this step</div>
        <div className="flex flex-wrap gap-1">
          {PROVIDER_IDS.map((id) => {
            const info = providers.find((entry) => entry.id === id);
            const theme = providerTheme[id];
            const active = rule.provider === id;
            return (
              <div key={id} className="relative">
                <button
                  type="button"
                  onClick={() => {
                    onChange({ provider: id, model: models.resolve(id) });
                    setModelFor(modelFor === id ? null : id);
                  }}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] ring-1 ring-inset",
                    active ? theme.chip : "text-fg-muted ring-line hover:bg-surface-3",
                  )}
                >
                  <AgentAvatar provider={id} size={16} activity={active ? "idle" : "offline"} />
                  {id}
                  {active && rule.model !== null && (
                    <span className="ml-1 opacity-70">{modelLabel(id, rule.model)}</span>
                  )}
                </button>
                {modelFor === id && info !== undefined && (
                  <ModelMenu
                    provider={id}
                    selected={active ? rule.model : models.resolve(id)}
                    configured={info.model}
                    pinned={models.isPinned(id)}
                    onSelect={(value) => {
                      onChange({ provider: id, model: value });
                      setModelFor(null);
                    }}
                    onClear={() => {
                      onChange({ provider: id, model: info.model });
                      setModelFor(null);
                    }}
                    onClose={() => setModelFor(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className={subStep ? "hidden" : undefined} aria-hidden={subStep || undefined}>
        <div className="mb-2 text-[10px] uppercase tracking-wider text-fg-dim">On DONE</div>
        <div className="flex flex-wrap gap-1">
          {(["continue", "stop", "skip_rest"] as const).map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => onChange({ onDone: action })}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset",
                rule.onDone === action ? "bg-accent/15 text-accent ring-accent/40" : "text-fg-muted ring-line",
              )}
            >
              {onDoneChip(action)}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-4 text-fg-dim">{onDoneConsequence(rule.onDone, policy)}</p>
      </section>

      <section>
        <div className="mb-2 text-[10px] uppercase tracking-wider text-fg-dim">On unfinished</div>
        <div className="flex flex-wrap gap-1">
          {(["continue", "skip", "wait"] as const).map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => onChange({ onUnfinished: action })}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset",
                rule.onUnfinished === action ? "bg-accent/15 text-accent ring-accent/40" : "text-fg-muted ring-line",
              )}
            >
              {action}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-4 text-fg-dim">{onUnfinishedConsequence(rule, policy)}</p>
      </section>

      <section className={subStep ? "hidden" : undefined} aria-hidden={subStep || undefined}>
        <div className="mb-2 text-[10px] uppercase tracking-wider text-fg-dim">Fallback providers</div>
        <p className="mb-2 text-[11px] leading-4 text-fg-dim">
          Ordered list tried when this station&apos;s agent cannot start or dies before doing any
          work. Empty means the suite / house default (
          {policy.fallbackProviders.join(" → ") || "none"}).
        </p>
        <div className="flex flex-wrap gap-1">
          {PROVIDER_IDS.filter((id) => id !== rule.provider).map((id) => {
            const theme = providerTheme[id];
            const index = rule.fallbackProviders.indexOf(id);
            const active = index >= 0;
            return (
              <button
                key={id}
                type="button"
                title={active ? `Fallback #${index + 1} — click to remove` : "Add as fallback"}
                onClick={() => {
                  const next = active
                    ? rule.fallbackProviders.filter((entry) => entry !== id)
                    : [...rule.fallbackProviders, id];
                  onChange({ fallbackProviders: next });
                }}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] ring-1 ring-inset",
                  active ? theme.chip : "text-fg-muted ring-line hover:bg-surface-3",
                )}
              >
                <AgentAvatar provider={id} size={16} activity={active ? "idle" : "offline"} />
                {id}
                {active && <span className="ml-0.5 opacity-70">#{index + 1}</span>}
              </button>
            );
          })}
        </div>
        {rule.fallbackProviders.length > 1 && (
          <p className="mt-2 text-[11px] leading-4 text-fg-dim">
            Order: {rule.fallbackProviders.join(" → ")}. Click again to remove; re-add to move to the end.
          </p>
        )}
      </section>

      {onUseStationSettings !== undefined && (
        <Button
          variant="ghost"
          size="sm"
          title="Remove this sub-step's agent override. Execution status is unchanged."
          onClick={onUseStationSettings}
        >
          Use station settings
        </Button>
      )}
    </div>
  );
}
