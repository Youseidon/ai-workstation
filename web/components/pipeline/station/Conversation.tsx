"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { OperationsPrompt, PromptActivity } from "@agent-console/shared";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { buildThread, composerMode, type ThreadEntry } from "./thread";

export { buildThread, composerMode, type ComposerMode, type ThreadEntry } from "./thread";

const LONG_CHARS = 360;
const LONG_LINES = 6;
const COMPOSER_MAX_PX = 192;

export function Conversation({
  item,
  activity,
  busy,
  focusSignal,
  onAnswer,
  onNote,
}: {
  item: OperationsPrompt;
  activity: PromptActivity | null;
  busy: boolean;
  /** Bump to move keyboard focus into the composer. */
  focusSignal: number;
  onAnswer(text: string): Promise<boolean>;
  onNote(text: string): Promise<boolean>;
}) {
  const thread = useMemo(() => buildThread(item, activity), [item, activity]);
  const mode = composerMode(item);
  const gatePending = item.humanIntervention?.status === "PENDING";
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // A draft belongs to the item it was written for.
  const [draftFor, setDraftFor] = useState(item.prompt.id);
  if (draftFor !== item.prompt.id) {
    setDraftFor(item.prompt.id);
    setDraft("");
  }

  useEffect(() => {
    if (focusSignal > 0) textareaRef.current?.focus();
  }, [focusSignal]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [thread.length, item.prompt.id]);

  // Grow with the text up to a cap, then scroll inside. Never pushes the layout.
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, COMPOSER_MAX_PX)}px`;
  }, [draft]);

  const canSend = !busy && (mode === "answer" ? !gatePending || draft.trim() !== "" : draft.trim() !== "");
  const send = async () => {
    if (!canSend) return;
    const ok = mode === "answer" ? await onAnswer(draft) : await onNote(draft);
    if (ok) setDraft("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {thread.length === 0 ? (
          <p className="rounded-panel border border-dashed border-line px-4 py-8 text-center text-xs leading-5 text-fg-dim">
            Nothing has been asked or noted on this item yet.
            {mode === "note" && <><br />Write below to leave the agent a note for its next run.</>}
          </p>
        ) : (
          thread.map((entry) => <Bubble key={entry.id} entry={entry} />)
        )}
        <div ref={endRef} />
      </div>

      {mode !== "closed" && (
        <div className="shrink-0 border-t border-line bg-surface-1 p-3">
          <label htmlFor={`composer-${item.prompt.id}`} className="mb-1.5 block text-xs text-fg-dim">
            {gatePending
              ? "Your decision on the approval point"
              : mode === "answer"
                ? "Answer the agent — or send empty to retry with what it already has"
                : "Note for the agent's next run on this item"}
          </label>
          <div className="flex items-end gap-2">
            <textarea
              id={`composer-${item.prompt.id}`}
              ref={textareaRef}
              value={draft}
              rows={1}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder={mode === "answer" ? "Type your answer…" : "I already did X — skip it and continue with Y…"}
              style={{ maxHeight: COMPOSER_MAX_PX }}
              className="min-h-9 min-w-0 flex-1 resize-none overflow-y-auto rounded-md border border-line bg-surface-2 px-3 py-2 text-sm leading-5 text-fg outline-none placeholder:text-fg-dim focus:border-accent"
            />
            <Button
              variant={mode === "answer" ? "success" : "secondary"}
              disabled={!canSend}
              loading={busy}
              onClick={() => void send()}
              title="Ctrl/⌘ + Enter"
            >
              {mode === "answer" ? (draft.trim() === "" && !gatePending ? "Retry" : "Send & resume") : "Add note"}
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-fg-dim">Ctrl/⌘ + Enter to send. Keep secrets out of this box.</p>
        </div>
      )}
    </div>
  );
}

function Bubble({ entry }: { entry: ThreadEntry }) {
  const [expanded, setExpanded] = useState(false);
  const long = entry.text.length > LONG_CHARS || entry.text.split("\n").length > LONG_LINES;
  const mine = entry.speaker === "you";
  const gate = entry.speaker === "gate";

  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[88%] min-w-0 rounded-2xl px-3.5 py-2.5",
          mine && "rounded-br-md bg-accent/12 ring-1 ring-inset ring-accent/25",
          entry.speaker === "agent" && "rounded-bl-md bg-surface-2 ring-1 ring-inset ring-line",
          gate && "rounded-bl-md bg-warning/8 ring-1 ring-inset ring-warning/35",
          entry.open === true && "ring-2 ring-warning/50",
        )}
      >
        <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wider">
          {gate && <GateGlyph pending={entry.open === true} />}
          <span className={cn(gate || entry.open === true ? "text-warning" : mine ? "text-accent" : "text-fg-dim")}>
            {entry.label}
          </span>
          <time className="numeric normal-case tracking-normal text-fg-dim" dateTime={entry.at}>
            {formatWhen(entry.at)}
          </time>
          {entry.open === true && <span className="rounded-full bg-warning/15 px-1.5 text-warning">waiting</span>}
        </div>
        <p
          className={cn(
            "whitespace-pre-wrap break-words text-sm leading-5 text-fg",
            long && !expanded && "line-clamp-6",
          )}
        >
          {entry.text}
        </p>
        {long && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="mt-1 text-xs text-accent hover:underline"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
    </div>
  );
}

export function GateGlyph({ pending, className }: { pending: boolean; className?: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className={cn(pending ? "text-warning" : "text-success", className)}>
      <rect x="5" y="0.6" width="6.2" height="6.2" rx="1.2" transform="rotate(45 5 0.6)" fill="currentColor" />
    </svg>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
