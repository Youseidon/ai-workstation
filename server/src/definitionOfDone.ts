/**
 * Producing the evidence a definition of done is judged on.
 *
 * The gate itself lives in `workspaces.writeStatus` and is a pure read: it asks
 * what has been *recorded* about each criterion and never runs anything. This
 * is the other half — the part that goes and finds out.
 *
 * The split is not tidiness. Running a criterion means holding a shell open for
 * as long as a test suite takes; doing that from inside the gate would mean a
 * SQLite write transaction held open for minutes, and a console whose whole job
 * is watching live agents blocked on its own event loop. So the paths that
 * intend to close a work item run the commands first, here, and then write the
 * status. A command nobody ran is UNVERIFIED, and UNVERIFIED closes nothing —
 * the same rule as a run that ended without reporting, for the same reason.
 */

import { unmetCriteria, type DodEvaluation } from "@agent-console/shared";
import { commandPassed, describeOutcome, runDodCommand } from "./dodCommands.ts";
import { createLogger } from "./lib/logger.ts";
import { workspaces } from "./workspaces.ts";

const log = createLogger("dod");

/**
 * Run every command criterion for a work item and file what each one returned.
 *
 * Sequential on purpose. These are builds, test suites and type checks against
 * one working tree — running them at once would have them fighting over the
 * same `node_modules`, the same ports and the same lock files, and a criterion
 * that fails because another criterion was running is worse than a slow gate.
 *
 * Never throws. A criterion that cannot be run is a criterion that did not
 * pass, and that is a fact about the work item, not an error for the caller:
 * a close refused because the operator typed a command that does not exist is
 * exactly right, and the message saying so is the evidence.
 */
export async function runDefinitionOfDoneCommands(promptId: number, runId: string | null = null): Promise<void> {
  let plan: { workDirectory: string; criteria: ReturnType<typeof workspaces.dodCommandPlan>["criteria"] };
  try {
    plan = workspaces.dodCommandPlan(promptId);
  } catch (error) {
    log.warn(`could not read the definition of done for prompt=${promptId}`, error);
    return;
  }
  if (plan.criteria.length === 0) return;

  for (const criterion of plan.criteria) {
    if (criterion.command === null) continue;
    try {
      const outcome = await runDodCommand({
        command: criterion.command,
        workDirectory: plan.workDirectory,
        cwd: criterion.cwd,
        timeoutMs: criterion.timeoutMs,
      });
      const passed = commandPassed(outcome, criterion.expectExitCode);
      workspaces.recordDodResult({
        promptId,
        criterionId: criterion.id,
        runId,
        source: "RUNNER",
        result: passed ? "PASSED" : "FAILED",
        evidence: describeOutcome(outcome, criterion.expectExitCode),
        output: outcome.output,
        exitCode: outcome.exitCode,
      });
      log.info(`dod ${passed ? "passed" : "FAILED"} prompt=${promptId} exit=${outcome.exitCode} ${criterion.command.slice(0, 80)}`);
    } catch (error) {
      // Refused before it ran at all — a cwd outside the workspace is the one
      // that gets here. Recorded as a failure with the refusal as its reason,
      // so the operator sees why rather than seeing nothing.
      const message = error instanceof Error ? error.message : String(error);
      workspaces.recordDodResult({
        promptId, criterionId: criterion.id, runId, source: "RUNNER",
        result: "FAILED", evidence: `This criterion could not be run: ${message}`, output: "", exitCode: null,
      });
      log.warn(`dod criterion refused prompt=${promptId} criterion=${criterion.id}: ${message}`);
    }
  }
}

/**
 * File a reviewer's verdicts against the criteria it was asked about.
 *
 * Only checks that quoted a `criterionId` back are recorded, and only against
 * criteria this work item actually has. Matching a reviewer's prose to a
 * criterion by string similarity would be a fuzzy comparison deciding whether
 * work closes; a check that names nothing is simply not filed.
 *
 * `COMMAND` and `CHILDREN_CLOSED` results are refused here however confidently
 * the reviewer reports them. Those two are settled by an exit code and by the
 * child rollup — that is the entire reason they are not prose — and letting a
 * model's opinion overwrite a recorded exit code would hand back the thing this
 * feature was built to take away.
 */
export function recordReviewerVerdicts(args: {
  promptId: number;
  runId: string | null;
  checks: ReadonlyArray<{ criterionId: number | null; criterion: string; result: string; evidence: string }>;
}): number {
  const criteria = new Map(
    workspaces.resolvedDefinitionOfDone(args.promptId).criteria.map((entry) => [entry.id, entry]),
  );
  let filed = 0;
  for (const check of args.checks) {
    if (check.criterionId === null) continue;
    const criterion = criteria.get(check.criterionId);
    if (criterion === undefined || criterion.kind !== "PROSE") continue;
    const result = check.result === "PASSED" ? "PASSED" : check.result === "FAILED" ? "FAILED" : "UNVERIFIED";
    workspaces.recordDodResult({
      promptId: args.promptId,
      criterionId: criterion.id,
      runId: args.runId,
      source: "REVIEWER",
      result,
      evidence: check.evidence === "" ? check.criterion : check.evidence,
    });
    filed += 1;
  }
  return filed;
}

/** One line per unmet criterion, for a log or a stop reason. */
export function describeUnmet(evaluation: DodEvaluation): string {
  return unmetCriteria(evaluation)
    .map((entry) => `${entry.text} — ${entry.result}${entry.evidence === "" ? "" : ` (${entry.evidence})`}`)
    .join("; ");
}
