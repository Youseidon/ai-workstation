"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ProviderId, ProviderInfo } from "@agent-console/shared";
import { modelLabel } from "@agent-console/shared";
import { providerTheme } from "@/lib/providerTheme";
import {
  allTargets,
  currentTargets,
  filterTargets,
  findMention,
  type MentionTarget,
} from "@/lib/mentions";
import type { ModelSelection } from "@/lib/useModelSelection";

interface Props {
  disabled: boolean;
  running: boolean;
  providers: ProviderInfo[];
  models: ModelSelection;
  /** The provider a send would currently go to, for the placeholder. */
  selected: ProviderId;
  onSubmit(prompt: string): void;
  onInterrupt(): void;
  /** Picking from the `@` popover retargets the header, not just this run. */
  onTarget(provider: ProviderId, model: string | null): void;
  lockedPrompt?: { id: number; title: string; content: string } | null;
}

export function PromptInput({
  disabled,
  running,
  providers,
  models,
  selected,
  onSubmit,
  onInterrupt,
  onTarget,
  lockedPrompt = null,
}: Props) {
  const [value, setValue] = useState("");
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the prompt, up to a few lines.
  useEffect(() => {
    const element = textareaRef.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [value]);

  useEffect(() => {
    if (!disabled) textareaRef.current?.focus();
  }, [disabled]);

  const mention = mentionDismissed ? null : findMention(value, caret);

  const suggestions = useMemo<MentionTarget[]>(() => {
    if (mention === null) return [];
    // A bare `@` lists providers as they stand; typing widens the search to
    // every catalogued model so `@haiku` or `@5.6` lands in one go.
    const pool = mention.query === "" ? currentTargets(providers, models) : allTargets(providers);
    return filterTargets(pool, mention.query).slice(0, 8);
  }, [mention, providers, models]);

  const open = mention !== null && suggestions.length > 0;
  const active = suggestions[Math.min(highlight, suggestions.length - 1)];

  // Reset the highlight during render (not in an effect) whenever the query
  // changes, so a shrinking list never leaves the selection out of range.
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
    const prompt = lockedPrompt?.content.trim() ?? value.trim();
    if (prompt === "" || disabled) return;
    onSubmit(prompt);
    if (lockedPrompt === null) { setValue(""); setCaret(0); }
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
    // Enter submits; Shift+Enter inserts a newline.
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const activeModel = models.resolve(selected);
  const activeLabel = modelLabel(selected, activeModel);

  return (
    <div className="relative flex items-end gap-2 border-t border-[#1d2229] bg-[#0b0d10] px-4 py-3">
      {open && (
        <div
          role="listbox"
          aria-label="Run target"
          className="absolute bottom-full left-4 z-30 mb-2 w-80 overflow-hidden rounded-md border border-[#252c35] bg-[#0e1115] shadow-xl shadow-black/50"
        >
          <div className="border-b border-[#1d2229] px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-[#4e5661]">
            run with…
          </div>
          {suggestions.map((entry, index) => {
            const isActive = entry === active;
            const theme = providerTheme[entry.provider];
            const label = modelLabel(entry.provider, entry.model) ?? "default";
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
                className={[
                  "flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-xs",
                  isActive ? "bg-[#161b21]" : "",
                  entry.available ? "" : "opacity-45",
                ].join(" ")}
              >
                <span className={`shrink-0 ${theme.text}`}>{entry.provider}</span>
                <span className="shrink-0 text-[#4e5661]">·</span>
                <span className="truncate text-[#d7dde5]">{label}</span>
                <span className="ml-auto shrink-0 truncate pl-2 text-[10px] text-[#5b636e]">
                  {entry.hint}
                </span>
              </button>
            );
          })}
          <div className="border-t border-[#1d2229] px-2.5 py-1 text-[10px] text-[#4e5661]">
            ↑↓ move · ⏎ / tab pick · esc dismiss
          </div>
        </div>
      )}

      <span className={`pb-2 ${providerTheme[selected].text}`}>❯</span>
      <textarea
        ref={textareaRef}
        rows={1}
        value={lockedPrompt?.content ?? value}
        readOnly={lockedPrompt !== null}
        disabled={disabled}
        placeholder={
          disabled
            ? running
              ? "run in progress — press Stop to interrupt"
              : "waiting for the backend…"
            : lockedPrompt !== null ? `Saved prompt: ${lockedPrompt.title}` : `ask ${selected}${activeLabel === null ? "" : ` (${activeLabel})`} to do something…  (@ to switch model, Enter to send)`
        }
        onChange={(event) => sync(event.target)}
        onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
        onClick={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        className="max-h-40 min-h-[38px] flex-1 resize-none rounded-md border border-[#1d2229] bg-[#101317] px-3 py-2 text-[#e7ecf2] placeholder:text-[#4e5661] focus:border-[#2f3742] focus:outline-none disabled:opacity-50"
      />
      {running ? (
        <button
          type="button"
          onClick={onInterrupt}
          className="h-[38px] shrink-0 rounded-md border border-red-500/40 bg-red-500/10 px-4 text-xs text-red-300 transition-colors hover:bg-red-500/20"
        >
          ■ Stop
        </button>
      ) : (
        <button
          type="button"
          onClick={submit}
          disabled={disabled || (lockedPrompt?.content ?? value).trim() === ""}
          className="h-[38px] shrink-0 rounded-md border border-[#2a323c] bg-[#181d24] px-4 text-xs text-[#c3cbd6] transition-colors hover:bg-[#20262e] disabled:opacity-40"
        >
          Send ⏎
        </button>
      )}
    </div>
  );
}
