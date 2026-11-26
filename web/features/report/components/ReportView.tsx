"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { UsageReport } from "@hydra/shared";
import { ContentTitle } from "@/components/layout/PageCanvas";
import { SidebarCollection, SidebarEmpty, SidebarRow } from "@/components/layout/SidebarCollection";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Spinner";
import { SERVER_URL } from "@/api/serverUrl";
import { workspaceApi } from "@/api/workspacesApi";
import { useHydra } from "@/contexts/hydra";
import { useWorkspace } from "@/contexts/workspaceContext";
import { buildTimeline, measureSessions, providerGroups, reportCsv, selectSessions, type ReportMetric, type ReportPeriod } from "../lib/reporting";
import { ReportSummary } from "./ReportSummary";
import { ProviderMix, ReportTimeline } from "./ReportCharts";
import { ReportEvidence } from "./ReportEvidence";
import { ReportBreakdown } from "./ReportBreakdown";
import styles from "./report.module.css";

export function ReportView() {
  const { workspaceId } = useWorkspace();
  return <WorkspaceReport key={workspaceId ?? "none"} workspaceId={workspaceId} />;
}

function WorkspaceReport({ workspaceId }: { workspaceId: number | null }) {
  const { operationsRevision } = useHydra();
  const { status, error: workspaceError } = useWorkspace();
  const [report, setReport] = useState<UsageReport | null>(null);
  const [period, setPeriod] = useState<ReportPeriod>(30);
  const [provider, setProvider] = useState("all");
  const [metric, setMetric] = useState<ReportMetric>("tokens");
  const [loading, setLoading] = useState(workspaceId !== null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [insightsOpen, setInsightsOpen] = useState(false);

  useEffect(() => {
    if (workspaceId === null) return;
    const selected = workspaceId;
    let current = true;
    async function load() {
      setLoading(true);
      try {
        const next = await workspaceApi.report(SERVER_URL, selected);
        if (current) { setReport(next); setError(null); }
      } catch (err) {
        if (current) setError(err instanceof Error ? err.message : "Report could not be loaded.");
      } finally {
        if (current) setLoading(false);
      }
    }
    void load();
    return () => { current = false; };
  }, [workspaceId, operationsRevision, refreshKey]);

  const sessions = useMemo(() => report === null ? [] : selectSessions(report.sessions, report.generatedAt, period, provider), [report, period, provider]);
  const measure = useMemo(() => measureSessions(sessions), [sessions]);
  const providers = useMemo(() => [...new Set(report?.sessions.map((session) => session.provider) ?? [])].sort(), [report]);
  const mix = useMemo(() => providerGroups(sessions), [sessions]);
  const timeline = useMemo(() => report === null ? null : buildTimeline(sessions, report.generatedAt, period), [sessions, report, period]);
  const unassigned = sessions.filter((session) => session.promptId === null || session.suiteId === null || session.programId === null).length;

  function jump(id: string) {
    if (id === "report-evidence-heading" || id === "report-providers-heading") setInsightsOpen(true);
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "nearest" }));
  }

  function exportCsv() {
    if (report === null || sessions.length === 0) return;
    const url = URL.createObjectURL(new Blob(["\uFEFF", reportCsv(sessions)], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `hydra-usage-${report.generatedAt.slice(0, 10)}-${period === "all" ? "all-time" : `${period}d`}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className={styles.report}>
      <ContentTitle title="Report" meta="Usage & API estimates" actions={workspaceId === null ? undefined : <>
        <div className={styles.periodSwitch} role="group" aria-label="Report time window">{([7, 30, "all"] as const).map((value) => <button key={value} type="button" aria-pressed={period === value} onClick={() => setPeriod(value)}>{value === "all" ? "All time" : `${value}d`}</button>)}</div>
        <label className={styles.select}><span className="sr-only">Report provider</span><select value={provider} onChange={(event) => setProvider(event.target.value)}><option value="all">All providers</option>{providers.map((id) => <option key={id} value={id}>{id}</option>)}</select><span aria-hidden="true">⌄</span></label>
        <Button className={styles.refreshButton} aria-label="Refresh report" variant="ghost" onClick={() => setRefreshKey((value) => value + 1)} loading={loading}><svg className={styles.compactIcon} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19.5 9a8 8 0 1 0 .2 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg><span className={styles.actionText}>Refresh</span></Button>
        <button type="button" className={styles.exportButton} aria-label="Export CSV" disabled={sessions.length === 0} onClick={exportCsv} title="Export all sessions in the selected time window and provider, with exact values"><svg className={styles.compactIcon} viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2" stroke="currentColor" strokeWidth="1.6" /><path d="M4 9h16M4 15h16M10 9v12" stroke="currentColor" strokeWidth="1.6" /></svg><span className={styles.actionText}>Export CSV</span></button>
      </>} />
      <SidebarCollection label="Report sections">
        {workspaceId === null ? <SidebarEmpty>Choose a workspace.</SidebarEmpty> : <>
          <SidebarRow title="Overview" detail={period === "all" ? "All recorded sessions" : `${period} UTC calendar days`} onSelect={() => jump("report-overview")} />
          <SidebarRow title="Usage breakdown" detail="Suites, tasks & sessions" onSelect={() => jump("report-breakdown")} />
          <SidebarRow title="Providers & data quality" detail={report === null ? undefined : `${measure.totals.sessionsWithUsage}/${sessions.length} sessions with usage`} onSelect={() => jump("report-providers-heading")} />
        </>}
      </SidebarCollection>
      <div className={styles.scroll}>
        {error !== null && <div className={styles.error} role="alert"><span>{report === null ? error : `Showing the last loaded snapshot. Refresh failed: ${error}`}</span><button type="button" disabled={loading} onClick={() => setRefreshKey((value) => value + 1)}>Try again</button></div>}
        {workspaceId === null ? <div className={styles.workspaceEmpty} role="status"><span aria-hidden="true">◇</span><h2>{status === "loading" ? "Loading your workspace…" : status === "error" ? "Workspace unavailable" : "Your usage story starts with a workspace"}</h2><p>{status === "error" ? workspaceError : "Session usage and estimates will appear here as your agents work."}</p>{status !== "loading" && <Link href="/workspaces">Open Workspaces</Link>}</div>
          : report === null ? loading && <div role="status" aria-label="Loading usage report"><div className={styles.metrics}>{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28 w-full" />)}</div><Skeleton className="h-96 w-full" /></div>
          : <>
            <div id="report-overview"><ReportSummary measure={measure} /></div>
            <div className={styles.scopeLine}><span>{period === "all" ? "All recorded history" : `${period} UTC calendar days`}<span>·</span>{sessions.length.toLocaleString()} sessions{provider !== "all" ? ` · ${provider}` : ""}</span><span>Recorded usage only · unreported activity excluded from totals</span></div>
            <div className={styles.mainGrid}>
              <div className={styles.mainColumn}>
                {timeline !== null && <ReportTimeline timeline={timeline} metric={metric} onMetric={setMetric} />}
                <ReportBreakdown sessions={sessions} />
              </div>
              <div className={styles.insights}>
                <button type="button" className={styles.insightsToggle} aria-expanded={insightsOpen} aria-controls="report-insights" onClick={() => setInsightsOpen((value) => !value)}><span>Providers & data quality</span><span>{measure.totals.sessionsWithoutUsage > 0 ? `${measure.totals.sessionsWithoutUsage} missing usage` : "View insights"}</span><span aria-hidden="true">{insightsOpen ? "⌃" : "⌄"}</span></button>
                <div id="report-insights" className={styles.insightsContent} data-expanded={insightsOpen}>
                  <ProviderMix groups={mix} measure={measure} metric={metric} />
                  <ReportEvidence measure={measure} unassigned={unassigned} undated={timeline?.undated ?? 0} pricingNote={report.pricingNote} />
                </div>
              </div>
            </div>
            <div className={styles.snapshot}><span>Rates from Hydra’s configured table · not live billing</span><span>Snapshot {new Date(report.generatedAt).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}{loading ? " · Updating…" : ""}</span></div>
          </>}
      </div>
    </div>
  );
}
