"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LogItem } from "@/lib/log";
import { LogEntry } from "./LogEntry";

const BOTTOM_THRESHOLD_PX = 48;

export function LogPanel({ items, workdir }: { items: LogItem[]; workdir: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
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
    <div className="relative min-h-0 flex-1">
      <div ref={containerRef} className="h-full overflow-y-auto px-4 py-4">
        {items.length === 0 ? (
          <div className="text-[#4e5661]">
            <div>multi-agent live console</div>
            <div className="mt-1">
              working directory: <span className="text-[#7d8794]">{workdir ?? "…"}</span>
            </div>
            <div className="mt-3">pick a provider, type a prompt below, and watch it work.</div>
          </div>
        ) : (
          items.map((item) => <LogEntry key={item.id} item={item} />)
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
          className="absolute bottom-4 right-6 rounded-full border border-[#242a33] bg-[#161a20] px-3 py-1.5 text-[11px] text-[#9aa4b1] shadow-lg transition-colors hover:text-[#f0f4f9]"
        >
          ↓ jump to latest
        </button>
      )}
    </div>
  );
}
