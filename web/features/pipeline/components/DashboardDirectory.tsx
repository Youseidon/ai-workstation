"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { formatElapsed, type PipelineDashboard as DashboardData, type OperationsSnapshot } from "@hydra/shared";
import { Badge } from "@/components/ui/Badge";
import { filterDirectory, pageItems, percentage, pipelineEntries, suiteEntries, type DirectoryFilter } from "../lib/dashboard";
import styles from "./dashboard.module.css";

const COMPACT_QUERY = "(max-width: 600px)";
function subscribeCompact(listener: () => void) {
  const media = window.matchMedia(COMPACT_QUERY);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
const compactSnapshot = () => window.matchMedia(COMPACT_QUERY).matches;
const serverSnapshot = () => false;

export function DashboardPagination({ page, pages, onChange, label }: { page: number; pages: number; onChange(page: number): void; label: string }) {
  if (pages <= 1) return null;
  return (
    <nav className={styles.pagination} aria-label={label}>
      <button type="button" disabled={page === 0} onClick={() => onChange(page - 1)}>Previous</button>
      <span>{page + 1} / {pages}</span>
      <button type="button" disabled={page + 1 === pages} onClick={() => onChange(page + 1)}>Next</button>
    </nav>
  );
}

export function DashboardDirectory({ dashboard, operations }: { dashboard: DashboardData; operations: OperationsSnapshot }) {
  const [view, setView] = useState<"pipelines" | "suites">("pipelines");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DirectoryFilter>("all");
  const [page, setPage] = useState(0);
  const compact = useSyncExternalStore(subscribeCompact, compactSnapshot, serverSnapshot);
  const pageSize = compact ? 3 : 5;
  const pipelines = useMemo(() => pipelineEntries(dashboard.pipelines), [dashboard.pipelines]);
  const suites = useMemo(() => suiteEntries(operations.suites, dashboard.pipelines), [operations.suites, dashboard.pipelines]);
  const entries = view === "pipelines" ? pipelines : suites;
  const filtered = useMemo(() => filterDirectory(entries, query, filter), [entries, query, filter]);
  const result = pageItems(filtered, page, pageSize);

  return (
    <section className={`${styles.panel} ${styles.directory}`} aria-label="Pipeline directory">
      <div className={styles.directoryTop}>
        <div className={styles.viewSwitch} role="group" aria-label="Browse pipelines or suites">
          {(["pipelines", "suites"] as const).map((option) => (
            <button key={option} type="button" aria-pressed={view === option} onClick={() => { setView(option); setPage(0); }}>
              {option === "pipelines" ? "Pipelines" : "Suites"}<span>{option === "pipelines" ? pipelines.length : suites.length}</span>
            </button>
          ))}
        </div>
        <span className={styles.directoryHint}>Attention first</span>
      </div>
      <div className={styles.directoryTools}>
        <label className={styles.search}>
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.7" /><path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
          <span className="sr-only">Search {view}</span>
          <input type="search" value={query} placeholder={`Find a ${view === "pipelines" ? "pipeline" : "suite"}…`} onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
        </label>
        <label className={styles.select}>
          <span className="sr-only">Filter {view}</span>
          <select value={filter} onChange={(event) => { setFilter(event.target.value as DirectoryFilter); setPage(0); }}>
            <option value="all">All statuses</option>
            <option value="running">Running</option>
            <option value="attention">Needs attention</option>
          </select>
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </label>
      </div>
      <div className={styles.columnLabels} aria-hidden="true"><span>{view === "pipelines" ? "Pipeline" : "Suite"}</span><span>Progress</span><span>Status</span></div>
      {filtered.length === 0 ? (
        <div className={styles.directoryEmpty} role="status">
          <span className={styles.emptyGlyph} aria-hidden="true">{entries.length === 0 ? "◇" : "⌕"}</span>
          <h3>{entries.length === 0 ? `No ${view} yet` : `No matching ${view}`}</h3>
          <p>{entries.length === 0 ? view === "pipelines" ? "Create a pipeline to connect your suites and start building." : "Add suites to a program in Workspaces." : "Try another name or status."}</p>
          {entries.length === 0 && view === "suites" && <Link href="/workspaces">Open Workspaces</Link>}
          {entries.length > 0 && <button type="button" onClick={() => { setQuery(""); setFilter("all"); setPage(0); }}>Clear filters</button>}
        </div>
      ) : (
        <ul className={styles.directoryList}>
          {result.items.map((entry) => {
            const ratio = percentage(entry.done, entry.total);
            return (
              <li key={entry.id}>
                <Link href={entry.href} className={styles.directoryRow}>
                  <span className={styles.rowIdentity}>
                    <span className={styles.rowIcon} data-attention={entry.needsAttention} data-running={entry.running} aria-hidden="true">
                      {entry.needsAttention ? "!" : <svg viewBox="0 0 24 24" fill="none"><rect x="3" y="8" width="6" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" /><rect x="15" y="8" width="6" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" /><path d="M9 12h6" stroke="currentColor" strokeWidth="1.5" /></svg>}
                    </span>
                    <span className={styles.rowName}><strong>{entry.name}</strong><span title={entry.context}>{entry.context}</span></span>
                  </span>
                  <span className={styles.rowProgress}>
                    <span><strong>{ratio === null ? "—" : `${ratio}%`}</strong><span>{entry.done}/{entry.total} steps</span></span>
                    <span className={styles.progressTrack} aria-hidden="true"><span style={{ width: `${ratio ?? 0}%` }} /></span>
                  </span>
                  <span className={styles.rowStatus}>
                    <Badge tone={entry.status.tone} dot={entry.running} className="text-sm!">{entry.status.label}</Badge>
                    <span className={entry.attention > 0 ? "text-warning" : "text-fg-dim"}>
                      {entry.attention > 0 ? `${entry.attention} need attention` : entry.durationMs === null ? "" : `Last run ${formatElapsed(entry.durationMs)}`}
                    </span>
                  </span>
                  <span className={styles.openLabel}>Open</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <div className={styles.directoryFooter}>
        <span role="status">{filtered.length === 0 ? "0" : `${result.page * pageSize + 1}–${Math.min((result.page + 1) * pageSize, filtered.length)}`} of {filtered.length} {view}</span>
        <DashboardPagination page={result.page} pages={result.pages} onChange={setPage} label={`${view} pages`} />
      </div>
    </section>
  );
}
