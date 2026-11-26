import { useId } from "react";
import { PROVIDER_IDS, type ProviderId } from "@hydra/shared";
import { cn } from "@/lib/cn";
import { MARK, MARK_SMALL, WORDMARK } from "./geometry";

const SMALL_AT = 24;

export type MarkTone = "brand" | "spectrum" | "mono";

export function HydraMark({
  size = 32,
  tone = "brand",
  live,
  title,
  className,
}: {
  size?: number;
  tone?: MarkTone;
  live?: readonly ProviderId[];
  title?: string;
  className?: string;
}) {
  const id = useId();
  const small = size <= SMALL_AT;
  const g = small ? MARK_SMALL : MARK;
  const awake = live !== undefined && live.length > 0;
  const active = new Set(live);

  const paint = (index: number): string => {
    const provider = PROVIDER_IDS[index];
    if (awake) return provider && active.has(provider) ? `var(--agent-${provider})` : "var(--fg-dim)";
    if (tone === "spectrum" && provider) return `var(--agent-${provider})`;
    if (tone === "mono") return "currentColor";
    return `url(#${id}-g)`;
  };
  const headClass = (index: number) => {
    const provider = PROVIDER_IDS[index];
    if (!awake) return undefined;
    return provider && active.has(provider) ? "hydra-head-live" : "hydra-head-idle";
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={cn("hydra-mark shrink-0", awake && "hydra-mark-awake", className)}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <defs>
        <linearGradient id={`${id}-g`} x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
          <stop offset="0" style={{ stopColor: "var(--brand-from)" }} />
          <stop offset="1" style={{ stopColor: "var(--brand-to)" }} />
        </linearGradient>
        {!small && (
          <mask id={`${id}-m`} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
            <rect width="64" height="64" fill="#fff" />
            {g.heads.map((head, index) => <circle key={index} cx={head.ex} cy={head.ey} r={g.eye} fill="#000" />)}
          </mask>
        )}
      </defs>
      <g className="hydra-mark-body" mask={small ? undefined : `url(#${id}-m)`}>
        {g.necks.map((d, index) => (
          <path key={index} d={d} fill="none" stroke={paint(index)} strokeWidth={g.neck} strokeLinecap="round" className={headClass(index)} />
        ))}
        {g.heads.map((head, index) => (
          <ellipse
            key={index}
            cx={head.cx}
            cy={head.cy}
            rx={g.hx}
            ry={g.hy}
            transform={`rotate(${head.angle} ${head.cx} ${head.cy})`}
            fill={paint(index)}
            className={headClass(index)}
          />
        ))}
        <path d={g.core} fill={awake ? "var(--fg)" : tone === "spectrum" ? "var(--fg)" : paint(0)} />
      </g>
    </svg>
  );
}

export function HydraWordmark({ height = 16, className }: { height?: number; className?: string }) {
  return (
    <svg
      height={height}
      width={(height * WORDMARK.width) / WORDMARK.height}
      viewBox={`${WORDMARK.x} ${WORDMARK.y} ${WORDMARK.width} ${WORDMARK.height}`}
      className={cn("shrink-0", className)}
      aria-hidden
    >
      <path d={WORDMARK.d} fill="currentColor" />
    </svg>
  );
}
