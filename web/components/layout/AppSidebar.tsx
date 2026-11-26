"use client";

import { userLocalStorage } from "@/lib/identityStorage";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import type { ProviderId } from "@hydra/shared";
import { HydraMark, HydraWordmark } from "@/components/brand/HydraMark";
import { ChatCollection } from "@/features/chat/components/ChatCollection";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import type { AppSection } from "@/lib/navigation";
import { useHydra } from "@/hooks/useHydra";
import { attentionLabel, useAttentionCounts } from "./RunAttention";
import { SectionSwitcher } from "./SectionSwitcher";
import { WorkspaceBeacon } from "./WorkspaceBeacon";
import { AccountControl } from "@/contexts/identity";
import { DemoBadge } from "@/features/demo/components/DemoBadge";
import { TourButton } from "@/features/tour/components/TourProvider";

const COLLAPSED_KEY = "hydra.sidebar-collapsed";
const MOBILE_QUERY = "(max-width: 1023px)";

function readCollapsed(): boolean {
  try {
    const value = userLocalStorage.getItem(COLLAPSED_KEY);
    return value === null ? userLocalStorage.getItem("chat-sidebar-collapsed") === "true" : value === "1";
  } catch { return false; }
}

function writeCollapsed(value: boolean) {
  try { userLocalStorage.setItem(COLLAPSED_KEY, value ? "1" : "0"); userLocalStorage.removeItem("chat-sidebar-collapsed"); } catch {  }
}

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
  // eslint-disable-next-line react-hooks/set-state-in-effect -- navigation is external to this component
  useEffect(() => { setDrawerOpen(false); }, [pathname]);
  const open = useCallback(() => { if (matchMedia(MOBILE_QUERY).matches) setDrawerOpen(true); else { setCollapsed(false); writeCollapsed(false); } }, []);
  const close = useCallback(() => { setDrawerOpen(false); if (!matchMedia(MOBILE_QUERY).matches) { setCollapsed(true); writeCollapsed(true); } }, []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  return useMemo(() => ({ collapsed, drawerOpen, mobile, open, close, closeDrawer }), [collapsed, drawerOpen, mobile, open, close, closeDrawer]);
}

interface BodyProps { section: AppSection | null; onClose(): void; onNavigate(): void; slot(node: HTMLDivElement | null): void }

function SidebarBrand({ onNavigate }: { onNavigate(): void }) {
  const { runs } = useHydra();
  const live = useMemo(() => [...new Set(runs.map((run) => run.provider))] as ProviderId[], [runs]);
  const label = live.length === 0 ? "No agents running" : `Running: ${live.join(", ")}`;
  return (
    <Link href="/" className="app-brand" onClick={onNavigate} aria-label={`Hydra home. ${label}`} title={label}>
      <HydraMark size={28} live={live} />
      <HydraWordmark height={17} className="mt-0.5" />
      {runs.length > 0 && <span className="app-brand-status numeric" aria-hidden>{runs.length} live</span>}
    </Link>
  );
}

function SidebarBody({ section, onClose, onNavigate, slot }: BodyProps) {
  const { connection } = useHydra();
  return <>
    <div className="app-sidebar-top">
      <div className="flex min-w-0 items-center gap-1">
        <SidebarBrand onNavigate={onNavigate} />
        <button type="button" className="app-icon-button" aria-label="Close sidebar" onClick={onClose}>‹</button>
      </div>
      <WorkspaceBeacon collapsed={false} />
      <SectionSwitcher current={section} onNavigate={onNavigate} />
      {section?.scope === "app" && <p className="app-sidebar-scope">Fleet activity and settings cover every workspace.</p>}
    </div>
    {section?.id === "chat" ? <ChatCollection onNavigate={onNavigate} /> : <div ref={slot} className="app-sidebar-slot" />}
    <div className="app-sidebar-bottom">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-fg-muted" role="status">{connection === "open" ? "Connected" : connection === "connecting" ? "Connecting…" : "Reconnecting…"}</span>
        <ThemeToggle />
      </div>
      <TourButton />
      <DemoBadge />
      <AccountControl />
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

export function AppSidebar({ section, state, asideSlot, drawerSlot }: {
  section: AppSection | null;
  state: ReturnType<typeof useSidebarState>;
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

  return <>
    <aside className="app-sidebar" data-collapsed={state.collapsed} aria-label="Sidebar">
      <SidebarBody section={section} onClose={close} onNavigate={() => {}} slot={asideSlot} />
    </aside>
    <button ref={trigger} type="button" className="app-sidebar-toggle app-icon-button" data-collapsed={state.collapsed}
      aria-label={attention ? `Open sidebar (${attention})` : "Open sidebar"} aria-controls={drawerId} aria-expanded={state.mobile ? state.drawerOpen : !state.collapsed} onClick={state.open}>
      ☰{(decisions || running) > 0 && <span className="app-sidebar-toggle-badge" data-urgent={decisions > 0} aria-hidden>{decisions || running}</span>}
    </button>
    <dialog ref={dialog} id={drawerId} className="app-sidebar-dialog" aria-label="Navigation"
      onCancel={state.closeDrawer} onClose={() => { state.closeDrawer(); trigger.current?.focus(); }}
      onClick={(event) => { if (event.target === event.currentTarget) state.closeDrawer(); }} onKeyDown={trapFocus}>
      {state.drawerOpen && <div className="app-sidebar-drawer"><SidebarBody section={section} onClose={close} onNavigate={state.closeDrawer} slot={drawerSlot} /></div>}
    </dialog>
  </>;
}
