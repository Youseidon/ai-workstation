"use client";

import { useMemo } from "react";
import Link from "next/link";
import type { OperationsPrompt, ProviderId, ProviderInfo, SuitePipelineRun } from "@agent-console/shared";
import { formatElapsed, formatTokens, modelLabel } from "@agent-console/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { useAgentConsole, type RunStatus } from "@/lib/agentConsole";
import { agentState } from "@/lib/agentState";
import { providerTheme } from "@/lib/providerTheme";
import type { ModelSelection } from "@/lib/useModelSelection";
import { RecoverySiding } from "./RecoverySiding";
import { StationRules } from "./RuleChip";
import type { RulePatch } from "./RulePopover";
import { LABEL, TONE } from "./status";

export function PipelineStation({
  item,
  pipeline,
  occupancy,
  selected,
  last,
  nextUp,
  fallbackProvider,
  providers,
  models,
  onSelect,
  onChangeRule,
}: {
  item: OperationsPrompt;
  pipeline: SuitePipelineRun | null | undefined;
  occupancy: RunStatus | null;
  selected: boolean;
  last: boolean;
  nextUp: boolean;
  fallbackProvider: ProviderId;
  providers: ProviderInfo[];
  models: ModelSelection;
  onSelect(): void;
  onChangeRule(patch: RulePatch): void;
}) {
  const rule = item.pipelineRule;
  const state = item.operationalState;
  const working = occupancy !== null;
  const recovering = pipeline?.recovering === true && pipeline.currentPromptId === item.prompt.id && working;
  const stoppedHere = pipeline?.state === "STOPPED" && pipeline.currentPromptId === item.prompt.id;
  const workingLocked = state === "WORKING";
  const dim = state === "WAITING_DEPENDENCY" || (state !== "COMPLETE" && state !== "WORKING" && state !== "READY" && state !== "AWAITING_RESPONSE" && state !== "RECOVERY_NEEDED" && state !== "FAILED" && !working);

  return (
    <div
      className={cn("relative flex gap-3", dim && "opacity-45")}
    >
      <Spine state={state} occupancy={occupancy} nextUp={nextUp} last={last} stoppedHere={stoppedHere} />

      <div className="min-w-0 flex-1 pb-4">
        <div
          className={cn(
            "w-full rounded-panel border p-2.5 text-left transition-colors",
            selected ? "border-line-strong bg-surface-3" : "border-line bg-surface-2 hover:bg-surface-3",
          )}
        >
          <button
            type="button"
            tabIndex={0}
            aria-current={selected ? "true" : undefined}
            onClick={onSelect}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              onSelect();
            }}
            className="block w-full text-left"
          >
          <div className="flex items-start justify-between gap-2">
            <span
              className={cn(
                "truncate text-[13px] text-fg",
                state === "SKIPPED" && "line-through text-fg-dim",
              )}
            >
              {item.prompt.externalKey ?? item.prompt.title}
            </span>
            <Badge tone={TONE[state]} dot={state === "WORKING"} pulse={state === "WORKING"}>
              {LABEL[state]}
            </Badge>
          </div>
          <div className="mt-0.5 truncate text-xs text-fg-muted">{item.prompt.title}</div>
          {item.prompt.blockedBy.length > 0 && state === "WAITING_DEPENDENCY" && (
            <div className="mt-1 text-[10px] text-fg-dim">waiting on {item.prompt.blockedBy.join(", ")}</div>
          )}
          {item.latestHandoff !== null && (item.latestHandoff.state === "QUEUED" || item.latestHandoff.state === "RUNNING") && (
            <div className="mt-1 text-[10px] text-info">preparing handoff with {item.latestHandoff.provider}</div>
          )}
          </button>

          {working && !recovering && occupancy !== null && (
            <div className="mt-2">
              <OccupancyStrip run={occupancy} />
            </div>
          )}

          <StationRules
            rule={rule}
            disabled={workingLocked}
            providers={providers}
            models={models}
            fallbackProvider={fallbackProvider}
            onChange={onChangeRule}
          />

          <RecoverySiding item={item} rule={rule} pipeline={pipeline}>
            {recovering && occupancy !== null ? <OccupancyStrip run={occupancy} /> : null}
          </RecoverySiding>
        </div>
      </div>
    </div>
  );
}

