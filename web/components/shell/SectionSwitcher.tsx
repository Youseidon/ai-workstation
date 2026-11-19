"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { APP_SECTIONS, type AppSection } from "@/lib/navigation";

/**
 * The section switcher: the current section stays visible by name, and all
 * destinations open from the same place on every page.
 */
export function SectionSwitcher({ current, onNavigate }: { current: AppSection | null; onNavigate(): void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => {
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

  return <div ref={root} className="app-section-switcher">
    <button ref={button} type="button" className="app-section-current" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
      <span className="app-section-icon" aria-hidden>{current?.icon}</span>
      <span className="min-w-0 flex-1 truncate text-left"><span className="sr-only">Section: </span>{current?.label ?? "Agent Console"}</span>
      <span aria-hidden className="app-section-chevron">▾</span>
    </button>
    <nav id={panelId} aria-label="Sections" className="app-section-menu" hidden={!open}>
      {APP_SECTIONS.map((section) => <Link key={section.id} href={section.href} aria-current={section.id === current?.id ? "page" : undefined}
        onClick={() => { setOpen(false); onNavigate(); }}>
        <span className="app-section-icon" aria-hidden>{section.icon}</span>
        <span>{section.label}</span>
      </Link>)}
    </nav>
  </div>;
}
