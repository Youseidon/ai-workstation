"use client";

import { Suspense } from "react";
import { AgentCommandCenter } from "@/components/agents/AgentCommandCenter";

export default function AgentsPage() {
  return <Suspense fallback={<p className="p-5 text-fg-muted">Loading agent command center…</p>}><AgentCommandCenter /></Suspense>;
}
