"use client";

import { useEffect, useRef } from "react";

export interface BoardKeyHandlers {
  /** Item ids in the order they are drawn. */
  order: number[];
  selectedId: number | null;
  panelOpen: boolean;
  select(promptId: number): void;
  reply(promptId: number): void;
  closePanel(): void;
  /** Space: play or pause. Omit where there is no transport. */
  toggleRun?(): void;
}

/**
 * The board's keyboard: j/k move through items, Enter opens the selected one,
 * r replies to it, Space plays or pauses, Esc closes the panel. Ignored while
 * typing, and while a dialog or menu is open (those own their keys).
 */
export function useBoardKeys(handlers: BoardKeyHandlers): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (document.querySelector('[role="dialog"], [role="menu"]') !== null) return;
      const state = latest.current;
      const move = (delta: number) => {
        if (state.order.length === 0) return;
        const index = state.selectedId === null ? -1 : state.order.indexOf(state.selectedId);
        const next = state.order[Math.max(0, Math.min(state.order.length - 1, index + delta))];
        if (next !== undefined) state.select(next);
      };
      if (event.key === "j") move(1);
      else if (event.key === "k") move(-1);
      else if (event.key === "Enter" && target?.tagName !== "BUTTON" && state.selectedId !== null) state.select(state.selectedId);
      else if (event.key === "r" && state.selectedId !== null) state.reply(state.selectedId);
      else if (event.key === " " && target?.tagName !== "BUTTON" && state.toggleRun !== undefined) state.toggleRun();
      else if (event.key === "Escape" && state.panelOpen) state.closePanel();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
