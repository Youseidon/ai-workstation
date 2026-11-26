import { unmetCriteria, type DodEvaluation } from "@hydra/shared";
import { recipeFingerprint } from "../../infrastructure/sourceFingerprint.ts";
import { requestCommand } from "../execution/commandTasks.ts";
import { createLogger } from "../../utils/logger.ts";
import { workspaces, WorkspaceError } from "../../repositories/workspaces.ts";

const log = createLogger("dod");

export async function runDefinitionOfDoneCommands(promptId: number, runId: string | null = null): Promise<void> {
  let plan: { workDirectory: string; criteria: ReturnType<typeof workspaces.dodCommandPlan>["criteria"] };
  try {
    plan = workspaces.dodCommandPlan(promptId);
  } catch (error) {
    log.warn(`could not read the definition of done for prompt=${promptId}`, error);
    return;
  }
  if (plan.criteria.length === 0) return;
  if (runId && workspaces.stationPolicy(promptId).verification === "deferred") {
    throw new WorkspaceError(409,"station_policy_conflict","This station defers verification but has command criteria. Move them to the designated Verify station before closing it.");
  }

  for (const criterion of plan.criteria) {
    if (criterion.command === null) continue;
    try {
      await requestCommand(promptId,criterion.id,runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      workspaces.recordDodResult({
        promptId, criterionId: criterion.id, runId, source: "RUNNER",
        result: "FAILED", evidence: `This criterion could not be run: ${message}`, output: "", exitCode: null,
      });
      log.warn(`dod criterion refused prompt=${promptId} criterion=${criterion.id}: ${message}`);
    }
  }
}

export function recordReviewerVerdicts(args: {
  promptId: number;
  runId: string | null;
  checks: ReadonlyArray<{ criterionId: number | null; criterion: string; result: string; evidence: string }>;
  inputHash?:string;environmentHash?:string;
}): number {
  const criteria = new Map(
    workspaces.resolvedDefinitionOfDone(args.promptId).criteria.map((entry) => [entry.id, entry]),
  );
  const seen=new Set<number>();
  for(const check of args.checks) {
    if(check.criterionId!==null && (!criteria.has(check.criterionId) || seen.has(check.criterionId))) return 0;
    if(check.criterionId!==null) seen.add(check.criterionId);
  }
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
      inputHash:args.inputHash,environmentHash:args.environmentHash,recipeHash:recipeFingerprint(criterion),stableInputs:!!args.inputHash && !!args.environmentHash,
    });
    filed += 1;
  }
  return filed;
}

export function describeUnmet(evaluation: DodEvaluation): string {
  return unmetCriteria(evaluation)
    .map((entry) => `${entry.text} — ${entry.result}${entry.evidence === "" ? "" : ` (${entry.evidence})`}`)
    .join("; ");
}
