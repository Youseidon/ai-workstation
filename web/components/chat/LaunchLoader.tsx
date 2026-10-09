"use client";

import { useEffect, useState } from "react";
import type { ProviderId, RunRole } from "@agent-console/shared";
import { formatElapsed, modelLabel } from "@agent-console/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { cn } from "@/lib/cn";
import { providerTheme } from "@/lib/providerTheme";

/**
 * Where a launch is between the click and the agent's first line.
 *
 * - `sending`: the request has left the browser; the server has not announced a run.
 * - `starting`: the run exists and its process is coming up.
 * - `waiting`: the agent is running but has not produced output yet.
 */
export type LaunchStage = "sending" | "starting" | "waiting";

const STEPS = ["Request sent", "Agent started", "First output"];

/** Silence long enough that a reader starts wondering whether to refresh. */
const REASSURE_AFTER_MS = 10_000;

/**
 * Fills the gap between Run/Ask and the first log line.
 *
 * Nothing here is ambience: the steps follow the real launch state and the
 * timer ticks every second, so a slow model start cannot be mistaken for a
 * frozen page. It unmounts the moment the agent says anything.
 */
export function LaunchLoader({
  stage,
  role,
  provider,
  model,
  detail,
}: {
  stage: LaunchStage;
  role: RunRole;
  provider: ProviderId;
  model: string | null;
  detail: string | null;
}) {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const theme = providerTheme[provider];
  const elapsedMs = now - startedAt;
  // The step being waited on; everything before it has really happened.
  const current = stage === "sending" ? 1 : 2;
  const modelName = modelLabel(provider, model);
  const headline =
    stage === "sending"
      ? `Handing your ${role === "consult" ? "question" : "prompt"} to ${provider}…`
      : stage === "starting"
        ? `${provider} is starting up…`
        : `${provider} is ${role === "consult" ? "researching" : "working"} — first output on its way…`;

  return (
    <div
      role="status"
      aria-live="polite"
      className="glass flex w-full max-w-md animate-slide-up flex-col items-center gap-5 rounded-2xl px-6 py-7 text-center shadow-xl"
    >
      {/* The agent itself, with ripples leaving it: something is being sent. */}
      <span className={cn("relative grid size-28 place-items-center", theme.text)}>
        <span aria-hidden className="absolute inset-3 rounded-full bg-current opacity-20 animate-pulse-ring" />
        <span aria-hidden className="absolute inset-3 rounded-full bg-current opacity-20 animate-pulse-ring [animation-delay:0.9s]" />
        <span aria-hidden className="absolute inset-0 rounded-full border border-dashed border-current opacity-25 animate-[ac-orbit_14s_linear_infinite_reverse]" />
        <AgentAvatar provider={provider} activity="thinking" size={72} title={`${provider} is launching`} />
      </span>

      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-fg">{headline}</p>
        <p className="text-xs text-fg-dim">
          {modelName !== null && <span>{modelName} · </span>}
          <span className="numeric text-fg-muted">{formatElapsed(elapsedMs)}</span>
          {detail !== null && <span> · {detail}</span>}
        </p>
      </div>

      {/* Sent → started → first output. The live segment carries a moving signal. */}
      <ol className="flex w-full items-start">
        {STEPS.map((label, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li key={label} className="flex flex-1 flex-col items-center gap-1.5">
              <span className="flex w-full items-center">
                <span className={cn("relative h-px flex-1 overflow-hidden", index === 0 ? "bg-transparent" : done ? "bg-current" : "bg-line", theme.text)}>
                  {active && (
                    <span className="absolute inset-y-0 left-0 w-1/2 animate-[ac-sweep_1.4s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-current to-transparent" />
                  )}
                </span>
                <span
                  className={cn(
                    "grid size-4 shrink-0 place-items-center rounded-full text-[9px] ring-1 ring-inset",
                    done ? cn(theme.fill, "text-surface-0 ring-transparent") : active ? cn(theme.text, "ring-current") : "text-fg-dim ring-line",
                  )}
                >
                  {done ? "✓" : active && <span className="size-1.5 animate-breathe rounded-full bg-current" />}
                </span>
                <span className={cn("h-px flex-1", index === STEPS.length - 1 ? "bg-transparent" : index + 1 < current ? "bg-current" : "bg-line", theme.text)} />
              </span>
              <span className={cn("text-[10px] uppercase tracking-wider", done || active ? "text-fg-muted" : "text-fg-dim")}>{label}</span>
            </li>
          );
        })}
      </ol>

      {/* A ghost of the transcript that is about to replace this card. */}
      <div aria-hidden className="flex w-full flex-col gap-1.5 opacity-70">
        <span className="skeleton h-2 w-11/12" />
        <span className="skeleton h-2 w-3/5 [animation-delay:0.2s]" />
        <span className="skeleton h-2 w-4/5 [animation-delay:0.4s]" />
      </div>

      <p className={cn("text-[11px] text-fg-dim transition-opacity", elapsedMs >= REASSURE_AFTER_MS ? "opacity-100" : "opacity-0")}>
        Still going — no need to refresh. The run continues on the server.
      </p>
    </div>
  );
}
