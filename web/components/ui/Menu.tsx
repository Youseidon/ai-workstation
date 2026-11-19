"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";
import { MoreIcon } from "./icons";

export interface MenuItem {
  id: string;
  label: ReactNode;
  onSelect(): void;
  disabled?: boolean;
  /** Shown as a tooltip — use it to say why an item is disabled. */
  title?: string;
  tone?: "default" | "danger";
  /** Draws a divider above this item. */
  separated?: boolean;
  hint?: ReactNode;
  /** Extra classes for the row, e.g. to show an item only at some widths. */
  className?: string;
}

/**
 * A small overflow menu: a trigger button and a list of actions. Closes on
 * outside click, Escape, and selection. Arrow keys move between items.
 */
export function Menu({
  items,
  label,
  trigger,
  align = "right",
  placement = "below",
  size = "sm",
  variant = "ghost",
  className,
  portal = false,
}: {
  items: MenuItem[];
  /** Accessible name for the trigger. */
  label: string;
  /** Trigger content; defaults to an ellipsis. */
  trigger?: ReactNode;
  align?: "left" | "right";
  placement?: "below" | "above";
  size?: ButtonSize;
  variant?: ButtonVariant;
  className?: string;
  /** Escape a scrolling thread list without clipping its row actions. */
  portal?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [portalTarget,setPortalTarget] = useState<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node) && !listRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        rootRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    listRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useLayoutEffect(() => {
    if(!open || !portal) return;
    const position=() => {
      const root=rootRef.current, list=listRef.current;
      if(!root || !list) return;
      const rect=root.getBoundingClientRect();
      list.style.maxWidth=`${window.innerWidth-16}px`;
      list.style.maxHeight=`${window.innerHeight-16}px`;
      const width=list.offsetWidth, height=list.offsetHeight;
      const above=placement === "above" ? rect.top >= height+8 || window.innerHeight-rect.bottom < height+8 : window.innerHeight-rect.bottom < height+8 && rect.top >= height+8;
      list.style.top=`${Math.max(8,Math.min(window.innerHeight-height-8,above ? rect.top-height-4 : rect.bottom+4))}px`;
      list.style.left=`${Math.max(8,Math.min(window.innerWidth-width-8,align === "right" ? rect.right-width : rect.left))}px`;
    };
    position();
    window.addEventListener("resize",position);
    window.addEventListener("scroll",position,true);
    return () => { window.removeEventListener("resize",position); window.removeEventListener("scroll",position,true); };
  },[open,portal,align,placement]);

  const moveFocus = (delta: number) => {
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + delta + buttons.length) % buttons.length]?.focus();
  };

  const list = open ? (
        <ul
          ref={listRef}
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveFocus(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveFocus(-1);
            }
          }}
          className={cn(
            "z-40 min-w-52 rounded-md border border-line bg-surface-1 py-1 shadow-xl",
            portal ? "fixed overflow-y-auto" : "absolute overflow-hidden",
            !portal && (align === "right" ? "right-0" : "left-0"),
            !portal && (placement === "below" ? "top-full mt-1" : "bottom-full mb-1"),
          )}
        >
          {items.map((item) => (
            <li key={item.id} role="none" className={cn(item.separated && "mt-1 border-t border-line pt-1", item.className)}>
              <button
                type="button"
                role="menuitem"
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  rootRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
                  setOpen(false);
                  item.onSelect();
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs transition-colors outline-none",
                  "disabled:cursor-not-allowed disabled:opacity-45",
                  item.tone === "danger"
                    ? "text-danger/90 hover:bg-danger/10 focus-visible:bg-danger/10"
                    : "text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:bg-surface-2 focus-visible:text-fg",
                )}
              >
                <span>{item.label}</span>
                {item.hint !== undefined && <span className="text-xs text-fg-dim">{item.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : null;

  return <div ref={rootRef} className={cn("relative",className)}>
    <Button size={size} variant={variant} iconOnly={trigger === undefined} aria-label={label} title={label}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      iconLeft={trigger === undefined ? <MoreIcon /> : undefined} onClick={event => {
        if(portal) setPortalTarget(event.currentTarget.closest("dialog") ?? document.body);
        setOpen(value => !value);
      }}>{trigger}</Button>
    {portal && list && portalTarget ? createPortal(list,portalTarget) : list}
  </div>;
}
