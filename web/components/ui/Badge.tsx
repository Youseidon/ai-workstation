"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type Tone = "neutral" | "accent" | "success" | "warning" | "caution" | "danger" | "info" | "violet";

/* Spelled out rather than interpolated, because Tailwind resolves class names
   at build time. Each entry is token-based, so it re-colours with the theme. */
const SOFT: Record<Tone, string> = {
  neutral: "bg-surface-3 text-fg-muted ring-line",
  accent: "bg-accent/12 text-accent ring-accent/30",
  success: "bg-success/12 text-success ring-success/30",
  warning: "bg-warning/12 text-warning ring-warning/30",
  caution: "bg-caution/12 text-caution ring-caution/30",
  danger: "bg-danger/12 text-danger ring-danger/30",
  info: "bg-info/12 text-info ring-info/30",
  violet: "bg-violet/12 text-violet ring-violet/30",
};

const DOT: Record<Tone, string> = {
  neutral: "bg-fg-dim",
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  caution: "bg-caution",
  danger: "bg-danger",
  info: "bg-info",
  violet: "bg-violet",
};

export interface BadgeProps {
  tone?: Tone;
  /** Renders a leading dot; `pulse` makes it breathe for live states. */
  dot?: boolean;
  pulse?: boolean;
  uppercase?: boolean;
  className?: string;
  title?: string;
  children: ReactNode;
}

export function Badge({
  tone = "neutral",
  dot = false,
  pulse = false,
  uppercase = false,
  className,
  title,
  children,
}: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10.5px] font-medium ring-1 ring-inset",
        uppercase && "uppercase tracking-wider",
        SOFT[tone],
        className,
      )}
    >
      {dot && <StatusDot tone={tone} pulse={pulse} />}
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * A state dot. When `pulse` is set it emits an expanding ring as well as
 * breathing, so "something is happening right now" is legible peripherally.
 */
export function StatusDot({
  tone = "neutral",
  pulse = false,
  size = 6,
  className,
}: {
  tone?: Tone;
  pulse?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn("relative inline-flex shrink-0 rounded-full", DOT[tone], className)}
    >
      {pulse && (
        <span
          className={cn("absolute inset-0 rounded-full animate-pulse-ring", DOT[tone])}
        />
      )}
    </span>
  );
}
