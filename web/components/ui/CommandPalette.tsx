"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { overlayHost } from "@/lib/overlayHost";
import { useIsClient } from "@/hooks/useIsClient";

export interface PaletteEntry {
  id: string;
  group: string;
  label: string;
  /** Second line: where it is or what it does. */
  hint?: string;
  /** Extra words to match that are not shown. */
  keywords?: string;
  icon?: ReactNode;
  /** Right-aligned: a key hint, a status. */
  trailing?: ReactNode;
  disabled?: string;
  run(): void;
}

/**
 * "Find anything" for a page with too much in it: steps, suites, settings and
 * actions answer the same query, ranked by where the words match. Opened with
 * ⌘K, Ctrl+K or "/", driven entirely from the keyboard.
 */
export function CommandPalette({ open, onClose, entries, placeholder = "Find a step, setting or action…" }: {
  open: boolean;
  onClose(): void;
  /** Called when the palette opens, so the page builds its index only on demand. */
  entries(): PaletteEntry[];
  placeholder?: string;
}) {
  const mounted = useIsClient();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();

  /* eslint-disable react-hooks/set-state-in-effect -- reset when reopened */
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Snapshot the index when opened; the page does not rebuild it per keystroke.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt on each open only
  const index = useMemo(() => (open ? entries() : []), [open]);
  const results = useMemo(() => rank(index, query), [index, query]);
  const flat = results.flatMap((group) => group.items);
  const current = Math.min(active, Math.max(0, flat.length - 1));

  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  if (!mounted || !open) return null;

  const choose = (entry: PaletteEntry | undefined) => {
    if (entry === undefined || entry.disabled !== undefined) return;
    onClose();
    entry.run();
  };

  return createPortal(
    <div className="palette-layer" onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      else if (event.key === "ArrowDown") { event.preventDefault(); setActive((current + 1) % Math.max(1, flat.length)); }
      else if (event.key === "ArrowUp") { event.preventDefault(); setActive((current - 1 + flat.length) % Math.max(1, flat.length)); }
      else if (event.key === "Enter") { event.preventDefault(); choose(flat[current]); }
    }}>
      <div className="palette-scrim" aria-hidden onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label="Find anything" className="palette">
        <div className="palette-input">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" /><path d="m16 16 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          <input ref={input} value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} placeholder={placeholder}
            role="combobox" aria-expanded aria-controls={listId} aria-activedescendant={flat[current] ? `${listId}-${flat[current]!.id}` : undefined} aria-autocomplete="list" />
          <kbd>esc</kbd>
        </div>
        <ul ref={list} id={listId} role="listbox" className="palette-results" aria-label="Results">
          {flat.length === 0 && <li className="palette-empty">Nothing matches “{query}”. Try a step key like S1-02, or words like “budget”, “verify”, “model”.</li>}
          {results.map((group) => (
            <li key={group.name} role="presentation">
              <p className="palette-group">{group.name}</p>
              <ul role="presentation">
                {group.items.map((entry) => {
                  const mine = flat.indexOf(entry);
                  return (
                    <li key={entry.id} id={`${listId}-${entry.id}`} role="option" aria-selected={mine === current} aria-disabled={entry.disabled !== undefined}
                      data-index={mine} className="palette-item" onMouseMove={() => setActive(mine)} onClick={() => choose(entry)}>
                      <span className="palette-icon" aria-hidden>{entry.icon ?? "•"}</span>
                      <span className="min-w-0 flex-1">
                        <span className="palette-label">{entry.label}</span>
                        {(entry.disabled ?? entry.hint) !== undefined && <span className="palette-hint">{entry.disabled ?? entry.hint}</span>}
                      </span>
                      {entry.trailing !== undefined && <span className="palette-trailing">{entry.trailing}</span>}
                      <span className="palette-enter" aria-hidden>↵</span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
        <p className="palette-footer" aria-hidden><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>⌘K</kbd> or <kbd>/</kbd> anywhere on the board</span></p>
      </div>
    </div>,
    overlayHost(),
  );
}

/** Every word must match somewhere; label hits outrank hint and keyword hits. */
function rank(entries: PaletteEntry[], query: string): Array<{ name: string; items: PaletteEntry[] }> {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const scored = entries.flatMap((entry) => {
    if (words.length === 0) return [{ entry, score: 0 }];
    const label = entry.label.toLowerCase();
    const rest = `${entry.hint ?? ""} ${entry.keywords ?? ""} ${entry.group}`.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (label.startsWith(word)) score += 4;
      else if (label.includes(word)) score += 3;
      else if (rest.includes(word)) score += 1;
      else return [];
    }
    if (entry.disabled !== undefined) score -= 2;
    return [{ entry, score }];
  });
  const limited = words.length === 0 ? scored : [...scored].sort((a, b) => b.score - a.score);
  const groups = new Map<string, PaletteEntry[]>();
  for (const { entry } of limited) {
    const items = groups.get(entry.group) ?? [];
    if (items.length < (words.length === 0 ? 6 : 8)) items.push(entry);
    groups.set(entry.group, items);
  }
  return [...groups].map(([name, items]) => ({ name, items }));
}
