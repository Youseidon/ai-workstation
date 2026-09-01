"use client";

import Link from "next/link";
import { formatElapsed, formatTokens } from "@agent-console/shared";
import { AgentPicker } from "@/components/AgentPicker";
import { preferExecuteRun } from "@/lib/agentState";
import { useAgentConsole } from "@/lib/useAgentConsole";
import { providerTheme } from "@/lib/providerTheme";
import { StatusDot } from "@/components/ui/Badge";
import { useChromePage } from "./chrome";

/**
 * Slim chrome strip: page identity on the left, agent picker and live-run chip
 * on the right. Page-specific actions arrive through PageChrome.
 */
export function TopBar() {
  const page = useChromePage();
  const { runs, connection, lastRun } = useAgentConsole();
  const live = preferExecuteRun(runs.find((run) => run.role === "execute") ?? runs[0] ?? null, runs);
  const theme = live ? providerTheme[live.provider] : null;

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface-1 px-4">
      <div className="min-w-0 flex-1">
        {page.breadcrumb !== null ? (
          <div className="truncate text-sm text-fg-muted">{page.breadcrumb}</div>
        ) : (
          <h1 className="truncate text-sm font-semibold text-fg">{page.title || "Agent Console"}</h1>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {page.actions}

        {live !== null ? (
          <Link
            href="/"
            className="hidden items-center gap-2 rounded-md bg-surface-2 px-2.5 py-1.5 text-xs ring-1 ring-inset ring-line transition-colors hover:bg-surface-3 sm:flex"
            title="Open Chat transcript"
          >
            <StatusDot tone={connection === "open" ? "accent" : "warning"} pulse={connection === "open"} />
            <span className={theme?.text ?? "text-fg"}>
              {live.role === "consult" ? "Asking" : "Running"} · {live.provider}
            </span>
            <span className="numeric text-fg-dim">{formatElapsed(live.elapsedMs)}</span>
            {live.usage !== null && (
              <span className="numeric hidden text-fg-dim md:inline">
                {formatTokens(live.usage.totalTokens)} tok
              </span>
            )}
          </Link>
        ) : lastRun !== null ? (
          <span className="hidden text-xs text-fg-dim lg:inline">
            last · {lastRun.provider} {lastRun.state}
          </span>
        ) : null}

        <AgentPicker />
      </div>
    </header>
  );
}
