"use client";

import { cn } from "@/lib/cn";

/**
 * The small pencil that opens something's settings. Sits beside a card's own
 * click target (never inside it: buttons cannot nest), quiet until the card is
 * hovered or the pencil is focused.
 */
export function EditIconButton({ label, onClick, className }: {
  /** Accessible name, e.g. "Edit S1-02 in Studio". */
  label: string;
  onClick(): void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      className={cn("edit-icon-button", className)}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="m13.5 6.5 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </button>
  );
}
