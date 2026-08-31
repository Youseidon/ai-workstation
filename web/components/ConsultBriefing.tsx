"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/lib/providerTheme";
import type { RunStatus } from "@/lib/agentConsole";
import type { LogItem } from "@/lib/log";
import { LogPanel } from "./LogPanel";
import { Button } from "./ui/Button";

/**
 * Transcript for consult runs. The writer LogPanel never renders these events.
 *
 * Opens while a consult is live, or with the last consult in this workspace
 * after it ends. Multiple live consults are tabs, not stacked transcripts.
 */
export function ConsultBriefing({
  consults,
  lastConsult,
  itemsFor,
  workdir,
  onStop,
}: {
  consults: RunStatus[];
  lastConsult: RunStatus | null;
  itemsFor(runId: string): LogItem[];
  workdir: string | null;
  onStop(runId: string): void;
}) {
  const tabs = consults.length > 0 ? consults : lastConsult !== null ? [lastConsult] : [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const active = tabs.find((tab) => tab.runId === selectedId) ?? tabs[tabs.length - 1] ?? null;

  if (active === null) return null;

  const live = consults.some((run) => run.runId === active.runId);
  const question = active.source.type === "consult" ? active.source.question : null;

  return (
    <section
      aria-label="Consult briefing"
      className="flex h-56 shrink-0 flex-col border-t border-line bg-surface-1"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-fg-dim">Asking</span>
        {tabs.map((tab) => {
          const tabTheme = providerTheme[tab.provider];
          const isActive = tab.runId === active.runId;
          const caption = tab.source.type === "consult" ? tab.source.question : null;
          return (
            <button
              key={tab.runId}
              type="button"
              onClick={() => setSelectedId(tab.runId)}
              title={caption ?? undefined}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] ring-1 ring-inset",
                isActive ? tabTheme.active : "text-fg-muted ring-transparent hover:bg-surface-2",
              )}
            >
              {tab.provider} · asking
            </button>
          );
        })}
        {question !== null && (
          <span className="min-w-0 max-w-[36ch] truncate text-[11px] text-fg-dim" title={question}>
            {question}
          </span>
        )}
        <span className="ml-auto">
          {live ? (
            <Button size="sm" variant="danger" onClick={() => onStop(active.runId)}>
              Stop
            </Button>
          ) : (
            <span className="text-[10px] uppercase tracking-wider text-fg-dim">{active.state}</span>
          )}
        </span>
      </div>
      <LogPanel items={itemsFor(active.runId)} workdir={workdir} />
    </section>
  );
}
