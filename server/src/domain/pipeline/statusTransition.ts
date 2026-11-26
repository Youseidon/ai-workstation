import { matchStepTransition } from "@hydra/shared";
import type { StepSignal, StepStatus, StepTransitionRow } from "@hydra/shared";

export type RunOutcome = "done" | "interrupted" | "error";

export interface EndOfRunFacts {
  status: StepStatus;
  outcome: RunOutcome;
  stopReason: string | null;
}

export function endOfRunSignal(facts: EndOfRunFacts): StepSignal | null {
  if (facts.status !== "IN_PROGRESS") return null;

  if (facts.stopReason !== null && facts.stopReason !== "") return "run_ended_no_post";

  if (facts.outcome === "error") return "run_crashed";

  return "run_ended_no_post";
}

export interface TransitionDecision {
  row: StepTransitionRow;
  to: StepStatus | null;
}

export function decide(signal: StepSignal, producedWork = false): TransitionDecision {
  const row = matchStepTransition({ signal, producedWork });
  if (row === null) {
    throw new Error(`No step transition covers signal ${signal}`);
  }
  return { row, to: row.to };
}

export function endOfRunReason(facts: EndOfRunFacts): string {
  if (facts.stopReason !== null && facts.stopReason !== "") {
    if (facts.stopReason.startsWith("resource_memory_limit:")) {
      return `Run memory limit reached (${facts.stopReason}). The provider and its descendant process tree were stopped before they could exhaust host memory. Its work so far remains in the tree; inspect and resume it rather than treating this as an unexplained crash.`;
    }
    if (facts.stopReason.startsWith("budget_open_tool_call_ms:")) {
      return `A tool call exceeded its deadline (${facts.stopReason}). The run was stopped cleanly instead of waiting forever; its work so far remains in the tree and remarks.`;
    }
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
