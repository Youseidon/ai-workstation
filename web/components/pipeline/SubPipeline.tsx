"use client";

import type { OperationsPrompt, PromptPipelineRule, SuitePipelineRun } from "@agent-console/shared";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import type { RunStatus } from "@/lib/agentConsole";
import { SnakeFlow } from "./SnakeFlow";
import { StationCard } from "./StationCard";
import { onUnfinishedChip, overrideChip, stationOccupancy, TONE, LABEL } from "./status";

export interface SubStepRuleView {
  rule: PromptPipelineRule;
  inherited: boolean;
}

export interface SubTrailEntry {
  promptId: number;
  label: string;
}

function isDone(item: OperationsPrompt): boolean {
  return item.operationalState === "DONE" || item.operationalState === "SKIPPED";
}

/**
 * The flowchart a station spawned by decomposing itself, drawn with the same
 * cards and the same snake as the pipeline above it. Sub-steps are not
 * flowchart entries — order and membership come from the agent — so this view
 * configures rather than composes: which agent runs each slice, what happens
 * when one blocks, and skipping a slice that no longer applies.
 */
export function SubPipeline({
  trail,
  items,
  parentRule,
  ruleFor,
  activeRun,
  runs,
  readOnly,
  busy,
  onNavigate,
  onOpen,
  onConfig,
  onUseStationSettings,
  onRetry,
  onSkip,
}: {
  /** Station first, deepest open node last. Clicking an entry navigates up. */
  trail: SubTrailEntry[];
  items: OperationsPrompt[];
  /** Effective rule of the node these sub-steps hang off. */
  parentRule: PromptPipelineRule;
  ruleFor(promptId: number): SubStepRuleView;
  activeRun: SuitePipelineRun | null;
  runs: RunStatus[];
  readOnly: boolean;
  busy: boolean;
  /** `null` returns to the station flowchart; an index returns to that depth. */
  onNavigate(index: number | null): void;
  onOpen(promptId: number): void;
  onConfig(promptId: number): void;
  onUseStationSettings(promptId: number): void;
  onRetry(promptId: number): void;
  onSkip(promptId: number): void;
}) {
  const parent = trail[trail.length - 1];
  const done = items.filter(isDone).length;
  const pinned = items.filter((item) => !ruleFor(item.prompt.id).inherited).length;
  // The first slice the scheduler will refuse to walk past.
  const blocking = items.find(
    (item) => item.operationalState === "RECOVERY_NEEDED" || item.operationalState === "BLOCKED",
  );

  return (
    <div className="space-y-4">
      <nav aria-label="Sub-pipeline trail" className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <button type="button" onClick={() => onNavigate(null)} className="text-accent hover:underline">
          ← Flowchart
        </button>
        {trail.map((entry, index) => (
          <span key={entry.promptId} className="flex items-center gap-1.5">
            <span aria-hidden className="text-fg-dim/60">
              ›
            </span>
            {index === trail.length - 1 ? (
              <span className="text-fg-muted">{entry.label}</span>
            ) : (
              <button type="button" onClick={() => onNavigate(index)} className="text-accent hover:underline">
                {entry.label}
              </button>
            )}
          </span>
        ))}
      </nav>

      <div className="rounded-panel border border-line bg-surface-1 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.18em] text-fg-dim">Sub-pipeline</div>
            <h3 className="mt-1 truncate text-lg text-fg">{parent?.label ?? "Sub-steps"}</h3>
            <p className="mt-1 text-xs leading-5 text-fg-dim">
              The agent split this step into {items.length} slice{items.length === 1 ? "" : "s"} and runs them in
              order before finishing the step itself. Order comes from the agent; the agent and blocked policy are
              yours to set.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {blocking !== undefined && (
              <Badge tone="caution" dot>
                {blocking.prompt.externalKey ?? blocking.prompt.title} is holding the rail
              </Badge>
            )}
            <Badge tone={done === items.length ? "success" : "accent"}>
              {done}/{items.length} done
            </Badge>
            <Badge tone={pinned === 0 ? "neutral" : "violet"}>
              {pinned === 0 ? "all inherited" : `${pinned} pinned`}
            </Badge>
          </div>
        </div>
        <div className="mt-3 border-t border-line pt-2 text-[11px] text-fg-dim">
          Inherited from this step: <span className="text-fg-muted">{overrideChip(parentRule) ?? "no agent yet"}</span>
          {" · on blocked "}
          <span className="text-fg-muted">{onUnfinishedChip(parentRule)}</span>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="rounded-panel border border-dashed border-line bg-surface-1/70 px-6 py-12 text-center text-sm text-fg-dim">
          This step has no sub-steps.
        </div>
      ) : (
        <SnakeFlow
          items={items}
          getKey={(item) => item.prompt.id}
          isLiveIndex={(index) => {
            const item = items[index];
            return item !== undefined && activeRun?.currentPromptId === item.prompt.id;
          }}
          renderCard={(item, index) => {
            const view = ruleFor(item.prompt.id);
            const childDone = item.children.filter(isDone).length;
            return (
              <StationCard
                index={index}
                item={item}
                rule={view.rule}
                inherited={view.inherited}
                current={activeRun?.currentPromptId === item.prompt.id}
                occupancy={stationOccupancy(item, runs, activeRun)}
                readOnly={readOnly}
                subSteps={item.children.length > 0 ? { done: childDone, total: item.children.length } : undefined}
                onOpenSubPipeline={item.children.length > 0 ? () => onOpen(item.prompt.id) : undefined}
                onConfig={readOnly || busy ? undefined : () => onConfig(item.prompt.id)}
                onUseStationSettings={readOnly || busy ? undefined : () => onUseStationSettings(item.prompt.id)}
                onRetry={readOnly || busy || item.operationalState !== "RECOVERY_NEEDED" ? undefined : () => onRetry(item.prompt.id)}
                onRemove={readOnly || busy || isDone(item) ? undefined : () => onSkip(item.prompt.id)}
                removeLabel="Skip"
              />
            );
          }}
        />
      )}

      <ol className="space-y-1">
        {items.map((item, index) => (
          <li key={item.prompt.id} className="flex items-center gap-2 text-[11px]">
            <span className="w-5 shrink-0 text-right numeric text-fg-dim">{index + 1}</span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                item.operationalState === "SKIPPED" ? "text-fg-dim line-through" : "text-fg-muted",
              )}
            >
              {item.prompt.externalKey ?? item.prompt.title}
            </span>
            <Badge tone={TONE[item.operationalState]}>{LABEL[item.operationalState]}</Badge>
          </li>
        ))}
      </ol>
    </div>
  );
}
