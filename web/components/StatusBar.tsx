"use client";

import { formatElapsed, formatTokens, modelLabel, type ProviderInfo } from "@agent-console/shared";
import type { ConnectionState, RunStatus } from "@/lib/useAgentConsole";
import { providerTheme } from "@/lib/providerTheme";

interface Props {
  connection: ConnectionState;
  provider: ProviderInfo | undefined;
  /** Model the next run would use — not necessarily the one running now. */
  model: string | null;
  run: RunStatus | null;
  lastRun: RunStatus | null;
  workdir: string | null;
}

export function StatusBar({ connection, provider, model, run, lastRun, workdir }: Props) {
  const active = run ?? lastRun;
  const theme = provider ? providerTheme[provider.id] : null;
  const usage = active?.usage ?? null;
  // Cursor does not report usage: show nothing rather than a fabricated zero.
  const showTokens = usage !== null && provider?.reportsTokens !== false;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[#1d2229] bg-[#0e1115] px-4 py-2 text-[11px]">
      <span className="flex items-center gap-1.5">
        <span
          className={[
            "size-1.5 rounded-full",
            connection === "open"
              ? "bg-emerald-400"
              : connection === "connecting"
                ? "bg-amber-400 animate-pulse"
                : "bg-red-500",
          ].join(" ")}
        />
        <span className={connection === "disconnected" ? "text-red-400" : "text-[#7d8794]"}>
          {connection === "open"
            ? "connected"
            : connection === "connecting"
              ? "connecting…"
              : "disconnected — retrying"}
        </span>
      </span>

      <span className="text-[#3a424c]">│</span>

      {run !== null ? (
        <span className="flex items-center gap-2">
          <span className="inline-block size-1.5 animate-pulse rounded-full bg-current text-emerald-400" />
          <span className="text-[#d7dde5]">
            Running (<span className={theme?.text ?? ""}>{run.provider}</span>
            {modelLabel(run.provider, run.model) !== null && (
              <span className="text-[#7d8794]"> · {modelLabel(run.provider, run.model)}</span>
            )}
            )…
          </span>
          <span className="tabular-nums text-[#9aa4b1]">{formatElapsed(run.elapsedMs)}</span>
          {showTokens && usage !== null && (
            <span className="tabular-nums text-[#7d8794]">
              · ↓{formatTokens(usage.totalTokens)} tokens
            </span>
          )}
          {run.detail !== null && (
            <span className="max-w-[28ch] truncate text-[#5b636e]">· {run.detail}</span>
          )}
        </span>
      ) : (
        <span className="flex items-center gap-2 text-[#7d8794]">
          <span>idle</span>
          {provider && (
            <span>
              · <span className={theme?.text ?? ""}>{provider.id}</span>
              <span className="text-[#9aa4b1]">
                {" "}
                {modelLabel(provider.id, model) ?? "default model"}
              </span>
              {provider.version !== null && <span className="text-[#5b636e]"> {provider.version}</span>}
            </span>
          )}
          {lastRun !== null && (
            <span className="text-[#5b636e]">
              · last run {lastRun.state} in {formatElapsed(lastRun.elapsedMs)}
              {showTokens && usage !== null ? ` · ${formatTokens(usage.totalTokens)} tokens` : ""}
            </span>
          )}
        </span>
      )}

      <span className="ml-auto flex items-center gap-3 text-[#4e5661]">
        {provider && <span title="permission / approval mode">{provider.permissionMode}</span>}
        {workdir !== null && (
          <span className="max-w-[42ch] truncate" title={workdir}>
            {workdir}
          </span>
        )}
      </span>
    </div>
  );
}
