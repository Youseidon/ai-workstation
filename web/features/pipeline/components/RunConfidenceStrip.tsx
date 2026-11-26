"use client";

import type { OperationsPrompt, PipelinePolicy, ProviderId } from "@hydra/shared";
import { cn } from "@/lib/cn";
import type { InspectorTab } from "./PipelineInspector";

/**
 * Sticky summary of the ceilings and rules that govern the next Play.
 * Chips open the matching inspector tab.
 */
export function RunConfidenceStrip({
  execution,
  policy,
  suiteFallbacks,
  stationFallbacks,
  continuation,
  waitReason,
  occupancyWrapUp,
  latestAudit,
  onOpenTab,
  bare = false,
  autoReassign = false,
}: {
  execution?: OperationsPrompt["execution"];
  policy: PipelinePolicy;
  suiteFallbacks: ProviderId[];
  stationFallbacks: ProviderId[] | null;
  continuation: OperationsPrompt["continuation"];
  waitReason: string | null | undefined;
  occupancyWrapUp: boolean;
  latestAudit: OperationsPrompt["latestAudit"];
  onOpenTab(tab: InspectorTab): void;
  /** Drop the frame when nested inside another panel. */
  bare?: boolean;
  autoReassign?: boolean;
}) {
  const effectiveFallbacks =
    stationFallbacks !== null && stationFallbacks.length > 0
      ? stationFallbacks
      : suiteFallbacks.length > 0
        ? suiteFallbacks
        : policy.fallbackProviders;
  const fallbackSource =
    stationFallbacks !== null && stationFallbacks.length > 0
      ? "station"
      : suiteFallbacks.length > 0
        ? "suite"
        : "house";

  const continuationsHot =
    waitReason === "continuations_exhausted" ||
    (continuation !== null && continuation.attempt >= continuation.of);
  const budgetHot = occupancyWrapUp || waitReason==="execution:budget_exhausted" || (waitReason?.startsWith("budget_") ?? false);

  return (
    <div
      aria-label="Run confidence"
      className={cn(
        "flex flex-wrap items-center gap-1.5",
        !bare && "rounded-panel border border-line bg-surface-1 px-3 py-2",
      )}
    >
      <span className="mr-1 text-xs font-semibold uppercase tracking-[0.14em] text-fg-dim">
        Execution policy
      </span>

      {execution && <Chip title="Cumulative requirement allowance, including reserved and unknown usage" hot={execution.attempts>=execution.policy.maxAttempts} onClick={()=>onOpenTab("budgets")}>
        {execution.engine === "shadow" ? "Shadow" : execution.phase === "delivered" ? "Verified delivery" : execution.exception?.code === "budget_exhausted" ? "Budget exhausted" : execution.exception ? "Exception" : execution.phase === "verification" ? "Verification pending" : "Implementation"} · {execution.acceptedUnits.length} units accepted · {execution.attempts}/{execution.policy.maxAttempts} attempts
      </Chip>}
      <Chip
        hot={continuationsHot}
        title="Automatic successors include agent-requested CONTINUE, crashed and unreported runs"
        onClick={() => onOpenTab("policy")}
      >
        {execution?.engine==="supervised"?"Worker attempts":"Successors"} · max {execution?.engine==="supervised" ? execution.policy.unitAttempts : policy.maxContinuations}
        {continuation !== null && (
          <span className="text-fg-dim">
            {" "}
            · {execution?.engine==="supervised"?"used":"live"} {continuation.attempt}/{continuation.of}
          </span>
        )}
        {execution?.engine==="supervised" ? execution.exception || execution.phase==="delivered" ? "" : " · then recovery" : policy.reviewAfterContinuations ? " · then review" : ""}
      </Chip>

      <Chip
        title={`Fallback order (${fallbackSource})`}
        onClick={() => onOpenTab(fallbackSource === "station" ? "station" : "policy")}
      >
        {autoReassign ? "Fallbacks" : "Auto reassignment"} ·{" "}
        {autoReassign ? (effectiveFallbacks.length > 0 ? effectiveFallbacks.join(" → ") : "none") : "off"}
        {autoReassign && fallbackSource !== "house" && (
          <span className="text-fg-dim"> · {fallbackSource}</span>
        )}
      </Chip>

      <Chip hot={budgetHot} title="Run budget ceilings" onClick={() => onOpenTab("budgets")}>
        {execution?.exception?.code==="budget_exhausted" ? "Budget · allowance exhausted" : occupancyWrapUp ? "Budget · banking work" : budgetHot ? "Budget · ceiling hit" : "Budgets · ceilings apply"}
      </Chip>

      <Chip title="Definition of done enforcement" onClick={() => onOpenTab("definition")}>
        DoD · {policy.dodEnforcement}
      </Chip>

      <Chip
        title={`Pause is ${policy.pauseMode}; Stop ${policy.stopInterruptsAgent ? "interrupts" : "does not interrupt"} the agent`}
        onClick={() => onOpenTab("policy")}
      >
        Pause {policy.pauseMode} · Stop{" "}
        {policy.stopInterruptsAgent ? "interrupts" : "waits"}
      </Chip>

      {latestAudit?.report != null && (
        <Chip title="Latest completion-audit confidence" onClick={() => onOpenTab("station")}>
          Audit · {latestAudit.report.confidence.toLowerCase()} confidence
        </Chip>
      )}
    </div>
  );
}

function Chip({
  children,
  title,
  onClick,
  hot = false,
}: {
  children: React.ReactNode;
  title: string;
  onClick(): void;
  hot?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "rounded-full px-2.5 py-1 text-xs ring-1 ring-inset transition-colors",
        hot
          ? "bg-caution/15 text-caution ring-caution/40 hover:bg-caution/20"
          : "bg-surface-2 text-fg-muted ring-line hover:bg-surface-3 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
