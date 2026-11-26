"use client";

import { userLocalStorage } from "@/lib/identityStorage";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { OperationsPrompt } from "@hydra/shared";
import { LABEL, TONE } from "@/features/pipeline/lib/status";
import { Badge } from "@/components/ui/Badge";
import { EditIconButton } from "@/components/ui/EditIconButton";
import { cn } from "@/lib/cn";
import { GateGlyph } from "./Conversation";
import { ancestorIdsForPrompt, filterPromptTree, isTerminal, needsYou, type WorkFilter } from "../../lib/station/tree";

const EXPANDED_KEY = "hydra.worklist-expanded";
const EXPANDED_EVENT = "hydra.worklist-expanded";

function parseExpanded(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isSafeInteger(id)) : [];
  } catch {
    return [];
  }
}

function readExpandedRaw(): string {
  try {
    return userLocalStorage.getItem(EXPANDED_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

function writeExpanded(ids: Iterable<number>): void {
  try {
    userLocalStorage.setItem(EXPANDED_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage is a convenience; the list still works without it.
  }
  window.dispatchEvent(new Event(EXPANDED_EVENT));
}

function subscribeExpanded(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(EXPANDED_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(EXPANDED_EVENT, onChange);
  };
}

/**
 * The dense view of the same items the flowchart draws: one row each, nested
 * sub-steps, filterable. Rows only select; actions live in the item panel.
 */
export function WorkList({
  items,
  filter,
  selectedId,
  currentId,
  onFilterChange,
  onSelect,
  onConfigure,
}: {
  items: OperationsPrompt[];
  filter: WorkFilter;
  selectedId: number | null;
  /** The item the live run is on. */
  currentId: number | null;
  onFilterChange(filter: WorkFilter): void;
  onSelect(promptId: number): void;
  /** Opens an item's settings in the studio; no pencil without it. */
  onConfigure?(promptId: number): void;
}) {
  const raw = useSyncExternalStore(subscribeExpanded, readExpandedRaw, () => "[]");
  const expanded = useMemo(() => new Set(parseExpanded(raw)), [raw]);
  const visible = useMemo(() => filterPromptTree(items, filter), [items, filter]);
  const counts = useMemo(() => countFilters(items), [items]);

  // Open the ancestors of a selected sub-step so the selection is visible.
  useEffect(() => {
    if (selectedId === null) return;
    const ancestors = ancestorIdsForPrompt(items, selectedId);
    if (ancestors.every((id) => expanded.has(id))) return;
    writeExpanded(new Set([...expanded, ...ancestors]));
  }, [selectedId, items, expanded]);

  const toggle = (id: number) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    writeExpanded(next);
  };

  return (
    <section className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter items">
        <FilterChip active={filter === "all"} onClick={() => onFilterChange("all")}>
          All <span className="numeric text-fg-dim">{counts.all}</span>
        </FilterChip>
        <FilterChip active={filter === "attention"} tone="warning" onClick={() => onFilterChange("attention")}>
          Needs you <span className="numeric opacity-70">{counts.attention}</span>
        </FilterChip>
        <FilterChip active={filter === "working"} tone="info" onClick={() => onFilterChange("working")}>
          Working <span className="numeric opacity-70">{counts.working}</span>
        </FilterChip>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-panel border border-dashed border-line px-6 py-10 text-center text-sm text-fg-dim">
          {filter === "attention" ? "Nothing needs you right now." : filter === "working" ? "Nothing is running right now." : "No items."}
        </div>
      ) : (
        <ul className="overflow-hidden rounded-panel border border-line bg-surface-1" role="tree">
          {visible.map((entry) => (
            <Row
              key={entry.prompt.id}
              entry={entry}
              depth={0}
              expanded={expanded}
              selectedId={selectedId}
              currentId={currentId}
              onToggle={toggle}
              onSelect={onSelect}
              onConfigure={onConfigure}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({
  entry,
  depth,
  expanded,
  selectedId,
  currentId,
  onToggle,
  onSelect,
  onConfigure,
}: {
  entry: OperationsPrompt;
  depth: number;
  expanded: Set<number>;
  selectedId: number | null;
  currentId: number | null;
  onToggle(id: number): void;
  onSelect(id: number): void;
  onConfigure?(id: number): void;
}) {
  const hasChildren = entry.children.length > 0;
  const open = hasChildren && expanded.has(entry.prompt.id);
  const selected = selectedId === entry.prompt.id;
  const gatePending = entry.humanIntervention?.status === "PENDING";

  return (
    <>
      <li
        role="treeitem"
        aria-selected={selected}
        aria-expanded={hasChildren ? open : undefined}
        className={cn(
          "group flex items-center gap-1 border-b border-line/70 pr-3 last:border-b-0",
          selected ? "bg-accent/10" : "hover:bg-surface-2",
        )}
        style={{ paddingLeft: 8 + depth * 18 }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(entry.prompt.id)}
            aria-label={open ? "Collapse sub-steps" : "Expand sub-steps"}
            className="flex size-6 shrink-0 items-center justify-center rounded text-xs text-fg-dim hover:bg-surface-3 hover:text-fg"
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span className="size-6 shrink-0" aria-hidden />
        )}
        <button
          type="button"
          onClick={() => onSelect(entry.prompt.id)}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
        >
          {currentId === entry.prompt.id && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-info" title="Live" />}
          {entry.prompt.externalKey !== null && (
            <span className="shrink-0 text-xs font-semibold text-fg-muted">{entry.prompt.externalKey}</span>
          )}
          <span className="min-w-0 flex-1 truncate text-sm text-fg">{entry.prompt.title}</span>
          {gatePending && <GateGlyph pending className="shrink-0" />}
          {hasChildren && (
            <span className="hidden shrink-0 text-xs numeric text-fg-dim sm:inline">
              {entry.children.filter((item) => isTerminal(item)).length}/{entry.children.length}
            </span>
          )}
          {entry.childAttention !== null && (
            <Badge tone={TONE[entry.childAttention]}>
              {entry.childAttentionCount > 1 && `${entry.childAttentionCount} `}
              {LABEL[entry.childAttention].toLowerCase()}
            </Badge>
          )}
          <Badge tone={TONE[entry.operationalState]} pulse={entry.operationalState === "WORKING"}>
            {LABEL[entry.operationalState]}
          </Badge>
        </button>
        {onConfigure !== undefined && (
          <EditIconButton label={`Edit ${entry.prompt.externalKey ?? entry.prompt.title} in Studio`} onClick={() => onConfigure(entry.prompt.id)} className="shrink-0" />
        )}
      </li>
      {open &&
        entry.children.map((child) => (
          <Row
            key={child.prompt.id}
            entry={child}
            depth={depth + 1}
            expanded={expanded}
            selectedId={selectedId}
            currentId={currentId}
            onToggle={onToggle}
            onSelect={onSelect}
            onConfigure={onConfigure}
          />
        ))}
    </>
  );
}

function countFilters(items: OperationsPrompt[]) {
  let all = 0;
  let attention = 0;
  let working = 0;
  const walk = (list: OperationsPrompt[]) => {
    for (const item of list) {
      all += 1;
      if (needsYou(item)) attention += 1;
      if (item.operationalState === "WORKING") working += 1;
      walk(item.children);
    }
  };
  walk(items);
  return { all, attention, working };
}

function FilterChip({
  active,
  tone = "neutral",
  onClick,
  children,
}: {
  active: boolean;
  tone?: "neutral" | "warning" | "info";
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs ring-1 ring-inset transition-colors",
        active && tone === "warning" && "bg-warning/12 text-warning ring-warning/40",
        active && tone === "info" && "bg-info/12 text-info ring-info/40",
        active && tone === "neutral" && "bg-surface-3 text-fg ring-line-strong",
        !active && "text-fg-dim ring-line hover:bg-surface-2 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
