"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { formatTokens, type SessionUsageRow } from "@hydra/shared";
import { breakdownGroups, estimateLabel, filterBreakdown, type BreakdownSort, type BreakdownView, type ReportGroup } from "../lib/reporting";
import styles from "./report.module.css";

function sessionDay(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) : "Unknown date";
}

export function ReportBreakdown({ sessions }: { sessions: SessionUsageRow[] }) {
  const [view, setView] = useState<BreakdownView>("suites");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<BreakdownSort>("cost");
  const [page, setPage] = useState(0);
  const [scope, setScope] = useState<{ view: BreakdownView; id: string; name: string } | null>(null);
  const pageSize = 3;
  const groups = useMemo(() => {
    const scoped = scope === null ? sessions : breakdownGroups(sessions, scope.view).find((group) => group.id === scope.id)?.sessions ?? [];
    return filterBreakdown(breakdownGroups(scoped, view), query, sort);
  }, [sessions, scope, view, query, sort]);
  const pages = Math.max(1, Math.ceil(groups.length / pageSize));
  const current = Math.min(page, pages - 1);
  const rows = groups.slice(current * pageSize, (current + 1) * pageSize);
  const drill = (group: ReportGroup) => { setScope({ view, id: group.id, name: group.name }); setView("sessions"); setPage(0); setQuery(""); };
  return (
    <section id="report-breakdown" className={`${styles.panel} ${styles.breakdown}`} aria-label="Usage breakdown">
      <div className={styles.breakdownHeader}>
        <div className={styles.viewSwitch} role="group" aria-label="Breakdown by">{(["suites", "tasks", "sessions"] as const).map((option) => <button key={option} type="button" aria-pressed={view === option} onClick={() => { setView(option); setScope(null); setPage(0); setQuery(""); }}>{option}</button>)}</div>
        <span className={styles.secondary}>Usage breakdown</span>
      </div>
      <div className={styles.tableTools}>
        <label className={styles.search}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.6" /><path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg><span className="sr-only">Search {view}</span><input type="search" placeholder={`Search ${view}…`} value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} /></label>
        <label className={styles.select}><span className="sr-only">Sort breakdown</span><select value={sort} onChange={(event) => { setSort(event.target.value as BreakdownSort); setPage(0); }}><option value="cost">Highest estimate</option><option value="tokens">Most tokens</option><option value="recent">Most recent</option></select><span aria-hidden="true">⌄</span></label>
      </div>
      {scope !== null && <div className={styles.scope}><span>Sessions · {scope.name}</span><button type="button" onClick={() => { setScope(null); setPage(0); }} aria-label="Clear session scope">Clear</button></div>}
      <div className={styles.tableHead} aria-hidden="true"><span>{view === "suites" ? "Suite" : view === "tasks" ? "Task" : "Session"}</span><span>Tokens</span><span>API estimate</span><span>{view === "sessions" ? "State / UTC" : "Sessions"}</span></div>
      {rows.length === 0 ? <div className={styles.tableEmpty} role="status"><span aria-hidden="true">◇</span><h3>{sessions.length === 0 ? "No sessions in this selection" : "No matching records"}</h3><p>{sessions.length === 0 ? "Change the time window or provider to explore other activity." : "Try another search, or clear the session scope."}</p>{(query !== "" || scope !== null) && <button type="button" onClick={() => { setQuery(""); setScope(null); setPage(0); }}>Clear filters</button>}</div>
        : <ul className={styles.tableRows}>{rows.map((group) => {
          const totals = group.measure.totals;
          const name = <><strong>{group.name}</strong><span title={group.context}>{group.context}</span></>;
          return <li key={group.id} className={styles.tableRow}>
            {group.href !== null ? <Link href={group.href} className={styles.workName}>{name}</Link> : <button type="button" className={styles.workName} onClick={() => drill(group)}>{name}</button>}
            <div className={styles.tableNumber}><strong title={totals.sessionsWithUsage > 0 ? totals.totalTokens.toLocaleString() : "Not reported"}>{totals.sessionsWithUsage > 0 ? formatTokens(totals.totalTokens) : "—"}</strong><span>{totals.sessionsWithoutUsage > 0 ? `${totals.sessionsWithoutUsage} missing usage` : "Reported"}</span></div>
            <div className={styles.tableNumber}><strong title={group.measure.priced > 0 ? `${totals.estimatedUsd} USD · API-rate estimate` : "No priced usage"}>{estimateLabel(group.measure)}</strong><span>{group.measure.priced === 0 ? "Unpriced" : group.measure.priced < totals.sessionCount ? `${group.measure.priced}/${totals.sessionCount} priced` : group.measure.defaultRates > 0 ? "Includes default rate" : "Model-family rate"}</span></div>
            <div className={styles.sessionCount}>{view === "sessions" ? <><span>{group.sessions[0]?.state ?? ""}</span><small title={group.latest}>{sessionDay(group.latest)}</small></> : <button type="button" onClick={() => drill(group)} aria-label={`View ${totals.sessionCount} sessions for ${group.name}`}>{totals.sessionCount}<small>View sessions</small></button>}</div>
          </li>;
        })}</ul>}
      <div className={styles.tableFooter}><span role="status">{groups.length === 0 ? "0" : `${current * pageSize + 1}–${Math.min((current + 1) * pageSize, groups.length)}`} of {groups.length} {view === "sessions" ? "sessions" : "groups"}</span>{pages > 1 && <nav className={styles.pagination} aria-label="Usage breakdown pages"><button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</button><span>{current + 1} / {pages}</span><button type="button" disabled={current + 1 === pages} onClick={() => setPage(current + 1)}>Next</button></nav>}</div>
    </section>
  );
}
