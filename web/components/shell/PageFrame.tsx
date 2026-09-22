import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Shared page canvas. Ops surfaces use `bleed` (full content column).
 * Reading / empty-state surfaces can use `reading` for a comfortable measure.
 */
export function PageFrame({
  children,
  variant = "bleed",
  className,
  padding = true,
}: {
  children: ReactNode;
  variant?: "bleed" | "reading";
  className?: string;
  /** When false, the caller owns padding (split panes, desks with their own gutters). */
  padding?: boolean;
}) {
  return (
    <div
      className={cn(
        "w-full",
        padding && "p-5",
        variant === "reading" && "mx-auto max-w-3xl",
        className,
      )}
    >
      {children}
    </div>
  );
}
