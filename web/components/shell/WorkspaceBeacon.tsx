"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { useWorkspace } from "@/lib/workspaceContext";

function shortenPath(path: string): string {
  // Prefer a tidy trailing segment; full path stays in the title attribute.
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

/**
 * Sidebar identity plate for the current workspace. Click to switch projects;
 * every page scopes itself to whatever is selected here.
 */
export function WorkspaceBeacon({ collapsed }: { collapsed: boolean }) {
  const { workspaces, workspace, workspaceId, status, setWorkspaceId } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setQuery("");
      setOpen(false);
    };
    const onPointer = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => window.clearTimeout(timer);
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return workspaces;
    return workspaces.filter((item) =>
      `${item.name} ${item.workDirectory} ${item.description}`.toLowerCase().includes(needle),
    );
  }, [workspaces, query]);

  const label =
    status === "loading"
      ? "Loading…"
      : status === "empty"
        ? "No workspace"
        : status === "error"
          ? "Unavailable"
          : (workspace?.name ?? "Choose workspace");

  const pathHint = workspace?.workDirectory ? shortenPath(workspace.workDirectory) : null;

  return (
    <div ref={containerRef} className={cn("relative", collapsed ? "w-full" : "min-w-0 flex-1")}>
      <button
        type="button"
        onClick={() =>
          setOpen((value) => {
            if (value) setQuery("");
            return !value;
          })
        }
        aria-haspopup="listbox"
        aria-expanded={open}
        title={workspace?.workDirectory ?? label}
        className={cn(
          "group flex w-full items-center rounded-md text-left transition-colors",
          collapsed ? "justify-center px-0 py-1.5" : "gap-2.5 px-1.5 py-1",
          "hover:bg-surface-2",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-md",
            workspace?.workDirectoryExists === false
              ? "bg-danger/15 text-danger ring-1 ring-inset ring-danger/40"
              : "bg-accent/15 text-accent ring-1 ring-inset ring-accent/35",
          )}
        >
          <WorkspaceMark />
        </span>
        {!collapsed && (
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1">
              <span className="truncate text-[13px] font-semibold tracking-tight text-fg">{label}</span>
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                aria-hidden
                className={cn("shrink-0 text-fg-dim transition-transform", open && "rotate-180")}
              >
                <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            {pathHint !== null && (
              <span className="mt-0.5 block truncate text-[10px] text-fg-dim" title={workspace?.workDirectory}>
                {pathHint}
              </span>
            )}
            {status === "empty" && (
              <span className="mt-0.5 block truncate text-[10px] text-fg-dim">Create one to begin</span>
            )}
          </span>
        )}
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Switch workspace"
          className={cn(
            "glass absolute z-50 animate-slide-up overflow-hidden rounded-lg shadow-xl",
            collapsed
              ? "left-full top-0 ml-2 w-72"
              : "left-0 right-0 top-full mt-2 w-[min(100%,18rem)] min-w-[16rem]",
          )}
        >
          <div className="border-b border-line p-2">
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search workspaces…"
              className="h-8 w-full rounded-md bg-surface-3 px-2.5 text-xs text-fg placeholder:text-fg-dim ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-accent/60"
            />
          </div>

          <div className="max-h-64 overflow-y-auto p-1.5">
            {status === "loading" && (
              <p className="px-2 py-3 text-xs text-fg-dim">Loading workspaces…</p>
            )}
            {status === "error" && (
              <p className="px-2 py-3 text-xs text-danger">Workspaces could not be loaded.</p>
            )}
            {status === "empty" && (
              <p className="px-2 py-3 text-xs text-fg-dim">
                No workspaces yet. Create one to scope Chat, Tasks, and Pipeline.
              </p>
            )}
            {status === "ready" && filtered.length === 0 && (
              <p className="px-2 py-3 text-xs text-fg-dim">No workspaces match.</p>
            )}
            {filtered.map((item) => {
              const active = item.id === workspaceId;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    setWorkspaceId(item.id);
                    setQuery("");
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
                    active ? "bg-accent/12 text-fg" : "text-fg-muted hover:bg-surface-3 hover:text-fg",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-[11px]",
                      item.workDirectoryExists
                        ? "bg-surface-3 text-accent ring-1 ring-inset ring-line"
                        : "bg-danger/15 text-danger ring-1 ring-inset ring-danger/35",
                    )}
                  >
                    <WorkspaceMark small />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-medium">{item.name}</span>
                      {!item.workDirectoryExists && (
                        <span className="shrink-0 rounded-full bg-danger/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-danger">
                          missing
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-[10.5px] text-fg-dim" title={item.workDirectory}>
                      {item.workDirectory}
                    </span>
                  </span>
                  {active && (
                    <span aria-hidden className="mt-0.5 text-accent">
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="border-t border-line p-1.5">
            <Link
              href="/workspaces"
              onClick={() => setOpen(false)}
              className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg"
            >
              <span>Manage workspaces</span>
              <span aria-hidden>→</span>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function WorkspaceMark({ small = false }: { small?: boolean }) {
  const size = small ? 12 : 15;
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 5.5 8 2.5l5.5 3v6L8 14.5l-5.5-3v-6Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M8 8v6.2M8 8 3 5.2M8 8l5-2.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
