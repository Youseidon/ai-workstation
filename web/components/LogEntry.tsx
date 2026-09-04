"use client";

import { useState } from "react";
import { formatElapsed, formatTokens } from "@agent-console/shared";
import { providerTheme } from "@/lib/providerTheme";
import type { LogItem } from "@/lib/log";
import { ProviderChip } from "./ProviderChip";
import { AgentAvatar, TypingCaret } from "./AgentAvatar";

function clock(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString("en-GB", { hour12: false });
}

function Gutter({ item, streaming = false }: { item: LogItem; streaming?: boolean }) {
  return (
    <div className="flex w-[232px] shrink-0 items-center gap-2 pt-px text-[10px] text-fg-dim">
      <span className="tabular-nums">{clock(item.timestamp)}</span>
      <AgentAvatar
        provider={item.provider}
        activity={streaming ? "speaking" : "idle"}
        size={16}
        title={item.provider}
      />
      <ProviderChip provider={item.provider} model={item.model} />
    </div>
  );
}

function stringifyInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/**
 * The database icon, drawn rather than typed.
 *
 * A glyph would inherit whatever the terminal font decided, and this mark has
 * to be recognisable at a glance in a fast-scrolling log — it is the one thing
 * that tells the operator an agent reached the app's own records rather than
 * the repository.
 */
function DatabaseIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden className={`shrink-0 ${className}`}>
      <ellipse cx="8" cy="3.6" rx="5.2" ry="2.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.8 3.6v8.8c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1V3.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.8 8c0 1.16 2.33 2.1 5.2 2.1s5.2-.94 5.2-2.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function LogEntry({ item, streaming = false }: { item: LogItem; streaming?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const theme = providerTheme[item.provider];

  if (item.kind === "prompt") {
    return (
      <div className="mt-6 flex gap-3 border-t border-line pt-4 first:mt-0 first:border-t-0 first:pt-0">
        <Gutter item={item} />
        <div className="min-w-0 flex-1">
          <div className="flex gap-2">
            <span className={theme.text}>❯</span>
            <span className="whitespace-pre-wrap break-words text-fg">{item.text}</span>
          </div>
        </div>
      </div>
    );
  }

  if (item.kind === "text") {
    return (
      <div className="mt-2 flex gap-3">
        <Gutter item={item} streaming={streaming} />
        <div
          className={[
            "min-w-0 flex-1 whitespace-pre-wrap break-words",
            item.textKind === "thinking" ? "italic text-fg-dim" : "text-fg",
          ].join(" ")}
        >
          {item.textKind === "thinking" && <span className="mr-1 not-italic">✻</span>}
          {item.text}
          {streaming && <TypingCaret />}
        </div>
      </div>
    );
  }

  if (item.kind === "tool") {
    const pending = item.result === null;
    const failed = item.result?.isError === true;
    const hasDetail = stringifyInput(item.input) !== "" || (item.result?.output ?? "") !== "";
    return (
      <div className="mt-2 flex gap-3">
        <Gutter item={item} />
        <div className={`min-w-0 flex-1 border-l pl-3 ${theme.rule}`}>
          <button
            type="button"
            disabled={!hasDetail}
            onClick={() => setExpanded((value) => !value)}
            className="flex w-full items-baseline gap-2 text-left disabled:cursor-default"
          >
            <span className={pending ? "text-fg-muted" : failed ? "text-danger" : "text-success"}>
              {pending ? "◐" : failed ? "✗" : "✓"}
            </span>
            <span className="shrink-0 font-semibold text-fg-muted">{item.name}</span>
            <span className="truncate text-fg-muted">{item.summary}</span>
            {hasDetail && (
              <span className="ml-auto shrink-0 pl-2 text-[10px] text-fg-dim">
                {expanded ? "▾" : "▸"}
              </span>
            )}
          </button>

          {expanded && (
            <div className="mt-2 space-y-2">
              {stringifyInput(item.input) !== "" && (
                <Block label="input" body={stringifyInput(item.input)} />
              )}
              {item.result !== null && item.result.output !== "" && (
                <Block
                  label={
                    item.result.exitCode === null
                      ? "output"
                      : `output · exit ${item.result.exitCode}`
                  }
                  body={item.result.output}
                  tone={item.result.isError ? "error" : "normal"}
                />
              )}
            </div>
          )}

          {!expanded && item.result !== null && item.result.summary !== "" && (
            <div
              className={[
                "mt-1 truncate text-[11px]",
                failed ? "text-danger/80" : "text-fg-dim",
              ].join(" ")}
            >
              ↳ {item.result.summary}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (item.kind === "error") {
    return (
      <div className="mt-2 flex gap-3">
        <Gutter item={item} />
        <div className="min-w-0 flex-1 rounded border border-danger/30 bg-danger/10 px-3 py-2">
          <div className="flex items-baseline gap-2 text-danger">
            <span>✗</span>
            <span className="break-words">{item.message}</span>
            {item.fatal && (
              <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-danger/70">
                fatal
              </span>
            )}
          </div>
          {item.detail !== null && item.detail !== "" && (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] text-danger/70">
              {item.detail}
            </pre>
          )}
        </div>
      </div>
    );
  }

  if (item.kind === "db") {
    // Tone follows the outcome, not the direction: a refused write is the one
    // an operator has to see, and a read that succeeded should stay quiet.
    const tone =
      item.outcome === "rejected"
        ? "text-danger"
        : item.direction === "write"
          ? "text-success"
          : "text-fg-dim";
    // Arrows point the way the data moved, so a write is distinguishable from a
    // read without reading the words.
    const arrow = item.direction === "write" ? "↑" : "↓";
    return (
      <div className="mt-1 flex gap-3">
        <Gutter item={item} />
        <div
          className={`flex min-w-0 flex-1 items-center gap-1.5 rounded border-l-2 py-0.5 pl-2 text-[11px] ${
            item.outcome === "rejected" ? "border-danger/50 bg-danger/5" : "border-accent/40 bg-accent/[0.04]"
          }`}
          title={`${item.method} ${item.operation} · ${item.httpStatus} · ${item.durationMs}ms`}
        >
          <DatabaseIcon className={tone} />
          <span className={`${tone} tabular-nums`}>{arrow}</span>
          <span className="shrink-0 text-fg-dim">{item.operation}</span>
          <span className="shrink-0 tabular-nums text-fg-dim/70">{item.httpStatus}</span>
          <span className="text-fg-dim/50">·</span>
          <span className={`truncate ${item.outcome === "rejected" ? "text-danger" : "text-fg"}`}>
            {item.outcome === "rejected" && item.errorCode !== null
              ? `refused: ${item.errorCode}`
              : item.summary}
          </span>
          {item.outcome === "replayed" && (
            <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-fg-dim/60">
              replayed
            </span>
          )}
          {item.changed.length > 0 && item.outcome !== "replayed" && (
            <span className="ml-auto shrink-0 text-[10px] text-fg-dim/60">
              {item.changed.join(" · ")}
            </span>
          )}
        </div>
      </div>
    );
  }

  const tone =
    item.state === "done"
      ? "text-success/80"
      : item.state === "interrupted"
        ? "text-warning/80"
        : "text-danger/80";

  return (
    <div className="mt-3 flex gap-3">
      <Gutter item={item} />
      <div className="flex min-w-0 flex-1 items-center gap-2 text-[11px]">
        <span className={tone}>■ {item.state}</span>
        <span className="text-fg-dim">· {formatElapsed(item.elapsedMs)}</span>
        {item.usage !== null && (
          <span className="text-fg-dim">
            · {formatTokens(item.usage.totalTokens)} tokens (↑
            {formatTokens(item.usage.inputTokens)} ↓{formatTokens(item.usage.outputTokens)})
          </span>
        )}
        <span className="ml-2 h-px flex-1 bg-line" />
      </div>
    </div>
  );
}

function Block({
  label,
  body,
  tone = "normal",
}: {
  label: string;
  body: string;
  tone?: "normal" | "error";
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-fg-dim">{label}</div>
      <pre
        className={[
          "max-h-72 overflow-auto rounded border px-2 py-1.5 text-[11px] leading-relaxed",
          "whitespace-pre-wrap break-words",
          tone === "error"
            ? "border-danger/20 bg-danger/5 text-danger/80"
            : "border-line bg-surface-1 text-fg-muted",
        ].join(" ")}
      >
        {body}
      </pre>
    </div>
  );
}
