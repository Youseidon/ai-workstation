"use client";

import type { PipelineThroughputDay } from "@agent-console/shared";
import { cn } from "@/lib/cn";

function formatDayLabel(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function PipelineThroughputChart({ days }: { days: PipelineThroughputDay[] }) {
  const max = Math.max(...days.map((day) => day.total), 1);

  if (days.every((day) => day.total === 0)) {
    return (
      <p className="py-8 text-center text-sm text-fg-dim">
        No finished pipeline runs in the last 30 days.
      </p>
    );
  }

  return (
    <div>
      <div className="flex h-36 items-end gap-px sm:gap-0.5" role="img" aria-label="Pipeline runs per day, last 30 days">
        {days.map((day) => {
          const completeHeight = day.complete > 0 ? Math.max(4, (day.complete / max) * 100) : 0;
          const stoppedHeight = day.stopped > 0 ? Math.max(4, (day.stopped / max) * 100) : 0;
          const label = formatDayLabel(day.date);
          return (
            <div
              key={day.date}
              className="group relative flex min-w-0 flex-1 flex-col justify-end"
              title={`${label}: ${day.complete} complete, ${day.stopped} stopped`}
            >
              <div className="flex h-full flex-col justify-end gap-px">
                {stoppedHeight > 0 && (
                  <div
                    className="w-full rounded-t-sm bg-caution/70"
                    style={{ height: `${stoppedHeight}%` }}
                  />
                )}
                {completeHeight > 0 && (
                  <div
                    className={cn("w-full bg-success/70", stoppedHeight === 0 && "rounded-t-sm")}
                    style={{ height: `${completeHeight}%` }}
                  />
                )}
                {day.total === 0 && <div className="h-1 w-full rounded-sm bg-surface-3" />}
              </div>
              <span className="mt-1 hidden truncate text-center text-[8px] text-fg-dim sm:block">
                {day.date.endsWith("-01") || day.date.endsWith("-15") ? label : ""}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-4 text-[11px] text-fg-dim">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-success/70" />
          Complete
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-caution/70" />
          Stopped / interrupted
        </span>
      </div>
    </div>
  );
}
