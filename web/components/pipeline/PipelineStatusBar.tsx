"use client";

import type { ProviderId } from "@agent-console/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Button } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";
import { CONTROL_LABEL, type PipelineControl, type PipelineStatusView } from "./status";

export interface PipelinePosition {
  /** 1-based stage index, 0 when the pipeline has not entered a stage yet. */
  stageIndex: number;
  stageCount: number;
  stageName: string | null;
  stationLabel: string | null;
  /** Deepest sub-step under the station, when the run drilled into one. */
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

/**
 * The single source of truth for "what is this pipeline doing, and what can I
 * do about it". Exactly one control is primary; everything else is demoted, so
 * two equally-loud buttons never leave the operator guessing which one applies.
 */
export function PipelineStatusBar({
  status,
  position,
  blockedReason,
  busy,
  onControl,
  onExplain,
}: {
  status: PipelineStatusView;
  position: PipelinePosition | null;
  /** Why the primary control cannot fire right now, in plain words. */
  blockedReason: string | null;
  busy: boolean;
  onControl(control: PipelineControl): void;
  /** Opens the rules panel. The pill is the affordance for "why these buttons?". */
  onExplain(): void;
}) {
  const primaryDisabled = busy || blockedReason !== null;

  return (
    <section
      aria-label="Pipeline status"
      className={cn("rounded-panel border", RING[status.tone])}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <button
            type="button"
            onClick={onExplain}
            title="What decides these buttons?"
            className="mt-[3px] flex shrink-0 items-center gap-2 rounded-sm underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <StatusDot tone={status.tone} pulse={status.pulse} size={8} />
            <span className={cn("text-[11px] font-medium uppercase tracking-[0.16em]", PILL[status.tone])}>
              {status.label}
            </span>
          </button>
          {/* Three lines, in the order the questions get asked: what the run is
              doing, what put it there, and what the button will do about it. */}
          <div className="min-w-0">
            <p className="text-[13px] leading-5 text-fg">{status.headline}</p>
            <p className="mt-0.5 text-xs leading-5 text-fg-muted">{status.because}</p>
            {status.hint !== null && (
              <p className="mt-0.5 text-xs leading-5 text-fg-dim">{status.hint}</p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {status.secondary.map((control) => (
            <Button
              key={control}
              size="sm"
              variant="ghost"
              disabled={busy}
              className={control === "stop" ? "text-danger/80 hover:bg-danger/10 hover:text-danger" : undefined}
              onClick={() => onControl(control)}
            >
              {CONTROL_LABEL[control]}
            </Button>
          ))}
          {status.primary !== null && (
            <Button
              size="md"
              variant={variantFor(status.primary)}
              disabled={primaryDisabled}
              title={blockedReason ?? undefined}
              onClick={() => onControl(status.primary!)}
            >
              {CONTROL_LABEL[status.primary]}
            </Button>
          )}
        </div>
      </div>

      {(position !== null || blockedReason !== null) && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line/70 px-4 py-2 text-[11px] text-fg-dim">
          {position !== null && (
            <>
              {position.stageCount > 0 && (
                <span className="numeric">
                  Stage {Math.max(position.stageIndex, 1)}/{position.stageCount}
                </span>
              )}
              {position.stageName !== null && (
                <>
                  <Chevron />
                  <span className="text-fg-muted">{position.stageName}</span>
                </>
              )}
              {position.stationLabel !== null && (
                <>
                  <Chevron />
                  <span className="text-fg-muted">{position.stationLabel}</span>
                </>
              )}
              {position.subStepLabel !== null && (
                <>
                  <Chevron />
                  <span className="text-fg-muted">{position.subStepLabel}</span>
                </>
              )}
              {position.provider !== null && (
                <span className="ml-1 inline-flex items-center gap-1.5">
                  <AgentAvatar provider={position.provider} size={14} activity="tooling" />
                  <span>{position.provider}</span>
                </span>
              )}
            </>
          )}
          {blockedReason !== null && status.primary !== null && (
            <span className={cn("text-caution", position !== null && "ml-auto")}>
              {CONTROL_LABEL[status.primary]} is unavailable — {blockedReason}.
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function Chevron() {
  return (
    <span aria-hidden className="text-fg-dim/60">
      ›
    </span>
  );
}
