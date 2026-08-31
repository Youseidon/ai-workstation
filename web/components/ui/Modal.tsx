"use client";

import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { useIsClient } from "@/lib/useIsClient";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export type ModalSize = "sm" | "md" | "lg" | "xl";

const SIZES: Record<ModalSize, string> = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
};

export interface ModalProps {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  description?: ReactNode;
  size?: ModalSize;
  /** Rendered in the footer, right-aligned. */
  footer?: ReactNode;
  /** Set false for flows that must be resolved by a button (destructive ops). */
  dismissible?: boolean;
  children?: ReactNode;
}

/**
 * An accessible modal dialog: portalled, focus-trapped, Escape-closable, and it
 * hands focus back to whatever opened it. This replaces the `window.confirm` /
 * `window.prompt` calls the app used to rely on, which cannot be styled, cannot
 * be themed, and block the whole browser tab.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  size = "md",
  footer,
  dismissible = true,
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const mounted = useIsClient();

  // Remember the trigger so focus can go back where the user left it.
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    return () => restoreRef.current?.focus?.();
  }, [open]);

  // Move focus into the dialog once it exists.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel === null) return;
    const first = panel.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel).focus();
  }, [open]);

  // Nothing behind the scrim should scroll.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape" && dismissible) {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (panel === null) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      // Wrap at both ends so Tab can never escape into the page behind.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [dismissible, onClose],
  );

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[8vh]"
      onKeyDown={onKeyDown}
    >
      <div
        aria-hidden
        onClick={dismissible ? onClose : undefined}
        style={{ background: "var(--backdrop)" }}
        className="fixed inset-0 animate-fade-in backdrop-blur-[2px]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        tabIndex={-1}
        className={cn(
          "glass relative w-full animate-slide-up rounded-xl shadow-2xl focus:outline-none",
          SIZES[size],
        )}
      >
        <header className="flex items-start gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-sm font-semibold text-fg">
              {title}
            </h2>
            {description !== undefined && (
              <p id={descriptionId} className="mt-1 text-xs leading-relaxed text-fg-muted">
                {description}
              </p>
            )}
          </div>
          {dismissible && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="-mr-1 -mt-1 rounded-md p-1.5 text-fg-dim transition-colors hover:bg-surface-3 hover:text-fg"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                <path
                  d="M3 3l8 8M11 3l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        </header>

        {children !== undefined && <div className="px-5 py-4">{children}</div>}

        {footer !== undefined && (
          <footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
