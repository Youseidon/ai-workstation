"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  PROVIDER_IDS,
  RUN_ROLES,
  estimateCost,
  formatTokens,
  isProviderId,
  modelLabel,
  formatUsd,
  mergeUsage,
  usageFromEvents,
  type AgentSession,
  type ProviderId,
  type RunRole,
  type RunChangeSummary,
  type RunSource,
  type TokenUsage,
} from "@agent-console/shared";
import { ConversationPanel } from "@/components/chat/ConversationPanel";
import { Badge, type Tone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { FilterControl, SidebarCollection, SidebarEmpty, SidebarRow } from "@/components/shell/SidebarCollection";
import { cn } from "@/lib/cn";
import { appendPrompt, applyEvent, type LogItem } from "@/lib/log";
import { SERVER_URL } from "@/lib/serverUrl";
import { useAgentConsole, type RunStatus } from "@/lib/agentConsole";
import { useWorkspace } from "@/lib/workspaceContext";
import { workspaceApi } from "@/lib/workspacesApi";
import { sessionEndReason } from "@/lib/sessionEndReason";

const SESSION_STATES = ["STARTING", "RUNNING", "DONE", "INTERRUPTED", "ERROR"] as const;

/** One row in the activity browser — a persisted session and/or a live run. */
interface ActivityRow {
  id: string;
  threadId: string | null;
  runIds: string[];
  turnCount: number;
  providers: string[];
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
  displayText: string | null;
  programName: string;
  suiteName: string;
  events: AgentSession["events"];
  run: RunStatus | null;
  changes: RunChangeSummary | null;
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
    case "audit":
    case "wrapup":
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
    case "audit":
      return `Audit · ${source.promptKey ?? source.title}`;
    case "wrapup":
      return `Wrap-up · ${source.promptKey ?? source.title}`;
    case "verification":
      return source.promptKey === null
        ? `Verify · ${source.suiteKey === null ? source.suiteName : `${source.suiteKey} — ${source.suiteName}`}`
        : `Verify · ${source.promptKey}`;
    case "custom":
      return source.displayText.split("\n")[0]?.slice(0, 80) || "(custom)";
    case "author":
      return `Draft · ${source.programName ?? source.goal.slice(0, 60)}`;
    case "instructions":
      return `Proposal · ${source.file}`;
  }
}

function displayTextFromSource(source: RunSource): string | null {
  switch (source.type) {
    case "custom":
      return source.displayText;
    case "author":
    case "instructions":
      return source.goal;
    case "consult":
    case "clarification":
      return source.question;
    default:
      return null;
  }
}

function rowFromSession(session: AgentSession, run: RunStatus | null): ActivityRow {
  return {
    id: session.id,
    threadId: session.threadId,
    runIds: [session.id],
    turnCount: 1,
    providers: [run?.provider ?? session.provider],
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
    displayText: session.displayText,
    programName: session.programName,
    suiteName: session.suiteName,
    events: session.events,
    run,
    changes: session.changes,
  };
}

function rowFromLiveRun(run: RunStatus): ActivityRow {
  const promptId = promptIdFromSource(run.source);
  const title = titleFromSource(run.source);
  return {
    id: run.runId,
    threadId: run.source.type === "custom" ? (run.source.threadId ?? null) : null,
    runIds: [run.runId],
    turnCount: 1,
    providers: [run.provider],
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
    promptTitle: run.source.type === "custom" ? (run.source.title ?? title) : title,
    displayText: displayTextFromSource(run.source),
    programName: run.source.type === "saved" ? run.source.programName : "",
    suiteName:
      run.source.type === "saved"
        ? run.source.suiteName
        : run.source.type === "verification"
          ? run.source.suiteName
          : "",
    events: [],
    run,
    changes: null,
  };
}

function workItemHref(row: ActivityRow): string | null {
  if (row.promptId !== null) return `/pipeline/open?prompt=${row.promptId}`;
  if (row.run?.source.type === "verification") {
    return `/pipeline/open?suite=${row.run.source.suiteId}`;
  }
  return null;
}

