import { formatTokens } from "@hydra/shared";
import { estimateLabel, percentLabel, ratio, type ReportMeasure } from "../lib/reporting";
import styles from "./report.module.css";

function CoverageRing({ value, label, tone }: { value: number | null; label: string; tone: string }) {
  return (
    <div className={styles.ring} role="img" aria-label={`${label}: ${percentLabel(value)}`}>
      <svg viewBox="0 0 72 72" aria-hidden="true">
        <circle cx="36" cy="36" r="29" fill="none" stroke="var(--surface-3)" strokeWidth="5" />
        <circle cx="36" cy="36" r="29" fill="none" stroke={`var(--${tone})`} strokeWidth="5" pathLength="100" strokeDasharray={`${value ?? 0} 100`} strokeLinecap={value ? "round" : "butt"} transform="rotate(-90 36 36)" />
      </svg>
      <span aria-hidden="true">{percentLabel(value)}</span>
    </div>
  );
}

export function ReportSummary({ measure }: { measure: ReportMeasure }) {
  const { totals } = measure;
  const coverage = ratio(totals.sessionsWithUsage, totals.sessionCount);
  const cached = ratio(measure.cachedInput, totals.inputTokens);
  return (
    <dl className={styles.metrics} aria-label="Usage summary">
      <div className={`${styles.metric} ${styles.estimateMetric}`}>
        <dt>API cost estimate {measure.priced > 0 && measure.priced < totals.sessionCount && <span className={styles.partial}>Partial</span>}</dt>
        <dd>{estimateLabel(measure)}</dd>
        <p>{measure.priced > 0 ? `${measure.priced} of ${totals.sessionCount} sessions priced` : "No priced usage in this selection"}</p>
      </div>
      <div className={styles.metric}>
        <dt>Reported tokens</dt>
        <dd title={totals.sessionsWithUsage > 0 ? totals.totalTokens.toLocaleString() : undefined}>{totals.sessionsWithUsage > 0 ? formatTokens(totals.totalTokens) : "—"}</dd>
        <p>{totals.sessionsWithUsage > 0 ? `${formatTokens(totals.inputTokens)} input · ${formatTokens(totals.outputTokens)} output` : "Awaiting provider telemetry"}</p>
      </div>
      <div className={`${styles.metric} ${styles.ringMetric}`}>
        <div><dt>Usage coverage</dt><dd>{totals.sessionsWithUsage}<small> / {totals.sessionCount}</small></dd><p>{totals.sessionCount === 0 ? "No sessions in this selection" : totals.sessionsWithoutUsage > 0 ? `${totals.sessionsWithoutUsage} without token data` : "Every session has token data"}</p></div>
        <CoverageRing value={coverage} label="Sessions with token data" tone={totals.sessionsWithoutUsage > 0 ? "warning" : "success"} />
      </div>
      <div className={`${styles.metric} ${styles.ringMetric}`}>
        <div><dt>Reported cache share</dt><dd title={measure.cachedInput.toLocaleString()}>{totals.sessionsWithUsage > 0 ? formatTokens(measure.cachedInput) : "—"}</dd><p>Cache reads · part of input</p></div>
        <CoverageRing value={cached} label="Cache reads as a share of reported input" tone="violet" />
      </div>
    </dl>
  );
}
