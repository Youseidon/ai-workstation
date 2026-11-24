"use client";

import type { OperationsPrompt, PromptPipelineRule } from "@agent-console/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/lib/providerTheme";
import { LABEL, onUnfinishedChip, onDoneChip, overrideChip, TONE, type stationOccupancy } from "./status";

export interface SubStepSummary {
  done: number;
  total: number;
}

/** Fixed so a row of cards never grows with its content. */
export const STATION_CARD_HEIGHT = 148;

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
        "group relative flex min-w-0 flex-col overflow-hidden rounded-panel border bg-surface-2 transition-[border-color,box-shadow,background-color]",
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

      <div className="pointer-events-none relative flex min-h-0 flex-1 flex-col py-2.5 pr-3 pl-3.5">
        <div className="flex items-start gap-2">
          {rule.provider !== null ? (
            <AgentAvatar
              provider={rule.provider}
              size={26}
              activity={occupancy !== null ? "tooling" : item.operationalState === "DONE" ? "done" : "idle"}
            />
          ) : (
            <span className="flex size-[26px] shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs numeric text-fg-muted">
              {index + 1}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm leading-5 text-fg" title={label}>{label}</div>
            <div className="truncate text-xs leading-4 text-fg-dim" title={item.prompt.title}>
              {item.prompt.externalKey !== null ? item.prompt.title : " "}
            </div>
          </div>
          <Badge tone={tone} pulse={item.operationalState === "WORKING"}>{LABEL[item.operationalState]}</Badge>
        </div>

        <div className={cn("mt-2 flex min-w-0 items-center gap-1.5 text-xs", theme?.text ?? "text-fg-muted")}>
          <span className="truncate">{who ?? "No agent — configure"}</span>
          {inherited && (
            <span
              className="shrink-0 rounded-full px-1.5 py-px text-xs uppercase tracking-wider text-fg-dim ring-1 ring-inset ring-line"
              title="Uses inherited agent settings. Choose an agent to override them for this prompt."
            >
              inherited
            </span>
          )}
        </div>
        <div
          className="mt-0.5 truncate text-xs text-fg-dim"
          title={`${onDoneChip(rule.onDone)} · ${onUnfinishedChip(rule)}`}
        >
          {onDoneChip(rule.onDone)} · {onUnfinishedChip(rule)}
          {item.continuation !== null && <> · cont. {item.continuation.attempt}/{item.continuation.of}</>}
          {rule.fallbackProviders.length > 0 && <> · ↪ {rule.fallbackProviders.join("→")}</>}
        </div>

        {item.execution && <p className="mt-1 truncate text-xs text-fg-dim">{item.execution.engine === "shadow" ? "Shadow" : item.execution.phase === "delivered" ? "Verified delivery" : item.execution.phase === "verification" ? "Verification pending" : "Implementation"} · {item.execution.acceptedUnits.length} accepted · {item.execution.attempts}/{item.execution.policy.maxAttempts} attempts</p>}

        {/* Footer line: exactly one of these, so the card height never moves. */}
        <div className="mt-auto pt-1.5">
          {occupancy !== null ? (
            <div className="flex items-center gap-1.5 text-xs text-info">
              <AgentAvatar provider={occupancy.provider} size={14} activity="tooling" />
              {occupancy.source.type === "wrapup" ? "wrapping up" : "running now"}
            </div>
          ) : stuck !== null ? (
            <p className="truncate text-xs text-caution" title={stuck.long}>
              ⚠ {stuck.short}
            </p>
          ) : subSteps !== undefined && subSteps.total > 0 ? (
            <div className="flex items-center gap-2 text-xs text-fg-muted">
              <SubStepMeter done={subSteps.done} total={subSteps.total} />
              <span className="min-w-0 flex-1 truncate">{subSteps.done}/{subSteps.total} sub-steps</span>
              {item.childAttention !== null && (
                <span className={cn("shrink-0", item.childAttention === "BLOCKED" ? "text-warning" : "text-caution")}>
                  {item.childAttentionCount > 1 && `${item.childAttentionCount} `}
                  {LABEL[item.childAttention].toLowerCase()}
                </span>
              )}
            </div>
          ) : item.latestAudit?.report != null ? (
            <p className="truncate text-xs text-fg-dim">audit · {item.latestAudit.report.confidence.toLowerCase()} confidence</p>
          ) : null}
        </div>
      </div>

      {onConfigure !== undefined && <button type="button" onClick={onConfigure}
        aria-label={`Configure agent for ${label}`}
        className="absolute right-2 bottom-2 z-10 rounded-md bg-surface-2 px-2 py-1 text-xs text-accent ring-1 ring-inset ring-line hover:bg-surface-3">Agent</button>}

      {(onOpenSubPipeline !== undefined || canRemove) && (
        <div className="absolute top-1.5 right-1.5 z-10 hidden gap-1 group-focus-within:flex group-hover:flex">
          {onOpenSubPipeline !== undefined && subSteps !== undefined && subSteps.total > 0 && (
            <CardChip onClick={onOpenSubPipeline} title="Open the sub-step flow">Sub-flow ›</CardChip>
          )}
          {canRemove && (
            <CardChip onClick={onRemove} title={removeLabel} danger>
              {removeLabel}
            </CardChip>
          )}
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
