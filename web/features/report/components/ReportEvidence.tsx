import { formatTokens } from "@hydra/shared";
import { ratio, type ReportMeasure } from "../lib/reporting";
import styles from "./report.module.css";

export function ReportEvidence({ measure, unassigned, undated, pricingNote }: { measure: ReportMeasure; unassigned: number; undated: number; pricingNote: string }) {
  const { totals } = measure;
  const unpriced = totals.sessionCount - measure.priced;
  const tokenTotal = totals.inputTokens + totals.outputTokens;
  const uncached = totals.inputTokens - measure.cachedInput;
  return (
    <details className={`${styles.panel} ${styles.evidence}`}>
      <summary className={styles.evidenceSummary}><span id="report-evidence-heading">Behind the numbers</span><span>{measure.priced}/{totals.sessionCount} priced</span><span aria-hidden="true">⌄</span></summary>
      <div className={styles.evidenceContent}>
      <div className={styles.basis}>
        <div className={styles.evidenceLabel}><span>Pricing basis</span><span>{measure.priced}/{totals.sessionCount} priced</span></div>
        <div className={styles.composition} aria-hidden="true"><span className={styles.modelRate} style={{ width: `${ratio(measure.modelRates, totals.sessionCount) ?? 0}%` }} /><span className={styles.defaultRate} style={{ width: `${ratio(measure.defaultRates, totals.sessionCount) ?? 0}%` }} /><span className={styles.unpriced} style={{ width: `${ratio(unpriced, totals.sessionCount) ?? 0}%` }} /></div>
        <div className={styles.basisLegend}><span><i className={styles.modelRate} />Model family<strong>{measure.modelRates}</strong></span><span><i className={styles.defaultRate} />Provider default<strong>{measure.defaultRates}</strong></span><span><i className={styles.unpriced} />Unpriced<strong>{unpriced}</strong></span></div>
      </div>
      <div className={styles.basis}>
        <div className={styles.evidenceLabel}><span>Token composition</span><span>Reported only</span></div>
        <div className={styles.composition} aria-hidden="true"><span className={styles.cachePart} style={{ width: `${ratio(measure.cachedInput, tokenTotal) ?? 0}%` }} /><span className={styles.inputPart} style={{ width: `${ratio(uncached, tokenTotal) ?? 0}%` }} /><span className={styles.outputPart} style={{ width: `${ratio(totals.outputTokens, tokenTotal) ?? 0}%` }} /></div>
        <div className={styles.tokenLegend}><span><i className={styles.cachePart} />Cache <strong>{totals.sessionsWithUsage > 0 ? formatTokens(measure.cachedInput) : "—"}</strong></span><span><i className={styles.inputPart} />Other input <strong>{totals.sessionsWithUsage > 0 ? formatTokens(uncached) : "—"}</strong></span><span><i className={styles.outputPart} />Output <strong>{totals.sessionsWithUsage > 0 ? formatTokens(totals.outputTokens) : "—"}</strong></span></div>
      </div>
      <div className={styles.evidenceNote}>
        <span>{unassigned} unassigned {unassigned === 1 ? "session" : "sessions"}</span>
        {measure.unpricedUsage > 0 && <span className="text-warning">{measure.unpricedUsage} with tokens but no price</span>}
        {undated > 0 && <span className="text-warning">{undated} without a usable chart date</span>}
      </div>
      <details className={styles.methodology}><summary>How these numbers work</summary><div><p>{pricingNote}</p><p>Estimates apply Hydra’s currently configured model-family rates to recorded sessions, including older sessions. This is not a live pricing feed or a historical invoice. Provider defaults are shown separately. Missing usage and unknown prices are excluded from numeric totals.</p><p>Cache reads are already included in input. Reasoning is part of output and is not added again. Sessions are grouped by their UTC start date; a session’s reported usage stays in that bucket.</p><p>Counts include in-progress sessions with the usage available at the snapshot. Exact recorded values and applied rates are available in the CSV export.</p></div></details>
      <p className={styles.proxyNote}>API-rate comparison · not a bill</p>
      </div>
    </details>
  );
}
