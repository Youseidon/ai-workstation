"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RunSource } from "@agent-console/shared";
import Link from "next/link";
import { ChatWorkspace } from "@/components/chat/ChatWorkspace";
import { PageChrome } from "@/components/shell/chrome";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useAgentConsole } from "@/lib/useAgentConsole";
import { useWorkspace } from "@/lib/workspaceContext";

function readPromptId(): number | null {
  if (typeof window === "undefined") return null;
  const requested = Number(new URLSearchParams(window.location.search).get("prompt"));
  return Number.isSafeInteger(requested) && requested > 0 ? requested : null;
}

interface WorkTab {
  id: string;
  workspaceId: number;
  title: string | null;
}

function runTitle(input: string): string {
  const compact = input.replace(/\s+/g, " ").trim();
  if (compact.length <= 52) return compact;
  return `${compact.slice(0, 49).trimEnd()}…`;
}

function sourceTitle(source: RunSource): string {
  switch (source.type) {
    case "custom": return source.displayText;
    case "saved": return source.title;
    case "consult": return source.title ?? source.question;
    case "clarification": return source.title;
    case "verification": return source.promptKey ?? source.suiteName;
    case "audit": return source.title;
    case "wrapup": return source.title;
    case "author": return source.programName ?? source.goal;
    case "instructions": return source.goal;
  }
}

