import { formatTokens, formatUsd, isProviderId } from "@hydra/shared";
import { providerTheme } from "@/features/providers/lib/providerTheme";
import { metricValue, percentLabel, ratio, type ReportGroup, type ReportMeasure, type ReportMetric, type buildTimeline } from "../lib/reporting";
import styles from "./report.module.css";

function reportDay(date: string, includeYear = false): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: includeYear ? "numeric" : undefined, timeZone: "UTC" });
}

function valueLabel(value: number | null, metric: ReportMetric) {
  return value === null ? "—" : metric === "tokens" ? formatTokens(value) : formatUsd(value);
}

export function ReportTimeline({ timeline, metric, onMetric }: {
  timeline: ReturnType<typeof buildTimeline>;
  metric: ReportMetric;
  onMetric(metric: ReportMetric): void;
}) {
  const { buckets, bucketDays } = timeline;
  const values = buckets.map((bucket) => metricValue(bucket.measure, metric));
  const peak = Math.max(...values.map((value) => value ?? 0), 0);
  const magnitude = peak > 0 ? 10 ** Math.floor(Math.log10(peak)) : 1;
  const max = Math.max(magnitude, Math.ceil(peak / magnitude) * magnitude);
  const observed = buckets.some((bucket) => metric === "tokens" ? bucket.measure.totals.sessionsWithUsage > 0 : bucket.measure.priced > 0);
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  const crossesYear = first?.start.slice(0, 4) !== last?.end.slice(0, 4);
  const axisLabel = (value: number) => metric === "cost" && value > 0 && value < 0.01 ? `$${value.toPrecision(2)}` : valueLabel(value, metric);
  return (
    <section className={`${styles.panel} ${styles.timeline}`} aria-labelledby="report-timeline-heading">
      <div className={styles.panelHeader}>
        <div><h2 id="report-timeline-heading">Usage over time</h2><p>{bucketDays === 1 ? "Daily" : `${bucketDays}-day buckets`} · session start date · UTC</p></div>
        <div className={styles.metricSwitch} role="group" aria-label="Chart metric">
          <button type="button" aria-pressed={metric === "tokens"} onClick={() => onMetric("tokens")}>Tokens</button>
          <button type="button" aria-pressed={metric === "cost"} onClick={() => onMetric("cost")}>API estimate</button>
        </div>
      </div>
      <div className={styles.plot}>
        <div className={styles.axis} aria-hidden="true"><span>{observed ? axisLabel(max) : ""}</span><span>{observed ? axisLabel(max / 2) : ""}</span><span>{observed ? "0" : ""}</span></div>
        <div className={styles.bars} role="img" aria-label={`${metric === "tokens" ? "Reported tokens" : "Known API cost estimates"} by UTC session start date. Missing telemetry is marked separately.`}>
          {buckets.map((bucket, i) => {
            const value = values[i] ?? null;
            const missing = metric === "tokens" ? bucket.measure.totals.sessionsWithoutUsage : bucket.measure.totals.sessionCount - bucket.measure.priced;
            const label = `${reportDay(bucket.start, true)}${bucket.end === bucket.start ? "" : ` – ${reportDay(bucket.end, true)}`}`;
            return <div key={bucket.start} className={styles.barColumn} title={`${label}: ${value === null && bucket.measure.totals.sessionCount === 0 ? "no sessions" : valueLabel(value, metric)} · ${bucket.measure.totals.sessionCount} sessions · ${missing} without ${metric === "tokens" ? "usage" : "pricing"}`}>
              {value !== null && value > 0 && <span className={styles.dataBar} data-metric={metric} style={{ height: `${value / max * 100}%` }} />}
              {missing > 0 ? <span className={styles.missingMarker} /> : (value === null || value === 0) && <span className={styles.zeroMarker} />}
            </div>;
          })}
        </div>
        {!observed && <div className={styles.plotEmpty}>No {metric === "tokens" ? "reported token usage" : "priced usage"} in this selection</div>}
      </div>
      <div className={styles.plotDates} aria-hidden="true"><span>{first === undefined ? "" : reportDay(first.start, crossesYear)}</span><span>{last === undefined ? "" : reportDay(last.end, crossesYear)}</span></div>
      <div className={styles.chartFooter}><span className={styles.chartKey}><i data-metric={metric} />{metric === "tokens" ? "Reported tokens" : "Known estimate"}</span><span className={styles.chartKey}><i className={styles.missingKey} />Missing data</span>
        <details className={styles.dailyValues}><summary>View values</summary><div><table><caption className="sr-only">Exact recorded values by UTC start date</caption><thead><tr><th>UTC date range</th><th>Tokens</th><th>API estimate (USD)</th><th>Sessions with usage</th></tr></thead><tbody>{buckets.map((bucket) => <tr key={bucket.start}><td>{bucket.start}{bucket.end !== bucket.start ? ` – ${bucket.end}` : ""}</td><td>{bucket.measure.totals.sessionsWithUsage > 0 ? bucket.measure.totals.totalTokens.toLocaleString() : bucket.measure.totals.sessionCount > 0 ? "Unknown" : "No sessions"}</td><td>{bucket.measure.priced > 0 ? String(bucket.measure.totals.estimatedUsd) : bucket.measure.totals.sessionCount > 0 ? "Unknown" : "No sessions"}</td><td>{bucket.measure.totals.sessionsWithUsage}/{bucket.measure.totals.sessionCount}</td></tr>)}</tbody></table></div></details>
      </div>
    </section>
  );
}

export function ProviderMix({ groups, measure, metric }: { groups: ReportGroup[]; measure: ReportMeasure; metric: ReportMetric }) {
  const total = metricValue(measure, metric);
  const ranked = [...groups].sort((a, b) => (metricValue(b.measure, metric) ?? -1) - (metricValue(a.measure, metric) ?? -1));
  return (
    <section className={`${styles.panel} ${styles.providerPanel}`} aria-labelledby="report-providers-heading">
      <div className={styles.panelHeader}><div><h2 id="report-providers-heading">Provider mix</h2><p>{metric === "tokens" ? "Share of reported tokens" : "Share of known API estimate"}</p></div><span className={styles.smallCount}>{groups.length}</span></div>
      {ranked.length === 0 ? <p className={styles.smallEmpty}>Providers appear after your first session.</p> : <ul className={styles.providers}>{ranked.map((group) => {
        const value = metricValue(group.measure, metric);
        const share = value === null || total === null ? null : ratio(value, total);
        const color = isProviderId(group.id) ? providerTheme[group.id].cssVar : "var(--fg-muted)";
        return <li key={group.id}><div className={styles.providerLine}><span className={styles.providerName}><i style={{ background: color }} />{group.name}<small title={`${group.measure.totals.sessionsWithUsage} of ${group.measure.totals.sessionCount} sessions with token usage`}>{group.measure.totals.sessionsWithUsage}/{group.measure.totals.sessionCount}</small></span><span title={value === null ? "No data" : `${value} ${metric === "cost" ? "USD" : "tokens"}`}>{valueLabel(value, metric)}<small>{percentLabel(share)}</small></span></div><div className={styles.providerTrack} aria-hidden="true"><span style={{ width: `${share ?? 0}%`, background: color }} /></div></li>;
      })}</ul>}
      {ranked.length > 0 && <p className={styles.providerCoverageNote}>Counts show sessions with token data / total.</p>}
    </section>
  );
}
