"use client";

import type { OperationsPrompt, PromptPipelineRule } from "@hydra/shared";
import { AgentAvatar } from "@/features/providers/components/AgentAvatar";
import { Badge } from "@/components/ui/Badge";
import { EditIconButton } from "@/components/ui/EditIconButton";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/features/providers/lib/providerTheme";
import { LABEL, overrideChip, TONE, type stationOccupancy } from "../lib/status";

export interface SubStepSummary {
  done: number;
  total: number;
}

/** Two readable lines; details and execution rules belong to the item panel. */
export const STATION_CARD_HEIGHT = 80;

const EDGE: Record<string, string> = {
  success: "before:bg-success",
  info: "before:bg-info",
  warning: "before:bg-warning",
  caution: "before:bg-caution",
  danger: "before:bg-danger",
  accent: "before:bg-accent",
  violet: "before:bg-violet",
  neutral: "before:bg-line-strong",
};

/**
 * One card on a flowchart. Stations and sub-steps share it so a nested
 * sub-pipeline reads like the pipeline that spawned it.
 *
 * The card is a selector, not a toolbar: clicking it opens the item panel,
 * where every action lives in one fixed place. Only composing the flowchart
 * (remove, in edit mode) is done on the card itself.
 */
export function StationCard({
  index,
  item,
  rule,
  current,
  occupancy,
  selected = false,
  readOnly = false,
  inherited = false,
  subSteps,
  onSelect,
  onConfigure,
  onOpenSubPipeline,
  onRemove,
  removeLabel = "Remove",
}: {
  index: number;
  item: OperationsPrompt;
  rule: PromptPipelineRule;
  current: boolean;
  occupancy: ReturnType<typeof stationOccupancy>;
  selected?: boolean;
  readOnly?: boolean;
  /** Sub-step only: the rule is the parent station's, not pinned here. */
  inherited?: boolean;
  subSteps?: SubStepSummary;
  onSelect?(): void;
  onConfigure?(): void;
  onOpenSubPipeline?(): void;
  onRemove?(): void;
  removeLabel?: string;
}) {
  const theme = rule.provider === null ? null : providerTheme[rule.provider];
  const who = overrideChip(rule);
  const stuck = stuckNote(item);
  const canRemove = !readOnly && onRemove !== undefined;
  const tone = TONE[item.operationalState];
  const label = item.prompt.externalKey ?? item.prompt.title;

  return (
    <div
      style={{ height: STATION_CARD_HEIGHT }}
      className={cn(
        "group relative flex min-w-0 flex-row overflow-visible rounded-panel border bg-surface-2 transition-[border-color,box-shadow,background-color]",
        // Status edge: the one colour cue that reads at a glance across a row.
        "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-['']",
        EDGE[tone] ?? EDGE.neutral,
        selected
          ? "border-accent/70 bg-surface-3 shadow-[0_0_0_1px_var(--color-accent)]"
          : current
            ? "border-accent/50 ring-1 ring-accent/30"
            : "border-line hover:border-line-strong hover:bg-surface-3",
      )}
    >
      {/* The whole card is the hit target; inner controls sit above it. */}
      <button
        type="button"
        onClick={onSelect}
        aria-label={`Open ${label}`}
        aria-pressed={selected}
        className="absolute inset-0 z-0 rounded-panel focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      />

      <div className="pointer-events-none relative flex min-h-0 min-w-0 flex-1 items-center gap-2.5 px-3 py-2">
        <span className="w-5 shrink-0 text-center text-xs numeric text-fg-dim">{index + 1}</span>
        {rule.provider !== null && <AgentAvatar provider={rule.provider} size={24} activity={occupancy !== null ? "tooling" : item.operationalState === "DONE" ? "done" : "idle"} />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs text-fg-muted">{item.prompt.externalKey ?? `Step ${index + 1}`}</span>
            <Badge tone={tone} pulse={item.operationalState === "WORKING"}>{LABEL[item.operationalState]}</Badge>
          </div>
          <div className="truncate text-sm leading-5 text-fg" title={item.prompt.title}>{item.prompt.title}</div>
          <div className="flex min-w-0 items-center gap-2 text-[0.6875rem] leading-4 text-fg-dim">
            <span className={cn("min-w-0 truncate", theme?.text)} title={who ?? "No agent — configure in Studio"}>{occupancy?.source.type === "wrapup" ? "Wrapping up" : who ?? "Choose agent"}{inherited ? " · inherited" : ""}</span>
            {stuck !== null && <span className="min-w-0 truncate text-caution" title={stuck.long}>⚠ {stuck.short}</span>}
            {subSteps !== undefined && subSteps.total > 0 && <span className="ml-auto shrink-0 numeric" title={item.childAttention !== null ? `${item.childAttentionCount} sub-steps need attention` : undefined}>{subSteps.done}/{subSteps.total} sub-steps{item.childAttention !== null ? " ⚠" : ""}</span>}
          </div>
        </div>
      </div>
      {(onConfigure !== undefined || onOpenSubPipeline !== undefined || canRemove) && (
        <div className="relative z-10 flex shrink-0 flex-col justify-center gap-1 pr-2">
          {onOpenSubPipeline !== undefined && subSteps !== undefined && subSteps.total > 0 && <CardChip onClick={onOpenSubPipeline} title="Open the sub-step flow">Sub-steps ›</CardChip>}
          {onConfigure !== undefined && <EditIconButton label={`Edit ${label} in Studio`} onClick={onConfigure} />}
          {canRemove && <CardChip onClick={onRemove} title={removeLabel} danger>{removeLabel}</CardChip>}
        </div>
      )}
    </div>
  );
}

function CardChip({
  children,
  title,
  danger = false,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  danger?: boolean;
  onClick?(): void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
      }}
      className={cn(
        "rounded-md bg-surface-1 px-2 py-0.5 text-xs shadow-sm ring-1 ring-inset",
        danger ? "text-danger ring-danger/30 hover:bg-danger/10" : "text-accent ring-line hover:bg-surface-2",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The one line an operator needs when a card is why the rail will not move.
 * Short form on the card; the long form is the tooltip and the panel.
 */
function stuckNote(item: OperationsPrompt): { short: string; long: string } | null {
  if (item.humanIntervention?.status === "PENDING") {
    return { short: "Waiting on your approval", long: "An approval point after this step needs your decision before the agent continues." };
  }
  if (item.operationalState === "BLOCKED") {
    return {
      short: "Blocked — needs your answer",
      long: "Blocked on a human response. Answer it in the Conversation tab, mark it complete if the work is already done, or skip it.",
    };
  }
  // `recoverable` also covers a run that ended UNREPORTED or FAILED — same fix.
  if (item.prompt.recoverable) {
    return {
      short: "Run stopped without a status",
      long: "The run stopped without posting a status — a crash, or a spent budget. Recover to continue it, mark it complete if the work is already done, or skip it.",
    };
  }
  return null;
}