export function ActivityView({ initialRunId = null }: { initialRunId?: string | null }) {
  const console_ = useAgentConsole();
  const { runs, operationsRevision, itemsFor } = console_;
  const { workspaceId } = useWorkspace();

  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
  const [detailById, setDetailById] = useState<Record<string, AgentSession>>({});
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialRunId);
  // The URL owns the selection: a deep link or browser navigation reselects.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the route's ?run= is external state
    if (initialRunId !== null) setSelectedId(initialRunId);
  }, [initialRunId]);

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
      .map((session) => {
        const detail=detailById[session.id];
        return rowFromSession(detail===undefined?session:{...detail,changes:session.changes}, null);
      });

    const grouped = new Map<string, ActivityRow>();
    const standalone: ActivityRow[] = [];
    for (const row of [...liveRows, ...historical]) {
      if (row.threadId === null) {
        standalone.push(row);
        continue;
      }
      const previous = grouped.get(row.threadId);
      if (previous === undefined) {
        grouped.set(row.threadId, row);
        continue;
      }
      const rowIsOlder = row.startedAt < previous.startedAt;
      grouped.set(row.threadId, {
        ...previous,
        promptTitle: rowIsOlder ? row.promptTitle : previous.promptTitle,
        displayText: rowIsOlder ? row.displayText : previous.displayText,
        runIds: [...previous.runIds, ...row.runIds],
        turnCount: previous.turnCount + row.turnCount,
        providers: [...new Set([...previous.providers, ...row.providers])],
        events: [...previous.events, ...row.events].sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
        live: previous.live || row.live,
        run: previous.run ?? row.run,
        changes: previous.changes ?? row.changes,
      });
    }
    return [...grouped.values(), ...standalone]
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }, [sessions, runs, detailById]);

  const filtered = useMemo(() => {
    return rows.filter((row) => {
      if (workspaceId !== null && row.workspaceId !== workspaceId) return false;
      if (workspaceId === null) return false;
      if (providerFilter !== "all" && !row.providers.includes(providerFilter)) return false;
      if (stateFilter !== "all" && normalizeState(row.state) !== stateFilter) return false;
      if (roleFilter !== "all" && row.role !== roleFilter) return false;
      return true;
    });
  }, [rows, workspaceId, providerFilter, stateFilter, roleFilter]);

  const selected = filtered.find((row) => row.id === selectedId || (selectedId !== null && row.runIds.includes(selectedId)))
    ?? filtered[0]
    ?? null;
  const activeId = selected?.id ?? null;

  // List responses omit transcripts so a 30s poll cannot OOM the server. Load
  // the shown thread's events only when it is opened (and not live). A detail
  // fetched before a run finished (e.g. while it was still spawning) is stale:
  // refetch it once the session list reports a different state or end time.
  const selectedRunIds = selected?.runIds ?? [];
  const selectedRunKey = selectedRunIds.join(":");
  useEffect(() => {
    const summaries = new Map((sessions ?? []).map((session) => [session.id, session]));
    const missing = selectedRunIds.filter((runId) => {
      if (runs.some((run) => run.runId === runId)) return false;
      const detail = detailById[runId];
      if (detail === undefined) return true;
      const summary = summaries.get(runId);
      return summary !== undefined && (summary.state !== detail.state || summary.endedAt !== detail.endedAt);
    });
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(missing.map((runId) => workspaceApi.session(SERVER_URL, runId)))
      .then((loaded) => {
        if (cancelled) return;
        setDetailError(null);
        setDetailById((prev) => ({
          ...prev,
          ...Object.fromEntries(loaded.map((session) => [session.id, session])),
        }));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDetailError(error instanceof Error ? error.message : "Session log could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the shown run ids
  }, [selectedRunKey, sessions, runs, detailById]);


  const logs = useMemo<LogItem[]>(() => {
    if (selected === null) return [];
    const summaries = (sessions ?? [])
      .filter((session) => selected.runIds.includes(session.id))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const captured = summaries.reduce<LogItem[]>((items, summary) => {
      const liveItems = runs.some((run) => run.runId === summary.id) ? itemsFor(summary.id) : null;
      if (liveItems !== null) return [...items, ...liveItems];
      const detail = detailById[summary.id];
      const base = { runId: summary.id, provider: summary.provider as ProviderId, model: summary.model, timestamp: summary.startedAt };
      // Pipeline and saved work-item runs carry no typed text: show the work
      // item instead, with its markdown available on demand.
      const seeded = summary.displayText !== null && summary.displayText !== ""
        ? appendPrompt(items, { ...base, text: summary.displayText })
        : summary.promptId !== null
          ? appendPrompt(items, {
              ...base,
              text: summary.promptKey === null ? summary.promptTitle : `${summary.promptKey} — ${summary.promptTitle}`,
              workItem: { id: summary.promptId, key: summary.promptKey, title: summary.promptTitle },
            })
          : items;
      return (detail?.events ?? []).reduce<LogItem[]>((next, event) => applyEvent(next, event), seeded);
    }, []);
    // A socket run can arrive before the next session-list response. Show its
    // stream immediately instead of waiting for the history poll to catch up.
    const listed = new Set(summaries.map(session => session.id));
    return [...captured, ...selected.runIds.filter(runId => !listed.has(runId)).flatMap(runId => itemsFor(runId))];
  }, [selected, sessions, runs, detailById, itemsFor]);

  const selectedUsage = useMemo(() => (selected === null ? null : usageForRow(selected)), [selected]);
  const selectedCost =
    selected === null ? null : estimateCost(selectedUsage, selected.provider, selected.model);
  const selectedLoaded = selected === null || selected.runIds.every(
    (runId) => runs.some((run) => run.runId === runId) || detailById[runId] !== undefined,
  );

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

      <SidebarCollection
        label="Conversations and runs"
        tools={
          <FilterControl active={[providerFilter, stateFilter, roleFilter].filter((value) => value !== "all").length}>
            <Select label="Provider" value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}>
              <option value="all">All</option>
              {PROVIDER_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
            </Select>
            <Select label="State" value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}>
              <option value="all">All</option>
              {SESSION_STATES.map((state) => <option key={state} value={state}>{state.toLowerCase()}</option>)}
            </Select>
            <Select label="Role" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
              <option value="all">All</option>
              {RUN_ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
            </Select>
          </FilterControl>
        }
      >
        <p className="app-sidebar-group">Conversations &amp; runs · {filtered.length}</p>
        {sessions === null && runs.length === 0 ? (
          <SidebarEmpty><span role="status">Loading activity…</span></SidebarEmpty>
        ) : filtered.length === 0 ? (
          <SidebarEmpty>No sessions match the current filters.</SidebarEmpty>
        ) : (
          filtered.map((row) => {
            const reason = sessionEndReason(row.state, row.events);
            const state = row.live ? "live" : normalizeState(row.state).toLowerCase();
            return (
              <SidebarRow
                key={row.id}
                href={`/activity?run=${encodeURIComponent(row.id)}`}
                onSelect={() => setSelectedId(row.id)}
                selected={activeId === row.id}
                title={`${row.promptKey !== null ? `${row.promptKey} · ` : ""}${row.promptTitle}`}
                detail={`${row.providers.join(" + ")} · ${row.role}${row.turnCount > 1 ? ` · ${row.turnCount} turns` : ""} · ${new Date(row.startedAt).toLocaleString()}`}
                status={reason === null ? state : `${state} · ${reason}`}
                statusTone={row.live ? "accent" : normalizeState(row.state) === "ERROR" ? "danger" : normalizeState(row.state) === "INTERRUPTED" ? "warning" : "muted"}
              />
            );
          })
        )}
      </SidebarCollection>

      <div className="min-h-0 flex-1">
        <section aria-label="Selected activity" className="activity-selected h-full min-h-0 min-w-0 px-5 max-sm:px-4">
          {selected === null ? (
            <>
            <h1 className="py-3 text-base font-medium">Activity</h1>
            <p className="text-sm text-fg-muted" role="status">
              {loadError !== null
                ? "Session history could not be loaded."
                : sessions === null && runs.length === 0
                  ? "Loading activity…"
                  : rows.some((row) => row.workspaceId === workspaceId)
                    ? "No sessions match the current filters."
                    : "No conversations or runs in this workspace yet."}
            </p>
            </>
          ) : (
            <div className="activity-session" key={selected.id}>
              <header className="activity-session-header">
                <div className="activity-session-heading">
                  <h1 title={`${selected.promptKey !== null ? `${selected.promptKey} — ` : ""}${selected.promptTitle}`}>
                    {selected.promptKey !== null && `${selected.promptKey} — `}{selected.promptTitle}
                  </h1>
                  <Badge tone={stateTone(selected.state)} dot pulse={selected.live}>
                    {selected.live ? "live" : normalizeState(selected.state).toLowerCase()}
                  </Badge>
                </div>
                <div className="activity-session-toolbar">
                  <div className="activity-session-identity">
                    <span>{selected.providers.map(id => console_.providers.find(provider => provider.id === id)?.label ?? id).join(" + ")}</span>
                    <span title={selected.model ?? "The provider did not report a model"}>{(isProviderId(selected.provider) ? modelLabel(selected.provider, selected.model) : selected.model) ?? "Model not reported"}</span>
                    {sessionEndReason(selected.state, selected.events) !== null && <span className="text-warning">{sessionEndReason(selected.state, selected.events)}</span>}
                  </div>
                  <div className="activity-session-actions">
                    {selected.changes !== null && selected.changes.filesChanged > 0 && <Link href={`/changes/${encodeURIComponent(selected.changes.runId)}`}>Review changes ↗</Link>}
                    <Link href={`/?workspace=${selected.workspaceId}${selected.threadId !== null ? `&thread=${encodeURIComponent(selected.threadId)}` : selected.promptId !== null ? `&prompt=${selected.promptId}` : ""}`}>
                      {selected.threadId === null ? "Open in Chat" : "Continue in Chat"} ↗
                    </Link>
                  </div>
                </div>
              </header>
              <details className="activity-session-details">
                <summary>Session details</summary>
                <div className="activity-session-metadata">
                  <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <Meta label={selected.providers.length > 1 ? "Agents" : "Agent"} value={selected.providers.join(", ")} />
                    <Meta label="Model" value={selected.model ?? "Not reported"} />
                    <Meta label="Role" value={selected.role} />
                    <Meta label="Workspace" value={selected.workspaceName} />
                    {selected.programName !== "" && <Meta label="Program / Suite" value={`${selected.programName} / ${selected.suiteName}`} />}
                    {selected.turnCount > 1 && <Meta label="Turns" value={String(selected.turnCount)} />}
                    {selected.changes?.state === "UNCHANGED" && <Meta label="Code changes" value="No code changes" />}
                    {sessionEndReason(selected.state, selected.events) !== null && (
                      <Meta label="End reason" value={sessionEndReason(selected.state, selected.events)!} />
                    )}
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
                    {selected.threadId !== null && <Meta label="Thread id" value={selected.threadId} mono />}
                    <Meta label={selected.runIds.length > 1 ? "Latest run id" : "Run id"} value={selected.id} mono />
                    <Meta label="Working directory" value={selected.workDirectory} mono />
                  </dl>
                  {href !== null && <Link href={href} className="activity-work-item">Open work item ↗</Link>}
                </div>
              </details>

              <section className="activity-session-log" aria-label="Agent logs">
                <h2 className="sr-only">{selected.threadId === null ? "Run" : "Conversation"} log</h2>
                {detailError !== null && !selected.live ? (
                  <p role="alert" className="rounded-panel border border-danger/40 bg-danger/10 p-4 text-sm text-danger">
                    Session log is unavailable: {detailError}
                  </p>
                ) : logs.length === 0 && !selected.live && !selectedLoaded ? (
                  <p className="rounded-panel border border-line p-4 text-sm text-fg-dim">
                    Loading conversation log…
                  </p>
                ) : logs.length === 0 ? (
                  <p className="rounded-panel border border-line p-4 text-sm text-fg-dim">
                    No event stream was captured for this session yet.
                  </p>
                ) : (
                  <div className="activity-transcript">
                    <ConversationPanel key={selected.threadId ?? selected.id} items={logs} workdir={selected.workDirectory} workspaceId={selected.workspaceId} storageKey={selected.threadId ?? selected.id} />
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
      <dt className="text-xs uppercase tracking-wider text-fg-dim">{label}</dt>
      <dd
        className={cn("mt-0.5 truncate text-sm text-fg", mono && "font-mono text-xs text-fg-muted")}
        title={hint !== undefined ? `${value} · ${hint}` : value}
      >
        {value}
      </dd>
      {hint !== undefined && <p className="mt-0.5 text-xs text-fg-dim">{hint}</p>}
    </div>
  );
}
