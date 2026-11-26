"use client";

import type { ReactNode } from "react";
import type { OperationsPrompt, PromptPipelineRule, SuitePipelineRun } from "@hydra/shared";
import { isTerminal } from "../lib/station/tree";
import { Badge } from "@/components/ui/Badge";
import type { RunStatus } from "@/models/runs";
import { SnakeFlow } from "./SnakeFlow";
import { StationCard } from "./StationCard";
import { onUnfinishedChip, overrideChip, stationOccupancy } from "../lib/status";

export interface SubStepRuleView {
  rule: PromptPipelineRule;
  inherited: boolean;
}

export interface SubTrailEntry {
  promptId: number;
  label: string;
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
  selectedId,
  onNavigate,
  onOpen,
  onSelect,
  onConfigure,
  renderGate,
}: {
  /** Station first, deepest open node last. Clicking an entry navigates up. */
  trail: SubTrailEntry[];
  items: OperationsPrompt[];
  /** Effective rule of the node these sub-steps hang off. */
  parentRule: PromptPipelineRule;
  ruleFor(promptId: number): SubStepRuleView;
  activeRun: SuitePipelineRun | null;
  runs: RunStatus[];
  selectedId: number | null;
  /** `null` returns to the station flowchart; an index returns to that depth. */
  onNavigate(index: number | null): void;
  /** Drill into a sub-step's own sub-steps. */
  onOpen(promptId: number): void;
  /** Show a sub-step in the item panel. */
  onSelect(promptId: number): void;
  /** Opens a sub-step's settings in the studio. */
  onConfigure?(promptId: number): void;
  renderGate?(item: OperationsPrompt): ReactNode;
}) {
  const parent = trail[trail.length - 1];
  const done = items.filter((item) => isTerminal(item)).length;
  const pinned = items.filter((item) => !ruleFor(item.prompt.id).inherited).length;
  // The first slice the scheduler will refuse to walk past.
  const blocking = items.find(
    (item) => item.prompt.recoverable || item.operationalState === "BLOCKED",
  );

  return (
    <div className="space-y-3">
      <nav aria-label="Sub-pipeline trail" className="flex flex-wrap items-center gap-1.5 text-xs">
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

      <div className="flex flex-wrap items-center gap-2 border-b border-line pb-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{parent?.label ?? "Sub-steps"}</h3>
        {blocking !== undefined && <Badge tone="caution">{blocking.prompt.externalKey ?? blocking.prompt.title} needs attention</Badge>}
        <Badge tone={items.length > 0 && done === items.length ? "success" : "neutral"}>{done}/{items.length} settled</Badge>
        <details className="text-xs text-fg-muted"><summary className="cursor-pointer">Inheritance</summary><p className="py-2">{pinned} pinned · {overrideChip(parentRule) ?? "No agent"} · unfinished: {onUnfinishedChip(parentRule)}. Sub-steps run in agent-defined order before their parent finishes.</p></details>
      </div>

      {items.length === 0 ? (
        <div className="rounded-panel border border-dashed border-line bg-surface-1 px-6 py-12 text-center text-sm text-fg-dim">
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
          renderGate={renderGate === undefined ? undefined : (item) => renderGate(item)}
          renderCard={(item, index) => {
            const view = ruleFor(item.prompt.id);
            const childDone = item.children.filter((child) => isTerminal(child)).length;
            return (
              <StationCard
                index={index}
                item={item}
                rule={view.rule}
                inherited={view.inherited}
                current={activeRun?.currentPromptId === item.prompt.id}
                occupancy={stationOccupancy(item, runs, activeRun)}
                selected={selectedId === item.prompt.id}
                subSteps={item.children.length > 0 ? { done: childDone, total: item.children.length } : undefined}
                onSelect={() => onSelect(item.prompt.id)}
                onConfigure={onConfigure === undefined ? undefined : () => onConfigure(item.prompt.id)}
                onOpenSubPipeline={item.children.length > 0 ? () => onOpen(item.prompt.id) : undefined}
              />
            );
          }}
        />
      )}

    </div>
  );
}
