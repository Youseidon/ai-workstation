"use client";

import type { OperationsSuite, ProviderId, ProviderInfo } from "@agent-console/shared";
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
            <PipelineStation
              key={item.prompt.id}
              item={item}
              pipeline={suite.pipeline?.active ?? pipeline}
              occupancy={occupancy}
              selected={selectedPromptId === item.prompt.id}
              last={index === suite.prompts.length - 1}
              nextUp={nextId === item.prompt.id && occupancy === null}
              fallbackProvider={playProvider}
              providers={providers}
              models={models}
              onSelect={() => onSelect(item.prompt.id)}
              onChangeRule={(patch) => onChangeRule(item.prompt.id, patch)}
            />
          );
        })
      )}
    </div>
  );
}
