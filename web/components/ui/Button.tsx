"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";
export type ButtonSize = "sm" | "md" | "lg";

/* Tailwind cannot build class names at runtime, so every variant is spelled
   out. The tone colours come from theme tokens, so these survive a theme swap. */
const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent/15 text-accent ring-1 ring-inset ring-accent/40 hover:bg-accent/25 hover:ring-accent/60 active:bg-accent/30",
  secondary:
    "bg-surface-2 text-fg-muted ring-1 ring-inset ring-line hover:bg-surface-3 hover:text-fg hover:ring-line-strong",
  ghost: "text-fg-dim hover:bg-surface-2 hover:text-fg",
  danger:
    "bg-danger/12 text-danger ring-1 ring-inset ring-danger/40 hover:bg-danger/22 hover:ring-danger/60",
  success:
    "bg-success/12 text-success ring-1 ring-inset ring-success/40 hover:bg-success/22 hover:ring-success/60",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-7 gap-1.5 px-2.5 text-xs rounded-md",
  md: "h-9 gap-2 px-3.5 text-[13px] rounded-md",
  lg: "h-11 gap-2 px-5 text-sm rounded-lg",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and blocks interaction without collapsing the layout. */
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  /** Square, label-less button. Requires `aria-label` from the caller. */
  iconOnly?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    iconLeft,
    iconRight,
    iconOnly = false,
    className,
    disabled,
    children,
    type = "button",
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium",
        "transition-[background-color,color,box-shadow,opacity] duration-150",
        "disabled:pointer-events-none disabled:opacity-40",
        VARIANTS[variant],
        SIZES[size],
        iconOnly && (size === "sm" ? "w-7 px-0" : size === "md" ? "w-9 px-0" : "w-11 px-0"),
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={size === "lg" ? 16 : 13} /> : iconLeft}
      {!iconOnly && children}
      {!loading && iconRight}
    </button>
  );
});
