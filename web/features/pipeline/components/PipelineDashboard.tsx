"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { OperationsSnapshot, PipelineDashboard as DashboardData } from "@hydra/shared";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Spinner";
import { SERVER_URL } from "@/api/serverUrl";
import { useHydra } from "@/contexts/hydra";
import { useWorkspace } from "@/contexts/workspaceContext";
import { workspaceApi } from "@/api/workspacesApi";
import { ContentTitle } from "@/components/layout/PageCanvas";
import { SidebarCollection, SidebarEmpty, SidebarRow } from "@/components/layout/SidebarCollection";
import { collectInbox } from "../lib/station/inbox";
import { pageItems, pipelineEntries, runOutcomes, type DashboardPeriod } from "../lib/dashboard";
import { DashboardDirectory, DashboardPagination } from "./DashboardDirectory";
import { DashboardMetrics } from "./DashboardMetrics";
import { PipelineThroughputChart } from "./PipelineThroughputChart";
import styles from "./dashboard.module.css";

export function PipelineDashboard() {
  const { workspaceId } = useWorkspace();
  // Switching workspaces also clears filters and prevents the previous request
  // from putting another workspace's records into this dashboard.
  return <WorkspaceDashboard key={workspaceId ?? "none"} workspaceId={workspaceId} />;
}

