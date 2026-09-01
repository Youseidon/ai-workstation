"use client";

import type { OperationsPrompt, OperationsSuite } from "@agent-console/shared";
import { LABEL, TONE } from "@/components/pipeline/status";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

export type TasksFilter = "all" | "attention" | "working";

export function WorkItemList({
  suite,
  prompts,
  filter,
  activePromptId,
  busy,
  providerLabel,
  canAct,
  onFilterChange,
  onSelect,
  onRun,
  onStop,
  onRecover,
  onRespond,
}: {
  suite: OperationsSuite;
  prompts: OperationsPrompt[];
  filter: TasksFilter;
  activePromptId: number | null;
  busy: boolean;
  providerLabel: string;
  canAct(entry: OperationsPrompt): boolean;
  onFilterChange(filter: TasksFilter): void;
  onSelect(promptId: number): void;
  onRun(entry: OperationsPrompt): void;
  onStop(entry: OperationsPrompt): void;
  onRecover(entry: OperationsPrompt): void;
  onRespond(entry: OperationsPrompt): void;
}) {
  const needsYou = suite.attentionCount;
  const working = suite.counts.WORKING;

  return (
    <section className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
          Work items · {prompts.length}
          {filter !== "all" && (
            <span className="ml-1 font-normal normal-case tracking-normal text-fg-dim">
              of {suite.prompts.length}
            </span>
          )}
        </h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip active={filter === "all"} onClick={() => onFilterChange("all")}>
            All
          </FilterChip>
          <FilterChip active={filter === "attention"} tone="warning" onClick={() => onFilterChange("attention")}>
            Needs you {needsYou}
          </FilterChip>
          <FilterChip active={filter === "working"} tone="info" onClick={() => onFilterChange("working")}>
            Working {working}
          </FilterChip>
        </div>
      </div>

      {prompts.length === 0 ? (
        <p className="rounded-panel border border-line bg-surface-1 p-4 text-sm text-fg-dim">
          {filter === "all"
            ? "This suite has no work items."
            : filter === "attention"
              ? "Nothing needs you right now."
              : "Nothing is working right now."}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {prompts.map((entry) => (
            <li key={entry.prompt.id}>
              <div
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-panel border px-3 py-2.5 transition-colors",
                  activePromptId === entry.prompt.id
                    ? "border-line-strong bg-surface-3"
                    : "border-line bg-surface-1 hover:bg-surface-2",
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelect(entry.prompt.id)}
                  aria-current={activePromptId === entry.prompt.id ? "true" : undefined}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {entry.prompt.externalKey !== null && (
                      <span className="shrink-0 text-[11px] font-semibold text-fg-muted">
                        {entry.prompt.externalKey}
                      </span>
                    )}
                    <span className="truncate text-[13px] text-fg">{entry.prompt.title}</span>
                    <Badge tone={TONE[entry.operationalState]}>{LABEL[entry.operationalState]}</Badge>
                  </div>
                  <div className="mt-1 text-[10px] text-fg-dim">
                    {new Date(entry.lastActivityAt).toLocaleString()}
                    {entry.latestIntervention !== null && (
                      <span className="ml-2 text-warning">{entry.latestIntervention}</span>
                    )}
                  </div>
                </button>

                <RowAction
                  entry={entry}
                  busy={busy}
                  providerLabel={providerLabel}
                  canAct={canAct(entry)}
                  onRun={() => onRun(entry)}
                  onStop={() => onStop(entry)}
                  onRecover={() => onRecover(entry)}
                  onRespond={() => onRespond(entry)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RowAction({
  entry,
  busy,
  providerLabel,
  canAct,
  onRun,
  onStop,
  onRecover,
  onRespond,
}: {
  entry: OperationsPrompt;
  busy: boolean;
  providerLabel: string;
  canAct: boolean;
  onRun(): void;
  onStop(): void;
  onRecover(): void;
  onRespond(): void;
}) {
  if (entry.operationalState === "READY") {
    return (
      <Button size="sm" variant="success" disabled={!canAct || busy} onClick={onRun}>
        Run
      </Button>
    );
  }
  if (entry.operationalState === "WORKING" && entry.prompt.currentRun !== null) {
    return (
      <Button size="sm" variant="danger" disabled={busy} onClick={onStop}>
        Stop
      </Button>
    );
  }
  if (entry.operationalState === "RECOVERY_NEEDED") {
    return (
      <Button size="sm" variant="secondary" disabled={busy} onClick={onRecover} title={`Recover with ${providerLabel}`}>
        Recover and resume
      </Button>
    );
  }
  if (entry.operationalState === "AWAITING_RESPONSE") {
    return (
      <Button size="sm" variant="secondary" disabled={busy} onClick={onRespond}>
        Respond
      </Button>
    );
  }
  return null;
}

function FilterChip({
  active,
  tone = "neutral",
  onClick,
  children,
}: {
  active: boolean;
  tone?: "neutral" | "warning" | "info";
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-md px-2.5 py-1 text-xs ring-1 ring-inset transition-colors",
        active && tone === "warning" && "bg-warning/12 text-warning ring-warning/40",
        active && tone === "info" && "bg-info/12 text-info ring-info/40",
        active && tone === "neutral" && "bg-surface-3 text-fg ring-line-strong",
        !active && "text-fg-dim ring-line hover:bg-surface-2 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
