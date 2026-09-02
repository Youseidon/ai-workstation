"use client";

import type { HumanInterventionStep, OperationsSuite, ProviderId, ProviderInfo } from "@agent-console/shared";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Spinner";
import type { RunStatus } from "@/lib/agentConsole";
import type { ModelSelection } from "@/lib/useModelSelection";
import { PipelineHeader } from "./PipelineHeader";
import { PipelineStation } from "./PipelineStation";
import type { RulePatch } from "./RulePopover";
import { firstReadyId, stationOccupancy } from "./status";

export function PipelineRail({
  suite,
  selectedPromptId,
  occupancyRuns,
  playProvider,
  providers,
  models,
  onSelectProvider,
  onRefreshProviders,
  playBlockedReason,
  busy,
  loading,
  onSelect,
  onPlay,
  onPause,
  onStop,
  onChangeRule,
}: {
  suite: OperationsSuite | null;
  selectedPromptId: number | null;
  occupancyRuns: RunStatus[];
  playProvider: ProviderId;
  providers: ProviderInfo[];
  models: ModelSelection;
  onSelectProvider(provider: ProviderId): void;
  onRefreshProviders(): void;
  playBlockedReason: string | null;
  busy: boolean;
  loading: boolean;
  onSelect(promptId: number): void;
  onPlay(): void;
  onPause(): void;
  onStop(): void;
  onChangeRule(promptId: number, patch: RulePatch): void;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (suite === null) {
    return <p className="text-xs leading-relaxed text-fg-dim">Select a suite to watch its rail.</p>;
  }

  const pipeline = suite.pipeline?.active ?? suite.pipeline?.latest ?? null;
  const workspaceRun = occupancyRuns.find((run) => run.workspace.id === suite.workspaceId) ?? null;
  const nextId = firstReadyId(suite.prompts);

  return (
    <div>
      <PipelineHeader
        suite={suite}
        pipeline={suite.pipeline?.active}
        occupancy={workspaceRun}
        playProvider={playProvider}
        providers={providers}
        models={models}
        onSelectProvider={onSelectProvider}
        onRefreshProviders={onRefreshProviders}
        playBlockedReason={playBlockedReason}
        busy={busy}
        onPlay={onPlay}
        onPause={onPause}
        onStop={onStop}
      />

      {suite.prompts.length === 0 ? (
        <p className="text-xs leading-relaxed text-fg-dim">
          No stations yet. Add work items on the Workspaces page.
        </p>
      ) : (
        suite.prompts.map((item, index) => {
          const occupancy = stationOccupancy(item, occupancyRuns, suite.pipeline?.active);
          return (
            <div key={item.prompt.id}>
              <PipelineStation
                item={item}
                pipeline={suite.pipeline?.active ?? pipeline}
                occupancy={occupancy}
                selected={selectedPromptId === item.prompt.id}
                last={index === suite.prompts.length - 1 && item.humanIntervention === null}
                nextUp={nextId === item.prompt.id && occupancy === null}
                fallbackProvider={playProvider}
                providers={providers}
                models={models}
                onSelect={() => onSelect(item.prompt.id)}
                onSelectChild={onSelect}
                onChangeRule={(patch) => onChangeRule(item.prompt.id, patch)}
              />
              {item.humanIntervention !== null && (
                <HumanInterventionStation step={item.humanIntervention} last={index === suite.prompts.length - 1} onSelect={() => onSelect(item.prompt.id)} />
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

function HumanInterventionStation({ step, last, onSelect }: { step: HumanInterventionStep; last: boolean; onSelect(): void }) {
  const complete = step.status === "COMPLETE";
  return (
    <div className="relative flex gap-3">
      <div className="relative flex w-3 shrink-0 flex-col items-center">
        {!last && <span aria-hidden className="absolute top-3 bottom-0 w-px border-l border-dashed border-line" />}
        <span aria-hidden className={`relative z-[1] mt-3 grid size-3 place-items-center rounded-full border text-[8px] ${complete ? "border-success bg-success text-surface-0" : "border-warning bg-warning/20 text-warning animate-breathe"}`}>
          {complete ? "✓" : "!"}
        </span>
      </div>
      <div className="min-w-0 flex-1 pb-4">
        <button type="button" onClick={onSelect} className="w-full rounded-panel border border-warning/40 bg-warning/5 p-2.5 text-left transition-colors hover:bg-warning/10">
          <div className="flex items-start justify-between gap-2">
            <span className="text-[13px] text-fg">Human intervention</span>
            <Badge tone={complete ? "success" : "warning"}>{complete ? "Responded" : "Action required"}</Badge>
          </div>
          <div className="mt-1 whitespace-pre-wrap text-xs leading-5 text-fg-muted">{step.requiredAction}</div>
          {step.response !== null && <div className="mt-2 border-t border-line pt-2 text-xs text-fg-dim">Response: {step.response}</div>}
        </button>
      </div>
    </div>
  );
}
