"use client";

import { AppNav } from "@/components/AppNav";
import { FleetView } from "@/components/FleetView";

export default function FleetPage() {
  return (
    <main className="flex h-full flex-col bg-surface-0">
      <header className="flex flex-wrap items-center gap-3 border-b border-line bg-surface-1 px-4 py-2.5">
        <h1 className="text-xs uppercase tracking-[0.2em] text-fg-muted">agent console</h1>
        <AppNav active="fleet" />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <FleetView />
      </div>
    </main>
  );
}
