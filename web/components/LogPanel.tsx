"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LogItem } from "@/lib/log";
import { useAgentConsole } from "@/lib/agentConsole";
import { LogEntry } from "./LogEntry";

const BOTTOM_THRESHOLD_PX = 48;

export function LogPanel({ items, workdir }: { items: LogItem[]; workdir: string | null }) {
  const { runs } = useAgentConsole();
  const containerRef = useRef<HTMLDivElement>(null);
  // The final line of a run that is still going is the one being typed. A
  // persisted transcript has no live run, so nothing blinks there.
  const last = items[items.length - 1];
  const streamingId =
    last !== undefined && runs.some((run) => run.runId === last.runId) ? last.id : null;
  // Auto-scroll is "pinned to bottom": scrolling up detaches, scrolling back
  // down re-attaches. Nothing yanks the view while the user is reading.
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const onScroll = () => {
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      setPinned(distance <= BOTTOM_THRESHOLD_PX);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (!pinned) return;
    const container = containerRef.current;
    if (container === null) return;
    container.scrollTop = container.scrollHeight;
  }, [items, pinned]);

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {/* A live run gets a moving hairline, so an idle-looking transcript that
          is actually still receiving events cannot be mistaken for finished. */}
      {streamingId !== null && (
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-10 h-px overflow-hidden">
          <div className="h-px w-1/3 animate-[ac-sweep_1.8s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-accent to-transparent" />
        </div>
      )}
      <div ref={containerRef} className="h-full min-h-0 overflow-y-auto overscroll-contain px-4 py-4">
        {items.length === 0 ? (
          <div className="text-fg-dim">
            <div>multi-agent live console</div>
            <div className="mt-1">
              working directory: <span className="text-fg-muted">{workdir ?? "…"}</span>
            </div>
            <div className="mt-3">pick a provider, type a prompt below, and watch it work.</div>
          </div>
        ) : (
          items.map((item) => <LogEntry key={item.id} item={item} streaming={item.id === streamingId} />)
        )}
        <div className="h-2" />
      </div>

      {!pinned && (
        <button
          type="button"
          onClick={() => {
            setPinned(true);
            const container = containerRef.current;
            if (container !== null) container.scrollTop = container.scrollHeight;
          }}
          className="absolute bottom-4 right-6 rounded-full border border-line bg-surface-2 px-3 py-1.5 text-[11px] text-fg-muted shadow-lg transition-colors hover:text-fg"
        >
          ↓ jump to latest
        </button>
      )}
    </div>
  );
}
