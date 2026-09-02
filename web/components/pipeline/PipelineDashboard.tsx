"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatElapsed, type PipelineDashboard as PipelineDashboardData } from "@agent-console/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Spinner";
import { SERVER_URL } from "@/lib/serverUrl";
import { useAgentConsole } from "@/lib/agentConsole";
import { useWorkspace } from "@/lib/workspaceContext";
import { workspaceApi } from "@/lib/workspacesApi";
import { PageChrome } from "@/components/shell/chrome";
import { PipelineBlockedStations } from "./PipelineBlockedStations";
import { PipelineThroughputChart } from "./PipelineThroughputChart";
import { PIPELINE_LABEL, PIPELINE_TONE } from "./status";

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-panel border border-line bg-surface-1/80 px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-fg-dim">{label}</div>
      <div className="mt-1 text-2xl tracking-tight text-fg numeric">{value}</div>
      {hint !== undefined && <div className="mt-1 text-[11px] text-fg-dim">{hint}</div>}
    </div>
  );
}

export function PipelineDashboard() {
  const console_ = useAgentConsole();
  const { workspaceId, status: workspaceStatus } = useWorkspace();
  const router = useRouter();
  const [dashboard, setDashboard] = useState<PipelineDashboardData | null>(null);
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
      const next = await workspaceApi.pipelineDashboard(SERVER_URL, workspaceId);
      setDashboard(next);
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

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <PageChrome
        title="Pipelines"
        breadcrumb={
          dashboard !== null ? (
            <span className="text-[11px] text-fg-dim">Updated {new Date(dashboard.generatedAt).toLocaleTimeString()}</span>
          ) : undefined
        }
        actions={
          <Button size="sm" variant="primary" disabled={workspaceId === null} onClick={() => router.push("/pipeline/new")}>
            New pipeline
          </Button>
        }
      />

      {error !== null && (
        <div role="alert" className="border-b border-danger/40 bg-danger/10 px-4 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="mx-auto max-w-6xl space-y-8">
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
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
            </section>
          ) : null}

          {dashboard !== null && dashboard.blockedStations.length > 0 && (
            <section>
              <h2 className="mb-3 text-[10px] uppercase tracking-[0.22em] text-warning">Needs attention</h2>
              <PipelineBlockedStations stations={dashboard.blockedStations} />
            </section>
          )}

          {dashboard !== null && (
            <section className="rounded-panel border border-line bg-surface-1/80 p-4">
              <h2 className="mb-1 text-[10px] uppercase tracking-[0.22em] text-fg-dim">Run throughput</h2>
              <p className="mb-4 text-xs text-fg-dim">Finished pipeline runs per day · last 30 days</p>
              <PipelineThroughputChart days={dashboard.throughput} />
            </section>
          )}

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[10px] uppercase tracking-[0.22em] text-fg-dim">Saved pipelines</h2>
              <Button size="sm" variant="ghost" onClick={() => void refresh()} loading={loading && dashboard !== null}>
                Refresh
              </Button>
            </div>

            {dashboard?.pipelines.length === 0 ? (
              <div className="rounded-panel border border-dashed border-line bg-surface-1/60 px-6 py-16 text-center">
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
                        className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-line bg-surface-1/80 px-4 py-3 transition-colors hover:border-line-strong hover:bg-surface-2"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-[15px] text-fg">{item.pipeline.name}</div>
                          <div className="mt-0.5 text-xs text-fg-dim">
                            {progress}
                            {item.attentionCount > 0 && (
                              <span className="ml-2 text-warning">{item.attentionCount} attention</span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {item.lastRunDurationMs !== null && (
                            <span className="text-[11px] numeric text-fg-dim">{formatElapsed(item.lastRunDurationMs)}</span>
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
        </div>
      </div>
    </main>
  );
}
