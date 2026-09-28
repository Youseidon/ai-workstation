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
 * Who is holding it, by name where the roster knows one.
 *
 * **jd's answer to m16-design.md section 4, 2026-09-28: resolve the label.** The
 * control record stores person ids, because that is what a shared
 * machine-readable record should store; a badge should not show one. The route
 * resolves it from the roster it already holds, so this reads `Held by Junaid`.
 *
 * A missing name falls back to the id rather than to a guess: an id is a poor
 * label, a wrong name is worse. That happens when the roster has no
 * `personLabel` for the holder - a roster published before the two labels were
 * separated (B5) - and never silently shows the wrong person.
 */
export function heldByTeammateHolder(held: HeldByTeammate): string | null {
  return held.executor === null ? null : held.executorLabel ?? held.executor;
}

export function heldByTeammateBadge(held: HeldByTeammate): string {
  const holder = heldByTeammateHolder(held);
  return holder === null ? "Offered to the team" : `Held by ${holder}`;
}

/**
 * Why a local action is refused, in P-A5's own words. The remedy branches on
 * whether anybody has accepted yet: `OFFERED` is a live handover with no holder,
 * and telling someone to wait for a return that nobody is working on would be
 * worse than saying nothing.
 */
export function heldByTeammateReason(held: HeldByTeammate): string {
  const holder = heldByTeammateHolder(held);
  const remedy = holder === null
    ? "No one has accepted it yet, so withdraw the offer first if you mean to work on it here."
    : `${holder} is holding it, and only they can release it. Wait for the return, or ask them to return it.`;
  return `This item is handed over: ${held.itemId} is ${held.state}. ${remedy}`;
}
