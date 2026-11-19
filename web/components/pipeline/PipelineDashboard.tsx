"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatElapsed, type OperationsSnapshot, type PipelineDashboard as PipelineDashboardData } from "@agent-console/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Spinner";
import { SERVER_URL } from "@/lib/serverUrl";
import { useAgentConsole } from "@/lib/agentConsole";
import { useWorkspace } from "@/lib/workspaceContext";
import { workspaceApi } from "@/lib/workspacesApi";
import { ContentTitle } from "@/components/shell/PageCanvas";
import { SidebarCollection, SidebarEmpty, SidebarRow } from "@/components/shell/SidebarCollection";
import { cn } from "@/lib/cn";
import { PipelineThroughputChart } from "./PipelineThroughputChart";
import { GateGlyph } from "./station/Conversation";
import { collectInbox } from "./station/NeedsYouInbox";
import { countStations } from "./station/tree";
import { LABEL, PIPELINE_LABEL, PIPELINE_TONE, TONE } from "./status";

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight text-fg numeric">{value}</dd>
      {hint !== undefined && <p className="mt-1 text-xs text-fg-muted">{hint}</p>}
    </div>
  );
}

export function PipelineDashboard() {
  const console_ = useAgentConsole();
  const { workspaceId, status: workspaceStatus } = useWorkspace();
  const router = useRouter();
  const [dashboard, setDashboard] = useState<PipelineDashboardData | null>(null);
  const [operations, setOperations] = useState<OperationsSnapshot | null>(null);
  const [suiteQuery, setSuiteQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (workspaceId === null) {
      setDashboard(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [next, ops] = await Promise.all([
        workspaceApi.pipelineDashboard(SERVER_URL, workspaceId),
        workspaceApi.operations(SERVER_URL, workspaceId),
      ]);
      setDashboard(next);
      setOperations(ops);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load pipeline dashboard");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh, console_.operationsRevision]);

  const summary = dashboard?.summary;
  const inbox = useMemo(() => collectInbox(operations?.suites ?? []), [operations]);

  // Where a suite opens: the pipeline running it, any pipeline with it, or its own view.
  const suiteHref = (suiteId: number): { href: string; via: string | null } => {
    const including = (dashboard?.pipelines ?? []).filter((entry) => entry.pipeline.stages.some((stage) => stage.suiteId === suiteId));
    const pick = including.find((entry) => entry.pipeline.active !== null) ?? including[0];
    return pick === undefined
      ? { href: `/pipeline/suite/${suiteId}`, via: null }
      : { href: `/pipeline/${pick.pipeline.id}?suite=${suiteId}`, via: pick.pipeline.name };
  };
  const suites = useMemo(() => {
    const needle = suiteQuery.trim().toLowerCase();
    const all = operations?.suites ?? [];
    return needle === ""
      ? all
      : all.filter((suite) => `${suite.name} ${suite.key ?? ""} ${suite.programName} ${suite.programKey ?? ""}`.toLowerCase().includes(needle));
  }, [operations, suiteQuery]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ContentTitle
        title="Pipelines"
        meta={dashboard !== null ? <>Updated {new Date(dashboard.generatedAt).toLocaleTimeString()}</> : undefined}
        actions={
          <Button size="sm" variant="ghost" onClick={() => void refresh()} loading={loading && dashboard !== null}>
            Refresh
          </Button>
        }
      />

      <SidebarCollection
        label="Pipelines"
        tools={
          <button type="button" className="app-sidebar-new" disabled={workspaceId === null} onClick={() => router.push("/pipeline/new")}>
            <span aria-hidden>＋</span> New pipeline
          </button>
        }
      >
        {workspaceId === null ? (
          <SidebarEmpty>Choose a workspace.</SidebarEmpty>
        ) : dashboard === null ? (
          <SidebarEmpty><span role="status">{error ?? "Loading pipelines…"}</span></SidebarEmpty>
        ) : dashboard.pipelines.length === 0 ? (
          <SidebarEmpty>No pipelines yet.</SidebarEmpty>
        ) : (
          <>
            <p className="app-sidebar-group">Pipelines · {dashboard.pipelines.length}</p>
            {dashboard.pipelines.map((item) => {
              const badge = item.pipeline.active ?? item.pipeline.latest;
              return (
                <SidebarRow
                  key={item.pipeline.id}
                  href={`/pipeline/${item.pipeline.id}`}
                  title={item.pipeline.name}
                  detail={item.totalSteps > 0 ? `${item.completedSteps}/${item.totalSteps} steps` : `${item.pipeline.stages.length} suites`}
                  status={item.attentionCount > 0 ? `${item.attentionCount} need you` : badge === null ? undefined : PIPELINE_LABEL[badge.state]}
                  statusTone={item.attentionCount > 0 ? "warning" : badge?.state === "PLAYING" ? "accent" : "muted"}
                />
              );
            })}
          </>
        )}
      </SidebarCollection>

      <div className="min-h-0 flex-1 overflow-auto px-5 pb-8 max-sm:px-4">
        {error !== null && <p role="alert" className="mb-4 text-sm text-danger">{error}</p>}
        <div className="w-full space-y-8">
          {workspaceStatus === "empty" && (
            <p className="text-sm text-fg-dim">
              No workspaces yet.{" "}
              <Link href="/workspaces" className="text-accent hover:underline">
                Create one
              </Link>{" "}
              before building pipelines.
            </p>
          )}

          {workspaceId !== null && loading && dashboard === null ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-20 w-full" />
              ))}
            </div>
          ) : summary !== undefined ? (
            <dl aria-label="Summary" className="grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Pipelines" value={String(summary.pipelineCount)} hint={`${summary.activePipelineCount} active`} />
              <StatCard
                label="Built"
                value={`${summary.completedSteps}/${summary.totalSteps}`}
                hint={summary.totalSteps > 0 ? `${Math.round((summary.completedSteps / summary.totalSteps) * 100)}% complete` : "No steps yet"}
              />
              <StatCard label="Pending" value={String(summary.pendingSteps)} hint={`${summary.attentionCount} need attention`} />
              <StatCard
                label="Runs (7d)"
                value={String(summary.runsLast7Days)}
                hint={summary.avgRunDurationMs === null ? "No finished runs yet" : `avg ${formatElapsed(summary.avgRunDurationMs)}`}
              />
            </dl>
          ) : null}

          {operations !== null && (
            <section id="needs-you" className="scroll-mt-4">
              <h2 className={cn("mb-3 text-base font-semibold", inbox.length > 0 ? "text-warning" : "text-fg")}>
                Needs you · {inbox.length}
              </h2>
              {inbox.length === 0 ? (
                <p className="rounded-panel border border-line bg-surface-1 px-4 py-3 text-sm text-fg-dim">
                  Nothing is waiting on you.
                </p>
              ) : (
                <ul className="grid gap-2 lg:grid-cols-2">
                  {inbox.slice(0, 12).map((entry) => (
                    <li key={entry.item.prompt.id}>
                      <Link
                        href={`/pipeline/open?prompt=${entry.item.prompt.id}&filter=attention`}
                        className="flex items-start gap-3 rounded-panel border border-line bg-surface-1 px-3 py-2.5 transition-colors hover:border-warning/40 hover:bg-surface-2"
                      >
                        <GateGlyph pending className="mt-1.5 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-sm text-fg">
                              {entry.item.prompt.externalKey ?? entry.item.prompt.title}
                            </span>
                            <Badge tone={TONE[entry.item.operationalState]}>{LABEL[entry.item.operationalState]}</Badge>
                          </div>
                          <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-fg-muted">{entry.ask}</p>
                          <div className="mt-0.5 truncate text-xs text-fg-dim">
                            {entry.suite.programName} · {entry.suite.key ?? entry.suite.name}
                          </div>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {inbox.length > 12 && <p className="mt-2 text-xs text-fg-dim">and {inbox.length - 12} more — open a suite to see them all.</p>}
            </section>
          )}

          {dashboard !== null && (
            <section>
              <h2 className="mb-1 text-base font-semibold text-fg">Run throughput</h2>
              <p className="mb-4 text-xs text-fg-dim">Finished pipeline runs per day · last 30 days</p>
              <PipelineThroughputChart days={dashboard.throughput} />
            </section>
          )}

          {dashboard !== null && (
          <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-semibold text-fg">Saved pipelines</h2>
              </div>
  
              {dashboard?.pipelines.length === 0 ? (
                <div className="rounded-panel border border-dashed border-line bg-surface-1 px-6 py-16 text-center">
                  <p className="text-sm text-fg-muted">No pipelines yet.</p>
                  <Button className="mt-4" size="sm" variant="secondary" onClick={() => router.push("/pipeline/new")}>
                    Create your first pipeline
                  </Button>
                </div>
              ) : (
                <ul className="space-y-2">
                  {(dashboard?.pipelines ?? []).map((item) => {
                    const badge = item.pipeline.active ?? item.pipeline.latest;
                    const progress =
                      item.totalSteps > 0 ? `${item.completedSteps}/${item.totalSteps} steps` : `${item.pipeline.stages.length} suites · no steps`;
                    return (
                      <li key={item.pipeline.id}>
                        <Link
                          href={`/pipeline/${item.pipeline.id}`}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-line bg-surface-1 px-4 py-3 transition-colors hover:border-line-strong hover:bg-surface-2"
                        >
                          <div className="min-w-0">
                            <div className="truncate text-base text-fg">{item.pipeline.name}</div>
                            <div className="mt-0.5 text-xs text-fg-dim">
                              {progress}
                              {item.attentionCount > 0 && (
                                <span className="ml-2 text-warning">{item.attentionCount} attention</span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {item.lastRunDurationMs !== null && (
                              <span className="text-xs numeric text-fg-dim">{formatElapsed(item.lastRunDurationMs)}</span>
                            )}
                            {badge !== null && (
                              <Badge tone={PIPELINE_TONE[badge.state]} pulse={badge.state === "PLAYING"}>
                                {PIPELINE_LABEL[badge.state]}
                              </Badge>
                            )}
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          {operations !== null && (
            <section>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-fg">Suites · {operations.suites.length}</h2>
                <label>
                  <span className="sr-only">Search suites</span>
                  <input
                    type="search"
                    value={suiteQuery}
                    onChange={(event) => setSuiteQuery(event.target.value)}
                    placeholder="Search suites…"
                    className="w-56 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-xs text-fg outline-none placeholder:text-fg-dim focus:border-line-strong"
                  />
                </label>
              </div>
              {suites.length === 0 ? (
                <p className="text-sm text-fg-dim">
                  {operations.suites.length === 0 ? "No suites yet. Create programs and suites on the Workspaces page." : `No suites match “${suiteQuery.trim()}”.`}
                </p>
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {suites.map((suite) => {
                    const stations = countStations(suite.prompts);
                    const ratio = stations.total === 0 ? 0 : Math.round((stations.done / stations.total) * 100);
                    const target = suiteHref(suite.id);
                    const verification = suite.latestVerification;
                    return (
                      <li key={suite.id}>
                        <Link
                          href={target.href}
                          className="block rounded-panel border border-line bg-surface-1 p-3 transition-colors hover:border-line-strong hover:bg-surface-2"
                        >
                          <div className="truncate text-xs uppercase tracking-wider text-fg-dim">{suite.programName}</div>
                          <div className="mt-0.5 flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-sm text-fg">
                              {suite.key !== null && <span className="text-fg-muted">{suite.key} · </span>}
                              {suite.name}
                            </span>
                            {suite.attentionCount > 0 && <Badge tone="warning">{suite.attentionCount}</Badge>}
                          </div>
                          <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-3">
                            <div className="h-full rounded-full bg-success" style={{ width: `${ratio}%` }} />
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-fg-dim">
                            <span>{stations.done}/{stations.total} done</span>
                            <span>· {target.via === null ? "no pipeline" : target.via}</span>
                            <span className="ml-auto">
                              {verification === null ? (
                                <Badge tone="neutral">unverified</Badge>
                              ) : (
                                <Badge
                                  tone={
                                    verification.state === "RUNNING"
                                      ? "info"
                                      : verification.verdict === "PASS"
                                        ? "success"
                                        : verification.verdict === "FAIL"
                                          ? "danger"
                                          : "warning"
                                  }
                                  dot
                                  pulse={verification.state === "RUNNING"}
                                >
                                  {verification.state === "RUNNING" ? "verifying" : (verification.verdict ?? verification.state).toLowerCase()}
                                </Badge>
                              )}
                            </span>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
