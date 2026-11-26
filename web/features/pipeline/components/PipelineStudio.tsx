"use client";

import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/cn";

/**
 * The Pipeline studio: everything you configure or review, in one wide popup.
 * The side drawer answers "what is happening"; the studio answers "how is it
 * set up, and how did it go". Sections are grouped, searchable, and each says
 * in one line what it is for, so nothing hides behind a terse tab label.
 */
export type StudioSection = "agents" | "step" | "policy" | "budgets" | "statuses" | "definition" | "verification" | "history";

export interface StudioSectionInfo {
  id: StudioSection;
  group: "Agents" | "Rules" | "Quality";
  label: string;
  blurb: string;
  /** Extra words the filter and the command palette match. */
  keywords: string;
}

export const STUDIO_SECTIONS: StudioSectionInfo[] = [
  { id: "agents", group: "Agents", label: "Suite agents", blurb: "Lead agent and model, per-prompt overrides, fallback order, auto-reassign", keywords: "provider model assign override fallback reassign crew lead" },
  { id: "step", group: "Agents", label: "This step", blurb: "Agent, outcomes, fallbacks and execution allowance for the selected step", keywords: "station config configure prompt on done unfinished allowance attempts tokens shadow" },
  { id: "policy", group: "Rules", label: "Run rules", blurb: "Pause and stop behaviour, continuations, every state and what you can do in it", keywords: "policy pause stop continuation reviewer transitions cooling" },
  { id: "budgets", group: "Rules", label: "Budgets", blurb: "Run time, token and cost ceilings", keywords: "budget limit cap tokens cost time ceiling" },
  { id: "statuses", group: "Rules", label: "Statuses", blurb: "Labels, tones and enter behaviour of every status", keywords: "status catalog label tone" },
  { id: "definition", group: "Rules", label: "Done criteria", blurb: "The suite's definition of done, inherited by every item", keywords: "definition of done dod criteria acceptance checks" },
  { id: "verification", group: "Quality", label: "Verify & audit", blurb: "Independent verification of the suite and recorded evidence", keywords: "verify verification audit evidence report check" },
  { id: "history", group: "Quality", label: "Run history", blurb: "Every past run of this pipeline", keywords: "history runs archive past flights log" },
];

const GROUP_ORDER = ["Agents", "Rules", "Quality"] as const;

export function PipelineStudio({
  open,
  section,
  onSectionChange,
  onClose,
  context,
  unavailable = {},
  badges = {},
  children,
}: {
  open: boolean;
  section: StudioSection;
  onSectionChange(section: StudioSection): void;
  onClose(): void;
  /** Where the studio is pointed: pipeline · suite · step. */
  context: ReactNode;
  /** Sections that cannot open right now, with the reason. */
  unavailable?: Partial<Record<StudioSection, string>>;
  badges?: Partial<Record<StudioSection, ReactNode>>;
  /** The current section's content. */
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const current = STUDIO_SECTIONS.find((entry) => entry.id === section) ?? STUDIO_SECTIONS[0]!;
  const visible = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return STUDIO_SECTIONS.filter((entry) => {
      const text = `${entry.label} ${entry.blurb} ${entry.keywords} ${entry.group}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [query]);

  const onNavKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button.studio-nav-item:not(:disabled)")];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    if (next === undefined) return;
    event.preventDefault();
    next.focus();
    next.click();
  };

  return (
    <Modal open={open} onClose={onClose} size="2xl" bodyClassName="studio-body" title="Pipeline studio" description={context}>
      <nav className="studio-nav" aria-label="Studio sections" onKeyDown={onNavKey}>
        <label className="studio-filter">
          <span className="sr-only">Filter studio sections</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" /><path d="m16 16 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter settings…" />
        </label>
        {GROUP_ORDER.map((group) => {
          const entries = visible.filter((entry) => entry.group === group);
          if (entries.length === 0) return null;
          return (
            <div key={group} className="studio-nav-group">
              <p className="studio-nav-heading">{group}</p>
              {entries.map((entry) => {
                const blocked = unavailable[entry.id];
                return (
                  <button key={entry.id} type="button" className="studio-nav-item" aria-current={entry.id === section ? "page" : undefined}
                    disabled={blocked !== undefined} title={blocked} onClick={() => onSectionChange(entry.id)}>
                    <span className="studio-nav-icon" aria-hidden>{STUDIO_ICONS[entry.id]}</span>
                    <span className="min-w-0 flex-1">
                      <span className="studio-nav-label">{entry.label}{badges[entry.id] !== undefined && <span className="studio-nav-badge">{badges[entry.id]}</span>}</span>
                      <span className="studio-nav-blurb">{blocked ?? entry.blurb}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
        {visible.length === 0 && <p className="px-2 py-4 text-xs text-fg-dim">No section matches “{query}”.</p>}
      </nav>
      <section className="studio-main" aria-label={current.label}>
        <header className="studio-main-header">
          <span className="studio-main-icon" aria-hidden>{STUDIO_ICONS[current.id]}</span>
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-fg">{current.label}</h3>
            <p className="text-xs text-fg-muted">{current.blurb}</p>
          </div>
        </header>
        <div className={cn("studio-main-content")} key={section}>{children}</div>
      </section>
    </Modal>
  );
}

const icon = (path: ReactNode) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{path}</svg>;

export const STUDIO_ICONS: Record<StudioSection, ReactNode> = {
  agents: icon(<><circle cx="9" cy="8" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><circle cx="17" cy="9" r="2.3" /><path d="M16 14.2a4.5 4.5 0 0 1 5 4.8" /></>),
  step: icon(<><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2.2" /><circle cx="10" cy="17" r="2.2" /></>),
  policy: icon(<><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></>),
  budgets: icon(<><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></>),
  statuses: icon(<><circle cx="6" cy="7" r="2" /><circle cx="6" cy="17" r="2" /><path d="M11 7h9M11 17h9" /></>),
  definition: icon(<><path d="M9 4h6l1 2h3v14H5V6h3l1-2Z" /><path d="m9 13 2 2 4-4" /></>),
  verification: icon(<><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4M8.5 11l1.8 1.8 3.2-3.3" /></>),
  history: icon(<><path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5" /><path d="M4 4v4.5h4.5M12 8v4l3 2" /></>),
};
