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
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-surface-1 px-4 py-2 text-[11px]">
      <span className="flex items-center gap-1.5">
        <span
          className={[
            "size-1.5 rounded-full",
            connection === "open"
              ? "bg-success"
              : connection === "connecting"
                ? "bg-warning animate-pulse"
                : "bg-danger",
          ].join(" ")}
        />
        <span className={connection === "disconnected" ? "text-danger" : "text-fg-muted"}>
          {connection === "open"
            ? "connected"
            : connection === "connecting"
              ? "connecting…"
              : "disconnected — retrying"}
        </span>
      </span>

      <span className="text-fg-dim">│</span>

      {run !== null ? (
        <span className="flex items-center gap-2">
          <span className="inline-block size-1.5 animate-pulse rounded-full bg-current text-success" />
          <span className="text-fg">
            Running (<span className={theme?.text ?? ""}>{run.provider}</span>
            {modelLabel(run.provider, run.model) !== null && (
              <span className="text-fg-muted"> · {modelLabel(run.provider, run.model)}</span>
            )}
            )…
          </span>
          <span className="tabular-nums text-fg-muted">{formatElapsed(run.elapsedMs)}</span>
          {showTokens && usage !== null && (
            <span className="tabular-nums text-fg-muted">
              · ↓{formatTokens(usage.totalTokens)} tokens
            </span>
          )}
          {run.detail !== null && (
            <span className="max-w-[28ch] truncate text-fg-dim">· {run.detail}</span>
          )}
        </span>
      ) : (
        <span className="flex items-center gap-2 text-fg-muted">
          <span>idle</span>
          {provider && (
            <span>
              · <span className={theme?.text ?? ""}>{provider.id}</span>
              <span className="text-fg-muted">
                {" "}
                {modelLabel(provider.id, model) ?? "default model"}
              </span>
              {provider.version !== null && <span className="text-fg-dim"> {provider.version}</span>}
            </span>
          )}
          {lastRun !== null && (
            <span className="text-fg-dim">
              · last run {lastRun.state} in {formatElapsed(lastRun.elapsedMs)}
              {showTokens && usage !== null ? ` · ${formatTokens(usage.totalTokens)} tokens` : ""}
            </span>
          )}
        </span>
      )}

      <span className="ml-auto flex items-center gap-3 text-fg-dim">
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
