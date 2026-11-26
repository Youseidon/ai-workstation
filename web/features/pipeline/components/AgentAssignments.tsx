"use client";

import type { PipelineFlowchartView, PipelinePolicy, PipelineRecord, ProviderId, ProviderInfo } from "@hydra/shared";
import { AgentModelPicker, FallbackOrderPicker, type AgentChoice } from "@/features/agents/components/AgentModelPicker";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import type { useModelSelection } from "@/features/providers/hooks/useModelSelection";

type DefaultsPatch = { defaultProvider?: ProviderId | null; defaultModel?: string | null; defaultFallbackProviders?: ProviderId[]; resetPromptAgents?: boolean };

/** Suite lead → prompt exceptions → ordered relief agents, all in one place. */
export function AgentAssignments({ pipeline, suiteName, view, providers, models, policy, busy, promptLabel, onDefaults, onAutoReassign, onPrompt, onConfigure }: {
  pipeline: PipelineRecord;
  suiteName: string;
  view: PipelineFlowchartView;
  providers: ProviderInfo[];
  models?: ReturnType<typeof useModelSelection>;
  policy: PipelinePolicy;
  busy: boolean;
  promptLabel(id: number): string;
  onDefaults(patch: DefaultsPatch): void;
  onAutoReassign(enabled: boolean): void;
  onPrompt(id: number, choice: AgentChoice, inheritFromParent: boolean): void;
  onConfigure(id: number): void;
}) {
  const defaults = view.defaults;
  const overrides = view.steps.filter((step) => step.provider !== null).length
    + view.subSteps.filter((step) => !step.inherited && step.rule.provider !== null).length;
  const fallbackList = defaults.defaultFallbackProviders;
  const rows = view.steps.flatMap((step) => [
    { id: step.promptId, rule: step, child: false, inherited: step.provider === null },
    ...view.subSteps.filter((sub) => {
      let parent = sub.parentPromptId;
      while (parent !== step.promptId) {
        const ancestor = view.subSteps.find((entry) => entry.promptId === parent);
        if (ancestor === undefined) return false;
        parent = ancestor.parentPromptId;
      }
      return true;
    }).map((sub) => ({ id: sub.promptId, rule: sub.rule, child: true, inherited: sub.inherited })),
  ]);

  return (
    <section id="agent-assignments" aria-label="Agent assignments" className="space-y-6">
      <div className="studio-card space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-fg">Suite agent</h3>
            <p className="mt-1 text-xs leading-5 text-fg-muted">Choose once for {suiteName}. Prompts and new sub-steps follow this agent unless you set an override below.</p>
          </div>
          <span className="text-xs text-fg-dim">{view.steps.length} prompts · {overrides} overrides</span>
        </div>
        <AgentModelPicker label="Suite agent" value={{ provider: defaults.defaultProvider, model: defaults.defaultModel }} providers={providers} models={models} disabled={busy}
          onChange={(choice) => onDefaults({ defaultProvider: choice.provider, defaultModel: choice.model,
            defaultFallbackProviders: fallbackList.filter((id) => id !== choice.provider) })} />
        {defaults.defaultProvider === null && <p className="text-xs text-caution">Choose a suite agent to cover prompts without an override.</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-fg-dim">Saved for this pipeline. Changes apply when the next job starts.</p>
          {overrides > 0 && (
            <Button size="sm" variant="ghost" disabled={busy || defaults.defaultProvider === null}
              onClick={() => onDefaults({ resetPromptAgents: true })}>Use suite agent for all prompts</Button>
          )}
        </div>
      </div>

      <div className="studio-card space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-fg">Prompt overrides</h3>
          <p className="mt-1 text-xs leading-5 text-fg-muted">Exceptions to the suite agent. The leading chip means “no override”.</p>
        </div>
        <div className="divide-y divide-line rounded-md border border-line">
          {rows.length === 0 && <p className="p-3 text-xs text-fg-dim">Add prompts to this suite’s flowchart to configure exceptions.</p>}
          {rows.map((row) => (
            <div key={row.id} className="grid gap-2 px-3 py-2.5 md:grid-cols-[minmax(7rem,10rem)_1fr] md:items-center">
              <button type="button" onClick={() => onConfigure(row.id)} title="Open this step's settings"
                className={`min-w-0 truncate text-left text-xs font-medium text-accent hover:underline ${row.child ? "pl-4" : ""}`}>
                {row.child ? "↳ " : ""}{promptLabel(row.id)}
              </button>
              <AgentModelPicker label={`Agent for ${promptLabel(row.id)}`} providers={providers} models={models} disabled={busy} size="sm"
                inherit={row.child ? { label: "Follow parent" } : { label: "Suite agent", provider: defaults.defaultProvider }}
                value={row.inherited ? { provider: null, model: null } : row.rule}
                onChange={(choice) => onPrompt(row.id, choice, row.child && choice.provider === null)} />
            </div>
          ))}
        </div>
      </div>

      <div className="studio-card space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <label htmlFor={`auto-reassign-${pipeline.id}`} className="text-sm font-semibold text-fg">Automatically reassign agents</label>
            <p className="mt-1 text-xs leading-5 text-fg-muted">{pipeline.autoReassign ? "On" : "Off"} for this pipeline. When on, skip agents at their 5-hour, weekly, or other reported cap and try the next available fallback. Also handles provider outages.</p>
          </div>
          <Switch id={`auto-reassign-${pipeline.id}`} checked={pipeline.autoReassign} disabled={busy} onCheckedChange={onAutoReassign} />
        </div>
        <div className="text-xs font-medium text-fg-muted">Fallback order for this suite</div>
        <FallbackOrderPicker label="Suite fallback order" value={fallbackList} exclude={defaults.defaultProvider} disabled={busy}
          onChange={(next) => onDefaults({ defaultFallbackProviders: next })} />
        <p className="text-xs leading-5 text-fg-dim">{fallbackList.length ? fallbackList.join(" → ") : `Uses house order: ${policy.fallbackProviders.join(" → ") || "none"}`}. Prompt fallback lists take precedence. If all agents are capped or unavailable, the pipeline waits for you.</p>
      </div>
    </section>
  );
}
