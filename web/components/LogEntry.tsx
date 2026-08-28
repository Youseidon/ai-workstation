"use client";

import { useState } from "react";
import { formatElapsed, formatTokens } from "@agent-console/shared";
import { providerTheme } from "@/lib/providerTheme";
import type { LogItem } from "@/lib/log";
import { ProviderChip } from "./ProviderChip";

function clock(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString("en-GB", { hour12: false });
}

function Gutter({ item }: { item: LogItem }) {
  return (
    <div className="flex w-[216px] shrink-0 items-center gap-2 pt-px text-[10px] text-[#5b636e]">
      <span className="tabular-nums">{clock(item.timestamp)}</span>
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

export function LogEntry({ item }: { item: LogItem }) {
  const [expanded, setExpanded] = useState(false);
  const theme = providerTheme[item.provider];

  if (item.kind === "prompt") {
    return (
      <div className="mt-6 flex gap-3 border-t border-[#1d2229] pt-4 first:mt-0 first:border-t-0 first:pt-0">
        <Gutter item={item} />
        <div className="min-w-0 flex-1">
          <div className="flex gap-2">
            <span className={theme.text}>❯</span>
            <span className="whitespace-pre-wrap break-words text-[#f0f4f9]">{item.text}</span>
          </div>
        </div>
      </div>
    );
  }

  if (item.kind === "text") {
    return (
      <div className="mt-2 flex gap-3">
        <Gutter item={item} />
        <div
          className={[
            "min-w-0 flex-1 whitespace-pre-wrap break-words",
            item.textKind === "thinking" ? "italic text-[#6d7681]" : "text-[#d7dde5]",
          ].join(" ")}
        >
          {item.textKind === "thinking" && <span className="mr-1 not-italic">✻</span>}
          {item.text}
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
            <span className={pending ? "text-[#7d8794]" : failed ? "text-red-400" : "text-emerald-400"}>
              {pending ? "◐" : failed ? "✗" : "✓"}
            </span>
            <span className="shrink-0 font-semibold text-[#c3cbd6]">{item.name}</span>
            <span className="truncate text-[#7d8794]">{item.summary}</span>
            {hasDetail && (
              <span className="ml-auto shrink-0 pl-2 text-[10px] text-[#4e5661]">
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
                failed ? "text-red-400/80" : "text-[#5b636e]",
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
        <div className="min-w-0 flex-1 rounded border border-red-500/30 bg-red-500/10 px-3 py-2">
          <div className="flex items-baseline gap-2 text-red-300">
            <span>✗</span>
            <span className="break-words">{item.message}</span>
            {item.fatal && (
              <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wider text-red-400/70">
                fatal
              </span>
            )}
          </div>
          {item.detail !== null && item.detail !== "" && (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px] text-red-200/70">
              {item.detail}
            </pre>
          )}
        </div>
      </div>
    );
  }

  const tone =
    item.state === "done"
      ? "text-emerald-400/80"
      : item.state === "interrupted"
        ? "text-amber-400/80"
        : "text-red-400/80";

  return (
    <div className="mt-3 flex gap-3">
      <Gutter item={item} />
      <div className="flex min-w-0 flex-1 items-center gap-2 text-[11px]">
        <span className={tone}>■ {item.state}</span>
        <span className="text-[#5b636e]">· {formatElapsed(item.elapsedMs)}</span>
        {item.usage !== null && (
          <span className="text-[#5b636e]">
            · {formatTokens(item.usage.totalTokens)} tokens (↑
            {formatTokens(item.usage.inputTokens)} ↓{formatTokens(item.usage.outputTokens)})
          </span>
        )}
        <span className="ml-2 h-px flex-1 bg-[#1a1f26]" />
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
      <div className="mb-1 text-[10px] uppercase tracking-wider text-[#4e5661]">{label}</div>
      <pre
        className={[
          "max-h-72 overflow-auto rounded border px-2 py-1.5 text-[11px] leading-relaxed",
          "whitespace-pre-wrap break-words",
          tone === "error"
            ? "border-red-500/20 bg-red-500/5 text-red-200/80"
            : "border-[#1d2229] bg-[#0e1115] text-[#9aa4b1]",
        ].join(" ")}
      >
        {body}
      </pre>
    </div>
  );
}
