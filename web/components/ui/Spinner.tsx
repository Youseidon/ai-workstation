import { cn } from "@/lib/cn";

/**
 * Indeterminate progress. Inherits `currentColor`, so it matches whatever it
 * sits inside. Under reduced motion the arc stops spinning but the ring stays,
 * which still reads as "busy" (the global rule freezes the animation).
 */
export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={cn("shrink-0 animate-[ac-orbit_0.9s_linear_infinite]", className)}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.22" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Content-shaped loading placeholder. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton", className)} />;
}
