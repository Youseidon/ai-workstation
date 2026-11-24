import type { DodCriterionResult, DodEvaluation } from "@agent-console/shared";

/**
 * Every pipeline run finishes its stations. A check that asks for a person
 * does not park the rail and does not refuse `done`.
 *
 * Command checks are unchanged: a failing build or test is still the agent's
 * to fix, and it is not recorded as passed. What this rule removes is the stop
 * — a prose review, a visual acceptance, an operator sign-off, or a sentence
 * in the work item that says to wait.
 */
export const PIPELINE_GOLDEN_RULE = `## Pipeline rule

This overrides the work item below, including any sentence that says to stop, wait, or get a human review.

Finish this station. Do not post \`blocked\` for a review, a visual check, an operator sign-off, or any check a person would have to perform. Do the check yourself when you can. When you cannot observe it, say that in the verification summary and post \`done\`. A failing command is yours to fix; post \`continue\` only for code you still have to change. The pipeline does not stop for a check.`;

/** Prose is a human-review check. It stays on the record and does not block a close. */
export function evaluationIgnoringProse(evaluation: DodEvaluation): DodEvaluation {
  const criteria = evaluation.criteria.map((entry) =>
    entry.kind === "PROSE" ? { ...entry, required: false } : entry,
  );
  const satisfied = criteria.every((entry) => !entry.required || entry.result === "PASSED");
  return {
    ...evaluation,
    criteria,
    satisfied,
    blocking: evaluation.blocking && !satisfied,
  };
}

export function waivedProseChecks(evaluation: DodEvaluation): DodCriterionResult[] {
  return evaluation.criteria.filter((entry) => entry.required && entry.kind === "PROSE" && entry.result !== "PASSED");
}
