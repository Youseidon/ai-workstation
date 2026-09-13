"use client";

import {
  formatResetIn,
  type ProviderUsage,
  type ProviderUsageWindow,
  type QuotaWarning,
} from "@agent-console/shared";
import { cn } from "@/lib/cn";
import { Skeleton } from "@/components/ui/Spinner";

const WINDOW_ORDER = ["session", "daily", "weekly", "monthly"] as const;

export function UsageBlock({
  usage,
  warnings = [],
  loading,
  available,
}: {
  usage: ProviderUsage | null;
  warnings?: QuotaWarning[];
  loading: boolean;
  available: boolean;
}) {
  if (!available) return null;
  if (loading) {
    return (
      <div className="mt-3 border-t border-line pt-3">
        <div className="text-[10px] uppercase tracking-wider text-fg-dim">plan usage</div>
        <div className="mt-2 flex flex-col gap-2">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </div>
      </div>
    );
  }
  if (usage === null || !usage.available || (usage.windows.length === 0 && usage.credits === null)) {
    return null;
  }

  const windows = [...usage.windows].sort(
    (left, right) => WINDOW_ORDER.indexOf(left.kind) - WINDOW_ORDER.indexOf(right.kind),
  );

  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider text-fg-dim">plan usage</div>
        {usage.plan !== null && <div className="truncate text-[10px] text-fg-dim">{usage.plan}</div>}
      </div>
      <dl className="mt-2 flex flex-col gap-2">
        {windows.map((window) => (
          <UsageMeter key={window.kind} window={window} />
        ))}
      </dl>
      {warnings.map((warning) => (
        <div key={warning.id} className="mt-2 rounded border border-warning/40 bg-warning/10 p-2 text-[11px] text-fg">
          <div>{warning.message}</div>
          <div className="mt-1 text-[10px] text-fg-dim">
            Choices: {warning.choices.map((choice) => choice.label).join(" · ")}
          </div>
        </div>
      ))}
      {usage.credits !== null && <CreditsLine credits={usage.credits} />}
    </div>
  );
}

export function UsageMeter({ window }: { window: ProviderUsageWindow }) {
  const percent = window.usedPercent;
  const tone = percent === null ? "neutral" : percent >= 90 ? "danger" : percent >= 70 ? "warning" : "success";
  const reset = formatResetIn(window.resetsAt);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <dt className="text-fg-dim">{windowLabel(window)}</dt>
        <dd className="numeric text-fg">{percent === null ? "—" : `${Math.round(percent)}%`}</dd>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-3">
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            tone === "danger" && "bg-danger",
            tone === "warning" && "bg-warning",
            tone === "success" && "bg-success",
            tone === "neutral" && "bg-fg-dim",
          )}
          style={{ width: `${percent === null ? 0 : Math.min(100, percent)}%` }}
        />
      </div>
      {reset !== null && <div className="mt-0.5 text-[10px] text-fg-dim">resets {reset}</div>}
    </div>
  );
}

export function CreditsLine({ credits }: { credits: NonNullable<ProviderUsage["credits"]> }) {
  const useful =
    credits.enabled === true ||
    (credits.balance !== null && credits.balance > 0) ||
    (credits.limit !== null && credits.limit > 0);
  if (!useful) return null;
  const money = (value: number) => {
    const symbol = credits.currency === "USD" || credits.currency === null ? "$" : `${credits.currency} `;
    return `${symbol}${value.toFixed(2)}`;
  };
  const parts: string[] = [];
  if (credits.balance !== null) parts.push(`${money(credits.balance)} left`);
  if (credits.used !== null && credits.limit !== null) {
    parts.push(`${money(credits.used)} / ${money(credits.limit)}`);
  } else if (credits.used !== null) {
    parts.push(`${money(credits.used)} used`);
  } else if (credits.limit !== null) {
    parts.push(`${money(credits.limit)} cap`);
  }
  if (parts.length === 0) return null;
  return <div className="mt-2 text-[10px] text-fg-dim">credits · {parts.join(" · ")}</div>;
}

function windowLabel(window: ProviderUsageWindow): string {
  if (window.kind === "session" && window.durationMinutes !== null) {
    const hours = window.durationMinutes / 60;
    if (hours >= 1 && Math.abs(hours - Math.round(hours)) < 0.05) return `${Math.round(hours)}h`;
  }
  return window.kind;
}
