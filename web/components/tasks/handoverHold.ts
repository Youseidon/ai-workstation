import type { OperationsPrompt } from "@agent-console/shared";

/** The live handover holding a work item, as `/api/operations` reports it. */
export type HeldByTeammate = NonNullable<OperationsPrompt["heldByTeammate"]>;

/*
 * M-16. One wording for "a teammate is holding this", read by three surfaces.
 *
 * It lives in its own module rather than in one of them because WorkItemList
 * would otherwise have to import from HandoverControl, which pulls the
 * workspaces API client and SERVER_URL into the row list for a string.
 *
 * The sentences are P-A5's, from `assertNoLiveHandover`, rather than new ones:
 * the reason a button is disabled and the reason the route would refuse it are
 * the same reason, and two spellings of it is how a person ends up told two
 * different things about one refusal.
 */

/**
 * The row badge. `executor` is the person id the control record carries - the
 * record stores ids, not display labels - so this reads `Held by 6525517234`
 * rather than `Held by Junaid`.
 *
 * **Open question for jd (m16-design.md section 4), unanswered as of
 * 2026-09-28:** resolve this to a roster display label instead? That is a second
 * lookup on a surface that has no roster today. Swapping it is a change to this
 * one function and nothing else, which is why it is a function.
 */
export function heldByTeammateBadge(held: HeldByTeammate): string {
  return held.executor === null ? "Offered to the team" : `Held by ${held.executor}`;
}

/**
 * Why a local action is refused, in P-A5's own words. The remedy branches on
 * whether anybody has accepted yet: `OFFERED` is a live handover with no holder,
 * and telling someone to wait for a return that nobody is working on would be
 * worse than saying nothing.
 */
export function heldByTeammateReason(held: HeldByTeammate): string {
  const remedy = held.executor === null
    ? "No one has accepted it yet, so withdraw the offer first if you mean to work on it here."
    : `${held.executor} is holding it, and only they can release it. Wait for the return, or ask them to return it.`;
  return `This item is handed over: ${held.itemId} is ${held.state}. ${remedy}`;
}
