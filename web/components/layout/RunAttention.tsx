"use client";

import { useHydra } from "@/hooks/useHydra";

/** Counts for the sidebar summary and the collapsed/mobile navigation trigger. */
export function useAttentionCounts() {
  const { runs, inputRequests } = useHydra();
  return { running: runs.length, decisions: Object.keys(inputRequests).length };
}

export function attentionLabel(running: number, decisions: number): string {
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} active ${running === 1 ? "agent" : "agents"}`);
  if (decisions > 0) parts.push(`${decisions} ${decisions === 1 ? "needs" : "need"} you`);
  return parts.join(" · ");
}
