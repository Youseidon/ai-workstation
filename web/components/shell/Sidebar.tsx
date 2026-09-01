"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { useAgentConsole } from "@/lib/useAgentConsole";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useOpenSettings } from "./chrome";

const STORAGE_KEY = "agent-console.sidebar-collapsed";

type NavId = "chat" | "tasks" | "pipeline" | "activity" | "report" | "agents" | "workspaces";

const LINKS: Array<{
  id: NavId;
  href: string;
  label: string;
  match: (pathname: string) => boolean;
  icon: React.ReactNode;
}> = [
  {
    id: "chat",
    href: "/",
    label: "Chat",
    match: (pathname) => pathname === "/",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6A2.5 2.5 0 0 1 16.5 15H10l-4 3.5V6.5Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    id: "tasks",
    href: "/tasks",
    label: "Tasks",
    match: (pathname) => pathname.startsWith("/tasks") || pathname.startsWith("/operations") || pathname.startsWith("/input"),
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M9 6h11M9 12h11M9 18h11" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M5 6.5 6.2 7.7 8 5.5M5 12.5 6.2 13.7 8 11.5M5 18.5 6.2 19.7 8 17.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: "pipeline",
    href: "/pipeline",
    label: "Pipeline",
    match: (pathname) => pathname.startsWith("/pipeline"),
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="6" cy="12" r="2.25" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="12" cy="6" r="2.25" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="12" cy="18" r="2.25" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="18" cy="12" r="2.25" stroke="currentColor" strokeWidth="1.6" />
        <path d="M8.2 10.8 9.8 7.8M8.2 13.2 9.8 16.2M14.2 7.8l1.6 3M14.2 16.2l1.6-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "activity",
    href: "/activity",
    label: "Activity",
    match: (pathname) => pathname.startsWith("/activity") || pathname.startsWith("/sessions"),
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M4 19V5M4 19h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M8 15v-3M12 15V8M16 15v-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "report",
    href: "/report",
    label: "Report",
    match: (pathname) => pathname.startsWith("/report"),
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M5 19V9M10 19V5M15 19v-7M20 19V8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <path d="M4 19h17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "agents",
    href: "/agents",
    label: "Agents",
    match: (pathname) => pathname.startsWith("/agents") || pathname.startsWith("/fleet"),
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="9" r="3.25" stroke="currentColor" strokeWidth="1.6" />
        <path d="M6.5 18.5c1.2-2.4 3.1-3.5 5.5-3.5s4.3 1.1 5.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="5.5" cy="10" r="2" stroke="currentColor" strokeWidth="1.4" opacity="0.7" />
        <circle cx="18.5" cy="10" r="2" stroke="currentColor" strokeWidth="1.4" opacity="0.7" />
      </svg>
    ),
  },
  {
    id: "workspaces",
    href: "/workspaces",
    label: "Workspaces",
    match: (pathname) => pathname.startsWith("/workspaces"),
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5v-7Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M12 12v8M12 12 4.5 8M12 12l7.5-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    ),
  },
];

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function Sidebar() {
  const pathname = usePathname();
  const { connection } = useAgentConsole();
  const openSettings = useOpenSettings();
  const [collapsed, setCollapsed] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setCollapsed(readCollapsed());
    setReady(true);
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((value) => {
      const next = !value;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* preference only */
      }
      return next;
    });
  }, []);

  const connectionLabel =
    connection === "open" ? "connected" : connection === "connecting" ? "connecting…" : "disconnected";

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-line bg-surface-1 transition-[width] duration-200",
        collapsed ? "w-14" : "w-56",
        !ready && "opacity-0",
      )}
    >
      <div className={cn("flex h-12 items-center border-b border-line", collapsed ? "justify-center px-1" : "gap-2 px-3")}>
        {!collapsed && (
          <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-muted">
            Agent Console
          </span>
        )}
        <button
          type="button"
          onClick={toggle}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          className="flex size-8 items-center justify-center rounded-md text-fg-dim transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            {collapsed ? (
              <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <path d="M10 3.5 5.5 8 10 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            )}
          </svg>
        </button>
      </div>

      <nav aria-label="Primary" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {LINKS.map((link) => {
          const current = link.match(pathname);
          return (
            <Link
              key={link.id}
              href={link.href}
              aria-current={current ? "page" : undefined}
              title={link.label}
              className={cn(
                "relative flex h-10 items-center gap-3 rounded-md text-sm font-medium transition-colors",
                collapsed ? "justify-center px-0" : "px-3",
                current
                  ? "bg-surface-3 text-fg before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-accent"
                  : "text-fg-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              <span className={cn("shrink-0", current ? "text-accent" : "text-fg-dim")}>{link.icon}</span>
              {!collapsed && <span className="truncate">{link.label}</span>}
            </Link>
          );
        })}
      </nav>

      <div className={cn("flex flex-col gap-1 border-t border-line p-2", collapsed && "items-center")}>
        <div
          className={cn(
            "flex h-9 items-center gap-2 rounded-md px-2 text-xs text-fg-dim",
            collapsed && "justify-center px-0",
          )}
          title={connectionLabel}
        >
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              connection === "open" ? "bg-success" : connection === "connecting" ? "bg-warning animate-pulse" : "bg-danger",
            )}
          />
          {!collapsed && <span className="truncate">{connectionLabel}</span>}
        </div>

        <div className={cn("flex items-center gap-1", collapsed ? "flex-col" : "")}>
          <ThemeToggle />
          <button
            type="button"
            onClick={openSettings}
            title="Settings"
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-fg-dim ring-1 ring-inset ring-line transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z"
                stroke="currentColor"
                strokeWidth="1.4"
              />
              <path
                d="M2.8 8.7V7.3l1.3-.4.5-1.2-1-1 1-1 1.2.5 1.2-.5.4-1.3h1.4l.4 1.3 1.2.5 1.2-.5 1 1-1 1 .5 1.2 1.3.4v1.4l-1.3.4-.5 1.2 1 1-1 1-1.2-.5-1.2.5-.4 1.3H7.3l-.4-1.3-1.2-.5-1.2.5-1-1 1-1-.5-1.2-1.3-.4Z"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
            {!collapsed && <span>Settings</span>}
          </button>
        </div>
      </div>
    </aside>
  );
}
