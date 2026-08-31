"use client";

import { formatElapsed } from "@agent-console/shared";
import type { PipelineRunDetail, PipelineState } from "@agent-console/shared";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { PIPELINE_LABEL, PIPELINE_TONE } from "./status";

export function PipelineArchive({
  runs,
  selectedId,
  onSelect,
}: {
  runs: PipelineRunDetail[];
  selectedId: string | null;
  onSelect(id: string): void;
}) {
  if (runs.length === 0) {
    return (
      <p className="px-1 py-6 text-xs leading-relaxed text-fg-dim">
        No flights yet. Save this pipeline and press Play — every run lands here.
      </p>
    );
  }

  return (
    <ol className="space-y-1">
      {runs.map((run) => {
        const selected = selectedId === run.id;
        const duration =
          run.endedAt === null
            ? null
            : formatElapsed(new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime());
        const current = run.stages.find((stage) => stage.suiteId === run.currentSuiteId);
        return (
          <li key={run.id}>
            <button
              type="button"
              onClick={() => onSelect(run.id)}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "w-full rounded-panel border px-3 py-2.5 text-left transition-colors",
                selected ? "border-line-strong bg-surface-3" : "border-transparent hover:bg-surface-2",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <time className="text-[11px] numeric text-fg-muted" dateTime={run.startedAt}>
                  {formatStamp(run.startedAt)}
                </time>
                <Badge tone={PIPELINE_TONE[run.state]} pulse={run.state === "PLAYING"}>
                  {PIPELINE_LABEL[run.state]}
                </Badge>
              </div>
              <div className="mt-1 text-[12px] text-fg-dim">
                {current !== undefined
                  ? `at ${current.suiteName}`
                  : run.state === "COMPLETE"
                    ? `${run.stages.length} suites`
                    : "not yet at a suite"}
                {duration !== null && <span className="numeric"> · {duration}</span>}
              </div>
              {selected && <RunStages run={run} />}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function RunStages({ run }: { run: PipelineRunDetail }) {
  return (
    <ol className="mt-3 space-y-1.5 border-t border-line pt-2">
      {run.stages.map((stage, index) => {
        const state: PipelineState | "pending" = stage.suiteRun?.state ?? "pending";
        return (
          <li key={stage.suiteId} className="flex items-center gap-2 text-[11px]">
            <span className="numeric w-4 text-fg-dim">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate text-fg-muted">{stage.suiteName}</span>
            <span
              className={cn(
                "uppercase tracking-wider",
                state === "pending" ? "text-fg-dim" : "text-fg-muted",
              )}
            >
              {state === "pending" ? "queued" : PIPELINE_LABEL[state]}
            </span>
          </li>
        );
      })}
      {run.stopReason !== null && run.stopReason !== "" && (
        <li className="text-[11px] text-fg-dim">{run.stopReason.replaceAll("_", " ")}</li>
      )}
    </ol>
  );
}

function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
