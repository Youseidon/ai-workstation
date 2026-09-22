"use client";

import Link from "next/link";
import type { PipelineBlockedStation } from "@agent-console/shared";
import { Badge } from "@/components/ui/Badge";
import { LABEL, TONE } from "./status";

export function PipelineBlockedStations({ stations }: { stations: PipelineBlockedStation[] }) {
  if (stations.length === 0) {
    return (
      <p className="py-4 text-sm text-fg-dim">No blocked stations on pipeline steps right now.</p>
    );
  }

  return (
    <ul className="space-y-2">
      {stations.map((station) => (
        <li key={`${station.pipelineId}-${station.promptId}`}>
          <Link
            href={`/pipeline/${station.pipelineId}?suite=${station.suiteId}`}
            className="flex flex-wrap items-start justify-between gap-2 rounded-panel border border-line bg-surface-1/80 px-3 py-2.5 transition-colors hover:border-warning/40 hover:bg-surface-2"
          >
            <div className="min-w-0">
              <div className="truncate text-[13px] text-fg">
                {station.promptKey ?? station.promptTitle}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-fg-dim">
                {station.pipelineName} · {station.suiteName}
              </div>
              {station.latestIntervention !== null && (
                <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-fg-muted">
                  {station.latestIntervention}
                </p>
              )}
            </div>
            <Badge tone={TONE[station.operationalState]}>{LABEL[station.operationalState]}</Badge>
          </Link>
        </li>
      ))}
    </ul>
  );
}
