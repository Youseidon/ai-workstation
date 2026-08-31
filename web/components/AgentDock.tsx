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
import { agentState, ACTIVITY_LABEL, consultQuestion } from "@/lib/agentState";

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

  const executes = runs.filter((run) => run.role === "execute");
  const consults = runs.filter((run) => run.role === "consult");

  return (
    <div className="relative z-30 border-t border-line bg-surface-1/80 backdrop-blur-md">
      <div className="flex flex-col divide-y divide-line">
        {executes.map((run) => (
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
        {consults.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-4 py-1.5">
            {consults.map((run) => (
              <AskChip
                key={run.runId}
                run={run}
                onStop={() => interrupt(run.runId)}
                stale={connection !== "open"}
              />
            ))}
          </div>
        )}
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
 * Quieter than a working row: a consult is reading, not occupying the writer
 * seat. Stop still names this run so it cannot interrupt the writer by accident.
 */
export function AskChip({
  run,
  onStop,
  stale = false,
}: {
  run: RunStatus;
  onStop(): void;
  stale?: boolean;
}) {
  const theme = providerTheme[run.provider];
  const question = consultQuestion(run);

  return (
    <span className={cn("inline-flex h-7 max-w-full items-center gap-1.5 rounded-full pl-2 pr-1 text-[11px] ring-1 ring-inset", theme.chip)}>
      <Link
        href={`/?workspace=${run.workspace.id}`}
        className="flex min-w-0 items-center gap-1.5 opacity-70"
        title={question}
        onClick={() => {
          window.dispatchEvent(new CustomEvent("agent-console:focus-consult", { detail: { runId: run.runId } }));
        }}
      >
        <AgentAvatar provider={run.provider} activity="thinking" size={16} title={`${run.provider} asking`} />
        <span className="min-w-0 truncate">asking · {question || "research"}</span>
      </Link>
      <button
        type="button"
        onClick={onStop}
        disabled={stale}
        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-danger ring-1 ring-inset ring-danger/40 hover:bg-danger/15 disabled:pointer-events-none disabled:opacity-40"
      >
        Stop
      </button>
    </span>
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
