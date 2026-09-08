"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { OperationsPrompt, OperationsSuite } from "@agent-console/shared";
import { LABEL, TONE } from "@/components/pipeline/status";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import {
  ancestorIdsForPrompt,
  countStations,
  countSubSteps,
  filterPromptTree,
  isTerminal,
  type TasksFilter,
} from "@/components/tasks/tree";

export type { TasksFilter };

const EXPANDED_KEY = "agent-console.tasks-expanded";
const EXPANDED_EVENT = "agent-console.tasks-expanded";

function parseExpanded(raw: string | null): number[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is number => Number.isSafeInteger(id));
  } catch {
    return [];
  }
}

function readExpandedRaw(): string {
  try {
    return window.localStorage.getItem(EXPANDED_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

function writeExpanded(ids: Iterable<number>): void {
  try {
    window.localStorage.setItem(EXPANDED_KEY, JSON.stringify([...ids]));
    window.dispatchEvent(new Event(EXPANDED_EVENT));
  } catch {
    // Ignore storage failures (private mode, quota, etc.).
  }
}

function subscribeExpanded(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(EXPANDED_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(EXPANDED_EVENT, onChange);
  };
}

function useExpandedIds(): [Set<number>, (promptId: number) => void] {
  const raw = useSyncExternalStore(subscribeExpanded, readExpandedRaw, () => "[]");
  const ids = useMemo(() => new Set(parseExpanded(raw)), [raw]);
  const toggle = (promptId: number) => {
    const next = new Set(ids);
    if (next.has(promptId)) next.delete(promptId);
    else next.add(promptId);
    writeExpanded(next);
  };
  return [ids, toggle];
}

export function WorkItemList({
  suite,
  filter,
  activePromptId,
  busy,
  providerLabel,
  canAct,
  onFilterChange,
  onSelect,
  onRun,
  onStop,
  onRecover,
  onRespond,
}: {
  suite: OperationsSuite;
  filter: TasksFilter;
  activePromptId: number | null;
  busy: boolean;
  providerLabel: string;
  canAct(entry: OperationsPrompt): boolean;
  onFilterChange(filter: TasksFilter): void;
  onSelect(promptId: number): void;
  onRun(entry: OperationsPrompt): void;
  onStop(entry: OperationsPrompt): void;
  onRecover(entry: OperationsPrompt): void;
  onRespond(entry: OperationsPrompt): void;
}) {
  const needsYou = suite.attentionCount;
  const working = suite.counts.WORKING;
  const visible = useMemo(() => filterPromptTree(suite.prompts, filter), [suite.prompts, filter]);
  const stations = countStations(visible);
  const subSteps = countSubSteps(visible);
  const stationTotal = suite.prompts.length;

  const [expanded, toggleExpanded] = useExpandedIds();

  // Deep links / child selection open ancestor rows via localStorage (no React setState).
  useEffect(() => {
    if (activePromptId === null) return;
    const ancestors = ancestorIdsForPrompt(suite.prompts, activePromptId);
    if (ancestors.length === 0) return;
    const next = new Set(parseExpanded(readExpandedRaw()));
    let changed = false;
    for (const id of ancestors) {
      if (!next.has(id)) {
        next.add(id);
        changed = true;
      }
    }
    if (changed) writeExpanded(next);
  }, [activePromptId, suite.prompts]);

  return (
    <section className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
          Work items · {stations.total} station{stations.total === 1 ? "" : "s"}
          {subSteps.total > 0 && (
            <span className="font-normal normal-case tracking-normal text-fg-dim">
              {" "}
              · {subSteps.total} sub-step{subSteps.total === 1 ? "" : "s"}
            </span>
          )}
          {filter !== "all" && (
            <span className="ml-1 font-normal normal-case tracking-normal text-fg-dim">
              of {stationTotal}
            </span>
          )}
        </h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip active={filter === "all"} onClick={() => onFilterChange("all")}>
            All
          </FilterChip>
          <FilterChip active={filter === "attention"} tone="warning" onClick={() => onFilterChange("attention")}>
            Needs you {needsYou}
          </FilterChip>
          <FilterChip active={filter === "working"} tone="info" onClick={() => onFilterChange("working")}>
            Working {working}
          </FilterChip>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-panel border border-line bg-surface-1 p-4 text-sm text-fg-dim">
          {filter === "all"
            ? "This suite has no work items."
            : filter === "attention"
              ? "Nothing needs you right now."
              : "Nothing is working right now."}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {visible.map((entry) => (
            <TreeRows
              key={entry.prompt.id}
              entry={entry}
              depth={0}
              expanded={expanded}
              activePromptId={activePromptId}
              busy={busy}
              providerLabel={providerLabel}
              canAct={canAct}
              onToggle={toggleExpanded}
              onSelect={onSelect}
              onRun={onRun}
              onStop={onStop}
              onRecover={onRecover}
              onRespond={onRespond}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function TreeRows({
  entry,
  depth,
  expanded,
  activePromptId,
  busy,
  providerLabel,
  canAct,
  onToggle,
  onSelect,
  onRun,
  onStop,
  onRecover,
  onRespond,
}: {
  entry: OperationsPrompt;
  depth: number;
  expanded: Set<number>;
  activePromptId: number | null;
  busy: boolean;
  providerLabel: string;
  canAct(entry: OperationsPrompt): boolean;
  onToggle(promptId: number): void;
  onSelect(promptId: number): void;
  onRun(entry: OperationsPrompt): void;
  onStop(entry: OperationsPrompt): void;
  onRecover(entry: OperationsPrompt): void;
  onRespond(entry: OperationsPrompt): void;
}) {
  const hasChildren = entry.children.length > 0;
  const open = hasChildren && expanded.has(entry.prompt.id);
  const childDone = entry.children.filter(isTerminal).length;

  return (
    <>
      <li>
        <div
          className={cn(
            "flex flex-wrap items-center gap-2 rounded-panel border px-3 py-2.5 transition-colors",
            activePromptId === entry.prompt.id
              ? "border-line-strong bg-surface-3"
              : "border-line bg-surface-1 hover:bg-surface-2",
          )}
          style={depth > 0 ? { marginLeft: depth * 16 } : undefined}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={() => onToggle(entry.prompt.id)}
              aria-expanded={open}
              aria-label={open ? "Collapse sub-steps" : "Expand sub-steps"}
              className="flex size-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-surface-3 hover:text-fg"
            >
              <span aria-hidden className="text-[10px]">
                {open ? "▾" : "▸"}
              </span>
            </button>
          ) : (
            <span className="size-6 shrink-0" aria-hidden />
          )}

          <button
            type="button"
            onClick={() => onSelect(entry.prompt.id)}
            aria-current={activePromptId === entry.prompt.id ? "true" : undefined}
            className="min-w-0 flex-1 text-left"
          >
            <div className="flex flex-wrap items-center gap-2">
              {entry.prompt.externalKey !== null && (
                <span className="shrink-0 text-[11px] font-semibold text-fg-muted">
                  {entry.prompt.externalKey}
                </span>
              )}
              <span className="truncate text-[13px] text-fg">{entry.prompt.title}</span>
              <Badge tone={TONE[entry.operationalState]}>{LABEL[entry.operationalState]}</Badge>
              {hasChildren && (
                <span className="text-[10px] text-fg-dim">
                  {childDone}/{entry.children.length} sub-steps
                </span>
              )}
              {entry.childAttention !== null && (
                <Badge tone={TONE[entry.childAttention]}>
                  {entry.childAttentionCount > 1 && `${entry.childAttentionCount} `}
                  {LABEL[entry.childAttention].toLowerCase()}
                </Badge>
              )}
            </div>
            <div className="mt-1 text-[10px] text-fg-dim">
              {new Date(entry.lastActivityAt).toLocaleString()}
              {entry.latestIntervention !== null && (
                <span className="ml-2 text-warning">{entry.latestIntervention}</span>
              )}
            </div>
          </button>

          <RowAction
            entry={entry}
            busy={busy}
            providerLabel={providerLabel}
            canAct={canAct(entry)}
            onRun={() => onRun(entry)}
            onStop={() => onStop(entry)}
            onRecover={() => onRecover(entry)}
            onRespond={() => onRespond(entry)}
          />
        </div>
      </li>
      {open &&
        entry.children.map((child) => (
          <TreeRows
            key={child.prompt.id}
            entry={child}
            depth={depth + 1}
            expanded={expanded}
            activePromptId={activePromptId}
            busy={busy}
            providerLabel={providerLabel}
            canAct={canAct}
            onToggle={onToggle}
            onSelect={onSelect}
            onRun={onRun}
            onStop={onStop}
            onRecover={onRecover}
            onRespond={onRespond}
          />
        ))}
    </>
  );
}

function RowAction({
  entry,
  busy,
  providerLabel,
  canAct,
  onRun,
  onStop,
  onRecover,
  onRespond,
}: {
  entry: OperationsPrompt;
  busy: boolean;
  providerLabel: string;
  canAct: boolean;
  onRun(): void;
  onStop(): void;
  onRecover(): void;
  onRespond(): void;
}) {
  if (entry.operationalState === "READY") {
    return (
      <Button size="sm" variant="success" disabled={!canAct || busy} onClick={onRun}>
        Run
      </Button>
    );
  }
  if (entry.operationalState === "WORKING" && entry.prompt.currentRun !== null) {
    return (
      <Button size="sm" variant="danger" disabled={busy} onClick={onStop}>
        Stop
      </Button>
    );
  }
  if (entry.prompt.recoverable) {
    return (
      <Button size="sm" variant="secondary" disabled={busy} onClick={onRecover} title={`Recover with ${providerLabel}`}>
        Recover and resume
      </Button>
    );
  }
  if (entry.operationalState === "BLOCKED") {
    return (
      <Button size="sm" variant="secondary" disabled={busy} onClick={onRespond}>
        Respond
      </Button>
    );
  }
  return null;
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
        "rounded-md px-2.5 py-1 text-xs ring-1 ring-inset transition-colors",
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
