"use client";

import type { OperationsPrompt, PromptPipelineRule } from "@agent-console/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/lib/providerTheme";
import { LABEL, onBlockedChip, onDoneChip, overrideChip, TONE, type stationOccupancy } from "./status";

export interface SubStepSummary {
  done: number;
  total: number;
}

/**
 * One card on a flowchart. Stations and sub-steps use the same card so a
 * nested sub-pipeline reads exactly like the pipeline that spawned it; only
 * the footer actions and the inheritance note differ.
 */
export function StationCard({
  index,
  item,
  rule,
  current,
  occupancy,
  readOnly = false,
  inherited = false,
  subSteps,
  onOpenSubPipeline,
  onConfig,
  onUseStationSettings,
  onRetry,
  onRemove,
  removeLabel = "Remove",
}: {
  index: number;
  item: OperationsPrompt;
  rule: PromptPipelineRule;
  current: boolean;
  occupancy: ReturnType<typeof stationOccupancy>;
  readOnly?: boolean;
  /** Sub-step only: the rule is the parent station's, not pinned here. */
  inherited?: boolean;
  subSteps?: SubStepSummary;
  onOpenSubPipeline?(): void;
  onConfig?(): void;
  /** Sub-step only: drop the override and follow the parent station again. */
  onUseStationSettings?(): void;
  /** Offered when a lost agent process left this item needing recovery. */
  onRetry?(): void;
  onRemove?(): void;
  removeLabel?: string;
}) {
  const theme = rule.provider === null ? null : providerTheme[rule.provider];
  const who = overrideChip(rule);
  const stuck = stuckNote(item.operationalState);
  const hasActions =
    !readOnly &&
    (onConfig !== undefined || onRemove !== undefined || onRetry !== undefined || (inherited === false && onUseStationSettings !== undefined));

  return (
    <div
      className={cn(
        "relative flex h-full min-w-0 flex-col rounded-panel border bg-surface-2 p-3",
        current ? "border-accent/50 ring-1 ring-accent/30" : "border-line",
      )}
    >
      <div className="flex items-start gap-2">
        {rule.provider !== null ? (
          <AgentAvatar
            provider={rule.provider}
            size={28}
            activity={occupancy !== null ? "tooling" : item.operationalState === "DONE" ? "done" : "idle"}
          />
        ) : (
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11px] numeric text-fg-muted">
            {index + 1}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-[13px] text-fg">{item.prompt.externalKey ?? item.prompt.title}</div>
              {item.prompt.externalKey !== null && (
                <div className="truncate text-[11px] text-fg-dim">{item.prompt.title}</div>
              )}
            </div>
            <Badge tone={TONE[item.operationalState]}>{LABEL[item.operationalState]}</Badge>
          </div>
          <div className={cn("mt-2 flex flex-wrap items-center gap-1.5 text-xs", theme?.text ?? "text-fg-muted")}>
            <span className="truncate">{who ?? "No agent — open config"}</span>
            {inherited && (
              <span
                className="rounded-full px-1.5 py-px text-[9.5px] uppercase tracking-wider text-fg-dim ring-1 ring-inset ring-line"
                title="Follows the parent station. Pick an agent here to pin one for this sub-step only."
              >
                inherited
              </span>
            )}
          </div>
          <div className="mt-1 text-[10px] text-fg-dim">
            {onDoneChip(rule.onDone)} · {onBlockedChip(rule)}
          </div>
          {occupancy !== null && (
            <div className="mt-2 flex items-center gap-2 text-[11px] text-fg-muted">
              <AgentAvatar provider={occupancy.provider} size={16} activity="tooling" />
              running
            </div>
          )}
        </div>
      </div>

      {stuck !== null && (
        <p className="mt-2.5 rounded-md bg-caution/10 px-2 py-1.5 text-[11px] leading-4 text-caution ring-1 ring-inset ring-caution/25">
          {stuck}
        </p>
      )}

      {subSteps !== undefined && subSteps.total > 0 && (
        <button
          type="button"
          onClick={onOpenSubPipeline}
          disabled={onOpenSubPipeline === undefined}
          className={cn(
            "mt-2.5 flex w-full items-center gap-2 rounded-md border border-dashed border-line px-2 py-1.5 text-left",
            onOpenSubPipeline !== undefined && "hover:border-accent/40 hover:bg-surface-3",
          )}
        >
          <SubStepMeter done={subSteps.done} total={subSteps.total} />
          <span className="min-w-0 flex-1 truncate text-[11px] text-fg-muted">
            {subSteps.done}/{subSteps.total} sub-steps done
          </span>
          {/* A parent with a failed sub-step used to read only "Waiting", which
              is true and useless — the trouble was a drill-down away and the
              card gave no reason to look. */}
          {item.childAttention !== null && (
            <Badge tone={TONE[item.childAttention]}>
              {item.childAttentionCount > 1 && `${item.childAttentionCount} `}
              {LABEL[item.childAttention].toLowerCase()}
            </Badge>
          )}
          {onOpenSubPipeline !== undefined && (
            <span className="shrink-0 text-[11px] text-accent">Open ›</span>
          )}
        </button>
      )}

      {hasActions && (
        <div className="mt-3 flex flex-wrap gap-1">
          {onRetry !== undefined && (
            <Button size="sm" variant="primary" aria-label="Retry this step" onClick={onRetry}>
              Retry
            </Button>
          )}
          {onConfig !== undefined && (
            <Button size="sm" variant="secondary" aria-label="Configure step" onClick={onConfig}>
              Config
            </Button>
          )}
          {!inherited && onUseStationSettings !== undefined && (
            <Button
              size="sm"
              variant="ghost"
              aria-label="Use parent station settings"
              title="Remove this sub-step's agent override. Execution status is unchanged."
              onClick={onUseStationSettings}
            >
              Use station settings
            </Button>
          )}
          {onRemove !== undefined && (
            <Button size="sm" variant="ghost" aria-label={removeLabel} onClick={onRemove}>
              {removeLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The one line an operator needs when a card is why the rail will not move.
 * Both states hold up every later step, so they must read as actionable rather
 * than as just another status chip.
 */
function stuckNote(state: OperationsPrompt["operationalState"]): string | null {
  // "Mark complete" is named in both: the run ending without a status says
  // nothing about whether the work got done, and re-running an agent to
  // re-report finished work is the expensive way out of that.
  if (state === "RECOVERY_NEEDED") return "The run stopped without posting a status — a crash, or a spent budget. Retry to continue it, mark it complete if the work is already done, or skip it.";
  if (state === "BLOCKED") return "Blocked on a human response. Answer it on the work item, mark it complete if the work is already done, or skip it.";
  return null;
}

function SubStepMeter({ done, total }: { done: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <span aria-hidden className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-surface-3">
      <span
        className={cn("block h-full rounded-full", pct === 100 ? "bg-success" : "bg-accent")}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}
