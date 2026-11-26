"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/features/providers/lib/providerTheme";
import type { RunStatus } from "@/models/runs";
import type { LogItem } from "@/features/runs/lib/log";
import { LogPanel } from "../../runs/components/LogPanel";
import { Button } from "../../../components/ui/Button";

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
  const [expanded, setExpanded] = useState(true);
  const active = tabs.find((tab) => tab.runId === selectedId) ?? tabs[tabs.length - 1] ?? null;

  if (active === null) return null;

  const live = consults.some((run) => run.runId === active.runId);
  const question = active.source.type === "consult" ? active.source.question : null;

  return (
    <section
      aria-label="Consult briefing"
      className="flex shrink-0 flex-col border border-line bg-surface-1 shadow-sm"
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-left"
      >
        <span aria-hidden className="text-xs text-fg-dim">{expanded ? "▾" : "▸"}</span>
        <span className="text-xs uppercase tracking-wider text-fg-dim">Asking</span>
        {tabs.map((tab) => {
          const tabTheme = providerTheme[tab.provider];
          const isActive = tab.runId === active.runId;
          return (
            <span
              key={tab.runId}
              role="presentation"
              onClick={(event) => {
                event.stopPropagation();
                setSelectedId(tab.runId);
                setExpanded(true);
              }}
              className={cn(
                "rounded-full px-2 py-0.5 text-xs ring-1 ring-inset",
                isActive ? tabTheme.active : "text-fg-muted ring-transparent",
              )}
            >
              {tab.provider}
            </span>
          );
        })}
        {question !== null && (
          <span className="min-w-0 max-w-[36ch] truncate text-xs text-fg-dim" title={question}>
            {question}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {live ? (
            <Button
              size="sm"
              variant="danger"
              onClick={(event) => {
                event.stopPropagation();
                onStop(active.runId);
              }}
            >
              Stop
            </Button>
          ) : (
            <span className="text-xs uppercase tracking-wider text-fg-dim">{active.state}</span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="flex h-48 flex-col border-t border-line">
          <LogPanel items={itemsFor(active.runId)} workdir={workdir} />
        </div>
      )}
    </section>
  );
}
