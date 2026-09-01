"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
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
  /** Hard lock on the textarea: connection, workspace, missing directory. */
  disabled: boolean;
  /** True when an execute writer owns this workspace. */
  running: boolean;
  writer: { provider: ProviderId; model: string | null } | null;
  providers: ProviderInfo[];
  models: ModelSelection;
  selected: ProviderId;
  runBlockedReason: string | null;
  askBlockedReason: string | null;
  savedPrompt: PromptOption | null;
  /** Workspace / work-item chips rendered in the composer header. */
  context: ReactNode;
  /** Footer meta: workdir path shown next to provider · model. */
  workdir: string | null;
  onSubmit(prompt: string): void;
  onAsk(prompt: string): void;
  onInterrupt(): void;
  onTarget(provider: ProviderId, model: string | null): void;
  onClearSavedPrompt(): void;
}

/**
 * The composer.
 *
 * Run stays the primary execute action. Ask is a consult: it is available
 * while a writer owns the workspace, and it does not require a ready work item.
 * Context chips live in the header so choosing what to run sits next to the box.
 */
export function Composer({
  disabled,
  running,
  writer,
  providers,
  models,
  selected,
  runBlockedReason,
  askBlockedReason,
  savedPrompt,
  context,
  workdir,
  onSubmit,
  onAsk,
  onInterrupt,
  onTarget,
  onClearSavedPrompt,
}: Props) {
  const [value, setValue] = useState("");
  const [askQuestion, setAskQuestion] = useState("");
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = textareaRef.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [value]);

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

  const hasAskText = savedPrompt !== null || value.trim() !== "" || askQuestion.trim() !== "";
  const canRun = !running && runBlockedReason === null && (savedPrompt !== null || value.trim() !== "");
  const canAsk = askBlockedReason === null && hasAskText;

  const ask = () => {
    if (!canAsk) return;
    if (savedPrompt !== null) {
      onAsk(askQuestion.trim());
      setAskQuestion("");
      return;
    }
    if (value.trim() === "") return;
    onAsk(value.trim());
    setValue("");
    setCaret(0);
  };

  const submit = () => {
    if (running) {
      ask();
      return;
    }
    if (savedPrompt !== null && askQuestion.trim() !== "" && canAsk) {
      ask();
      return;
    }
    if (!canRun) {
      if (canAsk) ask();
      return;
    }
    if (savedPrompt !== null) {
      onSubmit("");
      return;
    }
    if (value.trim() === "") return;
    onSubmit(value.trim());
    setValue("");
    setCaret(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
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
  const writerLabel =
    writer === null
      ? null
      : [writer.provider, modelLabel(writer.provider, writer.model)].filter((part) => part !== null).join(" · ");
  const placeholder = disabled
    ? (runBlockedReason ?? askBlockedReason ?? "waiting for the backend…")
    : writer !== null
      ? `ask ${selected} about this tree…`
      : `ask ${selected} to do something…`;

  return (
    <div className="relative rounded-xl border border-line bg-surface-2 shadow-lg shadow-black/20 ring-1 ring-inset ring-line/60">
      {open && (
        <div
          role="listbox"
          aria-label="Run target"
          className="glass absolute bottom-full left-3 z-30 mb-2 w-80 animate-slide-up overflow-hidden rounded-lg shadow-2xl"
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

      <div className="border-b border-line px-3 py-2.5">{context}</div>

      <div className="px-3 pt-3">
        {writer !== null && writerLabel !== null && (
          <div className="mb-2 rounded-md bg-caution/10 px-2.5 py-1.5 text-[11px] text-caution ring-1 ring-inset ring-caution/30">
            A writer ({writerLabel}) is in this workspace. You are reading a live tree. Files may be
            mid-edit. Do not treat a partial file as final.
          </div>
        )}

        <div className="mb-2 flex flex-wrap items-center gap-2">
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

          {!running && runBlockedReason !== null && <Badge tone="warning">{runBlockedReason}</Badge>}
          {askBlockedReason !== null && (running || askBlockedReason !== runBlockedReason) && (
            <Badge tone="warning">{askBlockedReason}</Badge>
          )}

          <span className="ml-auto text-[10px] text-fg-dim">
            {savedPrompt === null
              ? `@ switches model · ⏎ ${running ? "ask" : "send"} · ⇧⏎ newline · / focus`
              : running
                ? "⏎ ask"
                : "⏎ run"}
          </span>
        </div>

        {savedPrompt === null ? (
          <textarea
            ref={textareaRef}
            rows={3}
            value={value}
            disabled={disabled}
            aria-label="Prompt"
            placeholder={placeholder}
            onChange={(event) => sync(event.target)}
            onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
            onClick={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            className="max-h-60 min-h-[88px] w-full resize-none rounded-lg bg-surface-1 px-3 py-3 text-[13px] text-fg ring-1 ring-inset ring-line placeholder:text-fg-dim focus:outline-none focus:ring-2 focus:ring-accent/70 disabled:opacity-50"
          />
        ) : (
          <div className="rounded-lg bg-surface-1 ring-1 ring-inset ring-line">
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
                text is never pasted into the transcript. Ask reads it even when the item is not ready.
              </p>
            )}
            <input
              type="text"
              value={askQuestion}
              disabled={disabled}
              aria-label="Research question"
              placeholder={`optional question — Ask ${selected} about this item`}
              onChange={(event) => setAskQuestion(event.target.value)}
              onKeyDown={onKeyDown}
              className="w-full border-t border-line bg-transparent px-3 py-2 text-[13px] text-fg placeholder:text-fg-dim focus:outline-none disabled:opacity-50"
            />
          </div>
        )}

        <div className="mt-3 flex items-center justify-end gap-2 pb-1">
          {running ? (
            <Button variant="danger" onClick={onInterrupt}>
              ■ Stop
            </Button>
          ) : (
            <Button variant="primary" size="lg" onClick={submit} disabled={!canRun}>
              {savedPrompt === null ? "Run" : "Run work item"}
            </Button>
          )}
          <span className="inline-flex" title={askBlockedReason ?? undefined}>
            <Button
              variant="secondary"
              size="lg"
              onClick={ask}
              disabled={!canAsk}
              className={canAsk ? theme.active : undefined}
            >
              Ask
            </Button>
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-2 text-[11px] text-fg-dim">
        <span className={cn("font-medium", theme.text)}>{selected}</span>
        <span>·</span>
        <span>{activeLabel ?? "default model"}</span>
        {workdir !== null && (
          <>
            <span className="text-fg-dim/50">·</span>
            <span className="max-w-[42ch] truncate" title={workdir}>
              {workdir}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
