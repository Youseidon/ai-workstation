"use client";

import Link from "next/link";
import type { OperationsSnapshot, PipelineBlockedStation, PipelineRecord, PipelineRunDetail } from "@agent-console/shared";
import { formatElapsed } from "@agent-console/shared";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { PipelineBlockedStations } from "./PipelineBlockedStations";
import { PIPELINE_LABEL, PIPELINE_TONE } from "./status";

export function PipelineOverview({
  pipeline,
  snapshot,
  runs,
  blockedStations = [],
  className,
}: {
  pipeline: PipelineRecord;
  snapshot: OperationsSnapshot | null;
  runs: PipelineRunDetail[];
  blockedStations?: PipelineBlockedStation[];
  className?: string;
}) {
  const live = pipeline.active ?? pipeline.latest;
  const totalSteps = pipeline.stages.reduce((sum, stage) => sum + stage.stepCount, 0);
  const completedSteps = Math.max(0, totalSteps - pipeline.stages.reduce((sum, stage) => {
    const ops = snapshot?.suites.find((suite) => suite.id === stage.suiteId);
    if (ops === undefined || stage.stepCount === 0) return sum;
    const incomplete = ops.prompts.filter(
      (item) => item.operationalState !== "DONE" && item.operationalState !== "SKIPPED",
    ).length;
    return sum + Math.max(0, stage.stepCount - incomplete);
  }, 0));
  // Attention is scoped to steps assigned to this named pipeline. A suite can
  // participate in several pipelines, so its aggregate attentionCount would
  // incorrectly leak another pipeline's blocker into this overview.
  const attentionCount = blockedStations.length;

  const lastRun = runs[0];
  const lastDuration =
    lastRun?.endedAt === null || lastRun?.endedAt === undefined
      ? null
      : formatElapsed(new Date(lastRun.endedAt).getTime() - new Date(lastRun.startedAt).getTime());

  const currentStage =
    live?.currentSuiteId === null || live?.currentSuiteId === undefined
      ? null
      : pipeline.stages.find((stage) => stage.suiteId === live.currentSuiteId);

  return (
    <section className={cn("rounded-panel border border-line bg-surface-1/80 px-4 py-3", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.18em] text-fg-dim">
            <Link href="/pipeline" className="hover:text-accent">
              Pipelines
            </Link>
            {" · "}Overview
          </div>
          <h2 className="mt-0.5 text-lg tracking-tight text-fg">{pipeline.name}</h2>
          <p className="mt-1 text-xs text-fg-dim">
            {pipeline.stages.length} suite{pipeline.stages.length === 1 ? "" : "s"} · {completedSteps}/{totalSteps} steps built
            {attentionCount > 0 && <span className="ml-2 text-warning">{attentionCount} need attention</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {live !== null && (
            <Badge tone={PIPELINE_TONE[live.state]} pulse={live.state === "PLAYING"}>
              {PIPELINE_LABEL[live.state]}
            </Badge>
          )}
          {currentStage !== undefined && currentStage !== null && live?.state === "PLAYING" && (
            <span className="text-[11px] text-fg-dim">at {currentStage.suiteName}</span>
          )}
          {lastDuration !== null && <span className="text-[11px] numeric text-fg-dim">last run {lastDuration}</span>}
        </div>
      </div>
      {blockedStations.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-warning">Blocked stations</div>
          <PipelineBlockedStations stations={blockedStations} />
        </div>
      )}
    </section>
  );
}
