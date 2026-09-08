"use client";

import { useEffect, type ReactNode } from "react";
import type { OperationsSuite, ProviderId, ProviderInfo, SuitePipelineRun } from "@agent-console/shared";
import { AgentPicker } from "@/components/AgentPicker";
import { Button } from "@/components/ui/Button";
import { useDialogs } from "@/components/ui/Dialogs";
import { cn } from "@/lib/cn";
import type { RunStatus } from "@/lib/agentConsole";
import type { ModelSelection } from "@/lib/useModelSelection";
import { blockedDiagnosis, playKind, showPause, showStop } from "./status";

export function PipelineHeader({
  suite,
  pipeline,
  occupancy,
  playProvider: _playProvider,
  providers: _providers,
  models: _models,
  onSelectProvider: _onSelectProvider,
  onRefreshProviders: _onRefreshProviders,
  playBlockedReason,
  busy,
  onPlay,
  onPause,
  onStop,
}: {
  suite: OperationsSuite;
  pipeline: SuitePipelineRun | null | undefined;
  occupancy: RunStatus | null;
  playProvider: ProviderId;
  providers: ProviderInfo[];
  models: ModelSelection;
  onSelectProvider(provider: ProviderId): void;
  onRefreshProviders(): void;
  playBlockedReason: string | null;
  busy: boolean;
  onPlay(): void;
  onPause(): void;
  onStop(): void;
}) {
  const dialogs = useDialogs();
  const kind = playKind(pipeline, occupancy);
  const playEnabled = kind !== "hidden" && playBlockedReason === null && !busy;
  const done = suite.counts.COMPLETE;
  const total = suite.prompts.length;
  const waiting = suite.counts.AWAITING_RESPONSE + suite.counts.RECOVERY_NEEDED;
  const interrupted = suite.pipeline?.latest?.state === "INTERRUPTED" && suite.pipeline.active === null;
  const latest = suite.pipeline?.latest ?? pipeline ?? null;
  const blockedItem =
    latest?.currentPromptId === null
      ? null
      : (suite.prompts.find((item) => item.prompt.id === latest?.currentPromptId) ?? null);
  const blocked = blockedItem === null ? null : blockedDiagnosis(blockedItem);
  const blockedKey =
    blockedItem === null
      ? null
      : blockedItem.prompt.externalKey;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "p" && event.key !== "P") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]") !== null) return;
      if (!playEnabled) return;
      event.preventDefault();
      onPlay();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onPlay, playEnabled]);

  const confirmStop = async () => {
    const confirmed = await dialogs.confirm({
      title: "Stop this pipeline?",
      description:
        "Stops auto-advance. The current agent, if running, is interrupted and the work item will need recovery.",
      confirmLabel: "Stop pipeline",
      tone: "danger",
    });
    if (confirmed) onStop();
  };

  return (
    <div className="sticky top-0 z-10 -mx-3 mb-3 border-b border-line bg-surface-1/90 px-3 py-2.5 backdrop-blur-md">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] text-fg">
            {suite.key !== null && <span className="text-fg-muted">{suite.key} · </span>}
            {suite.name}
          </div>
          <div className="mt-0.5 text-[10px] uppercase tracking-wider text-fg-dim">
            {done}/{total} done
            {suite.counts.WORKING > 0 && ` · ${suite.counts.WORKING} working`}
            {waiting > 0 && ` · ${waiting} needs attention`}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {kind !== "hidden" && (
            <Button
              size="sm"
              variant="success"
              disabled={!playEnabled}
              title={playBlockedReason ?? (kind === "resume" ? "Resume this suite" : "Play this suite")}
              onClick={onPlay}
            >
              {kind === "resume" ? "Resume" : "Play"}
            </Button>
          )}
          {showPause(pipeline) && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              title="Paused — current station will finish."
              onClick={onPause}
            >
              Pause
            </Button>
          )}
          {showStop(pipeline) && (
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void confirmStop()}>
              Stop
            </Button>
          )}
        </div>
      </div>

      <div className="mt-2">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-fg-dim">Play with</div>
        <AgentPicker compact />
      </div>

      {pipeline?.state === "PAUSED" && (
        <Banner tone="caution">Paused — current station will finish.</Banner>
      )}
      {pipeline?.state === "WAITING_HUMAN" && (
        <Banner tone="warning">
          {blocked?.requiresHuman === false
            ? `${blocked.title} — ${blocked.message}`
            : "Waiting for you — answer in the detail pane, then Resume."}
        </Banner>
      )}
      {interrupted && (
        <Banner tone="caution">
          Server restarted. Prompt {blockedKey ?? "the current station"} was left blocked. Play to continue.
        </Banner>
      )}
      {latest?.stopReason === "recover_exhausted" && pipeline == null && (
        <Banner tone="danger">Recovered, still blocked — pipeline stopped.</Banner>
      )}
    </div>
  );
}

function Banner({ tone, children }: { tone: "caution" | "warning" | "danger"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "mt-2 rounded-md px-2.5 py-1.5 text-[11px] ring-1 ring-inset",
        tone === "caution" && "bg-caution/10 text-caution ring-caution/30",
        tone === "warning" && "bg-warning/10 text-warning ring-warning/30",
        tone === "danger" && "bg-danger/10 text-danger ring-danger/30",
      )}
    >
      {children}
    </div>
  );
}
