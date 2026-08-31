"use client";

import Link from "next/link";
import { useMemo } from "react";
import { formatElapsed, formatTokens, modelLabel } from "@agent-console/shared";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/lib/providerTheme";
import { ACTIVITY_LABEL, agentState, type AgentState } from "@/lib/agentState";
import { useAgentConsole } from "@/lib/agentConsole";
import { AgentAvatar } from "./AgentAvatar";
import { AskChip } from "./AgentDock";
import { Badge, type Tone } from "./ui/Badge";
import { Button } from "./ui/Button";
import { CountUp } from "./CountUp";

const ACTIVITY_TONE: Record<AgentState["activity"], Tone> = {
  offline: "neutral",
  idle: "neutral",
  starting: "info",
  thinking: "info",
  tooling: "accent",
  speaking: "violet",
  done: "success",
  error: "danger",
};

function fleetSummary(writing: number, asking: number): string {
  if (writing === 0 && asking === 0) return "All agents idle.";
  if (writing > 0 && asking > 0) return `${writing} writing · ${asking} asking`;
  if (writing > 0) return `${writing} agent${writing === 1 ? "" : "s"} writing.`;
  return `${asking} agent${asking === 1 ? "" : "s"} asking.`;
}

/**
 * Every agent at once: who is working, on what, for how long, and at what cost.
 *
 * The console answers "what is this run doing"; nothing answered "what is the
 * fleet doing". With runs owned by the server and broadcast to every client,
 * this is a straight read of live state.
 */
export function FleetView() {
  const { providers, runs, items, lastRun, connection, interrupt } = useAgentConsole();

  const agents = useMemo(
    () => providers.map((provider) => agentState(provider, runs, items, lastRun)),
    [providers, runs, items, lastRun],
  );

  const writing = runs.filter((run) => run.role === "execute").length;
  const asking = runs.filter((run) => run.role === "consult").length;
  const totalTokens = runs.reduce((sum, run) => sum + (run.usage?.totalTokens ?? 0), 0);

  return (
    <div className="mx-auto w-full max-w-6xl p-5">
      <header className="mb-5 flex flex-wrap items-end gap-4">
        <div>
          <h2 className="text-lg text-fg">Fleet</h2>
          <p className="mt-0.5 text-xs text-fg-dim">
            {connection === "open" ? fleetSummary(writing, asking) : "Reconnecting to the backend…"}
          </p>
        </div>
        <dl className="ml-auto flex gap-6">
          <Stat label="available" value={agents.filter((agent) => agent.available).length} />
          {asking > 0 ? (
            <>
              {writing > 0 && <Stat label="writing" value={writing} />}
              <Stat label="asking" value={asking} />
            </>
          ) : (
            <Stat label="working" value={writing} />
          )}
          <Stat label="tokens in flight" value={totalTokens} format={formatTokens} />
        </dl>
      </header>

      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {agents.map((agent) => (
          <AgentCard
            key={agent.provider}
            agent={agent}
            onStop={() => {
              if (agent.run !== null) interrupt(agent.run.runId);
            }}
            onStopConsult={(runId) => interrupt(runId)}
          />
        ))}
      </ul>
    </div>
  );
}

function Stat({
  label,
  value,
  format,
}: {
  label: string;
  value: number;
  format?: (value: number) => string;
}) {
  return (
    <div className="text-right">
      <dd className="numeric text-xl text-fg">
        <CountUp value={value} format={format} />
      </dd>
      <dt className="text-[10px] uppercase tracking-wider text-fg-dim">{label}</dt>
    </div>
  );
}

function AgentCard({
  agent,
  onStop,
  onStopConsult,
}: {
  agent: AgentState;
  onStop(): void;
  onStopConsult(runId: string): void;
}) {
  const theme = providerTheme[agent.provider];
  const busy = agent.run !== null || agent.consultCount > 0;
  const label = modelLabel(agent.provider, agent.model);

  return (
    <li
      className={cn(
        "relative flex flex-col overflow-hidden rounded-panel border bg-surface-1 p-4 transition-colors",
        busy ? "border-line-strong" : "border-line",
        agent.activity === "offline" && "opacity-60",
      )}
    >
      {/* A slow sheen across the card while the agent is working. */}
      {busy && (
        <span
          aria-hidden
          className={cn("pointer-events-none absolute inset-x-0 top-0 h-px opacity-70", theme.fill)}
        />
      )}

      <div className="flex items-start gap-3">
        <AgentAvatar
          provider={agent.provider}
          activity={agent.activity}
          size={44}
          title={`${agent.provider}: ${ACTIVITY_LABEL[agent.activity]}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("text-[13px] font-semibold", theme.text)}>{agent.provider}</span>
            <Badge tone={ACTIVITY_TONE[agent.activity]} dot pulse={busy}>
              {ACTIVITY_LABEL[agent.activity]}
            </Badge>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-fg-dim">{label ?? "provider default"}</div>
        </div>
      </div>

      <p
        className={cn(
          "mt-3 min-h-[2.5rem] text-xs leading-relaxed",
          agent.activity === "offline" ? "text-fg-dim" : "text-fg-muted",
        )}
      >
        <span className="line-clamp-2">{agent.caption}</span>
      </p>

      {agent.run !== null && (
        <>
          <dl className="mt-2 grid grid-cols-2 gap-2 border-t border-line pt-3 text-[11px]">
            <div>
              <dt className="text-fg-dim">elapsed</dt>
              <dd className="numeric text-fg">{formatElapsed(agent.run.elapsedMs)}</dd>
            </div>
            <div>
              <dt className="text-fg-dim">tokens</dt>
              <dd className="numeric text-fg">
                {agent.run.usage === null ? "—" : formatTokens(agent.run.usage.totalTokens)}
              </dd>
            </div>
            <div className="col-span-2 min-w-0">
              <dt className="text-fg-dim">workspace</dt>
              <dd className="truncate text-fg" title={agent.run.workspace.workDirectory}>
                {agent.run.workspace.name}
              </dd>
            </div>
          </dl>
          <div className="mt-3 flex gap-2">
            <Link
              href="/"
              className="flex-1 rounded-md px-2 py-1.5 text-center text-xs text-fg-muted ring-1 ring-inset ring-line transition-colors hover:bg-surface-2 hover:text-fg"
            >
              Transcript
            </Link>
            <Button size="sm" variant="danger" onClick={onStop}>
              Stop
            </Button>
          </div>
        </>
      )}

      {agent.consultCount > 0 && (
        <div className={cn("flex flex-col gap-1.5", agent.run !== null ? "mt-3" : "mt-2 border-t border-line pt-3")}>
          <div className="text-[10px] uppercase tracking-wider text-fg-dim">
            {agent.consultCount} asking
          </div>
          <div className="flex flex-wrap gap-1.5">
            {agent.consults.map((consult) => (
              <AskChip key={consult.runId} run={consult} onStop={() => onStopConsult(consult.runId)} />
            ))}
          </div>
        </div>
      )}

      {agent.run === null && agent.consultCount === 0 && (
        <div className="mt-2 border-t border-line pt-3 text-[11px] text-fg-dim">
          {agent.available ? "Ready to take work." : "Configure it in Settings, then re-run detection."}
        </div>
      )}
    </li>
  );
}
