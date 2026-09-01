"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  PROVIDER_IDS,
  RUN_ROLES,
  estimateCost,
  formatTokens,
  formatUsd,
  mergeUsage,
  usageFromEvents,
  type AgentSession,
  type RunRole,
  type RunSource,
  type TokenUsage,
} from "@agent-console/shared";
import { LogPanel } from "@/components/LogPanel";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import { applyEvent, type LogItem } from "@/lib/log";
import { SERVER_URL } from "@/lib/serverUrl";
import { useAgentConsole, type RunStatus } from "@/lib/agentConsole";
import { workspaceApi } from "@/lib/workspacesApi";

type Pane = "list" | "detail";

const SESSION_STATES = ["STARTING", "RUNNING", "DONE", "INTERRUPTED", "ERROR"] as const;

/** One row in the activity browser — a persisted session and/or a live run. */
interface ActivityRow {
  id: string;
  live: boolean;
  workspaceId: number;
  workspaceName: string;
  workDirectory: string;
  provider: string;
  model: string | null;
  role: RunRole;
  state: string;
  startedAt: string;
  endedAt: string | null;
  promptId: number | null;
  promptKey: string | null;
  promptTitle: string;
  programName: string;
  suiteName: string;
  events: AgentSession["events"];
  run: RunStatus | null;
}

function normalizeState(state: string): string {
  return state.trim().toUpperCase();
}

function stateTone(state: string): Tone {
  switch (normalizeState(state)) {
    case "RUNNING":
    case "STARTING":
      return "info";
    case "DONE":
      return "success";
    case "ERROR":
      return "danger";
    case "INTERRUPTED":
      return "warning";
    default:
      return "neutral";
  }
}

function promptIdFromSource(source: RunSource): number | null {
  switch (source.type) {
    case "saved":
    case "clarification":
      return source.promptId;
    case "consult":
      return source.promptId;
    default:
      return null;
  }
}

function titleFromSource(source: RunSource): string {
  switch (source.type) {
    case "saved":
      return source.promptKey === null ? source.title : `${source.promptKey} — ${source.title}`;
    case "clarification":
      return source.promptKey === null ? source.title : `${source.promptKey} — ${source.title}`;
    case "consult":
      return (source.title ?? source.question) || "(consult)";
    case "verification":
      return source.promptKey === null
        ? `Verify · ${source.suiteKey === null ? source.suiteName : `${source.suiteKey} — ${source.suiteName}`}`
        : `Verify · ${source.promptKey}`;
    case "custom":
      return source.displayText.split("\n")[0]?.slice(0, 80) || "(custom)";
  }
}

function rowFromSession(session: AgentSession, run: RunStatus | null): ActivityRow {
  return {
    id: session.id,
    live: run !== null,
    workspaceId: session.workspaceId,
    workspaceName: session.workspaceName,
    workDirectory: session.workDirectory,
    provider: run?.provider ?? session.provider,
    model: run?.model ?? session.model,
    role: run?.role ?? session.role,
    state: run !== null ? run.state.toUpperCase() : session.state,
    startedAt: session.startedAt,
    endedAt: run !== null ? null : session.endedAt,
    promptId: session.promptId,
    promptKey: session.promptKey,
    promptTitle: session.promptTitle,
    programName: session.programName,
    suiteName: session.suiteName,
    events: session.events,
    run,
  };
}

function rowFromLiveRun(run: RunStatus): ActivityRow {
  const promptId = promptIdFromSource(run.source);
  const title = titleFromSource(run.source);
  return {
    id: run.runId,
    live: true,
    workspaceId: run.workspace.id,
    workspaceName: run.workspace.name,
    workDirectory: run.workspace.workDirectory,
    provider: run.provider,
    model: run.model,
    role: run.role,
    state: run.state.toUpperCase(),
    startedAt: run.startedAt,
    endedAt: null,
    promptId,
    promptKey:
      run.source.type === "saved" || run.source.type === "clarification" || run.source.type === "consult"
        ? run.source.promptKey
        : null,
    promptTitle: title,
    programName: run.source.type === "saved" ? run.source.programName : "",
    suiteName:
      run.source.type === "saved"
        ? run.source.suiteName
        : run.source.type === "verification"
          ? run.source.suiteName
          : "",
    events: [],
    run,
  };
}