function Spine({
  state,
  occupancy,
  nextUp,
  last,
  stoppedHere,
}: {
  state: OperationsPrompt["operationalState"];
  occupancy: RunStatus | null;
  nextUp: boolean;
  last: boolean;
  stoppedHere: boolean;
}) {
  const theme = occupancy !== null ? providerTheme[occupancy.provider] : null;
  const fill =
    occupancy !== null
      ? theme?.fill
      : state === "COMPLETE"
        ? "bg-success"
        : state === "AWAITING_RESPONSE"
          ? "bg-warning"
          : state === "RECOVERY_NEEDED"
            ? "bg-caution"
            : state === "FAILED" || stoppedHere
              ? "bg-danger"
              : "bg-transparent";
  const ring =
    occupancy !== null
      ? "border-transparent"
      : state === "READY"
        ? "border-accent"
        : state === "SKIPPED" || state === "WAITING_DEPENDENCY"
          ? "border-dashed border-fg-dim"
          : state === "COMPLETE"
            ? "border-success"
            : stoppedHere
              ? "border-danger"
              : "border-fg-dim";
  const pulse = occupancy !== null;
  const glow = occupancy !== null ? `0 0 0 4px color-mix(in oklab, ${theme!.cssVar}, 25%, transparent)` : undefined;

  return (
    <div className="relative flex w-3 shrink-0 flex-col items-center">
      {!last && (
        <span
          aria-hidden
          className={cn(
            "absolute top-3 bottom-0 w-px",
            state === "COMPLETE" ? "bg-line-strong" : "border-l border-dashed border-line",
            occupancy !== null && "border-none",
          )}
          style={occupancy !== null ? { background: theme!.cssVar } : undefined}
        />
      )}
      <span
        aria-hidden
        className={cn(
          "relative z-[1] mt-3 size-3 rounded-full border",
          fill,
          ring,
          nextUp && occupancy === null && "animate-breathe",
          state === "COMPLETE" && "overflow-hidden",
        )}
        style={glow !== undefined ? { boxShadow: glow, background: occupancy !== null ? theme!.cssVar : undefined } : undefined}
      >
        {pulse && (
          <span
            aria-hidden
            className="absolute inset-0 rounded-full animate-pulse-ring"
            style={{ background: theme?.cssVar }}
          />
        )}
        {state === "COMPLETE" && (
          <span className="absolute inset-0 rounded-full bg-success/50 animate-sweep" />
        )}
        {state === "COMPLETE" && (
          <span className="absolute inset-0 grid place-items-center text-[8px] leading-none text-surface-0">✓</span>
        )}
      </span>
    </div>
  );
}

/** Same occupancy language as AgentDock: avatar, elapsed, tokens. */
export function OccupancyStrip({ run }: { run: RunStatus }) {
  const { items, lastRun, providers } = useAgentConsole();
  const theme = providerTheme[run.provider];
  const info = providers.find((entry) => entry.id === run.provider);
  const state = useMemo(
    () => (info === undefined ? null : agentState(info, [run], items, lastRun)),
    [info, run, items, lastRun],
  );
  const model = modelLabel(run.provider, run.model);
  const showTokens = run.usage !== null && info?.reportsTokens !== false;

  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]", theme.text)}>
      <AgentAvatar
        provider={run.provider}
        activity={state?.activity ?? "thinking"}
        size={20}
        title={`${run.provider}: ${state?.caption ?? "working"}`}
      />
      <span className="font-semibold">{run.provider}</span>
      {model !== null && <span className="text-fg-dim">{model}</span>}
      <span className="numeric text-fg" title="Elapsed, measured on the server">
        {formatElapsed(run.elapsedMs)}
      </span>
      {showTokens && run.usage !== null && (
        <span className="numeric text-fg-dim animate-shimmer" title="Cumulative tokens">
          {formatTokens(run.usage.totalTokens)}
        </span>
      )}
      <Link
        href="/"
        onClick={(event) => event.stopPropagation()}
        className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-fg-dim ring-1 ring-inset ring-line hover:bg-surface-2 hover:text-fg"
      >
        Transcript
      </Link>
    </div>
  );
}
