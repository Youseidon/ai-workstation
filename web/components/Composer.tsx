"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { PromptOption, ProviderId, ProviderInfo } from "@agent-console/shared";
import { modelLabel } from "@agent-console/shared";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/lib/providerTheme";
import {
  allTargets,
  currentTargets,
  filterTargets,
  findMention,
  type MentionTarget,
} from "@/lib/mentions";
import type { ModelSelection } from "@/lib/useModelSelection";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";

interface Props {
  disabled: boolean;
  running: boolean;
  providers: ProviderInfo[];
  models: ModelSelection;
  selected: ProviderId;
  /** Reason the composer is unavailable, shown instead of a bare disabled box. */
  blockedReason: string | null;
  savedPrompt: PromptOption | null;
  onSubmit(prompt: string): void;
  onInterrupt(): void;
  onTarget(provider: ProviderId, model: string | null): void;
  onClearSavedPrompt(): void;
}

/**
 * The composer.
 *
 * One card that owns everything a run needs: who it goes to, what context is
 * attached, and the single primary action. The previous version was a bare
 * textarea in a strip, and in saved-prompt mode it submitted the literal string
 * "saved prompt" while showing only a one-line title — so you could not see
 * what you were about to run.
 */
export function Composer({
  disabled,
  running,
  providers,
  models,
  selected,
  blockedReason,
  savedPrompt,
  onSubmit,
  onInterrupt,
  onTarget,
  onClearSavedPrompt,
}: Props) {
  const [value, setValue] = useState("");
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the prompt, up to a few lines.
  useEffect(() => {
    const element = textareaRef.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [value]);

  // `/` from anywhere focuses the composer, the way a search box does.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true]") !== null) return;
      event.preventDefault();
      textareaRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const mention = savedPrompt !== null || mentionDismissed ? null : findMention(value, caret);

  const suggestions = useMemo<MentionTarget[]>(() => {
    if (mention === null) return [];
    const pool = mention.query === "" ? currentTargets(providers, models) : allTargets(providers);
    return filterTargets(pool, mention.query).slice(0, 8);
  }, [mention, providers, models]);

  const open = mention !== null && suggestions.length > 0;
  const active = suggestions[Math.min(highlight, suggestions.length - 1)];

  const query = mention?.query ?? null;
  const [lastQuery, setLastQuery] = useState<string | null>(query);
  if (query !== lastQuery) {
    setLastQuery(query);
    setHighlight(0);
  }

  const sync = (element: HTMLTextAreaElement) => {
    setValue(element.value);
    setCaret(element.selectionStart);
    setMentionDismissed(false);
  };

  const applyTarget = (entry: MentionTarget) => {
    if (mention === null) return;
    onTarget(entry.provider, entry.model);
    // Strip the token so the mention never reaches the agent as prompt text.
    const next = `${value.slice(0, mention.start)}${value.slice(mention.end)}`.replace(/^\s+/, "");
    setValue(next);
    setMentionDismissed(true);
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (element === null) return;
      element.focus();
      const position = Math.min(mention.start, next.length);
      element.setSelectionRange(position, position);
      setCaret(position);
    });
  };

  const submit = () => {
    if (disabled) return;
    if (savedPrompt !== null) {
      onSubmit("");
      return;
    }
    if (value.trim() === "") return;
    onSubmit(value.trim());
    setValue("");
    setCaret(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlight((index) => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((index) => (index - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        if (active !== undefined) applyTarget(active);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionDismissed(true);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const theme = providerTheme[selected];
  const activeLabel = modelLabel(selected, models.resolve(selected));
  const canSend = !disabled && (savedPrompt !== null || value.trim() !== "");

  return (
    <div className="relative border-t border-line bg-surface-1 px-4 py-3">
      {open && (
        <div
          role="listbox"
          aria-label="Run target"
          className="glass absolute bottom-full left-4 z-30 mb-2 w-80 animate-slide-up overflow-hidden rounded-lg shadow-2xl"
        >
          <div className="border-b border-line px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-fg-dim">
            run with…
          </div>
          {suggestions.map((entry, index) => {
            const isActive = entry === active;
            const entryTheme = providerTheme[entry.provider];
            return (
              <button
                key={`${entry.provider}:${entry.model ?? "__default__"}`}
                type="button"
                role="option"
                aria-selected={isActive}
                onMouseEnter={() => setHighlight(index)}
                // mousedown, not click: the textarea must not blur first.
                onMouseDown={(event) => {
                  event.preventDefault();
                  applyTarget(entry);
                }}
                className={cn(
                  "flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-xs",
                  isActive && "bg-surface-3",
                  !entry.available && "opacity-45",
                )}
              >
                <span className={cn("shrink-0", entryTheme.text)}>{entry.provider}</span>
                <span className="shrink-0 text-fg-dim">·</span>
                <span className="truncate text-fg">
                  {modelLabel(entry.provider, entry.model) ?? "default"}
                </span>
                <span className="ml-auto shrink-0 truncate pl-2 text-[10px] text-fg-dim">
                  {entry.hint}
                </span>
              </button>
            );
          })}
          <div className="border-t border-line px-2.5 py-1 text-[10px] text-fg-dim">
            ↑↓ move · ⏎ / tab pick · esc dismiss
          </div>
        </div>
      )}

      {/* Target and attached context ---------------------------------------- */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className={cn("flex items-center gap-1.5 text-xs font-medium", theme.text)}>
          <span aria-hidden className={cn("size-2 rounded-full", theme.fill)} />
          {selected}
        </span>
        {activeLabel !== null && <span className="text-[11px] text-fg-dim">{activeLabel}</span>}

        {savedPrompt !== null && (
          <span className="flex items-center gap-1.5 rounded-full bg-surface-3 py-0.5 pl-2.5 pr-1 text-[11px] ring-1 ring-inset ring-line">
            <span className="text-fg-dim">context</span>
            <span className="max-w-[26ch] truncate text-fg">
              {savedPrompt.externalKey ?? savedPrompt.title}
            </span>
            <button
              type="button"
              onClick={onClearSavedPrompt}
              aria-label="Remove the attached work item"
              className="rounded-full p-0.5 text-fg-dim transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <svg width="10" height="10" viewBox="0 0 14 14" fill="none" aria-hidden>
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </span>
        )}

        {blockedReason !== null && <Badge tone="warning">{blockedReason}</Badge>}

        <span className="ml-auto text-[10px] text-fg-dim">
          {savedPrompt === null ? "@ switches model · ⏎ send · ⇧⏎ newline · / focus" : "⏎ run"}
        </span>
      </div>

      {/* Input, or a real preview of the work item -------------------------- */}
      {savedPrompt === null ? (
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={disabled}
          aria-label="Prompt"
          placeholder={
            disabled
              ? running
                ? "an agent is working in this workspace — stop it to send another"
                : (blockedReason ?? "waiting for the backend…")
              : `ask ${selected} to do something…`
          }
          onChange={(event) => sync(event.target)}
          onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
          onClick={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          className="max-h-52 min-h-[42px] w-full resize-none rounded-md bg-surface-2 px-3 py-2.5 text-[13px] text-fg ring-1 ring-inset ring-line placeholder:text-fg-dim focus:outline-none focus:ring-2 focus:ring-accent/70 disabled:opacity-50"
        />
      ) : (
        <div className="rounded-md bg-surface-2 ring-1 ring-inset ring-line">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            <span className="text-[13px] text-fg">
              {savedPrompt.externalKey !== null && (
                <span className="mr-1.5 font-semibold text-fg-muted">{savedPrompt.externalKey}</span>
              )}
              {savedPrompt.title}
            </span>
            <span className="text-[10px] text-fg-dim">
              {savedPrompt.programName} / {savedPrompt.suiteName}
            </span>
            <button
              type="button"
              onClick={() => setPreviewOpen((current) => !current)}
              aria-expanded={previewOpen}
              className="ml-auto flex items-center gap-1 text-[11px] text-fg-muted transition-colors hover:text-fg"
            >
              <span aria-hidden className="text-[9px]">{previewOpen ? "▾" : "▸"}</span>
              {previewOpen ? "Hide" : "Preview"} instruction
            </button>
          </div>
          {previewOpen ? (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-terminal text-fg-muted">
              {savedPrompt.content}
            </pre>
          ) : (
            <p className="px-3 py-2.5 text-[11px] leading-relaxed text-fg-dim">
              The agent loads this item&apos;s authoritative context from the database at run time — its
              text is never pasted into the transcript.
            </p>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center justify-end gap-2">
        {running ? (
          <Button variant="danger" onClick={onInterrupt}>
            ■ Stop
          </Button>
        ) : (
          <Button variant="primary" onClick={submit} disabled={!canSend}>
            {savedPrompt === null ? "Send ⏎" : "Run work item"}
          </Button>
        )}
      </div>
    </div>
  );
}
