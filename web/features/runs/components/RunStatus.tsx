"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { ProviderInfo } from "@hydra/shared";
import { formatElapsed, formatTokens, modelLabel } from "@hydra/shared";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/features/providers/lib/providerTheme";
import type { RunStatus } from "@/models/runs";
import { useHydra } from "@/hooks/useHydra";
import type { LogItem } from "@/features/runs/lib/log";
import { Button } from "../../../components/ui/Button";
import { StatusDot } from "../../../components/ui/Badge";
import { AgentAvatar } from "../../providers/components/AgentAvatar";
import { agentState, ACTIVITY_LABEL, consultQuestion } from "@/features/runs/lib/agentState";

export function runOwnerHref(run: RunStatus, runTabIds: Record<string, string>): string {
  const thread = runTabIds[run.runId] ?? (run.source.type === "custom" ? run.source.threadId : undefined);
  if (thread !== undefined) return `/?workspace=${run.workspace.id}&thread=${encodeURIComponent(thread)}`;
  return `/activity?workspace=${run.workspace.id}&run=${encodeURIComponent(run.runId)}`;
}

export function RunRow({
  run,
  items,
  providers,
  lastRun,
  onStop,
  stale,
  waiting,
  ownerHref,
  onOpen,
}: {
  run: RunStatus;
  items: LogItem[];
  providers: ProviderInfo[];
  lastRun: RunStatus | null;
  onStop(): void;
  stale: boolean;
  waiting: boolean;
  ownerHref: string;
  onOpen?(): void;
}) {
  const theme = providerTheme[run.provider];
  const info = providers.find((entry) => entry.id === run.provider);
  const state = useMemo(
    () => (info === undefined ? null : agentState(info, [run], items, lastRun)),
    [info, run, items, lastRun],
  );
  const activity = waiting ? "needs your input" : state?.caption ?? describeActivity(items, run);
  const model = modelLabel(run.provider, run.model);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      { }
      <span className={cn("flex items-center gap-2.5", theme.text)}>
        <AgentAvatar
          provider={run.provider}
          activity={stale ? "idle" : state?.activity ?? "thinking"}
          size={30}
          title={`${run.provider}: ${ACTIVITY_LABEL[state?.activity ?? "thinking"]}`}
        />
        <span className="text-sm font-semibold">{run.provider}</span>
      </span>

      {model !== null && <span className="text-xs text-fg-dim">{model}</span>}

      { }
      <span className="flex min-w-0 flex-1 items-center gap-2 text-xs text-fg-muted">
        <StatusDot tone={stale || waiting ? "warning" : "accent"} pulse={!stale && !waiting} />
        <span className="truncate" title={activity}>
          {stale ? "reconnecting — the agent is still running" : activity}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-3 text-xs">
        <span className="numeric text-fg" title="Elapsed, measured on the server">
          {formatElapsed(run.elapsedMs)}
        </span>
        {run.usage !== null && (
          <span className="numeric text-fg-dim" title="Cumulative tokens">
            {formatTokens(run.usage.totalTokens)} tok
          </span>
        )}
        <span className="hidden max-w-[24ch] truncate text-fg-dim lg:inline" title={run.workspace.workDirectory}>
          {run.workspace.name}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-2">
        <Link
          href={ownerHref}
          onClick={onOpen}
          className="rounded-md px-2 py-1 text-xs text-fg-muted ring-1 ring-inset ring-line transition-colors hover:bg-surface-2 hover:text-fg"
        >
          Open
        </Link>
        <Button size="sm" variant="danger" onClick={onStop} disabled={stale}>
          Stop
        </Button>
      </span>
    </div>
  );
}

export function AskChip({
  run,
  onStop,
  stale = false,
  waiting = false,
  onOpen,
}: {
  run: RunStatus;
  onStop(): void;
  stale?: boolean;
  waiting?: boolean;
  onOpen?(): void;
}) {
  const theme = providerTheme[run.provider];
  const question = consultQuestion(run);
  const { runTabIds } = useHydra();

  return (
    <span className={cn("inline-flex h-7 max-w-full items-center gap-1.5 rounded-full pl-2 pr-1 text-xs ring-1 ring-inset", theme.chip)}>
      <Link
        href={runOwnerHref(run, runTabIds)}
        className="flex min-w-0 items-center gap-1.5"
        title={question}
        onClick={onOpen}
      >
        <AgentAvatar provider={run.provider} activity={waiting ? "idle" : "thinking"} size={16} title={`${run.provider} ${waiting ? "needs input" : "asking"}`} />
        <span className="min-w-0 truncate">{waiting ? "needs input" : `asking · ${question || "research"}`}</span>
      </Link>
      <button
        type="button"
        onClick={onStop}
        disabled={stale}
        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-danger ring-1 ring-inset ring-danger/40 hover:bg-danger/15 disabled:pointer-events-none disabled:opacity-40"
      >
        Stop
      </button>
    </span>
  );
}

function describeActivity(items: LogItem[], run: RunStatus): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.runId !== run.runId) continue;
    if (item.kind === "tool" && item.result === null) {
      return item.summary === "" ? `running ${item.name}` : `${item.name} · ${item.summary}`;
    }
    if (item.kind === "text" && item.text.trim() !== "") {
      const flat = item.text.replace(/\s+/g, " ").trim();
      return item.textKind === "thinking" ? `thinking · ${flat}` : flat;
    }
  }
  return run.detail ?? (run.state === "starting" ? "starting up…" : "working…");
}
