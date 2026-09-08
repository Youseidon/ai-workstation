"use client";

import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

const STEPS = [
  {
    id: "name",
    title: "Name & suites",
    body: "Give the pipeline a name and tick the suites it should run on the left rail.",
  },
  {
    id: "policy",
    title: "House rules",
    body: "Confirm pause/stop behaviour, continuation limits, and budgets before the first play.",
  },
  {
    id: "stations",
    title: "Station agents",
    body: "Open Configure on each station to pick the agent and outcomes. Save when the flowchart looks right.",
  },
] as const;

export type NewPipelineGuideStep = (typeof STEPS)[number]["id"];

/**
 * Lightweight first-run coach for `/pipeline/new`. Dismissible; does not block
 * the board — experts can skip straight to editing.
 */
export function NewPipelineGuide({
  step,
  onStepChange,
  onOpenPolicy,
  onFocusStations,
  onDismiss,
}: {
  step: NewPipelineGuideStep;
  onStepChange(step: NewPipelineGuideStep): void;
  onOpenPolicy(): void;
  onFocusStations(): void;
  onDismiss(): void;
}) {
  const index = STEPS.findIndex((entry) => entry.id === step);
  const current = STEPS[index] ?? STEPS[0];

  return (
    <div className="rounded-panel border border-accent/30 bg-accent/[0.06] px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-accent">
            New pipeline · step {index + 1} of {STEPS.length}
          </div>
          <h3 className="mt-1 text-sm font-medium text-fg">{current.title}</h3>
          <p className="mt-1 text-[12px] leading-5 text-fg-muted">{current.body}</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[11px] text-fg-dim hover:text-fg"
        >
          Skip guide
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {STEPS.map((entry, entryIndex) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onStepChange(entry.id)}
            className={cn(
              "rounded-full px-2.5 py-1 text-[11px] ring-1 ring-inset",
              entry.id === step
                ? "bg-accent/15 text-accent ring-accent/40"
                : "text-fg-dim ring-line hover:bg-surface-2 hover:text-fg",
            )}
          >
            {entryIndex + 1}. {entry.title}
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {step === "policy" && (
          <Button size="sm" variant="secondary" onClick={onOpenPolicy}>
            Open policy & budgets
          </Button>
        )}
        {step === "stations" && (
          <Button size="sm" variant="secondary" onClick={onFocusStations}>
            Configure first station
          </Button>
        )}
        {index < STEPS.length - 1 ? (
          <Button
            size="sm"
            variant="primary"
            onClick={() => onStepChange(STEPS[index + 1].id)}
          >
            Next
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={onDismiss}>
            Done
          </Button>
        )}
      </div>
    </div>
  );
}
