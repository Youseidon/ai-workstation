"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LABEL, TONE } from "@/features/pipeline/lib/status";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { GateGlyph } from "./Conversation";
import { collectInbox, type InboxEntry } from "../../lib/station/inbox";

export { collectInbox, type InboxEntry };

export function NeedsYouInbox({
  entries,
  onOpen,
}: {
  entries: InboxEntry[];
  onOpen(entry: InboxEntry): void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const count = entries.length;
  const gates = useMemo(() => entries.filter((entry) => entry.item.humanIntervention?.status === "PENDING").length, [entries]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn(
          "flex h-8 items-center gap-2 rounded-full px-3 text-xs ring-1 ring-inset transition-colors",
          count > 0
            ? "bg-warning/12 text-warning ring-warning/40 hover:bg-warning/18"
            : "text-fg-dim ring-line hover:bg-surface-2 hover:text-fg",
        )}
        title={count === 0 ? "Nothing is waiting on you" : `${count} item${count === 1 ? "" : "s"} waiting on you`}
      >
        {count > 0 ? <GateGlyph pending className={gates > 0 ? "animate-pulse" : undefined} /> : <span aria-hidden>✓</span>}
        <span className="numeric">{count}</span>
        <span>{count === 1 ? "needs you" : "need you"}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Waiting on you"
          className="absolute right-0 top-full z-40 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-panel border border-line bg-surface-1 shadow-2xl"
        >
          <div className="border-b border-line px-3 py-2 text-xs uppercase tracking-[0.16em] text-fg-dim">
            Waiting on you · oldest first
          </div>
          {count === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-fg-dim">Nothing is waiting on you.</p>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {entries.map((entry) => (
                <li key={entry.item.prompt.id} className="border-b border-line/70 last:border-b-0">
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onOpen(entry);
                    }}
                    className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
                  >
                    <GateGlyph pending className="mt-1 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm text-fg">
                          {entry.item.prompt.externalKey ?? entry.item.prompt.title}
                        </span>
                        <Badge tone={TONE[entry.item.operationalState]}>{LABEL[entry.item.operationalState]}</Badge>
                      </span>
                      <span className="mt-0.5 block line-clamp-2 text-xs leading-4 text-fg-muted">{entry.ask}</span>
                      <span className="mt-0.5 block truncate text-xs text-fg-dim">
                        {entry.suite.key ?? entry.suite.name} · waiting since {since(entry.item.lastActivityAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function since(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
