"use client";

import type { ReactNode } from "react";
import { AgentDock } from "@/components/AgentDock";
import { SettingsPanel } from "@/components/SettingsPanel";
import { useAgentConsole } from "@/lib/useAgentConsole";
import { SERVER_URL } from "@/lib/serverUrl";
import { ChromeProvider, useChromeDispatch, useChromeSettingsOpen } from "./chrome";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

/**
 * Persistent app chrome: sidebar rail, top bar, agent dock under the top bar,
 * and a single SettingsPanel owned here so every page shares one instance.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <ChromeProvider>
      <AppShellInner>{children}</AppShellInner>
    </ChromeProvider>
  );
}

function AppShellInner({ children }: { children: ReactNode }) {
  const settingsOpen = useChromeSettingsOpen();
  const { closeSettings } = useChromeDispatch();
  const { runs } = useAgentConsole();

  return (
    <div className="flex h-dvh bg-surface-0">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        {/* Lives under the top bar so the page bottom stays free for composers. */}
        <AgentDock />
        <div className="min-h-0 flex-1">{children}</div>
      </div>
      {settingsOpen && (
        <SettingsPanel
          serverUrl={SERVER_URL}
          onClose={closeSettings}
          runInProgress={runs.length > 0}
        />
      )}
    </div>
  );
}
