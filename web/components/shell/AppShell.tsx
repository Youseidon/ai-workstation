"use client";

import type { ReactNode } from "react";
import { AgentDock } from "@/components/AgentDock";
import { ChromeProvider } from "./chrome";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

/**
 * Persistent app chrome: sidebar rail, top bar, and the agent dock under the
 * top bar so every page shares one instance.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ChromeProvider>
      <div className="flex h-dvh bg-surface-0">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          {/* Lives under the top bar so the page bottom stays free for composers. */}
          <AgentDock />
          <div className="min-h-0 flex-1">{children}</div>
        </div>
      </div>
    </ChromeProvider>
  );
}
