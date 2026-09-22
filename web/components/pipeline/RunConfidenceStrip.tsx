"use client";

import type { OperationsPrompt, PipelinePolicy, ProviderId } from "@agent-console/shared";
import { cn } from "@/lib/cn";
import type { InspectorTab } from "./PipelineInspector";

/**
 * Sticky summary of the ceilings and rules that govern the next Play.
 * Chips open the matching inspector tab.
 */
export function RunConfidenceStrip({
  policy,
  suiteFallbacks,
  stationFallbacks,
  continuation,
  waitReason,
  occupancyWrapUp,
  latestAudit,
  onOpenTab,
}: {
  policy: PipelinePolicy;
  suiteFallbacks: ProviderId[];
  stationFallbacks: ProviderId[] | null;
  continuation: OperationsPrompt["continuation"];
  waitReason: string | null | undefined;
  occupancyWrapUp: boolean;
  latestAudit: OperationsPrompt["latestAudit"];
  onOpenTab(tab: InspectorTab): void;
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
  const budgetHot = occupancyWrapUp || (waitReason?.startsWith("budget_") ?? false);

  return (
    <div
      aria-label="Run confidence"
      className="flex flex-wrap items-center gap-1.5 rounded-panel border border-line bg-surface-1/80 px-3 py-2"
    >
      <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-dim">
        Running under
      </span>

      <Chip
        hot={continuationsHot}
        title="How many times a station may continue on its own"
        onClick={() => onOpenTab("policy")}
      >
        Continuations · max {policy.maxContinuations}
        {continuation !== null && (
          <span className="text-fg-dim">
            {" "}
            · live {continuation.attempt}/{continuation.of}
          </span>
        )}
        {policy.reviewAfterContinuations ? " · then review" : ""}
      </Chip>

      <Chip
        title={`Fallback order (${fallbackSource})`}
        onClick={() => onOpenTab(fallbackSource === "station" ? "station" : "policy")}
      >
        Fallbacks ·{" "}
        {effectiveFallbacks.length > 0 ? effectiveFallbacks.join(" → ") : "none"}
        {fallbackSource !== "house" && (
          <span className="text-fg-dim"> · {fallbackSource}</span>
        )}
      </Chip>

      <Chip hot={budgetHot} title="Run budget ceilings" onClick={() => onOpenTab("budgets")}>
        {budgetHot ? "Budget · wrap-up / ceiling hit" : "Budgets · ceilings apply"}
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
        "rounded-full px-2.5 py-1 text-[11px] ring-1 ring-inset transition-colors",
        hot
          ? "bg-caution/15 text-caution ring-caution/40 hover:bg-caution/20"
          : "bg-surface-2 text-fg-muted ring-line hover:bg-surface-3 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
