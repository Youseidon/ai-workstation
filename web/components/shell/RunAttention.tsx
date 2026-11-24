"use client";

import { useAgentConsole } from "@/lib/useAgentConsole";

/** Counts for the sidebar summary and the collapsed/mobile navigation trigger. */
export function useAttentionCounts() {
  const { runs, inputRequests } = useAgentConsole();
  return { running: runs.length, decisions: Object.keys(inputRequests).length };
}

export function attentionLabel(running: number, decisions: number): string {
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} active ${running === 1 ? "agent" : "agents"}`);
  if (decisions > 0) parts.push(`${decisions} ${decisions === 1 ? "needs" : "need"} you`);
  return parts.join(" · ");
}