export default function Page() {
  const console_ = useAgentConsole();
  const { workspaces, workspaceId, status, error, setWorkspaceId, refresh } = useWorkspace();
  const [tabs, setTabs] = useState<WorkTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deepLinkedPrompt] = useState(readPromptId);
  const [deepLinkTabId, setDeepLinkTabId] = useState<string | null>(null);
  const nextTabNumber = useRef(1);

  // On Chat, the app-wide workspace picker opens or focuses the workspace's tab.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- synchronize the external workspace context into Chat's tab set */
    if (workspaceId === null) return;
    const activeTab = tabs.find((tab) => tab.id === activeId);
    if (activeTab?.workspaceId === workspaceId) return;
    const existing = [...tabs].reverse().find((tab) => tab.workspaceId === workspaceId);
    if (existing !== undefined) {
      setActiveId(existing.id);
      return;
    }
    const id = `work-${nextTabNumber.current++}`;
    setTabs((current) => [...current, { id, workspaceId, title: null }]);
    setActiveId(id);
    if (deepLinkedPrompt !== null) setDeepLinkTabId((current) => current ?? id);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [workspaceId, deepLinkedPrompt, tabs, activeId]);

  // A workspace can be deleted from another page or browser window.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- reconcile tabs after an external workspace deletion */
    if (status !== "ready") return;
    const available = new Set(workspaces.map((workspace) => workspace.id));
    setTabs((current) => current.filter((tab) => available.has(tab.workspaceId)));
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [status, workspaces]);

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? null;
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeTab?.workspaceId) ?? null;
  const activeItems = activeId === null ? [] : console_.itemsForTab(activeId);
  const tabWorkspaces = useMemo(
    () => tabs.flatMap((tab) => {
      const workspace = workspaces.find((item) => item.id === tab.workspaceId);
      return workspace === undefined ? [] : [{ tab, workspace }];
    }),
    [tabs, workspaces],
  );

  const selectTab = (tab: WorkTab) => {
    setActiveId(tab.id);
    setWorkspaceId(tab.workspaceId);
    setPickerOpen(false);
  };

  const openTab = (workspaceIdToOpen: number) => {
    const tab = { id: `work-${nextTabNumber.current++}`, workspaceId: workspaceIdToOpen, title: null };
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
    setWorkspaceId(workspaceIdToOpen);
    setPickerOpen(false);
  };

  const titleTab = (id: string, title: string) => {
    const nextTitle = runTitle(title);
    if (nextTitle === "") return;
    setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, title: nextTitle } : tab));
  };

  const closeTab = (id: string) => {
    if (tabs.length <= 1) return;
    if (console_.runs.some((run) => console_.runTabIds[run.runId] === id)) return;
    if (console_.pendingLaunches.some((launch) => launch.tabId === id)) return;
    const index = tabs.findIndex((tab) => tab.id === id);
    const nextTabs = tabs.filter((tab) => tab.id !== id);
    setTabs(nextTabs);
    if (activeId !== id) return;
    selectTab(nextTabs[Math.min(index, nextTabs.length - 1)]!);
  };

  return (
    <main className="flex h-full flex-col bg-surface-0">
      <PageChrome
        title="Chat"
        actions={
          <Button size="sm" variant="ghost" onClick={() => activeId !== null && console_.clearTabLog(activeId)} disabled={activeItems.length === 0}>
            Clear tab log
          </Button>
        }
      />

      {error !== null && (
        <div role="alert" className="flex items-center gap-3 border-b border-danger/40 bg-danger/10 px-4 py-2 text-xs text-danger">
          <span className="min-w-0 flex-1">The workspace library is unavailable: {error}</span>
          <Button size="sm" variant="secondary" onClick={() => void refresh()}>Retry</Button>
        </div>
      )}

      {status === "empty" && (
        <div role="status" className="border-b border-line bg-surface-1 px-4 py-2 text-xs text-fg-muted">
          No workspaces yet. <Link href="/workspaces" className="text-accent hover:underline">Create one</Link>{" "}
          before starting an agent.
        </div>
      )}

      {tabWorkspaces.length > 0 && (
        <div className="flex shrink-0 items-center gap-1 border-b border-line bg-surface-1 px-3 py-2" role="tablist" aria-label="Agent runs">
          <div className="flex min-w-0 max-w-[calc(100%-2.5rem)] gap-1 overflow-x-auto">
            {tabWorkspaces.map(({ tab, workspace }) => {
              const active = tab.id === activeId;
              const tabRuns = console_.runs.filter((run) => console_.runTabIds[run.runId] === tab.id);
              const tabStarting = console_.pendingLaunches.some((launch) => launch.tabId === tab.id);
              const writer = tabRuns.some((run) => run.role === "execute");
              const researching = tabRuns.some((run) => run.role === "consult");
              const label = runTitle(tab.title ?? (tabRuns[0] === undefined ? "New run" : sourceTitle(tabRuns[0].source)));
              return (
                <div key={tab.id} title={`${label} — ${workspace.name}`} className={cn("group flex h-8 max-w-64 shrink-0 items-center rounded-lg border px-1 shadow-sm transition", active ? "border-line-strong bg-surface-0 text-fg" : "border-transparent bg-surface-2/60 text-fg-muted hover:border-line hover:bg-surface-2 hover:text-fg") }>
                  <button type="button" role="tab" aria-selected={active} onClick={() => selectTab(tab)} className="flex min-w-0 items-center gap-2 px-2 text-xs">
                    <span className={cn("size-1.5 shrink-0 rounded-full", writer || tabStarting ? "animate-pulse bg-caution" : researching ? "animate-pulse bg-accent" : "bg-fg-dim/40")} />
                    <span className="truncate">{label}</span>
                  </button>
                  <button type="button" aria-label={`Close ${label} tab`} title={tabRuns.length > 0 || tabStarting ? "Stop or wait for active runs before closing this tab" : tabs.length <= 1 ? "Keep at least one work tab open" : "Close tab"} disabled={tabs.length <= 1 || tabRuns.length > 0 || tabStarting} onClick={() => closeTab(tab.id)} className="rounded p-1 text-fg-dim opacity-0 transition hover:bg-surface-3 hover:text-fg group-hover:opacity-100 focus:opacity-100 disabled:hidden">
                    ×
                  </button>
                </div>
              );
            })}
          </div>

          <div className="relative shrink-0">
            <button type="button" aria-label="New run" title="New run" aria-expanded={pickerOpen} onClick={() => setPickerOpen((open) => !open)} className="flex size-8 items-center justify-center rounded-lg border border-dashed border-line-strong bg-surface-0 text-lg text-fg-muted transition hover:border-accent/60 hover:bg-accent/10 hover:text-accent">+</button>
            {pickerOpen && (
              <div className="glass absolute right-0 top-full z-40 mt-1 w-72 overflow-hidden rounded-lg p-1.5 shadow-xl">
                <p className="px-2 py-1 text-[10px] uppercase tracking-wider text-fg-dim">Open workspace tab</p>
                {workspaces.map((workspace) => (
                  <button key={workspace.id} type="button" onClick={() => openTab(workspace.id)} className="block w-full rounded-md px-2 py-2 text-left hover:bg-surface-3">
                    <span className="block truncate text-xs text-fg">{workspace.name}</span>
                    <span className="block truncate text-[10px] text-fg-dim">{workspace.workDirectory}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {activeWorkspace === null && status === "loading" && (
        <div className="flex flex-1 items-center justify-center text-sm text-fg-dim">Loading workspace…</div>
      )}

      {tabWorkspaces.map(({ tab, workspace }) => (
        <ChatWorkspace key={tab.id} tabId={tab.id} workspace={workspace} visible={tab.id === activeId} initialPromptId={tab.id === deepLinkTabId ? deepLinkedPrompt : null} onTitle={(title) => titleTab(tab.id, title)} />
      ))}
    </main>
  );
}
