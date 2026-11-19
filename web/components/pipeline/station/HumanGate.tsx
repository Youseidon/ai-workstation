"use client";

import type { HumanInterventionStep } from "@agent-console/shared";
import { cn } from "@/lib/cn";

/**
 * An approval point, drawn on the arrow between two stations rather than as a
 * card of its own. It is a fixed-size marker, so neither the question nor the
 * answer can stretch the flowchart; both live in the item's Conversation tab.
 *
 * Amber and pulsing while it waits, green once answered. Hover shows the first
 * lines of what it asks; click opens the conversation to answer it.
 */
export function HumanGate({
  step,
  selected,
  onOpen,
}: {
  step: HumanInterventionStep;
  selected: boolean;
  onOpen(): void;
}) {
  const pending = step.status === "PENDING";
  return (
    <div className="group/gate relative">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        aria-label={pending ? "Approval point — waiting on you. Open to answer." : "Approval point — answered. Open conversation."}
        className={cn(
          "relative grid size-7 place-items-center rounded-md shadow-md ring-1 ring-inset transition-transform",
          "rotate-45 hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          pending ? "bg-warning text-surface-0 ring-warning/60" : "bg-success/90 text-surface-0 ring-success/60",
          selected && "outline-2 outline-offset-2 outline-accent",
        )}
      >
        {pending && <span aria-hidden className="absolute inset-0 animate-ping rounded-md bg-warning/40" />}
        <span aria-hidden className="relative -rotate-45 text-xs leading-none font-semibold">
          {pending ? "?" : "✓"}
        </span>
      </button>

      {/* Hover preview: three lines at most, so it can never become a wall of text. */}
      <div
        role="tooltip"
        className={cn(
          "pointer-events-none absolute top-full left-1/2 z-30 mt-2 hidden w-64 -translate-x-1/2 rounded-panel border bg-surface-1 p-2.5 text-left shadow-xl",
          "group-hover/gate:block group-focus-within/gate:block",
          pending ? "border-warning/40" : "border-success/35",
        )}
      >
        <div className={cn("text-xs uppercase tracking-wider", pending ? "text-warning" : "text-success")}>
          {pending ? "Approval point · waiting on you" : "Approval point · answered"}
        </div>
        <p className="mt-1 line-clamp-3 text-xs leading-4 text-fg-muted">{step.requiredAction}</p>
        {!pending && step.response !== null && (
          <p className="mt-1.5 line-clamp-2 border-t border-line pt-1.5 text-xs leading-4 text-fg-dim">
            <span className="text-fg-muted">You: </span>
            {step.response}
          </p>
        )}
        <p className="mt-1.5 text-xs text-accent">{pending ? "Click to answer ›" : "Click for the conversation ›"}</p>
      </div>
    </div>
  );
}
