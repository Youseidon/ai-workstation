"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChatCollection } from "@/components/chat/ChatCollection";
import { ThemeToggle } from "@/components/ThemeToggle";
import type { AppSection } from "@/lib/navigation";
import { useAgentConsole } from "@/lib/useAgentConsole";
import { RunAttentionSummary, attentionLabel, useAttentionCounts } from "./RunAttention";
import { SectionSwitcher } from "./SectionSwitcher";
import { WorkspaceBeacon } from "./WorkspaceBeacon";

const COLLAPSED_KEY = "agent-console.sidebar-collapsed";
const MOBILE_QUERY = "(max-width: 1023px)";

function readCollapsed(): boolean {
  try {
    const value = localStorage.getItem(COLLAPSED_KEY);
    // Chat's former preference carries over once.
    return value === null ? localStorage.getItem("chat-sidebar-collapsed") === "true" : value === "1";
  } catch { return false; }
}

function writeCollapsed(value: boolean) {
  try { localStorage.setItem(COLLAPSED_KEY, value ? "1" : "0"); localStorage.removeItem("chat-sidebar-collapsed"); } catch { /* preference only */ }
}

/** The sidebar's one desktop collapse preference and mobile drawer state. */
export function useSidebarState(pathname: string) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const media = matchMedia(MOBILE_QUERY);
    const update = () => { setMobile(media.matches); if (!media.matches) setDrawerOpen(false); };
    update(); media.addEventListener("change", update);
    const timer = setTimeout(() => setCollapsed(readCollapsed()), 0);
    return () => { media.removeEventListener("change", update); clearTimeout(timer); };
  }, []);
  // A new route closes the mobile drawer.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- navigation is external to this component
  useEffect(() => { setDrawerOpen(false); }, [pathname]);
  const open = useCallback(() => { if (matchMedia(MOBILE_QUERY).matches) setDrawerOpen(true); else { setCollapsed(false); writeCollapsed(false); } }, []);
  const close = useCallback(() => { setDrawerOpen(false); if (!matchMedia(MOBILE_QUERY).matches) { setCollapsed(true); writeCollapsed(true); } }, []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  return useMemo(() => ({ collapsed, drawerOpen, mobile, open, close, closeDrawer }), [collapsed, drawerOpen, mobile, open, close, closeDrawer]);
}

interface BodyProps { section: AppSection | null; onClose(): void; onNavigate(): void; onAttention(): void; slot(node: HTMLDivElement | null): void }

function SidebarBody({ section, onClose, onNavigate, onAttention, slot }: BodyProps) {
  const { connection } = useAgentConsole();
  return <>
    <div className="app-sidebar-top">
      <div className="flex min-w-0 items-center gap-1">
        <WorkspaceBeacon collapsed={false} />
        <button type="button" className="app-icon-button" aria-label="Close sidebar" onClick={onClose}>‹</button>
      </div>
      <SectionSwitcher current={section} onNavigate={onNavigate} />
      {section?.scope === "app" && <p className="app-sidebar-scope">Settings here apply to every workspace.</p>}
    </div>
    {section?.id === "chat" ? <ChatCollection onNavigate={onNavigate} /> : <div ref={slot} className="app-sidebar-slot" />}
    <div className="app-sidebar-bottom">
      <RunAttentionSummary onOpen={onAttention} />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-fg-muted" role="status">{connection === "open" ? "Connected" : connection === "connecting" ? "Connecting…" : "Reconnecting…"}</span>
        <ThemeToggle />
      </div>
    </div>
  </>;
}

function trapFocus(event: KeyboardEvent<HTMLDialogElement>) {
  if (event.key !== "Tab") return;
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex='0']")].filter((node) => node.getClientRects().length > 0);
  const first = focusable[0], last = focusable.at(-1);
  if (!first) { event.preventDefault(); return; }
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

/**
 * The one application sidebar: a 272 px column on desktop with one collapse
 * preference, and a modal drawer below 1024 px. Its body is the same in both.
 */
export function AppSidebar({ section, state, onAttention, asideSlot, drawerSlot }: {
  section: AppSection | null;
  state: ReturnType<typeof useSidebarState>;
  onAttention(): void;
  /** Ref callbacks for the collection slot in the desktop sidebar and in the mobile drawer. */
  asideSlot(node: HTMLDivElement | null): void;
  drawerSlot(node: HTMLDivElement | null): void;
}) {
  const drawerId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const { running, decisions } = useAttentionCounts();
  const attention = attentionLabel(running, decisions);

  useEffect(() => {
    if (state.drawerOpen && !dialog.current?.open) dialog.current?.showModal();
    else if (!state.drawerOpen && dialog.current?.open) dialog.current.close();
  }, [state.drawerOpen]);

  const close = () => { state.close(); requestAnimationFrame(() => trigger.current?.focus()); };
  const attentionFromDrawer = () => { state.closeDrawer(); onAttention(); };

  return <>
    <aside className="app-sidebar" data-collapsed={state.collapsed} aria-label="Sidebar">
      <SidebarBody section={section} onClose={close} onNavigate={() => {}} onAttention={onAttention} slot={asideSlot} />
    </aside>
    <button ref={trigger} type="button" className="app-sidebar-toggle app-icon-button" data-collapsed={state.collapsed}
      aria-label={attention ? `Open sidebar (${attention})` : "Open sidebar"} aria-controls={drawerId} aria-expanded={state.mobile ? state.drawerOpen : !state.collapsed} onClick={state.open}>
      ☰{(decisions || running) > 0 && <span className="app-sidebar-toggle-badge" data-urgent={decisions > 0} aria-hidden>{decisions || running}</span>}
    </button>
    <dialog ref={dialog} id={drawerId} className="app-sidebar-dialog" aria-label="Navigation"
      onCancel={state.closeDrawer} onClose={() => { state.closeDrawer(); trigger.current?.focus(); }}
      onClick={(event) => { if (event.target === event.currentTarget) state.closeDrawer(); }} onKeyDown={trapFocus}>
      {state.drawerOpen && <div className="app-sidebar-drawer"><SidebarBody section={section} onClose={close} onNavigate={state.closeDrawer} onAttention={attentionFromDrawer} slot={drawerSlot} /></div>}
    </dialog>
  </>;
}
