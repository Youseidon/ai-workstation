"use client";

import type { ReactNode } from "react";
import type { PipelinePolicy, PipelineRunDetail } from "@hydra/shared";
import { PipelineArchive } from "./PipelineArchive";
import { RightNowSummary } from "./PipelineInspector";
import { STUDIO_ICONS, STUDIO_SECTIONS, type StudioSection } from "./PipelineStudio";
import type { PipelineStatusView } from "../lib/status";

/**
 * The drawer's pipeline view: what is happening, the last few runs, and a
 * launcher into the studio for everything else. No tab strip — one scroll.
 */
export function PipelineOverviewPanel({
  saved,
  status,
  policy,
  stationLabel,
  runs,
  selectedRunId,
  onSelectRun,
  onOpenStudio,
  onFind,
  onEditStation,
  unavailable,
  badges,
}: {
  saved: boolean;
  status: PipelineStatusView;
  policy: PipelinePolicy;
  stationLabel: string | null;
  runs: PipelineRunDetail[];
  selectedRunId: string | null;
  onSelectRun(id: string): void;
  onOpenStudio(section: StudioSection): void;
  onFind(): void;
  onEditStation?(): void;
  unavailable: Partial<Record<StudioSection, string>>;
  badges: Partial<Record<StudioSection, ReactNode>>;
}) {
  return (
    <div className="h-full space-y-5 overflow-y-auto p-4">
      <button type="button" className="overview-find" onClick={onFind}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" /><path d="m16 16 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        <span className="flex-1 text-left">Find a step, setting or action…</span>
        <kbd>⌘K</kbd>
      </button>

      {saved && <RightNowSummary status={status} station={stationLabel} policy={policy} onEditStation={onEditStation} onEditPolicy={() => onOpenStudio("policy")} />}

      <section className="space-y-2">
        <h3 className="overview-heading">Studio · configure &amp; review</h3>
        <div className="overview-launcher">
          {STUDIO_SECTIONS.map((entry) => {
            const blocked = unavailable[entry.id];
            return (
              <button key={entry.id} type="button" className="overview-tile" disabled={blocked !== undefined} title={blocked ?? entry.blurb} onClick={() => onOpenStudio(entry.id)}>
                <span className="overview-tile-icon" aria-hidden>{STUDIO_ICONS[entry.id]}</span>
                <span className="overview-tile-label">{entry.label}</span>
                {badges[entry.id] !== undefined && <span className="overview-tile-badge">{badges[entry.id]}</span>}
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="overview-heading">Recent runs</h3>
          {runs.length > 4 && <button type="button" className="text-xs text-accent hover:underline" onClick={() => onOpenStudio("history")}>All {runs.length} runs ›</button>}
        </div>
        {saved
          ? <PipelineArchive runs={runs.slice(0, 4)} selectedId={selectedRunId} onSelect={onSelectRun} />
          : <p className="text-xs leading-relaxed text-fg-dim">Save a pipeline to keep a history of every run.</p>}
      </section>
    </div>
  );
}
