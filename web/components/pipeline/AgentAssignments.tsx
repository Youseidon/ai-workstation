"use client";

import type { PipelineFlowchartView, PipelinePolicy, PipelineRecord, ProviderId, ProviderInfo } from "@agent-console/shared";
import { modelLabel, PROVIDER_IDS } from "@agent-console/shared";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";

type Assignment = { provider: ProviderId | null; model: string | null };
type DefaultsPatch = { defaultProvider?: ProviderId | null; defaultModel?: string | null; defaultFallbackProviders?: ProviderId[]; resetPromptAgents?: boolean };

/** Suite lead → prompt exceptions → ordered relief agents, all in one place. */
export function AgentAssignments({ pipeline, suiteName, view, providers, policy, busy, promptLabel, onDefaults, onAutoReassign, onPrompt, onConfigure }: {
  pipeline: PipelineRecord;
  suiteName: string;
  view: PipelineFlowchartView;
  providers: ProviderInfo[];
  policy: PipelinePolicy;
  busy: boolean;
  promptLabel(id: number): string;
  onDefaults(patch: DefaultsPatch): void;
  onAutoReassign(enabled: boolean): void;
  onPrompt(id: number, choice: Assignment, inheritFromParent: boolean): void;
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
    <section id="agent-assignments" aria-label="Agent assignments" className="scroll-mt-28 space-y-4 rounded-panel border border-accent/30 bg-surface-1 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-fg">Agent assignments</h3>
          <p className="mt-1 text-xs leading-5 text-fg-muted">Choose once for {suiteName}. Prompts and new sub-steps follow this agent unless you set an override.</p>
        </div>
        <span className="text-xs text-fg-dim">{view.steps.length} prompts · {overrides} overrides</span>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-medium text-fg-muted">Suite agent</div>
        <AssignmentPicker label="Suite agent" value={{ provider: defaults.defaultProvider, model: defaults.defaultModel }} providers={providers} disabled={busy}
          onChange={(choice) => onDefaults({ defaultProvider: choice.provider, defaultModel: choice.model,
            defaultFallbackProviders: fallbackList.filter((id) => id !== choice.provider) })} />
        {defaults.defaultProvider === null && <p className="text-xs text-caution">Choose a suite agent to cover prompts without an override.</p>}
        {overrides > 0 && (
          <Button size="sm" variant="ghost" disabled={busy || defaults.defaultProvider === null}
            onClick={() => onDefaults({ resetPromptAgents: true })}>Use suite agent for all prompts</Button>
        )}
        <p className="text-xs text-fg-dim">Saved for this pipeline. Changes apply when the next job starts.</p>
      </div>

      <details className="rounded-md border border-line">
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-accent">Prompt overrides · assign exceptions here</summary>
        <div className="divide-y divide-line border-t border-line">
          {rows.length === 0 && <p className="p-3 text-xs text-fg-dim">Add prompts to this suite’s flowchart to configure exceptions.</p>}
          {rows.map((row) => (
            <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <button type="button" onClick={() => onConfigure(row.id)} title="Open prompt configuration"
                className={`min-w-0 text-left text-xs text-accent hover:underline ${row.child ? "pl-4" : ""}`}>
                {row.child ? "↳ " : ""}{promptLabel(row.id)}
              </button>
              <AssignmentPicker label={`Agent for ${promptLabel(row.id)}`} providers={providers} disabled={busy}
                inheritLabel={row.child ? "Follow parent prompt" : `Suite agent${defaults.defaultProvider ? ` · ${defaults.defaultProvider}` : ""}`}
                value={row.inherited ? { provider: null, model: null } : row.rule}
                onChange={(choice) => onPrompt(row.id, choice, row.child && choice.provider === null)} />
            </div>
          ))}
        </div>
      </details>

      <div className="space-y-3 border-t border-line pt-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <label htmlFor={`auto-reassign-${pipeline.id}`} className="text-xs font-medium text-fg">Automatically reassign agents</label>
            <p className="mt-1 text-xs leading-5 text-fg-muted">{pipeline.autoReassign ? "On" : "Off"} for this pipeline. When on, skip agents at their 5-hour, weekly, or other reported cap and try the next available fallback. Also handles provider outages.</p>
          </div>
          <Switch id={`auto-reassign-${pipeline.id}`} checked={pipeline.autoReassign} disabled={busy} onCheckedChange={onAutoReassign} />
        </div>
        <div className="text-xs text-fg-muted">Fallback order for this suite</div>
        <div className="flex flex-wrap gap-1.5">
          {PROVIDER_IDS.filter((id) => id !== defaults.defaultProvider).map((id) => {
            const index = fallbackList.indexOf(id);
            return <button key={id} type="button" disabled={busy} aria-pressed={index >= 0}
              title={index >= 0 ? "Remove fallback; re-add to move it to the end" : "Add to fallback order"}
              onClick={() => onDefaults({ defaultFallbackProviders: index >= 0 ? fallbackList.filter((entry) => entry !== id) : [...fallbackList, id] })}
              className={`rounded-full px-2.5 py-1 text-xs ring-1 ring-inset ${index >= 0 ? "bg-accent/15 text-accent ring-accent/40" : "text-fg-muted ring-line hover:bg-surface-3"}`}>
              {id}{index >= 0 ? ` · ${index + 1}` : ""}
            </button>;
          })}
        </div>
        <p className="text-xs leading-5 text-fg-dim">{fallbackList.length ? fallbackList.join(" → ") : `Uses house order: ${policy.fallbackProviders.join(" → ") || "none"}`}. Prompt fallback lists take precedence. If all agents are capped or unavailable, the pipeline waits for you. Usage gaps are handled when the provider reports an error.</p>
      </div>
    </section>
  );
}

function AssignmentPicker({ label, value, providers, disabled, inheritLabel = "Choose an agent", onChange }: {
  label: string; value: Assignment; providers: ProviderInfo[]; disabled: boolean; inheritLabel?: string; onChange(choice: Assignment): void;
}) {
  const info = providers.find((provider) => provider.id === value.provider);
  const model = info?.modelSelectionMode === "auto" ? info.model : value.model;
  const selectClass = "max-w-full rounded-md border border-line bg-surface-2 px-2 py-1.5 text-xs text-fg disabled:opacity-50";
  return (
    <div className="flex max-w-full flex-wrap gap-2">
      <select aria-label={label} value={value.provider ?? ""} disabled={disabled} className={selectClass}
        onChange={(event) => onChange({ provider: event.target.value === "" ? null : event.target.value as ProviderId, model: null })}>
        <option value="">{inheritLabel}</option>
        {PROVIDER_IDS.map((id) => <option key={id} value={id}>{id}{providers.find((provider) => provider.id === id)?.available ? "" : " · unavailable"}</option>)}
      </select>
      {value.provider !== null && (
        <select aria-label={`${label} model`} value={model ?? ""} disabled={disabled || info?.modelSelectionMode === "auto"} className={selectClass}
          onChange={(event) => onChange({ provider: value.provider, model: event.target.value || null })}>
          <option value="">Provider default</option>
          {model && !info?.models.some((option) => option.id === model) && <option value={model}>{modelLabel(value.provider, model)}</option>}
          {info?.models.filter((option) => option.id !== null).map((option) => <option key={option.id} value={option.id!}>{option.label}</option>)}
        </select>
      )}
    </div>
  );
}
