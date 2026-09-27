import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { BareGitControlRecordRemote, isLiveHandoverState } from "./teamControlRecord.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

/*
 * M-17. Refuses the owner's own local actions on a work item a teammate is
 * holding.
 *
 * Reproduced 2026-09-28 before this existed: with the shared control record
 * RUNNING and another person as executor, answering the owner's prompt took that
 * workstation's execute runs from 1 to 2, marked the prompt DONE, and raised no
 * notification, while the receiver was still running its own. Two workstations ran
 * one item, and the owner's run completed a task the receiver was still working on.
 *
 * Why this is a module of its own rather than a helper in `teamHandoverSurface`:
 * that file imports `startExecute` from `runService`, so a guard living there and
 * called from `runService` would be a cycle. This imports `workspaces`,
 * `teamControlRecord` and `config` and nothing else.
 *
 * Why it is not in `operationalState`: that function is synchronous and runs once
 * per prompt inside the snapshot builder's loop, and reading a control record is
 * git I/O. M-16 is the task that makes the state readable there; this guard does
 * not wait for it, because the loss is available today.
 */

/** The one bare clone every item's control ref lives in, local to this checkout. */
function controlBare(): string {
  return join(config.repoRoot, ".agent-console", "handover", "control.git");
}

/**
 * The live handover holding this prompt, or null.
 *
 * **Only the requester's link is considered, and that is the whole correctness of
 * it.** A receiver that accepts an offer creates an item link on *its own* prompt
 * with role `executor` and sets `control_head` on it, so a guard that looked at
 * every link would refuse the receiver's own run and break handover outright. The
 * requester's link is the one whose work is at risk from a local action.
 *
 * The read is of the **local** bare control repo, not the network remote, so this
 * costs no request and cannot fail because a remote is unreachable. It is skipped
 * entirely unless the link already carries a `control_head`, which means a
 * handover record exists at all - so an item that was never handed over pays one
 * indexed query.
 */
export async function liveHandoverHolding(promptId: number): Promise<{ itemId: string; state: string; executor: string | null } | null> {
  const link = workspaces.itemLinksForPrompt(promptId).find(entry => entry.role === "requester" && entry.controlHead !== null);
  if (link === undefined) return null;
  const bare = controlBare();
  if (!existsSync(bare)) return null;
  const snapshot = await new BareGitControlRecordRemote(bare, link.itemId).read();
  const record = snapshot?.record;
  if (record === undefined || !isLiveHandoverState(record.state)) return null;
  return { itemId: record.itemId, state: record.state, executor: record.executor };
}

/**
 * Refuses a local action while a handover is live, naming who holds it.
 *
 * The same set as the `/close` guard ruled on 2026-09-22 and re-affirmed by jd's
 * ruling 7 of 2026-09-27: every state in `LIVE_HANDOVER_STATES` refuses, including
 * `OFFERED`, where nobody holds the item yet but an open invitation exists that
 * could still be accepted onto the very work this action would change. Consistency
 * with that guard is deliberate; two guards over one predicate that disagreed
 * about `OFFERED` would be worse than either.
 *
 * `liveHandoverCloseRefusal` is deliberately not reused: its sentences are about
 * closing a thread, and telling someone their *answer* "cannot be closed" would be
 * worse than saying nothing.
 */
export async function assertNoLiveHandover(promptId: number, action: string): Promise<void> {
  const live = await liveHandoverHolding(promptId);
  if (live === null) return;
  const remedy = live.executor === null
    ? "No one has accepted it yet, so withdraw the offer first if you mean to work on it here."
    : `${live.executor} is holding it, and only they can release it. Wait for the return, or ask them to return it.`;
  throw new WorkspaceError(409, "handover_live",
    `${action} is refused while this item is handed over: ${live.itemId} is ${live.state}. ${remedy}`,
    { itemId: live.itemId, state: live.state, executor: live.executor ?? "" });
}
