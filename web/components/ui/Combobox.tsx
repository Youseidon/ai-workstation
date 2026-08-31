"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";
import { Badge, type Tone } from "./Badge";

export interface ComboboxItem<T> {
  value: T;
  /** The text shown when this item is selected, and what search matches on. */
  label: string;
  /** Secondary line in the list — path, context, whatever disambiguates. */
  description?: string;
  /** A short prefix, such as an external key. */
  prefix?: string;
  badge?: { text: string; tone: Tone };
  /** Extra note shown after the badge, e.g. what a blocked item waits on. */
  note?: string;
  disabled?: boolean;
  /** Additional text that should match a search but is not displayed. */
  keywords?: string;
}

interface Props<T> {
  label: string;
  value: T | null;
  items: ComboboxItem<T>[];
  onChange(value: T): void;
  placeholder?: string;
  disabled?: boolean;
  emptyText?: string;
  /** Rendered above the list, e.g. a "custom prompt" reset row. */
  leading?: ReactNode;
  className?: string;
  widthClass?: string;
}

/**
 * A searchable select.
 *
 * The native `<select>` this replaces had to cram an external key, a program, a
 * suite, a title, a status and a blocker list into one `<option>` string, which
 * the browser then truncated — and gave no way to search among hundreds of work
 * items. Here each row is structured, and typing filters.
 */
export function Combobox<T extends string | number>({
  label,
  value,
  items,
  onChange,
  placeholder = "Select…",
  disabled = false,
  emptyText = "Nothing to choose from.",
  leading,
  className,
  widthClass = "w-[26rem]",
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const labelId = useId();

  const selected = items.find((item) => item.value === value) ?? null;

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return items;
    return items.filter((item) =>
      `${item.prefix ?? ""} ${item.label} ${item.description ?? ""} ${item.keywords ?? ""}`
        .toLowerCase()
        .includes(needle),
    );
  }, [items, query]);

  // Keep the highlight inside the list as it shrinks while typing.
  const safeHighlight = Math.min(highlight, Math.max(filtered.length - 1, 0));

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setHighlight(0);
  }, []);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open, close]);

  const commit = (item: ComboboxItem<T>) => {
    if (item.disabled === true) return;
    onChange(item.value);
    close();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((index) => (filtered.length === 0 ? 0 : (index + 1) % filtered.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((index) =>
        filtered.length === 0 ? 0 : (index - 1 + filtered.length) % filtered.length,
      );
    } else if (event.key === "Home") {
      event.preventDefault();
      setHighlight(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setHighlight(Math.max(filtered.length - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = filtered[safeHighlight];
      if (item !== undefined) commit(item);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  return (
    <div ref={containerRef} className={cn("relative min-w-0", className)}>
      <span id={labelId} className="sr-only">
        {label}
      </span>
      <button
        type="button"
        disabled={disabled}
        aria-labelledby={labelId}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex h-8 w-full min-w-0 items-center gap-2 rounded-md bg-surface-2 px-2.5 text-left text-xs",
          "ring-1 ring-inset ring-line transition-colors",
          "hover:bg-surface-3 hover:ring-line-strong",
          "disabled:cursor-not-allowed disabled:opacity-50",
          open && "ring-accent/70",
        )}
      >
        {selected?.badge !== undefined && (
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              selected.badge.tone === "success" && "bg-success",
              selected.badge.tone === "warning" && "bg-warning",
              selected.badge.tone === "danger" && "bg-danger",
              selected.badge.tone === "info" && "bg-info",
              selected.badge.tone === "accent" && "bg-accent",
              selected.badge.tone === "violet" && "bg-violet",
              selected.badge.tone === "neutral" && "bg-fg-dim",
            )}
          />
        )}
        <span className={cn("min-w-0 flex-1 truncate", selected === null && "text-fg-dim")}>
          {selected === null ? placeholder : (
            <>
              {selected.prefix !== undefined && (
                <span className="mr-1.5 font-semibold text-fg-muted">{selected.prefix}</span>
              )}
              <span className="text-fg">{selected.label}</span>
            </>
          )}
        </span>
        <span aria-hidden className="shrink-0 text-[8px] text-fg-dim">▼</span>
      </button>

      {open && (
        <div
          className={cn(
            "glass absolute left-0 top-full z-40 mt-1.5 max-w-[calc(100vw-2rem)] animate-slide-up overflow-hidden rounded-lg shadow-2xl",
            widthClass,
          )}
        >
          <div className="border-b border-line p-1.5">
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={
                filtered[safeHighlight] === undefined ? undefined : `${listId}-${safeHighlight}`
              }
              value={query}
              placeholder={`Search ${label.toLowerCase()}…`}
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlight(0);
              }}
              onKeyDown={onKeyDown}
              className="h-7 w-full rounded bg-surface-1 px-2 text-xs text-fg ring-1 ring-inset ring-line placeholder:text-fg-dim focus:outline-none focus:ring-accent/70"
            />
          </div>

          {leading}

          <ul id={listId} role="listbox" aria-labelledby={labelId} className="max-h-72 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <li className="px-2.5 py-3 text-xs text-fg-dim">{emptyText}</li>
            ) : (
              filtered.map((item, index) => (
                <li key={String(item.value)}>
                  <button
                    type="button"
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={item.value === value}
                    aria-disabled={item.disabled === true}
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => commit(item)}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left",
                      index === safeHighlight && "bg-surface-3",
                      item.disabled === true && "opacity-45",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        {item.prefix !== undefined && (
                          <span className="font-semibold text-fg-muted">{item.prefix}</span>
                        )}
                        <span className="truncate text-xs text-fg">{item.label}</span>
                        {item.badge !== undefined && (
                          <Badge tone={item.badge.tone}>{item.badge.text}</Badge>
                        )}
                      </span>
                      {item.description !== undefined && (
                        <span className="mt-0.5 block truncate text-[10.5px] text-fg-dim">
                          {item.description}
                        </span>
                      )}
                      {item.note !== undefined && (
                        <span className="mt-0.5 block truncate text-[10.5px] text-warning">
                          {item.note}
                        </span>
                      )}
                    </span>
                    {item.value === value && (
                      <span aria-hidden className="shrink-0 text-accent">✓</span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>

          <div className="border-t border-line px-2.5 py-1 text-[10px] text-fg-dim">
            ↑↓ move · ⏎ select · esc close
          </div>
        </div>
      )}
    </div>
  );
}
