"use client";

import { useEffect, useRef } from "react";
import type { OperationsSuite, PipelineState } from "@hydra/shared";
import { EditIconButton } from "@/components/ui/EditIconButton";
import { cn } from "@/lib/cn";
import type { SuiteProgress } from "../lib/progress";
import { progressLabel } from "../lib/progress";
import { SuiteProgressMark } from "./SuiteProgressMark";
import styles from "./workspace.module.css";

export interface ConstellationStage {
  suiteId: number;
  programName: string;
  suiteName: string;
  suiteKey: string | null;
  operations: OperationsSuite | null;
  progress: SuiteProgress;
}

export function PipelineConstellation({ stages, selectedSuiteId, currentSuiteId, pipelineState, onSelect, onEdit }: {
  stages: ConstellationStage[];
  selectedSuiteId: number | null;
  currentSuiteId: number | null;
  pipelineState: PipelineState | null;
  onSelect(suiteId: number): void;
  onEdit?(suiteId: number): void;
}) {
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    nav.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedSuiteId]);
  if (stages.length === 0) return <div className="rounded-panel border border-dashed border-line px-4 py-6 text-sm text-fg-muted">Add suites from the sidebar to build your execution order.</div>;
  return <nav ref={nav} aria-label="Suite execution order" className={styles.stageStrip}>
    <ol className={styles.stages}>
      {stages.map((stage, index) => {
        const selected = selectedSuiteId === stage.suiteId;
        const running = currentSuiteId === stage.suiteId && pipelineState === "PLAYING";
        return <li key={stage.suiteId} className={cn(styles.stage, selected && styles.selectedStage)}>
          <button type="button" onClick={() => onSelect(stage.suiteId)} aria-current={selected ? "step" : undefined} title={`${stage.programName} · ${stage.suiteName} · ${progressLabel(stage.progress)}`} className={styles.stageSelect}>
            <SuiteProgressMark progress={stage.progress} running={running} index={index} />
            <span className={styles.stageIdentity}>
              <strong>{stage.suiteKey !== null ? `${stage.suiteKey} · ${stage.suiteName}` : stage.suiteName}</strong>
              <span>
                {stage.progress.known ? `${stage.progress.done}/${stage.progress.total}` : "—"}
                {running && " · running"}
                {stage.progress.attention > 0 ? ` · ${stage.progress.attention} need you` : !running && stage.progress.complete ? " · complete" : ""}
              </span>
            </span>
          </button>
          {onEdit && <EditIconButton label={`Edit ${stage.suiteKey ?? stage.suiteName} in Studio`} onClick={() => onEdit(stage.suiteId)} className="shrink-0" />}
        </li>;
      })}
    </ol>
  </nav>;
}
