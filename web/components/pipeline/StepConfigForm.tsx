"use client";

import type { ReactNode } from "react";
import type { OperationsPrompt, PipelinePolicy, PromptPipelineRule, ProviderId } from "@agent-console/shared";
import { onDoneConsequence, onUnfinishedConsequence } from "@agent-console/shared";
import { AgentModelPicker, FallbackOrderPicker } from "@/components/agents/AgentModelPicker";
import { cn } from "@/lib/cn";
import { useModelSelection } from "@/lib/useModelSelection";
import { ExecutionPanel } from "./ExecutionPanel";
import { onDoneChip } from "./status";

/**
 * Station / sub-step rule editor body, shown in the Pipeline studio. The agent
 * row is the same picker the suite uses; its leading chip is "follow the level
 * above" (suite agent for a station, the station for a sub-step).
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
  onUseSuiteSettings,
  suiteProvider,
  onChange,
  onExecutionChanged,
}: {
  rule: PromptPipelineRule;
  item: OperationsPrompt;
  subStep?: boolean;
  inherited?: boolean;
  providers: Parameters<typeof useModelSelection>[0];
  models: ReturnType<typeof useModelSelection>;
  policy: PipelinePolicy;
  onUseStationSettings?(): void;
  onUseSuiteSettings?(): void;
  suiteProvider?: ProviderId | null;
  onChange(patch: Partial<Omit<PromptPipelineRule, "promptId">>): void;
  onExecutionChanged?(): void;
}) {
  const inherit = subStep
    ? { label: "Follow station" }
    : { label: suiteProvider ? "Suite agent" : "Suite agent (not chosen)", provider: suiteProvider ?? null };
  const following = subStep ? inherited : rule.provider === null;

  return (
    <div className="space-y-5">
      <div className="studio-card space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-fg">Agent for this {subStep ? "sub-step" : "step"}</h3>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            {following
              ? subStep ? "Follows the station's agent. Pick one below to pin it to this sub-step only." : `Follows the suite agent${suiteProvider ? ` (${suiteProvider})` : ""}. Pick one below to override it for this step.`
              : subStep ? "Pinned to this sub-step. Choose “Follow station” to remove the override; execution status will not change." : "Overrides the suite agent for this step."}
          </p>
        </div>
        <AgentModelPicker
          label={`Agent for ${item.prompt.externalKey ?? item.prompt.title}`}
          value={following ? { provider: null, model: null } : { provider: rule.provider, model: rule.model }}
          providers={providers}
          models={models}
          inherit={(subStep ? onUseStationSettings : onUseSuiteSettings) !== undefined || following ? inherit : undefined}
          onChange={(choice) => {
            if (choice.provider === null) {
              if (subStep) onUseStationSettings?.();
              else onUseSuiteSettings?.();
              return;
            }
            onChange({ provider: choice.provider, model: choice.model });
          }}
        />
      </div>

      <div className="studio-card space-y-4">
        <h3 className="text-sm font-semibold text-fg">Outcomes</h3>
        <section className={subStep ? "hidden" : undefined} aria-hidden={subStep || undefined}>
          <div className="mb-2 text-xs uppercase tracking-wider text-fg-dim">On DONE</div>
          <div className="flex flex-wrap gap-1">
            {(["continue", "stop", "skip_rest"] as const).map((action) => (
              <OutcomeChip key={action} on={rule.onDone === action} onClick={() => onChange({ onDone: action })}>{onDoneChip(action)}</OutcomeChip>
            ))}
          </div>
          <p className="mt-2 text-xs leading-4 text-fg-dim">{onDoneConsequence(rule.onDone, policy)}</p>
        </section>
        <section>
          <div className="mb-2 text-xs uppercase tracking-wider text-fg-dim">On unfinished</div>
          <div className="flex flex-wrap gap-1">
            {(["continue", "skip", "wait"] as const).map((action) => (
              <OutcomeChip key={action} on={rule.onUnfinished === action} onClick={() => onChange({ onUnfinished: action })}>{action}</OutcomeChip>
            ))}
          </div>
          <p className="mt-2 text-xs leading-4 text-fg-dim">{onUnfinishedConsequence(rule, policy)}</p>
        </section>
      </div>

      <section className={cn("studio-card space-y-3", subStep && "hidden")} aria-hidden={subStep || undefined}>
        <div>
          <h3 className="text-sm font-semibold text-fg">Fallback providers</h3>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            Tried when automatic reassignment is enabled for this pipeline and this agent hits a limit or becomes
            unavailable. Empty uses the suite / house order ({policy.fallbackProviders.join(" → ") || "none"}).
          </p>
        </div>
        <FallbackOrderPicker label="Step fallback order" value={rule.fallbackProviders} exclude={rule.provider}
          onChange={(fallbackProviders) => onChange({ fallbackProviders })} />
        {rule.fallbackProviders.length > 1 && (
          <p className="text-xs leading-4 text-fg-dim">Order: {rule.fallbackProviders.join(" → ")}.</p>
        )}
      </section>

      <ExecutionPanel key={item.prompt.id} promptId={item.prompt.id} onChanged={onExecutionChanged} />
    </div>
  );
}

function OutcomeChip({ on, onClick, children }: { on: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn("rounded-full px-2.5 py-1 text-xs ring-1 ring-inset transition-colors", on ? "bg-accent/15 text-accent ring-accent/40" : "text-fg-muted ring-line hover:bg-surface-3")}
    >
      {children}
    </button>
  );
}
