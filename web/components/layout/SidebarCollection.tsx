"use client";

import Link from "next/link";
import { createContext, useContext, useId, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

/**
 * A section's collection inside the one shared sidebar.
 *
 * The shell owns the sidebar's geometry and exposes a single slot below the
 * section switcher. A route renders its collection through `SidebarCollection`
 * from inside its own tree, so the collection and the content share one state
 * owner and one data subscription. The portal only decides where the rows
 * appear; it cannot add a second sidebar, header or viewport.
 */
interface SlotValue {
  /** The visible slot: the drawer's while the mobile drawer is open, otherwise the desktop sidebar's. */
  target: HTMLElement | null;
  /** Closes the mobile drawer after a selection. */
  onNavigate(): void;
}

const SlotContext = createContext<SlotValue>({ target: null, onNavigate: () => {} });
export const SidebarSlotProvider = SlotContext.Provider;

export function useSidebarNavigate(): () => void {
  return useContext(SlotContext).onNavigate;
}

export function SidebarCollection({ label, tools, children }: { label: string; tools?: ReactNode; children: ReactNode }) {
  const { target } = useContext(SlotContext);
  if (target === null) return null;
  return createPortal(<>
    {tools !== undefined && <div className="app-sidebar-tools">{tools}</div>}
    <nav className="app-sidebar-collection" aria-label={label}>{children}</nav>
  </>, target);
}

/** One selectable record. A link when the selection is addressable, otherwise a button. */
export function SidebarRow({ href, onSelect, selected = false, title, detail, status, statusTone, trailing, depth = 0 }: {
  href?: string;
  onSelect?(): void;
  selected?: boolean;
  title: ReactNode;
  /** A quiet second line: path, provider, time. */
  detail?: ReactNode;
  status?: ReactNode;
  statusTone?: "accent" | "danger" | "warning" | "muted";
  trailing?: ReactNode;
  depth?: number;
}) {
  const navigate = useSidebarNavigate();
  const describedBy = useId();
  const body = <>
    <span className="truncate">{title}</span>
    {detail !== undefined && detail !== null && <span className="app-sidebar-detail">{detail}</span>}
    {status !== undefined && status !== null && <span id={describedBy} className="app-sidebar-status" data-tone={statusTone}>{status}</span>}
  </>;
  const common = {
    className: "app-sidebar-link",
    "aria-current": selected ? ("page" as const) : undefined,
    "aria-describedby": status ? describedBy : undefined,
  };
  return <div className="app-sidebar-row" data-selected={selected} style={depth > 0 ? { marginLeft: depth * 14 } : undefined}>
    {href !== undefined
      ? <Link href={href} scroll={false} {...common} onClick={() => { onSelect?.(); navigate(); }}>{body}</Link>
      : <button type="button" {...common} onClick={() => { onSelect?.(); navigate(); }}>{body}</button>}
    {trailing}
  </div>;
}

export function SidebarGroup({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return <div className="mb-4">{title !== undefined && <p className="app-sidebar-group">{title}</p>}{children}</div>;
}

export function SidebarEmpty({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return <div className="app-sidebar-empty" role={alert ? "alert" : undefined}>{children}</div>;
}

export function SidebarBack({ href, children }: { href: string; children: ReactNode }) {
  const navigate = useSidebarNavigate();
  return <Link href={href} className="app-sidebar-back" onClick={navigate}><span aria-hidden>←</span> {children}</Link>;
}

/** A compact disclosure of filters for the current collection. */
export function FilterControl({ active, children, className }: { active: number; children: ReactNode; className?: string }) {
  return <details className={cn("app-sidebar-filters", className)}>
    <summary>Filters{active > 0 ? ` · ${active} active` : ""}</summary>
    <div className="app-sidebar-filter-grid">{children}</div>
  </details>;
}
