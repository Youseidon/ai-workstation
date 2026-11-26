"use client";

import type { ProviderId } from "@hydra/shared";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/features/providers/lib/providerTheme";
import type { AgentActivity } from "@/features/runs/lib/agentState";

const CORE: Record<ProviderId, React.ReactNode> = {
  claude: (
    <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M24 15v18M16.2 19.5l15.6 9M16.2 28.5l15.6-9" />
    </g>
  ),
  codex: (
    <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M19.5 17.5 14 24l5.5 6.5" />
      <path d="M28.5 17.5 34 24l-5.5 6.5" />
      <path d="M25.6 16.5l-3.2 15" opacity="0.55" />
    </g>
  ),
  cursor: (
    <g fill="currentColor">
      <path d="M18 14.5 33 24l-6.6 1.6L23.4 32z" />
    </g>
  ),
  grok: (
    <g stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
      <path d="M17 17l14 14M31 17L17 31" />
    </g>
  ),
  copilot: (
    <g fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
      <path d="M14 22.5c3-1.5 6.7-1.5 10 0 3.3-1.5 7-1.5 10 0v4a5 5 0 0 1-5 5h-2.6a3 3 0 0 1-2.4-1.2L24 29l-2.4 3.3A3 3 0 0 1 19 33h-2a5 5 0 0 1-5-5z" transform="translate(1 -2)" />
    </g>
  ),
  kilocode: (
    <g fill="currentColor">
      <path d="M27.5 12.5 16.5 26h6l-2 9.5L31.5 22h-6z" />
    </g>
  ),
};

export interface AgentAvatarProps {
  provider: ProviderId;
  activity: AgentActivity;
  size?: number;
  className?: string;
  title?: string;
}

export function AgentAvatar({ provider, activity, size = 32, className, title }: AgentAvatarProps) {
  const theme = providerTheme[provider];
  const busy = activity === "thinking" || activity === "tooling" || activity === "speaking";
  const offline = activity === "offline";

  const tone =
    activity === "error"
      ? "text-danger"
      : activity === "done"
        ? "text-success"
        : offline
          ? "text-fg-dim"
          : theme.text;

  return (
    <span
      role="img"
      aria-label={title ?? `${provider}: ${activity}`}
      style={{ width: size, height: size }}
      className={cn(
        "relative inline-grid shrink-0 place-items-center",
        tone,
        activity === "error" && "animate-glitch",
        className,
      )}
    >
      { }
      {activity === "tooling" && (
        <span aria-hidden className="absolute inset-0 rounded-full bg-current opacity-25 animate-pulse-ring" />
      )}

      <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden className="relative">
        { }
        <circle
          cx="24"
          cy="24"
          r="22"
          fill="currentColor"
          className={cn("opacity-[0.09]", activity === "idle" && "animate-breathe")}
        />

        { }
        <g className={cn("origin-center", busy && "animate-orbit")}>
          <circle
            cx="24"
            cy="24"
            r="20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeDasharray={offline ? "3 6" : busy ? "26 12" : "94 6"}
            className={offline ? "opacity-35" : "opacity-70"}
          />
          { }
          {busy && <circle cx="44" cy="24" r="2.4" fill="currentColor" />}
        </g>

        <g className={cn(offline && "opacity-40", activity === "speaking" && "animate-breathe")}>
          {CORE[provider]}
        </g>
      </svg>

      { }
      {(activity === "done" || activity === "error") && (
        <span
          aria-hidden
          className="absolute -bottom-0.5 -right-0.5 grid place-items-center rounded-full bg-surface-0 ring-1 ring-current"
          style={{ width: size * 0.42, height: size * 0.42, fontSize: size * 0.26 }}
        >
          {activity === "done" ? "✓" : "✕"}
        </span>
      )}
    </span>
  );
}

export function TypingCaret({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("ml-0.5 inline-block h-[1em] w-[0.5ch] translate-y-[0.12em] bg-current animate-blink", className)}
    />
  );
}
