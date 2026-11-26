import type { PipelineThroughputDay } from "@hydra/shared";
import styles from "./dashboard.module.css";

function formatDay(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export function PipelineThroughputChart({ days }: { days: PipelineThroughputDay[] }) {
  const max = Math.max(2, Math.ceil(Math.max(...days.map((day) => day.total), 0) / 2) * 2);
  const total = days.reduce((sum, day) => sum + day.total, 0);
  const first = days[0];
  const last = days[days.length - 1];
  return (
    <div className={styles.throughput}>
      <div className={styles.chartArea}>
        <div className={styles.chartGrid} aria-hidden="true"><span>{max}</span><span>{Math.round(max / 2)}</span><span>0</span></div>
        <div className={styles.chartBars} role="img" aria-label={`${total} recorded run outcomes across ${days.length} UTC days. ${days.reduce((sum, day) => sum + day.complete, 0)} complete; ${days.reduce((sum, day) => sum + day.stopped, 0)} stopped or interrupted.`}>
          {days.map((day) => (
            <div key={day.date} className={styles.chartColumn}>
              <div className={styles.chartBar} title={`${formatDay(day.date)} (UTC): ${day.complete} complete, ${day.stopped} stopped or interrupted`}>
                <span className={styles.stoppedBar} style={{ height: `${(day.stopped / max) * 100}%` }} />
                <span className={styles.completeBar} style={{ height: `${(day.complete / max) * 100}%` }} />
                {day.total === 0 && <span className={styles.zeroBar} />}
              </div>
            </div>
          ))}
        </div>
        {total === 0 && <span className={styles.chartEmpty}>Run history will appear here</span>}
      </div>
      <div className={styles.chartDates} aria-hidden="true"><span>{first === undefined ? "" : formatDay(first.date)}</span><span>{last === undefined ? "" : formatDay(last.date)}</span></div>
      <div className={styles.chartLegend}><span><i className={styles.completeBar} />Complete</span><span><i className={styles.stoppedBar} />Stopped / interrupted</span></div>
      {total > 0 && <details className={styles.chartDetails}><summary>Daily values</summary><div><table><caption className="sr-only">Run outcomes by start date (UTC)</caption><thead><tr><th>Date (UTC)</th><th>Complete</th><th>Stopped / interrupted</th></tr></thead><tbody>{days.map((day) => <tr key={day.date}><td>{formatDay(day.date)}</td><td>{day.complete}</td><td>{day.stopped}</td></tr>)}</tbody></table></div></details>}
    </div>
  );
}