function WorkspaceDashboard({ workspaceId }: { workspaceId: number | null }) {
  const { operationsRevision } = useHydra();
  const { status: workspaceStatus, error: workspaceError } = useWorkspace();
  const [data, setData] = useState<{ dashboard: DashboardData; operations: OperationsSnapshot } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(workspaceId !== null);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<DashboardPeriod>(7);
  const [queuePage, setQueuePage] = useState(0);
  const [insightsOpen, setInsightsOpen] = useState(() => typeof window !== "undefined" && window.location.hash === "#needs-you");

  useEffect(() => {
    const onHashChange = () => {
      if (window.location.hash !== "#needs-you") return;
      setInsightsOpen(true);
      requestAnimationFrame(() => document.getElementById("needs-you")?.scrollIntoView({ block: "nearest" }));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (data === null || window.location.hash !== "#needs-you") return;
    document.getElementById("needs-you")?.scrollIntoView({ block: "nearest" });
  }, [data]);

  useEffect(() => {
    if (workspaceId === null) return;
    const selectedWorkspaceId = workspaceId;
    let current = true;
    async function load() {
      setLoading(true);
      try {
        const [dashboard, operations] = await Promise.all([
          workspaceApi.pipelineDashboard(SERVER_URL, selectedWorkspaceId),
          workspaceApi.operations(SERVER_URL, selectedWorkspaceId),
        ]);
        if (current) { setData({ dashboard, operations }); setError(null); }
      } catch (err) {
        if (current) setError(err instanceof Error ? err.message : "Could not load pipeline dashboard");
      } finally {
        if (current) setLoading(false);
      }
    }
    void load();
    return () => { current = false; };
  }, [workspaceId, operationsRevision, refreshKey]);

  const inbox = useMemo(() => collectInbox(data?.operations.suites ?? []), [data]);
  const queue = pageItems(inbox, queuePage, 2);
  const outcomes = runOutcomes(data?.dashboard.throughput ?? [], period);
  const sidebarEntries = useMemo(() => pipelineEntries(data?.dashboard.pipelines ?? []), [data]);

  return (
    <div className={styles.dashboard}>
      <ContentTitle
        title="Pipelines"
        meta="Workspace overview"
        actions={workspaceId !== null ? <>
          <Button variant="ghost" loading={loading} onClick={() => setRefreshKey((value) => value + 1)} aria-label="Refresh pipeline dashboard">Refresh</Button>
          <Link href="/pipeline/new" className={styles.createLink}><span aria-hidden="true">＋</span> New pipeline</Link>
        </> : undefined}
      />
      <SidebarCollection label="Pipelines">
        {workspaceId === null ? <SidebarEmpty>Choose a workspace.</SidebarEmpty>
          : data === null ? <SidebarEmpty>{error ?? "Loading pipelines…"}</SidebarEmpty>
          : sidebarEntries.length === 0 ? <SidebarEmpty>No pipelines yet.</SidebarEmpty>
          : sidebarEntries.map((entry) => <SidebarRow key={entry.id} href={entry.href} title={entry.name} detail={`${entry.done}/${entry.total} steps`} status={entry.needsAttention ? "Needs attention" : entry.status.label} statusTone={entry.needsAttention ? "warning" : entry.running ? "accent" : "muted"} />)}
      </SidebarCollection>
      <div className={styles.scroll}>
        {error !== null && <div role="alert" className={styles.error}>{data === null ? error : `Showing the last loaded snapshot. Refresh failed: ${error}`}<button type="button" disabled={loading} onClick={() => setRefreshKey((value) => value + 1)}>Try again</button></div>}
        {workspaceId === null ? (
          <div className={styles.workspaceEmpty} role="status">
            <span className={styles.emptyGlyph} aria-hidden="true">◇</span>
            <h2>{workspaceStatus === "loading" ? "Loading your workspace…" : workspaceStatus === "error" ? "Workspace unavailable" : "Your pipeline overview starts here"}</h2>
            <p>{workspaceStatus === "loading" ? "Preparing your pipelines and activity." : workspaceStatus === "error" ? workspaceError : "Create a workspace, then connect your suites in a pipeline."}</p>
            {workspaceStatus !== "loading" && <Link href="/workspaces" className={styles.createLink}>Open Workspaces</Link>}
          </div>
        ) : data === null ? (
          loading && <div role="status" aria-label="Loading pipeline overview"><div className={styles.metrics}>{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28 w-full" />)}</div><Skeleton className="mt-4 h-96 w-full" /></div>
        ) : (
          <>
            <DashboardMetrics dashboard={data.dashboard} outcomes={outcomes} period={period} />
            <div className={styles.mainGrid}>
              <DashboardDirectory dashboard={data.dashboard} operations={data.operations} />
              <div className={styles.insights}>
                <button className={styles.insightsToggle} type="button" aria-expanded={insightsOpen} aria-controls="pipeline-insights" onClick={() => setInsightsOpen((value) => !value)}>
                  <span>Insights</span><span>{inbox.length > 0 ? `${inbox.length} need you` : "Activity & outcomes"}</span>
                  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d={insightsOpen ? "m4 10 4-4 4 4" : "m4 6 4 4 4-4"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                </button>
                <div id="pipeline-insights" className={styles.insightsContent} data-expanded={insightsOpen}>
                  <section className={`${styles.panel} ${styles.activity}`} aria-labelledby="run-activity-heading">
                    <div className={styles.panelHeader}>
                      <h2 id="run-activity-heading">Run activity</h2>
                      <div className={styles.periodSwitch} role="group" aria-label="Run activity period">
                        {([7, 30] as const).map((value) => <button key={value} type="button" aria-pressed={period === value} onClick={() => setPeriod(value)}>{value}d</button>)}
                      </div>
                    </div>
                    <div className={styles.activityTotal}><strong>{outcomes.total}</strong><span>recorded outcomes<span>By run start date · UTC</span></span></div>
                    <PipelineThroughputChart days={outcomes.days} />
                  </section>
                  <section id="needs-you" className={`${styles.panel} ${styles.attention}`} aria-labelledby="attention-heading">
                    <div className={styles.panelHeader}><h2 id="attention-heading">Needs you <span className={inbox.length > 0 ? styles.attentionCount : styles.clearCount}>{inbox.length}</span></h2><span className={styles.directoryHint}>{inbox.length > 0 ? "Oldest first" : "All clear"}</span></div>
                    {inbox.length === 0 ? <div className={styles.allClear}><span aria-hidden="true">✓</span><p>Nothing waiting on you.</p></div>
                      : <ul className={styles.attentionList}>{queue.items.map((entry) => <li key={entry.item.prompt.id}><Link href={`/pipeline/open?prompt=${entry.item.prompt.id}&filter=attention`}><span className={styles.queueGlyph} aria-hidden="true">!</span><span><strong>{entry.item.prompt.externalKey ?? entry.item.prompt.title}</strong><span className={styles.queueAsk} title={entry.ask}>{entry.ask}</span><span className={styles.queueContext}>{entry.suite.programName} · {entry.suite.key ?? entry.suite.name}</span></span></Link></li>)}</ul>}
                    <DashboardPagination page={queue.page} pages={queue.pages} onChange={setQueuePage} label="Attention queue pages" />
                  </section>
                </div>
              </div>
            </div>
            <div className={styles.snapshot}><span>Workspace snapshot</span><span>Updated {new Date(data.dashboard.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{loading ? " · Updating…" : ""}</span></div>
          </>
        )}
      </div>
    </div>
  );
}
