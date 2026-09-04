import { STEP_DISPLAY_STATUSES } from "@agent-console/shared";
import type { PromptOperationalState, PromptOption } from "@agent-console/shared";

export const OPERATIONAL_STATES:PromptOperationalState[]=[...STEP_DISPLAY_STATUSES];

/**
 * What a work item shows on a card: its stored status, unless a live overlay
 * describes it better.
 *
 * The three overlays are the only inference left here, and each is a fact about
 * right now rather than a guess about the past — a process is running, the
 * process is gone, a prerequisite is unmet. Everything else is returned exactly
 * as it was stored.
 */
export function operationalState(prompt:PromptOption):PromptOperationalState {
  if(prompt.currentRun?.processActive)return "WORKING";
  // Only the genuine crash-before-bookkeeping case: still marked in progress,
  // but the process is gone and nothing ever recorded how it ended.
  //
  // This used to be a bare `prompt.recoverable`, which covers UNREPORTED and
  // FAILED too — so every one of them displayed as "Recovery needed" and the
  // distinction between "the run said nothing" and "the process failed" was
  // masked at the last step, after all the work to store it. `recoverable`
  // stays broad, because the Recover button should still be offered for those;
  // it just no longer decides what the item is called.
  if(prompt.recoverable&&prompt.status==="IN_PROGRESS")return "RECOVERY_NEEDED";
  if(prompt.status==="BLOCKED")return "BLOCKED";
  if(prompt.status==="DONE")return "DONE";
  if(prompt.status==="SKIPPED")return "SKIPPED";
  if(prompt.blockedBy.length>0)return "WAITING_DEPENDENCY";
  if(prompt.status==="TODO")return prompt.ready?"READY":"WAITING_DEPENDENCY";
  // Return what is stored. This used to be `return "FAILED"` — an if-chain
  // fall-through, so nothing ever *decided* an item had failed; it arrived
  // there by matching nothing else. An IN_PROGRESS item whose run had ended
  // was shown to the operator as a failure on no evidence at all, which is
  // precisely the inference that made the pipeline's verdicts untrustworthy.
  // FAILED is now a stored status that only an observed process failure writes.
  return prompt.status;
}
