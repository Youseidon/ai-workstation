"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  formatTokens,
  formatUsd,
  isProviderId,
  modelLabel,
  type SessionUsageRow,
  type SuiteUsageRow,
  type TaskUsageRow,
  type UsageReport,
  type UsageTotals,
  type WorkspaceRecord,
} from "@agent-console/shared";
import { CountUp } from "@/components/CountUp";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/lib/providerTheme";
import { SERVER_URL } from "@/lib/serverUrl";
import { useAgentConsole } from "@/lib/useAgentConsole";
import { workspaceApi } from "@/lib/workspacesApi";

type Tab = "suites" | "tasks" | "sessions";

function share(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, (part / whole) * 100);
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sessionTitle(session: SessionUsageRow): string {
  if (session.promptKey !== null && session.promptKey !== "") {
    return `${session.promptKey} — ${session.promptTitle}`;
  }
  return session.promptTitle;
}

export function ReportView() {
  const { operationsRevision } = useAgentConsole();
  const [report, setReport] = useState<UsageReport | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [workspaceFilter, setWorkspaceFilter] = useState<string>("all");
  const [tab, setTab] = useState<Tab>("suites");
  const [expandedSuite, setExpandedSuite] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void workspaceApi
      .list(SERVER_URL)
      .then(setWorkspaces)
      .catch(() => {
        /* workspace filter is optional */
      });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const workspaceId = workspaceFilter === "all" ? undefined : Number(workspaceFilter);
      const nextReport = await workspaceApi.report(SERVER_URL, workspaceId);
      setReport(nextReport);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Report could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [workspaceFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh, operationsRevision]);

  const sessionsById = useMemo(() => {
    const map = new Map<string, SessionUsageRow>();
    for (const session of report?.sessions ?? []) map.set(session.id, session);
    return map;
  }, [report]);

  const allTasks = useMemo(() => {
    if (report === null) return [];
    return report.suites
      .flatMap((suite) => suite.tasks)
      .sort(
        (a, b) =>
          b.totals.estimatedUsd - a.totals.estimatedUsd ||
          b.totals.totalTokens - a.totals.totalTokens,
      );
  }, [report]);

  const maxSuiteCost = Math.max(
    ...(report?.suites.map((suite) => suite.totals.estimatedUsd) ?? [0]),
    0.01,
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 p-5">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs text-fg-dim">
              Tokens per session, rolled up into tasks and suites.
              {report !== null ? ` · ${formatWhen(report.generatedAt)}` : ""}
            </p>
            {loadError !== null && <p className="mt-1 text-xs text-danger">{loadError}</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="Workspace"
              value={workspaceFilter}
              onChange={(event) => setWorkspaceFilter(event.target.value)}
              className="w-44"
            >
              <option value="all">All workspaces</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={String(workspace.id)}>
                  {workspace.name}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="ghost" onClick={() => void refresh()} loading={loading && report !== null}>
              Refresh
            </Button>
          </div>
        </header>

        {report === null && loading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-24 w-full rounded-lg" />
            ))}
          </div>
        ) : report !== null ? (
          <>
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <HeroStat
                label="Estimated spend"
                kind="money"
                value={report.totals.estimatedUsd}
                hint={report.pricingNote}
                accent
              />
              <HeroStat
                label="Tokens"
                kind="tokens"
                value={report.totals.totalTokens}
                hint={`${formatTokens(report.totals.inputTokens)} in · ${formatTokens(report.totals.outputTokens)} out`}
              />
              <HeroStat
                label="Sessions"
                kind="count"
                value={report.totals.sessionCount}
                hint={
                  report.totals.sessionsWithoutUsage > 0
                    ? `${report.totals.sessionsWithoutUsage} without token data`
                    : "All reported usage"
                }
              />
              <HeroStat
                label="Suites with spend"
                kind="count"
                value={report.suites.filter((suite) => suite.totals.sessionCount > 0).length}
                hint={`${allTasks.length} tasks · ${report.unassigned.sessionIds.length} unassigned`}
              />
            </section>

            {report.byProvider.length > 0 && (
              <section className="rounded-lg bg-surface-1 ring-1 ring-inset ring-line">
                <div className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3">
                  <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-dim">
                    By provider
                  </h2>
                  <p className="text-[11px] text-fg-dim">API-rate estimate</p>
                </div>
                <ul className="divide-y divide-line">
                  {report.byProvider.map((entry) => {
                    const theme = isProviderId(entry.provider) ? providerTheme[entry.provider] : null;
                    const width = share(entry.totals.estimatedUsd || entry.totals.totalTokens, Math.max(report.totals.estimatedUsd, report.totals.totalTokens, 1));
                    return (
                      <li key={entry.provider} className="px-4 py-3">
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <span className={cn("font-medium capitalize", theme?.text ?? "text-fg")}>
                            {entry.provider}
                          </span>
                          <span className="numeric text-fg">
                            {formatUsd(entry.totals.estimatedUsd)}
                            <span className="ml-2 text-fg-dim">{formatTokens(entry.totals.totalTokens)}</span>
                          </span>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
                          <div
                            className={cn("h-full rounded-full transition-[width] duration-500", theme?.fill ?? "bg-accent")}
                            style={{ width: `${width}%` }}
                          />
                        </div>
                        <div className="mt-1 text-[10px] text-fg-dim">
                          {entry.totals.sessionsWithUsage}/{entry.totals.sessionCount} sessions with usage
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            <section className="rounded-lg bg-surface-1 ring-1 ring-inset ring-line">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
                <div className="flex gap-1 rounded-md bg-surface-2 p-1 ring-1 ring-inset ring-line">
                  {(
                    [
                      ["suites", "Suites"],
                      ["tasks", "Tasks"],
                      ["sessions", "Sessions"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setTab(id)}
                      className={cn(
                        "rounded px-3 py-1.5 text-xs font-medium transition-colors",
                        tab === id ? "bg-surface-3 text-fg" : "text-fg-dim hover:text-fg",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="max-w-md text-[11px] leading-relaxed text-fg-dim">{report.pricingNote}</p>
              </div>

              {tab === "suites" && (
                <SuiteTable
                  suites={report.suites}
                  unassigned={report.unassigned}
                  sessionsById={sessionsById}
                  expandedSuite={expandedSuite}
                  onToggle={(suiteId) =>
                    setExpandedSuite((current) => (current === suiteId ? null : suiteId))
                  }
                  barWhole={maxSuiteCost}
                />
              )}
              {tab === "tasks" && <TaskTable tasks={allTasks} />}
              {tab === "sessions" && <SessionTable sessions={report.sessions} />}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}

function HeroStat({
  label,
  value,
  kind,
  hint,
  accent = false,
}: {
  label: string;
  value: number;
  kind: "money" | "tokens" | "count";
  hint?: string;
  accent?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-lg bg-surface-1 p-4 ring-1 ring-inset ring-line",
        accent && "bg-[linear-gradient(135deg,color-mix(in_oklab,var(--accent)_12%,transparent),transparent_55%)]",
      )}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-dim">{label}</div>
      <div className={cn("mt-2 numeric text-2xl font-semibold tracking-tight", accent ? "text-accent" : "text-fg")}>
        {kind === "money" ? (
          <MoneyCount value={value} />
        ) : kind === "tokens" ? (
          <CountUp value={value} format={formatTokens} />
        ) : (
          <CountUp value={value} />
        )}
      </div>
      {hint !== undefined && (
        <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-fg-dim" title={hint}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** CountUp only animates integers; animate cents then format as dollars. */
function MoneyCount({ value }: { value: number }) {
  const cents = Math.round(value * 100);
  return <CountUp value={cents} format={(raw) => formatUsd(raw / 100)} />;
}

function SuiteTable({
  suites,
  unassigned,
  sessionsById,
  expandedSuite,
  onToggle,
  barWhole,
}: {
  suites: SuiteUsageRow[];
  unassigned: UsageReport["unassigned"];
  sessionsById: Map<string, SessionUsageRow>;
  expandedSuite: number | null;
  onToggle: (suiteId: number) => void;
  barWhole: number;
}) {
  if (suites.length === 0 && unassigned.sessionIds.length === 0) {
    return <EmptyState message="No suites have sessions yet." />;
  }

  return (
    <ul className="divide-y divide-line">
      {suites.map((suite) => {
        const open = expandedSuite === suite.suiteId;
        return (
          <li key={suite.suiteId}>
            <button
              type="button"
              onClick={() => onToggle(suite.suiteId)}
              className="flex w-full flex-col gap-2 px-4 py-3 text-left transition-colors hover:bg-surface-2/60"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-fg">{suite.suiteName}</div>
                  <div className="truncate text-[11px] text-fg-dim">
                    {suite.programName}
                    {suite.workspaceName ? ` · ${suite.workspaceName}` : ""}
                    {` · ${suite.tasks.length} task${suite.tasks.length === 1 ? "" : "s"}`}
                  </div>
                </div>
                <TotalsChip totals={suite.totals} />
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-500"
                  style={{
                    width: `${share(
                      suite.totals.estimatedUsd > 0
                        ? suite.totals.estimatedUsd
                        : suite.totals.totalTokens,
                      suite.totals.estimatedUsd > 0 ? barWhole : Math.max(barWhole, 1),
                    )}%`,
                  }}
                />
              </div>
            </button>
            {open && (
              <div className="border-t border-line bg-surface-0/40 px-4 py-3">
                <ul className="flex flex-col gap-2">
                  {suite.tasks.map((task) => (
                    <TaskRow key={task.promptId} task={task} compact />
                  ))}
                </ul>
              </div>
            )}
          </li>
        );
      })}
      {unassigned.sessionIds.length > 0 && (
        <li className="px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <div className="text-sm font-medium text-fg">Unassigned sessions</div>
              <div className="text-[11px] text-fg-dim">
                Research, consult, and custom runs without a work item · {unassigned.sessionIds.length} session
                {unassigned.sessionIds.length === 1 ? "" : "s"}
              </div>
            </div>
            <TotalsChip totals={unassigned.totals} />
          </div>
          <ul className="mt-3 flex flex-col gap-1.5">
            {unassigned.sessionIds.slice(0, 12).map((id) => {
              const session = sessionsById.get(id);
              if (session === undefined) return null;
              return <SessionRow key={id} session={session} />;
            })}
            {unassigned.sessionIds.length > 12 && (
              <li className="text-[11px] text-fg-dim">+{unassigned.sessionIds.length - 12} more</li>
            )}
          </ul>
        </li>
      )}
    </ul>
  );
}

function TaskTable({ tasks }: { tasks: TaskUsageRow[] }) {
  if (tasks.length === 0) return <EmptyState message="No task-linked sessions yet." />;
  return (
    <ul className="divide-y divide-line">
      {tasks.map((task) => (
        <li key={task.promptId} className="px-4 py-3">
          <TaskRow task={task} />
        </li>
      ))}
    </ul>
  );
}

function TaskRow({ task, compact = false }: { task: TaskUsageRow; compact?: boolean }) {
  return (
    <div className={cn("flex flex-wrap items-baseline justify-between gap-3", compact && "rounded-md bg-surface-1 px-3 py-2 ring-1 ring-inset ring-line")}>
      <div className="min-w-0">
        <Link
          href={`/tasks?prompt=${task.promptId}`}
          className="truncate text-sm font-medium text-fg hover:text-accent"
        >
          {task.promptKey !== null ? `${task.promptKey} — ${task.promptTitle}` : task.promptTitle}
        </Link>
        {!compact && (
          <div className="truncate text-[11px] text-fg-dim">
            {task.suiteName} · {task.programName}
            {` · ${task.sessionIds.length} session${task.sessionIds.length === 1 ? "" : "s"}`}
          </div>
        )}
        {compact && (
          <div className="text-[10px] text-fg-dim">
            {task.sessionIds.length} session{task.sessionIds.length === 1 ? "" : "s"}
          </div>
        )}
      </div>
      <TotalsChip totals={task.totals} />
    </div>
  );
}

function SessionTable({ sessions }: { sessions: SessionUsageRow[] }) {
  if (sessions.length === 0) return <EmptyState message="No sessions recorded yet." />;
  return (
    <ul className="divide-y divide-line">
      {sessions.map((session) => (
        <li key={session.id} className="px-4 py-3">
          <SessionRow session={session} detailed />
        </li>
      ))}
    </ul>
  );
}

function SessionRow({ session, detailed = false }: { session: SessionUsageRow; detailed?: boolean }) {
  const theme = isProviderId(session.provider) ? providerTheme[session.provider] : null;
  const model = isProviderId(session.provider)
    ? modelLabel(session.provider, session.model)
    : session.model;
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {session.promptId !== null ? (
            <Link href={`/tasks?prompt=${session.promptId}`} className="truncate text-sm text-fg hover:text-accent">
              {sessionTitle(session)}
            </Link>
          ) : (
            <span className="truncate text-sm text-fg">{sessionTitle(session)}</span>
          )}
          <Badge tone="neutral">{session.role}</Badge>
          <span className={cn("text-[10px] capitalize", theme?.text ?? "text-fg-dim")}>{session.provider}</span>
        </div>
        <div className="mt-0.5 truncate text-[11px] text-fg-dim">
          {formatWhen(session.startedAt)}
          {model !== null ? ` · ${model}` : ""}
          {detailed && session.suiteName ? ` · ${session.suiteName}` : ""}
          {session.usage === null ? " · no token data" : ""}
        </div>
      </div>
      <div className="numeric text-right text-sm">
        <div className="text-fg">{session.cost.usd === null ? "—" : formatUsd(session.cost.usd)}</div>
        <div className="text-[11px] text-fg-dim">
          {session.usage === null ? "—" : formatTokens(session.usage.totalTokens)}
        </div>
      </div>
    </div>
  );
}

function TotalsChip({ totals }: { totals: UsageTotals }) {
  return (
    <div className="numeric shrink-0 text-right text-sm">
      <div className="font-medium text-fg">{formatUsd(totals.estimatedUsd)}</div>
      <div className="text-[11px] text-fg-dim">
        {formatTokens(totals.totalTokens)}
        {totals.sessionsWithoutUsage > 0 ? ` · ${totals.sessionsWithoutUsage} unknown` : ""}
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <p className="px-4 py-10 text-center text-sm text-fg-dim">{message}</p>;
}
