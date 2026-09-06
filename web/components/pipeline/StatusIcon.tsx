"use client";

/**
 * The glyph for a status, drawn from a key rather than typed as text.
 *
 * The server stores an icon *key*, never markup, so an operator picking an icon
 * cannot inject anything into the page and a theme change can restyle every
 * glyph at once. Unicode would have been simpler and worse: these have to stay
 * legible at 12px next to a badge in whatever font the terminal-styled log
 * happens to resolve, and emoji in particular render at wildly different
 * weights across platforms.
 */

import type { StatusIcon as StatusIconKey } from "@agent-console/shared";

const PATHS: Record<StatusIconKey, { d: string; fill?: boolean }[]> = {
  dot: [{ d: "M8 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z", fill: true }],
  spinner: [{ d: "M8 2a6 6 0 1 0 6 6" }],
  check: [{ d: "M3 8.5 6.5 12 13 4" }],
  cross: [{ d: "M4 4l8 8M12 4l-8 8" }],
  question: [{ d: "M5.6 5.5a2.5 2.5 0 1 1 3.3 2.37c-.55.2-.9.72-.9 1.3v.33" }, { d: "M8 12.4h.01" }],
  alert: [{ d: "M8 2.8 14.2 13.2H1.8L8 2.8Z" }, { d: "M8 6.6v3" }, { d: "M8 11.6h.01" }],
  clock: [{ d: "M8 2.4a5.6 5.6 0 1 0 0 11.2A5.6 5.6 0 0 0 8 2.4Z" }, { d: "M8 5.2V8l2 1.6" }],
  skip: [{ d: "M3.5 4l5 4-5 4z" }, { d: "M11 4v8" }],
  review: [{ d: "M7.2 2.6a4.6 4.6 0 1 0 0 9.2 4.6 4.6 0 0 0 0-9.2Z" }, { d: "M10.6 10.6 14 14" }, { d: "M5.4 7.2l1.4 1.4 2.4-2.6" }],
  search: [{ d: "M7 2.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8Z" }, { d: "M10.4 10.4 14 14" }],
  pause: [{ d: "M6 3.5v9M10 3.5v9" }],
  link: [{ d: "M6.5 9.5a2.6 2.6 0 0 1 0-3.7l1.8-1.8a2.6 2.6 0 0 1 3.7 3.7l-.9.9" }, { d: "M9.5 6.5a2.6 2.6 0 0 1 0 3.7l-1.8 1.8a2.6 2.6 0 0 1-3.7-3.7l.9-.9" }],
};

export function StatusIcon({ icon, className = "" }: { icon: StatusIconKey; className?: string }) {
  const paths = PATHS[icon] ?? PATHS.dot;
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      aria-hidden
      className={`inline-block shrink-0 align-[-1px] ${icon === "spinner" ? "animate-spin" : ""} ${className}`}
    >
      {paths.map((path, index) => (
        <path
          key={index}
          d={path.d}
          fill={path.fill === true ? "currentColor" : "none"}
          stroke={path.fill === true ? "none" : "currentColor"}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
