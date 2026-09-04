/**
 * How a run's ending becomes a status.
 *
 * Pure: this module decides, `workspaces.writeStatus` writes. Splitting them is
 * what makes the decision testable without a database and what stops the
 * decision being re-implemented at each of the places that used to write a
 * status directly.
 *
 * The rule the whole redesign turns on is `endOfRunSignal`: a run that ends
 * without posting a terminal status yields `run_ended_no_post`, which lands on
 * `UNREPORTED`. It never yields success and never yields failure. The old code
 * wrote `BLOCKED` here, which made an agent that finished the work but dropped
 * its final HTTP call indistinguishable from one that stopped to ask a
 * question — and `BLOCKED` is what the pipeline parks on, so finished work sat
 * waiting for a human who had nothing to answer.
 */

import { matchStepTransition } from "@agent-console/shared";
import type { StepSignal, StepStatus, StepTransitionRow } from "@agent-console/shared";

/** How an agent process came to an end, as the runner observed it. */
export type RunOutcome = "done" | "interrupted" | "error";

export interface EndOfRunFacts {
  /** The work item's status at the moment the process ended. */
  status: StepStatus;
  /** How the process itself finished. */
  outcome: RunOutcome;
  /**
   * The runner's reason for stopping the run early, when it had one — a budget
   * cap rather than anything the agent did.
   */
  stopReason: string | null;
}

/**
 * What the end of a run means for the work item.
 *
 * `null` means the run's ending says nothing about the item: the agent already
 * posted a terminal status, or the item was moved on by a decompose, so there
 * is nothing left to conclude and nothing to record.
 */
export function endOfRunSignal(facts: EndOfRunFacts): StepSignal | null {
  // The agent spoke for itself. Its post is the most direct evidence available
  // and outranks anything the process did afterwards.
  if (facts.status !== "IN_PROGRESS") return null;

  // A budget stop is deliberate and resumable. It is emphatically not a crash:
  // the work up to that point is real, banked in remarks, and a successor
  // should continue from it. Treating it as a failure would throw that away.
  if (facts.stopReason !== null && facts.stopReason !== "") return "run_ended_no_post";

  if (facts.outcome === "error") return "run_crashed";

  // A clean or interrupted exit with nothing posted. Whether the work is
  // finished is genuinely unknown, and unknown is its own answer.
  return "run_ended_no_post";
}

export interface TransitionDecision {
  row: StepTransitionRow;
  /** Where the item lands. Null when the row defers to the station's rule. */
  to: StepStatus | null;
}

/** The row that decides an outcome, with the status it lands on. */
export function decide(signal: StepSignal, producedWork = false): TransitionDecision {
  const row = matchStepTransition({ signal, producedWork });
  if (row === null) {
    // The totality test in shared makes this unreachable. Throwing rather than
    // defaulting is deliberate: a silent fallback here would be a status nobody
    // decided, which is the class of bug this whole module exists to remove.
    throw new Error(`No step transition covers signal ${signal}`);
  }
  return { row, to: row.to };
}

/**
 * The sentence stored on the work item and shown to the operator.
 *
 * Written here rather than at the call site so that the wording for a given
 * situation exists once. The old code composed this string inline in three
 * places and they had drifted apart.
 */
export function endOfRunReason(facts: EndOfRunFacts): string {
  if (facts.stopReason !== null && facts.stopReason !== "") {
    return `Run budget exhausted (${facts.stopReason}). The run was stopped before it could `
      + "post a status. Its work so far is in the tree and in this item's remarks; resume from "
      + "there rather than restarting.";
  }
  if (facts.outcome === "error") {
    return "The agent process failed. This is an observed failure, not an assumption about "
      + "the work: what was completed before it died is unknown until it is checked.";
  }
  return `The agent process ended ${facts.outcome} without posting a status. Whether the work `
    + "was finished is unknown — it has not been treated as either done or failed.";
}
