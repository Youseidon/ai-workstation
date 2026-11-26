"use client";

import { userLocalStorage } from "@/lib/identityStorage";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { APP_SECTIONS, type AppSection } from "@/lib/navigation";

const DISCOVERED_KEY = "hydra.section-switcher-discovered";

export function SectionSwitcher({ current, onNavigate }: { current: AppSection | null; onNavigate(): void }) {
  const [open, setOpen] = useState(false);
  const [discovered, setDiscovered] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const others = APP_SECTIONS.filter((section) => section.id !== current?.id);

  useEffect(() => {
    const timer = setTimeout(() => {
      try { setDiscovered(userLocalStorage.getItem(DISCOVERED_KEY) === "1"); } catch {  }
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    root.current?.addEventListener("keydown", onKey);
    const node = root.current;
    return () => { document.removeEventListener("pointerdown", onPointer); node?.removeEventListener("keydown", onKey); };
  }, [open]);

  const toggle = () => {
    setOpen((value) => !value);
    if (!discovered) {
      setDiscovered(true);
      try { userLocalStorage.setItem(DISCOVERED_KEY, "1"); } catch {  }
    }
  };

  const links = () => [...(root.current?.querySelectorAll<HTMLAnchorElement>(".app-section-menu a") ?? [])];
  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (!open) toggle();
    requestAnimationFrame(() => { const items = links(); (event.key === "ArrowDown" ? items[0] : items.at(-1))?.focus(); });
  };
  const onMenuKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const items = links();
    const index = items.indexOf(document.activeElement as HTMLAnchorElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  return <div ref={root} className="app-section-switcher" data-open={open} data-discovered={discovered}>
    <button ref={button} type="button" className="app-section-current" aria-expanded={open} aria-controls={panelId} aria-haspopup="true"
      onClick={toggle} onKeyDown={onTriggerKey}>
      <span className="app-section-current-icon" aria-hidden>{current?.icon}</span>
      <span className="app-section-current-text">
        <span className="app-section-eyebrow" aria-hidden>{open ? "Pick a page" : "Navigate"}</span>
        <span className="app-section-current-label"><span className="sr-only">Section: </span>{current?.label ?? "Hydra"}</span>
      </span>
      <span className="app-section-peek" aria-hidden>
        {others.slice(0, 3).map((section, index) => <span key={section.id} style={{ "--peek-index": index } as CSSProperties}>{section.icon}</span>)}
      </span>
      <span aria-hidden className="app-section-chevron">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
    </button>
    <nav id={panelId} aria-label="Sections" className="app-section-menu" hidden={!open} onKeyDown={onMenuKey}>
      <p className="app-section-menu-head" aria-hidden><span>Jump to</span><kbd>↑↓</kbd></p>
      {APP_SECTIONS.map((section, index) => <Link key={section.id} href={section.href} aria-current={section.id === current?.id ? "page" : undefined}
        style={{ "--item-index": index } as CSSProperties}
        onClick={() => { setOpen(false); onNavigate(); }}>
        <span className="app-section-icon" aria-hidden>{section.icon}</span>
        <span className="flex-1">{section.label}</span>
        {section.id === current?.id ? <span className="app-section-here" aria-hidden>You&apos;re here</span> : <span className="app-section-go" aria-hidden>→</span>}
      </Link>)}
    </nav>
  </div>;
}
