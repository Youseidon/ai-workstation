"use client";

import type { OperationsSuite, PipelineState, ProviderId } from "@agent-console/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import type { AgentActivity } from "@/lib/agentState";
import { providerTheme } from "@/lib/providerTheme";
import { SnakeFlow } from "./SnakeFlow";
import { PIPELINE_LABEL, PIPELINE_TONE } from "./status";

export interface ConstellationStage {
  suiteId: number;
  programName: string;
  programKey: string | null;
  suiteName: string;
  suiteKey: string | null;
  promptCount: number;
  stepCount: number;
  operations: OperationsSuite | null;
  providers: ProviderId[];
}

export function PipelineConstellation({
  stages,
  selectedSuiteId,
  currentSuiteId,
  pipelineState,
  liveProviders,
  onSelect,
}: {
  stages: ConstellationStage[];
  selectedSuiteId: number | null;
  currentSuiteId: number | null;
  pipelineState: PipelineState | null;
  liveProviders: Partial<Record<ProviderId, AgentActivity>>;
  onSelect(suiteId: number): void;
}) {
  if (stages.length === 0) {
    return (
      <div className="rounded-panel border border-dashed border-line bg-surface-1/60 px-6 py-16 text-center">
        <div className="text-[10px] uppercase tracking-[0.25em] text-accent">Awaiting stages</div>
        <p className="mt-2 text-sm text-fg-muted">
          Pick suites from the programs on the left. They become stations on this rail, in order.
        </p>
      </div>
    );
  }

  return (
    <SnakeFlow
      items={stages}
      getKey={(stage) => stage.suiteId}
      isLiveIndex={(index) =>
        stages[index] !== undefined &&
        currentSuiteId === stages[index].suiteId &&
        pipelineState === "PLAYING"
      }
      renderCard={(stage, index) => {
        const current = currentSuiteId === stage.suiteId;
        const selected = selectedSuiteId === stage.suiteId;
        const live = current && pipelineState === "PLAYING";
        const ops = stage.operations;
        const done = ops?.counts.DONE ?? 0;
        const total = ops?.prompts.length ?? stage.promptCount;
        return (
          <button
            type="button"
            onClick={() => onSelect(stage.suiteId)}
            aria-current={selected ? "true" : undefined}
            className={cn(
              "relative flex h-full min-w-0 w-full flex-col rounded-panel border p-4 text-left transition-[border-color,box-shadow,transform] duration-200",
              selected
                ? "border-accent/50 bg-surface-2 ring-1 ring-accent/25"
                : "border-line bg-surface-1/80 hover:border-line-strong hover:bg-surface-2",
              live && "pipeline-node-live glow text-accent",
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11px] numeric text-fg-muted ring-1 ring-inset ring-line">
                {index + 1}
              </span>
              {current && pipelineState !== null && (
                <Badge tone={PIPELINE_TONE[pipelineState]} dot pulse={pipelineState === "PLAYING"}>
                  {PIPELINE_LABEL[pipelineState]}
                </Badge>
              )}
            </div>
            <div className="mt-3 text-[10px] uppercase tracking-[0.18em] text-fg-dim">
              {stage.programKey ?? stage.programName}
            </div>
            <div className="mt-0.5 truncate text-[15px] text-fg">
              {stage.suiteKey !== null && <span className="text-fg-muted">{stage.suiteKey} · </span>}
              {stage.suiteName}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-fg-dim">
              <span className="numeric">
                {done}/{total} done
              </span>
              <span>· {stage.stepCount} on rail</span>
            </div>
            {stage.providers.length > 0 && (
              <div className="mt-3 flex items-center gap-1.5">
                {stage.providers.map((provider) => (
                  <span key={provider} className={cn("rounded-full", providerTheme[provider].text)} title={provider}>
                    <AgentAvatar
                      provider={provider}
                      size={22}
                      activity={liveProviders[provider] ?? (stage.providers.includes(provider) ? "idle" : "offline")}
                    />
                  </span>
                ))}
              </div>
            )}
            {ops !== undefined && ops !== null && ops.attentionCount > 0 && (
              <div className="mt-2 text-[11px] text-warning">{ops.attentionCount} need you</div>
            )}
          </button>
        );
      }}
    />
  );
}
