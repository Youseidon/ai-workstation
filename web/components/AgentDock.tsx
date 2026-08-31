"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import type { ProviderInfo } from "@agent-console/shared";
import { formatElapsed, formatTokens, modelLabel } from "@agent-console/shared";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/lib/providerTheme";
import { useAgentConsole, type RunStatus } from "@/lib/agentConsole";
import type { LogItem } from "@/lib/log";
import { Button } from "./ui/Button";
import { StatusDot } from "./ui/Badge";
import { AgentAvatar } from "./AgentAvatar";
import { agentState, ACTIVITY_LABEL } from "@/lib/agentState";

/**
 * The agent's presence, on every page.
 *
 * Mounted in the root layout, so it is the one thing that does not reset when
 * you navigate. Before this, leaving the Console meant the run vanished from
 * the UI entirely — it was still working, but nothing on screen said so.
 *
 * Renders nothing at all while idle, so it costs no layout space until an agent
 * is actually doing something.
 */
export function AgentDock() {
  const { runs, items, interrupt, connection, providers, lastRun } = useAgentConsole();
  const pathname = usePathname();

  if (runs.length === 0) return null;

  return (
    <div className="relative z-30 border-t border-line bg-surface-1/80 backdrop-blur-md">
      <div className="flex flex-col divide-y divide-line">
        {runs.map((run) => (
          <DockRow
            key={run.runId}
            run={run}
            items={items}
            providers={providers}
            lastRun={lastRun}
            onStop={() => interrupt(run.runId)}
            stale={connection !== "open"}
            showTranscriptLink={pathname !== "/"}
          />
        ))}
      </div>
    </div>
  );
}

function DockRow({
  run,
  items,
  providers,
  lastRun,
  onStop,
  stale,
  showTranscriptLink,
}: {
  run: RunStatus;
  items: LogItem[];
  providers: ProviderInfo[];
  lastRun: RunStatus | null;
  onStop(): void;
  stale: boolean;
  showTranscriptLink: boolean;
}) {
  const theme = providerTheme[run.provider];
  const info = providers.find((entry) => entry.id === run.provider);
  const state = useMemo(
    () => (info === undefined ? null : agentState(info, [run], items, lastRun)),
    [info, run, items, lastRun],
  );
  const activity = state?.caption ?? describeActivity(items, run);
  const model = modelLabel(run.provider, run.model);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
      {/* Identity. The pulsing core is the seat of the agent avatar. */}
      <span className={cn("flex items-center gap-2.5", theme.text)}>
        <AgentAvatar
          provider={run.provider}
          activity={stale ? "idle" : state?.activity ?? "thinking"}
          size={30}
          title={`${run.provider}: ${ACTIVITY_LABEL[state?.activity ?? "thinking"]}`}
        />
        <span className="text-[13px] font-semibold">{run.provider}</span>
      </span>

      {model !== null && <span className="text-xs text-fg-dim">{model}</span>}

      {/* What it is doing right now, in words. */}
      <span className="flex min-w-0 flex-1 items-center gap-2 text-xs text-fg-muted">
        <StatusDot tone={stale ? "warning" : "accent"} pulse={!stale} />
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
        {showTranscriptLink && (
          <Link
            href="/"
            className="rounded-md px-2 py-1 text-xs text-fg-dim ring-1 ring-inset ring-line transition-colors hover:bg-surface-2 hover:text-fg"
          >
            Transcript
          </Link>
        )}
        <Button size="sm" variant="danger" onClick={onStop} disabled={stale}>
          Stop
        </Button>
      </span>
    </div>
  );
}

/**
 * Turns the tail of the event stream into one human sentence.
 *
 * A tool call still waiting on a result is the most informative thing a run can
 * be doing, so it wins over streamed prose.
 */
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
