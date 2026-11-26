"use client";

import { useState, type ReactNode } from "react";
import type { ProviderId } from "@hydra/shared";
import { Menu } from "@/components/ui/Menu";
import { Button } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { CONTROL_LABEL, type PipelineControl, type PipelineStatusView } from "../lib/status";

export interface PipelineRecoveryActions {
  onRetry?(): void;
  onSkip(): void;
  onOpen(): void;
  label: string;
}

export interface PipelinePosition {
  stageIndex: number;
  stageCount: number;
  stageName: string | null;
  stationLabel: string | null;
  subStepLabel: string | null;
  provider: ProviderId | null;
}

const RING: Record<PipelineStatusView["tone"], string> = {
  neutral: "border-line bg-surface-1",
  accent: "border-accent/40 bg-accent/[0.06]",
  success: "border-success/40 bg-success/[0.06]",
  warning: "border-warning/50 bg-warning/[0.07]",
  caution: "border-caution/45 bg-caution/[0.06]",
  danger: "border-danger/50 bg-danger/[0.07]",
  info: "border-info/40 bg-info/[0.06]",
  violet: "border-violet/40 bg-violet/[0.06]",
};

const PILL: Record<PipelineStatusView["tone"], string> = {
  neutral: "text-fg-muted",
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  caution: "text-caution",
  danger: "text-danger",
  info: "text-info",
  violet: "text-violet",
};

function variantFor(control: PipelineControl): "primary" | "success" | "danger" | "secondary" {
  if (control === "stop") return "danger";
  if (control === "pause") return "secondary";
  return "success";
}

export function PipelineStatusBar({
  status,
  position,
  blockedReason,
  recoveryActions,
  busy,
  onControl,
  onExplain,
  inbox,
  rules,
  onReviewAllocation,
}: {
  status: PipelineStatusView;
  position: PipelinePosition | null;
  blockedReason: string | null;
  recoveryActions: PipelineRecoveryActions | null;
  busy: boolean;
  onControl(control: PipelineControl): void;
  onExplain(): void;
  inbox?: ReactNode;
  rules?: ReactNode;
  onReviewAllocation?(): void;
}) {
  const primaryDisabled = busy || blockedReason !== null;
  const [rulesOpen, setRulesOpen] = useState(false);

  return (
    <section
      aria-label="Pipeline status"
      className={cn("rounded-panel border shadow-sm", RING[status.tone])}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
        <button type="button" onClick={onExplain} title="Open execution rules" className="flex shrink-0 items-center gap-2 rounded text-xs">
          <StatusDot tone={status.tone} pulse={status.pulse} size={8} />
          <span className={cn("font-medium", PILL[status.tone])}>{status.label}</span>
        </button>
        <p className="min-w-0 flex-1 basis-40 truncate text-xs text-fg-muted" title={status.headline}>{status.headline}</p>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {inbox}
          {onReviewAllocation && <Button size="sm" variant="primary" disabled={busy} onClick={onReviewAllocation}>Review allocation</Button>}
          <button type="button" aria-expanded={rulesOpen} onClick={() => setRulesOpen((value) => !value)} className="text-xs text-fg-muted hover:text-fg">Details {rulesOpen ? "▴" : "▾"}</button>
          {status.secondary.length > 0 && <Menu label="More execution controls" portal items={status.secondary.map((control) => ({
            id: control, label: CONTROL_LABEL[control], disabled: busy, tone: control === "stop" ? "danger" as const : "default" as const, onSelect: () => onControl(control),
          }))} />}
          {status.primary !== null && <Button size="sm" variant={variantFor(status.primary)} disabled={primaryDisabled} title={blockedReason ?? status.hint ?? undefined} onClick={() => { if (status.primary !== null) onControl(status.primary); }}>{CONTROL_LABEL[status.primary]}</Button>}
        </div>
      </div>
      {blockedReason !== null && status.primary !== null && <p className="border-t border-line/70 px-3 py-1.5 text-xs text-caution">{CONTROL_LABEL[status.primary]} unavailable: {blockedReason}.</p>}
      {rulesOpen && <div className="space-y-2 border-t border-line/70 px-3 py-2 text-xs text-fg-muted">
        <p>{status.because}</p>
        {status.hint !== null && <p className="text-fg-dim">{status.hint}</p>}
        {position !== null && <p>Suite {Math.max(position.stageIndex, 1)}/{position.stageCount} · {[position.stageName, position.stationLabel, position.subStepLabel, position.provider].filter(Boolean).join(" › ")}</p>}
        {rules}
      </div>}

      {recoveryActions !== null && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line/70 px-4 py-2">
          {recoveryActions.onRetry !== undefined && (
            <Button size="sm" variant="primary" disabled={busy} onClick={recoveryActions.onRetry}>
              Retry
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            className="text-danger/80 hover:bg-danger/10 hover:text-danger"
            onClick={recoveryActions.onSkip}
          >
            Skip
          </Button>
          <button type="button" onClick={recoveryActions.onOpen} className="text-xs text-accent hover:underline">
            Open {recoveryActions.label} →
          </button>
        </div>
      )}
    </section>
  );
}
