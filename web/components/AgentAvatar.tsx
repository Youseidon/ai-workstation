"use client";

import type { ProviderId } from "@agent-console/shared";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/lib/providerTheme";
import type { AgentActivity } from "@/lib/agentState";

/**
 * The core glyph for each agent — a distinct silhouette so the four are
 * tellable apart at 20px, drawn on a 48×48 grid centred on (24, 24).
 *
 * Inline SVG rather than image assets: it inherits the agent's themed hue
 * through `currentColor`, scales without a second file, and adds nothing to the
 * bundle.
 */
const CORE: Record<ProviderId, React.ReactNode> = {
  // A six-armed spark.
  claude: (
    <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M24 15v18M16.2 19.5l15.6 9M16.2 28.5l15.6-9" />
    </g>
  ),
  // Nested brackets, for the terminal.
  codex: (
    <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M19.5 17.5 14 24l5.5 6.5" />
      <path d="M28.5 17.5 34 24l-5.5 6.5" />
      <path d="M25.6 16.5l-3.2 15" opacity="0.55" />
    </g>
  ),
  // A pointer.
  cursor: (
    <g fill="currentColor">
      <path d="M18 14.5 33 24l-6.6 1.6L23.4 32z" />
    </g>
  ),
  // Crossed bars.
  grok: (
    <g stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
      <path d="M17 17l14 14M31 17L17 31" />
    </g>
  ),
};

export interface AgentAvatarProps {
  provider: ProviderId;
  activity: AgentActivity;
  size?: number;
  className?: string;
  /** Adds a text label for screen readers describing the live state. */
  title?: string;
}

/**
 * An agent, as a presence.
 *
 * The animation is not ambience — each state maps to something the run is
 * actually doing, so the ring spinning means a tool call is genuinely in
 * flight. All of it stops under `prefers-reduced-motion` or the app's own
 * "reduce effects" switch, which is why the resting frame is legible on its
 * own: the ring, the core and the colour still distinguish every state.
 */
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
      {/* Expanding ring, emitted while a tool call is in flight. */}
      {activity === "tooling" && (
        <span aria-hidden className="absolute inset-0 rounded-full bg-current opacity-25 animate-pulse-ring" />
      )}

      <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden className="relative">
        {/* Halo */}
        <circle
          cx="24"
          cy="24"
          r="22"
          fill="currentColor"
          className={cn("opacity-[0.09]", activity === "idle" && "animate-breathe")}
        />

        {/* Orbit ring: a broken circle that turns while the agent works. */}
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
          {/* A satellite, so rotation reads even at small sizes. */}
          {busy && <circle cx="44" cy="24" r="2.4" fill="currentColor" />}
        </g>

        <g className={cn(offline && "opacity-40", activity === "speaking" && "animate-breathe")}>
          {CORE[provider]}
        </g>
      </svg>

      {/* A finished run gets a tick; a failed one a cross. */}
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

/** A blinking caret, for text that is still streaming in. */
export function TypingCaret({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("ml-0.5 inline-block h-[1em] w-[0.5ch] translate-y-[0.12em] bg-current animate-blink", className)}
    />
  );
}
