import type { OperationsPrompt } from "@agent-console/shared";

/** System interruptions may be retried without inventing a human answer. */
export function canRetryWithExistingContext(item: OperationsPrompt): boolean {
  const handoff = item.latestHandoff;
  if (handoff?.state === "READY" && (handoff.recommendation === "WAIT_FOR_HUMAN" || handoff.brief?.blockers.some(blocker => blocker.requiresHuman))) return false;
  return item.operationalState === "AWAITING_RESPONSE" && /without posting the required DONE or BLOCKED status|No active agent run/i.test(item.latestIntervention ?? "");
}

export function needsHumanResponse(item: OperationsPrompt | null): boolean {
  return item !== null && item.operationalState === "AWAITING_RESPONSE" && !canRetryWithExistingContext(item);
}
