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
  // Isolating the app's own database traffic answers a question the full
  // transcript buries: did this agent report what it did, and was it accepted?
  // Offered only when there is traffic to isolate, so it is never a dead
  // control on a run that never called.
  const [dbOnly, setDbOnly] = useState(false);
  const dbCount = items.filter((item) => item.kind === "db").length;
  const dbRefused = items.filter((item) => item.kind === "db" && item.outcome === "rejected").length;
  const shown = dbOnly ? items.filter((item) => item.kind === "db") : items;

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
      {dbCount > 0 && (
        <div className="absolute right-3 top-2 z-10">
          <button
            type="button"
            onClick={() => setDbOnly((on) => !on)}
            aria-pressed={dbOnly}
            title="Show only this agent's reads and writes to the console's own database"
            className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
              dbOnly
                ? "border-accent bg-accent/15 text-accent"
                : "border-line bg-bg/80 text-fg-dim hover:text-fg"
            }`}
          >
            database {dbCount}
            {dbRefused > 0 && <span className="ml-1 text-danger">· {dbRefused} refused</span>}
          </button>
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
          shown.map((item) => <LogEntry key={item.id} item={item} streaming={item.id === streamingId} />)
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
