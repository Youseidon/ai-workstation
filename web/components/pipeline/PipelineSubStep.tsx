"use client";

import type { OperationsPrompt } from "@agent-console/shared";
import { StatusDot } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { LABEL, TONE } from "./status";

/**
 * The compact, read-only row a sub-step gets under its station. Sub-steps
 * were spawned by the station decomposing itself mid-run — they are real
 * tracked work items with their own history, but never a flowchart step of
 * their own, so they render smaller and nested rather than as a peer card.
 */
export function PipelineSubSteps({ items, onSelect }: { items: OperationsPrompt[]; onSelect?(promptId: number): void }) {
  if (items.length === 0) return null;
  const done = items.filter((item) => item.operationalState === "COMPLETE" || item.operationalState === "SKIPPED").length;

  return (
    <div className="mt-2 space-y-1 border-l border-dashed border-line pl-2.5">
      <div className="text-[10px] text-fg-dim">
        Sub-steps · {done}/{items.length} done
      </div>
      {items.map((item) => {
        const state = item.operationalState;
        const working = state === "WORKING";
        return (
          <div key={item.prompt.id}>
            <button
              type="button"
              disabled={onSelect === undefined}
              onClick={() => onSelect?.(item.prompt.id)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left",
                onSelect !== undefined && "hover:bg-surface-2",
              )}
            >
              <StatusDot tone={TONE[state]} pulse={working} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[11px] text-fg-muted",
                  state === "SKIPPED" && "line-through",
                )}
                title={item.prompt.title}
              >
                {item.prompt.externalKey ?? item.prompt.title}
              </span>
              <span className="shrink-0 text-[10px] text-fg-dim">{LABEL[state]}</span>
            </button>
            <PipelineSubSteps items={item.children} onSelect={onSelect} />
          </div>
        );
      })}
    </div>
  );
}
