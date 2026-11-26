import type { PipelineDashboard as DashboardData } from "@hydra/shared";
import { formatElapsed } from "@hydra/shared";
import { percentage, type DashboardPeriod, type runOutcomes } from "../lib/dashboard";
import styles from "./dashboard.module.css";

function Gauge({ value, tone = "accent", label }: { value: number | null; tone?: "accent" | "success"; label: string }) {
  return (
    <div className={styles.gauge} role="img" aria-label={`${label}: ${value === null ? "no data" : `${value}%`}`}>
      <svg viewBox="0 0 80 80" aria-hidden="true">
        <circle cx="40" cy="40" r="32" fill="none" stroke="var(--surface-3)" strokeWidth="6" />
        <circle cx="40" cy="40" r="32" fill="none" stroke={`var(--${tone})`} strokeWidth="6" pathLength="100" strokeDasharray={`${value ?? 0} 100`} strokeLinecap={value ? "round" : "butt"} transform="rotate(-90 40 40)" />
      </svg>
      <span aria-hidden="true">{value === null ? "—" : <>{value}<small>%</small></>}</span>
    </div>
  );
}

export function DashboardMetrics({ dashboard, outcomes, period }: {
  dashboard: DashboardData;
  outcomes: ReturnType<typeof runOutcomes>;
  period: DashboardPeriod;
}) {
  const { summary } = dashboard;
  const running = dashboard.pipelines.filter((item) => item.pipeline.active?.state === "PLAYING").length;
  const waiting = summary.activePipelineCount - running;
  return (
    <dl className={styles.metrics} aria-label="Pipeline statistics">
      <div className={`${styles.metric} ${styles.metricGauge}`}>
        <div>
          <dt>Step completion</dt>
          <dd>{summary.completedSteps.toLocaleString()}<small> / {summary.totalSteps.toLocaleString()}</small></dd>
          <p>{summary.pendingSteps.toLocaleString()} remaining</p>
        </div>
        <Gauge value={percentage(summary.completedSteps, summary.totalSteps)} label="Step completion" />
      </div>
      <div className={styles.metric}>
        <dt>Active pipelines</dt>
        <dd>{summary.activePipelineCount}<small> / {summary.pipelineCount}</small></dd>
        <p><span className="text-accent">{running} running</span><span className={styles.separator}>·</span>{waiting} paused or waiting</p>
      </div>
      <div className={`${styles.metric} ${styles.metricGauge}`}>
        <div>
          <dt>Run completion <span className={styles.periodLabel}>{period}d</span></dt>
          <dd>{outcomes.complete}<small> / {outcomes.total}</small></dd>
          <p>{outcomes.total === 0 ? "No recorded outcomes" : "Complete / outcomes"}</p>
        </div>
        <Gauge value={outcomes.rate} tone="success" label="Run completion" />
      </div>
      <div className={styles.metric}>
        <dt>Average run</dt>
        <dd>{summary.avgRunDurationMs === null ? "—" : formatElapsed(summary.avgRunDurationMs)}</dd>
        <p>All finished runs · all time</p>
      </div>
    </dl>
  );
}