function workItemHref(row: ActivityRow): string | null {
  if (row.promptId !== null) return `/tasks?prompt=${row.promptId}`;
  if (row.run?.source.type === "verification") {
    return `/tasks?suite=${row.run.source.suiteId}`;
  }
  return null;
}

export function ActivityView() {
  const console_ = useAgentConsole();
  const { runs, operationsRevision, itemsFor } = console_;

  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>("list");

  const [workspaceFilter, setWorkspaceFilter] = useState<string>("all");
  const [providerFilter, setProviderFilter] = useState<string>("all");
  const [stateFilter, setStateFilter] = useState<string>("all");
  const [roleFilter, setRoleFilter] = useState<string>("all");

  const refresh = useCallback(
    () =>
      workspaceApi
        .sessions(SERVER_URL)
        .then((value) => {
          setSessions(value);
          setLoadError(null);
        })
        .catch((error: unknown) => {
          setLoadError(error instanceof Error ? error.message : "Sessions could not be loaded.");
        }),
    [],
  );

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(timer);
  }, [refresh, operationsRevision, runs.length]);

  const rows = useMemo<ActivityRow[]>(() => {
    const byId = new Map((sessions ?? []).map((session) => [session.id, session]));
    const liveIds = new Set(runs.map((run) => run.runId));

    const liveRows = runs.map((run) => {
      const session = byId.get(run.runId);
      return session === undefined ? rowFromLiveRun(run) : rowFromSession(session, run);
    });

    const historical = (sessions ?? [])
      .filter((session) => !liveIds.has(session.id))
      .map((session) => rowFromSession(session, null));

    return [...liveRows, ...historical];
  }, [sessions, runs]);

  const workspaces = useMemo(() => {
    const map = new Map<number, string>();
    for (const row of rows) map.set(row.workspaceId, row.workspaceName);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const filtered = useMemo(() => {
    return rows.filter((row) => {
      if (workspaceFilter !== "all" && String(row.workspaceId) !== workspaceFilter) return false;
      if (providerFilter !== "all" && row.provider !== providerFilter) return false;
      if (stateFilter !== "all" && normalizeState(row.state) !== stateFilter) return false;
      if (roleFilter !== "all" && row.role !== roleFilter) return false;
      return true;
    });
  }, [rows, workspaceFilter, providerFilter, stateFilter, roleFilter]);

  const activeId =
    filtered.some((row) => row.id === selectedId) ? selectedId : filtered[0]?.id ?? null;
  const selected = filtered.find((row) => row.id === activeId) ?? null;

  const logs = useMemo<LogItem[]>(() => {
    if (selected === null) return [];
    if (selected.live) return itemsFor(selected.id);
    return selected.events.reduce<LogItem[]>((items, event) => applyEvent(items, event), []);
  }, [selected, itemsFor]);

  const selectedUsage = useMemo(() => (selected === null ? null : usageForRow(selected)), [selected]);
  const selectedCost =
    selected === null ? null : estimateCost(selectedUsage, selected.provider, selected.model);

  const href = selected === null ? null : workItemHref(selected);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {loadError !== null && (
        <div
          role="alert"
          className="flex items-center gap-3 border-b border-danger/40 bg-danger/10 px-4 py-2 text-xs text-danger"
        >
          <span className="min-w-0 flex-1">Session history is unavailable: {loadError}</span>
          <Button size="sm" variant="secondary" onClick={() => void refresh()}>
            Retry
          </Button>
        </div>
      )}

      <div className="flex items-center gap-1 border-b border-line bg-surface-1 px-4 py-1.5 lg:hidden">
        {(["list", "detail"] as Pane[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setPane(option)}
            aria-current={pane === option ? "true" : undefined}
            className={cn(
              "rounded-md px-3 py-1 text-xs capitalize transition-colors",
              pane === option ? "bg-surface-3 text-fg" : "text-fg-dim hover:bg-surface-2 hover:text-fg",
            )}
          >
            {option === "list" ? "Sessions" : "Detail"}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[380px_minmax(0,1fr)]">
        <aside
          className={cn(
            "flex min-h-0 flex-col border-line bg-surface-1 lg:border-r",
            pane === "list" ? "flex" : "hidden lg:flex",
          )}
        >
          <div className="grid grid-cols-2 gap-2 border-b border-line p-3">
            <Select
              label="Workspace"
              value={workspaceFilter}
              onChange={(event) => setWorkspaceFilter(event.target.value)}
            >
              <option value="all">All</option>
              {workspaces.map(([id, name]) => (
                <option key={id} value={String(id)}>
                  {name}
                </option>
              ))}
            </Select>
            <Select
              label="Provider"
              value={providerFilter}
              onChange={(event) => setProviderFilter(event.target.value)}
            >
              <option value="all">All</option>
              {PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </Select>
            <Select
              label="State"
              value={stateFilter}
              onChange={(event) => setStateFilter(event.target.value)}
            >
              <option value="all">All</option>
              {SESSION_STATES.map((state) => (
                <option key={state} value={state}>
                  {state.toLowerCase()}
                </option>
              ))}
            </Select>
            <Select
              label="Role"
              value={roleFilter}
              onChange={(event) => setRoleFilter(event.target.value)}
            >
              <option value="all">All</option>
              {RUN_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </Select>
          </div>

          <div className="flex items-center justify-between px-3 py-2 text-[10px] uppercase tracking-wider text-fg-dim">
            <span>Sessions</span>
            <span>{filtered.length}</span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            {sessions === null && runs.length === 0 ? (
              <div className="space-y-2">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : filtered.length === 0 ? (
              <p className="text-xs text-fg-dim">No sessions match the current filters.</p>
            ) : (
              filtered.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(row.id);
                    setPane("detail");
                  }}
                  aria-current={activeId === row.id ? "true" : undefined}
                  className={cn(
                    "mb-2 w-full rounded-panel border p-3 text-left transition-colors",
                    activeId === row.id
                      ? "border-line-strong bg-surface-3"
                      : "border-line bg-surface-2 hover:bg-surface-3",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="truncate text-[13px] text-fg">
                      {row.promptKey !== null ? `${row.promptKey} · ` : ""}
                      {row.promptTitle}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {row.live && (
                        <Badge tone="info" dot pulse>
                          live
                        </Badge>
                      )}
                      <Badge tone={stateTone(row.state)}>{normalizeState(row.state).toLowerCase()}</Badge>
                    </span>
                  </div>
                  <div className="mt-1 truncate text-xs text-fg-muted">
                    {row.workspaceName} · {row.provider}
                    {row.model !== null && ` · ${row.model}`}
                    {` · ${row.role}`}
                  </div>
                  <div className="mt-1 text-[10px] text-fg-dim">
                    {new Date(row.startedAt).toLocaleString()}
                  </div>
                </button>
              ))
            )}
          </div>
        </aside>

        <section
          className={cn(
            "min-h-0 min-w-0 overflow-y-auto p-5",
            pane === "detail" ? "block" : "hidden lg:block",
          )}
        >
          {selected === null ? (
            <p className="text-sm text-fg-dim">Select a session to inspect its metadata and log.</p>
          ) : (
            <div className="mx-auto flex h-full max-w-5xl flex-col gap-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={stateTone(selected.state)} dot pulse={selected.live}>
                      {normalizeState(selected.state).toLowerCase()}
                    </Badge>
                    <Badge tone="neutral">{selected.role}</Badge>
                    {selected.live && (
                      <Badge tone="info" dot pulse>
                        live
                      </Badge>
                    )}
                  </div>
                  <h2 className="mt-1.5 text-xl text-fg">
                    {selected.promptKey !== null && `${selected.promptKey} — `}
                    {selected.promptTitle}
                  </h2>
                  <p className="mt-1 text-xs text-fg-dim">
                    {selected.workspaceName}
                    {selected.programName !== "" && ` · ${selected.programName}`}
                    {selected.suiteName !== "" && ` / ${selected.suiteName}`}
                  </p>
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {href !== null && (
                    <Link
                      href={href}
                      className="rounded-md px-3 py-1.5 text-xs text-fg-muted ring-1 ring-inset ring-line transition-colors hover:bg-surface-2 hover:text-fg"
                    >
                      Open work item
                    </Link>
                  )}
                  <Link
                    href={`/?workspace=${selected.workspaceId}${selected.promptId !== null ? `&prompt=${selected.promptId}` : ""}`}
                    className="rounded-md px-3 py-1.5 text-xs text-fg-muted ring-1 ring-inset ring-line transition-colors hover:bg-surface-2 hover:text-fg"
                  >
                    Open in Console
                  </Link>
                </div>
              </div>

              <dl className="grid gap-3 rounded-panel border border-line bg-surface-1 p-4 sm:grid-cols-2 lg:grid-cols-3">
                <Meta label="Provider" value={selected.provider} />
                <Meta label="Model" value={selected.model ?? "default"} />
                <Meta label="Started" value={new Date(selected.startedAt).toLocaleString()} />
                <Meta
                  label="Ended"
                  value={
                    selected.endedAt === null
                      ? selected.live
                        ? "in progress"
                        : "—"
                      : new Date(selected.endedAt).toLocaleString()
                  }
                />
                <Meta
                  label="Tokens"
                  value={
                    selectedUsage === null
                      ? "—"
                      : `${formatTokens(selectedUsage.totalTokens)} (${formatTokens(selectedUsage.inputTokens)} in · ${formatTokens(selectedUsage.outputTokens)} out)`
                  }
                />
                <Meta
                  label="Est. cost"
                  value={selectedCost?.usd == null ? "—" : formatUsd(selectedCost.usd)}
                  hint={selectedCost?.usd == null ? "Provider did not report usage" : "API list-rate estimate"}
                />
                <Meta label="Run id" value={selected.id} mono />
                <Meta label="Working directory" value={selected.workDirectory} mono />
              </dl>

              <section className="flex min-h-0 flex-1 flex-col">
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <div className="text-xs uppercase tracking-wider text-fg-dim">
                    Session log · {selected.provider} · {normalizeState(selected.state).toLowerCase()}
                  </div>
                  <div className="numeric text-xs text-fg-muted">
                    {selectedUsage === null ? (
                      <span className="text-fg-dim">no token data</span>
                    ) : (
                      <>
                        <span className="text-fg">{formatTokens(selectedUsage.totalTokens)}</span>
                        <span className="text-fg-dim"> tok</span>
                        {selectedCost?.usd != null && (
                          <>
                            <span className="mx-1.5 text-fg-dim">·</span>
                            <span className="text-accent">{formatUsd(selectedCost.usd)}</span>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
                {logs.length === 0 ? (
                  <p className="rounded-panel border border-line p-4 text-sm text-fg-dim">
                    No event stream was captured for this session yet.
                  </p>
                ) : (
                  <div className="flex min-h-[50vh] flex-1 flex-col overflow-hidden rounded-panel border border-line lg:min-h-0">
                    <LogPanel items={logs} workdir={selected.workDirectory} />
                  </div>
                )}
              </section>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function usageForRow(row: ActivityRow): TokenUsage | null {
  // Live runs keep the freshest counters on the snapshot; fall back to events.
  return mergeUsage(usageFromEvents(row.events), row.run?.usage ?? null);
}

function Meta({
  label,
  value,
  mono = false,
  hint,
}: {
  label: string;
  value: string;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wider text-fg-dim">{label}</dt>
      <dd
        className={cn("mt-0.5 truncate text-sm text-fg", mono && "font-mono text-xs text-fg-muted")}
        title={hint !== undefined ? `${value} · ${hint}` : value}
      >
        {value}
      </dd>
      {hint !== undefined && <p className="mt-0.5 text-[10px] text-fg-dim">{hint}</p>}
    </div>
  );
}
