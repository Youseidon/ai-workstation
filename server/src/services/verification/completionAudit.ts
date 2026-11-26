import type { ProcessIdentity } from "../../contracts/execution.ts";
import { executionHash } from "../../repositories/executionStore.ts";
import { repositoryResource, sourceFingerprint, environmentFingerprint } from "../../infrastructure/sourceFingerprint.ts";
import { trackRuntimeEffect, releaseRuntimeEffect, acceptSupervisedUnit, settleSupervisedRun } from "../execution/executionSupervisor.ts";
import { AUDIT_CHECK_RESULTS, COMPLETION_VERDICTS, isProviderId, type CompletionAuditCheck, type CompletionAuditReport, type CompletionVerdict, type ProviderId } from "@hydra/shared";
import { detectProviders, getAdapter, getProviderInfo, resolveProviderModel } from "../../providers/registry.ts";
import { recordReviewerVerdicts } from "./definitionOfDone.ts";
import { newId } from "../../utils/ids.ts";
import { createLogger } from "../../utils/logger.ts";
import { isCooling } from "../../providers/providerHealth.ts";
import { runHub } from "../runs/runHub.ts";
import { runContexts } from "../runs/runContext.ts";
import { startRun } from "../runs/runner.ts";
import { materialize } from "../workspaces/workspaceInstructions.ts";
import { executionStore, evidenceStore, workspaces } from "../../repositories/workspaces.ts";
import type { RunCostMetrics } from "../../models/workspaces.ts";

const log = createLogger("audit");

export function selectAuditProvider(available:readonly ProviderId[],source:ProviderId,requested?:ProviderId):ProviderId|null {
  // An explicitly requested fresh read-only session is independent even when
  // the operator chooses the same provider as the writer.
  if(requested && available.includes(requested))return requested;
  const alternatives=available.filter(provider=>provider!==source);
  const pool=alternatives.length>0?alternatives:available;
  // Prefer the lean native transport for the bounded review allowance.
  return pool.includes("codex")?"codex":pool[0] ?? null;
}

/*
 * The problem this exists for: a developer agent finishes a work item, then
 * ends without posting DONE. After the continuation loop spends its allowance,
 * one read-only agent checks the tree against the work item's acceptance
 * criteria and says whether the work is there. That agent cannot edit anything
 * and cannot post a status; it returns a verdict, and only a COMPLETE verdict
 * with no failed check is allowed to close the station.
 */

/**
 * First available read-only provider that is not the source. Cursor cannot be
 * held read-only, so it is never eligible. When excluding the source would leave
 * nobody, fall back to any read-only provider rather than declining silently.
 */
async function providerFor(
  requested: ProviderId | undefined,
  exclude: ProviderId,
): Promise<ProviderId | null> {
  const providers = await detectProviders();
  // Skip cooling providers — a reviewer that cannot start is worse than none.
  const readOnly = providers.filter((item) => item.available && item.id !== "cursor" && !isCooling(item.id));
  return selectAuditProvider(readOnly.map(item=>item.id),exclude,requested);
}

function list(value: unknown, max = 30): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, max) : [];
}

function parseChecks(value: unknown): CompletionAuditCheck[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .slice(0, 40)
    .map((row) => ({
      criterion: String(row.criterion ?? "").slice(0, 500),
      // Anything that is not a plain integer is treated as "the reviewer did
      // not name a criterion". A coerced id would file a verdict against the
      // wrong one, which is worse than filing it against none.
      criterionId: typeof row.criterionId === "number" && Number.isInteger(row.criterionId) ? row.criterionId : null,
      result: typeof row.result === "string" && AUDIT_CHECK_RESULTS.includes(row.result.toUpperCase() as never)
        ? (row.result.toUpperCase() as CompletionAuditCheck["result"])
        : "UNVERIFIED",
      evidence: String(row.evidence ?? "").slice(0, 2000),
      command: typeof row.command === "string" && row.command.trim() !== "" ? row.command.trim().slice(0, 500) : null,
    }))
    .filter((check) => check.criterion !== "");
}

/**
 * The auditor's own word is taken for INCOMPLETE and UNVERIFIABLE, but a
 * COMPLETE is only honoured when its own evidence supports it: at least one
 * criterion checked, none failed, and none left unverified. An agent that says
 * COMPLETE while reporting a failed check has contradicted itself, and the
 * contradiction is resolved against closing the station.
 */
export function reconcileVerdict(claimed: CompletionVerdict, checks: CompletionAuditCheck[], requiredIds?: readonly number[], allowedIds: readonly number[] | undefined = requiredIds): CompletionVerdict {
  if (claimed !== "COMPLETE") return claimed;
  if (checks.length === 0) return "UNVERIFIABLE";
  if (requiredIds !== undefined && requiredIds.length > 0) {
    const allowed = new Set(allowedIds);
    const seen = new Set<number>();
    for (const check of checks) {
      if (check.criterionId === null || !allowed.has(check.criterionId) || seen.has(check.criterionId)) return "UNVERIFIABLE";
      seen.add(check.criterionId);
    }
    if (requiredIds.some(id=>!seen.has(id))) return "UNVERIFIABLE";
  }
  if (checks.some((check) => check.result === "FAILED")) return "INCOMPLETE";
  if (checks.some((check) => check.result === "UNVERIFIED")) return "UNVERIFIABLE";
  return "COMPLETE";
}

export function parseReport(text: string): CompletionAuditReport {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const raw = JSON.parse(candidate) as Record<string, unknown>;
  const claimed: CompletionVerdict = typeof raw.verdict === "string" && COMPLETION_VERDICTS.includes(raw.verdict.toUpperCase() as never)
    ? (raw.verdict.toUpperCase() as CompletionVerdict)
    : "UNVERIFIABLE";
  const checks = parseChecks(raw.checks);
  const confidence = typeof raw.confidence === "string" && ["HIGH", "MEDIUM", "LOW"].includes(raw.confidence.toUpperCase())
    ? (raw.confidence.toUpperCase() as CompletionAuditReport["confidence"])
    : "LOW";
  return {
    version: 1,
    verdict: claimed==="COMPLETE" && list(raw.remainingWork).length>0 ? "INCOMPLETE" : reconcileVerdict(claimed, checks),
    confidence,
    checks,
    remainingWork: list(raw.remainingWork),
    verificationSummary: typeof raw.verificationSummary === "string" ? raw.verificationSummary.slice(0, 20000) : "",
    reasoning: typeof raw.reasoning === "string" ? raw.reasoning.slice(0, 20000) : "",
  };
}

export function auditMarkdown(report: CompletionAuditReport, provider: ProviderId, sourceRunId: string): string {
  const rows = report.checks.length === 0
    ? "_The auditor checked nothing it could name._"
    : ["| Criterion | Result | Evidence | Command |", "| --- | --- | --- | --- |"]
      .concat(report.checks.map((check) => `| ${cell(check.criterion)} | ${check.result} | ${cell(check.evidence)} | ${cell(check.command ?? "")} |`))
      .join("\n");
  const remaining = report.remainingWork.length === 0 ? "- None found." : report.remainingWork.map((item) => `- ${item}`).join("\n");
  return `# Completion audit\n\n**Verdict: ${report.verdict}** (confidence ${report.confidence}) — read-only ${provider} audit of run \`${sourceRunId}\`.\n\n## Checks\n\n${rows}\n\n## Work still missing\n\n${remaining}\n\n## Reasoning\n\n${report.reasoning || "_Not given._"}\n`;
}

/** Markdown tables cannot carry a raw pipe or newline; neither is worth losing the row over. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").slice(0, 300);
}

export type AuditBlock = "already_complete" | "not_auditable" | "audit_running" | "attempt_limit" | "provider_unavailable";
export type ScheduleAuditResult = { started: true; auditId: string } | { started: false; block: AuditBlock };

export interface ScheduleAuditArgs {
  workspaceId: number;
  promptId: number;
  sourceRunId: string;
  sourceProvider: ProviderId;
  /** Set by an operator asking for a specific auditor; otherwise one is chosen. */
  auditProvider?: ProviderId;
  auditModel?: string | null;
  /** False for a manual audit, which is allowed past the automatic attempt cap. */
  automatic?: boolean;
}

export async function scheduleCompletionAudit(args: ScheduleAuditArgs): Promise<ScheduleAuditResult> {
  const outcome = workspaces.promptOutcome(args.promptId);
  if (outcome.status === "DONE" || outcome.status === "SKIPPED") return { started: false, block: "already_complete" };
  // An agent that posted BLOCKED itself asked a human a question; tree-reading
  // cannot answer it. Everything else the continuation loop parks on is fair game.
  if (outcome.status === "BLOCKED" && workspaces.latestStatusTrigger(args.promptId) === "agent_post") {
    return { started: false, block: "not_auditable" };
  }

  const previous = workspaces.completionAuditsForRun(args.sourceRunId);
  if (previous.some((item) => item.state === "QUEUED" || item.state === "RUNNING")) return { started: false, block: "audit_running" };
  // One automatic audit per source run — the post-N path must not loop.
  if (args.automatic !== false && previous.length >= 1) return { started: false, block: "attempt_limit" };

  const provider = await providerFor(
    args.auditProvider !== undefined && isProviderId(args.auditProvider) ? args.auditProvider : undefined,
    args.sourceProvider,
  );
  if (provider === null) {
    log.warn(`no read-only provider available for audit prompt=${args.promptId}`);
    return { started: false, block: "provider_unavailable" };
  }
  const providerInfo = await getProviderInfo(provider);
  const model = resolveProviderModel(providerInfo, args.auditModel ?? null);
  const id = newId("audit");
  const managed=executionStore.forPrompt(args.promptId);
  let effect:ReturnType<typeof executionStore.reserve>|null=null;
  if(managed?.engine==="supervised") {
    const usage=executionStore.status(managed.id);
    const ordinaryAttempts=usage.attempts-executionStore.unitUsage(managed.id,args.promptId).recovery;
    const pending=executionStore.pending().find(e=>e.contractId===managed.id && e.payload.kind==="audit" && e.payload.sourceRunId===args.sourceRunId && e.state==="PENDING");
    effect=pending ?? executionStore.reserve({contractId:managed.id,promptId:args.promptId,requestId:args.automatic===false?`manual-audit-${id}`:`audit-${args.sourceRunId}`,expectedGeneration:managed.generation,revision:managed.revision,resource:repositoryResource(workspaces.get(args.workspaceId).workDirectory),payload:{kind:"audit",sourceRunId:args.sourceRunId,provider,model,actor:"reviewer"},actor:"reviewer",recovery:ordinaryAttempts>=managed.policy.maxAttempts-managed.policy.recoveryAttempts || usage.activeMs+managed.policy.workerMs>managed.policy.maxActiveMs*0.8 || usage.tokens+managed.policy.workerTokens>managed.policy.maxTokens*0.8});
    if(!executionStore.claim(effect.id)) return {started:false,block:"audit_running"};
    trackRuntimeEffect(effect.id);
  }
  try {
  const record = workspaces.createCompletionAudit({ id, workspaceId: args.workspaceId, promptId: args.promptId, sourceRunId: args.sourceRunId, provider, model });
  const runId = effect?.runId ?? newId("run");
  const credential = runContexts.create(runId, args.workspaceId, args.promptId);
  // Recorded with the handoff role: like a handoff this is a read-only
  // support run, and that role is what forces the provider's read-only mode,
  // keeps it out of "a writer is active in this workspace", and stops it
  // owning the station's single active-execute slot.
  workspaces.beginHandoffAgentRun({ runId, workspaceId: args.workspaceId, promptId: args.promptId, provider, model, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt });
  workspaces.updateCompletionAudit(id, { state: "RUNNING", auditRunId: runId });

  const workspace = workspaces.get(args.workspaceId);
  const legacyDossier = workspaces.completionAuditDossier(args.workspaceId, args.promptId, args.sourceRunId);
  const dossier=managed?.engine==="supervised" ? JSON.stringify({workItem:legacyDossier,execution:{originalPrompt:managed.originalPrompt,contractVersion:managed.version,criteria:managed.criteria,plan:executionStore.plan(managed.id),runnerHistory:evidenceStore.runnerHistory(args.promptId),sharedConsumers:executionStore.sharedConsumers(args.promptId).map(consumer=>({contractId:consumer.contract.id,originalPrompt:consumer.contract.originalPrompt,unit:consumer.unit})),currentUnitId:args.promptId,deliveryPhase:managed.phase}}) : legacyDossier;
  const saved = workspaces.resolvePrompt(args.workspaceId, args.promptId);
  const guide=effect ? `

Use server-owned command recipes rather than building in your read-only sandbox. Replace criterionId 42 with the dossier's ID and use a unique requestId for each new check:

\`curl -fsS -X POST -H 'Authorization: Bearer ${credential.token}' -H 'Content-Type: application/json' 'http://127.0.0.1:${(await import("../../config/config.ts")).config.port}/api/agent/runs/${runId}/check' -d '{"requestId":"unique-check-request","criterionId":42,"expectedGeneration":${effect.generation},"planRevision":${effect.revision}}'\`

The response contains the persisted runner fact and output. Quote that fact accurately; you cannot override it. execution.runnerHistory contains trusted historical command receipts; distinct requestKeyHash values establish distinct admitted request identities without exposing request keys. Historical failures prove what happened, while only current matching evidence can satisfy a check now. Judge the implementation and submitted handoff; the accepted review and final DONE status are outcomes of your decision, not prerequisites for it. A DONE submission refused solely because this independent review is pending is not an implementation defect. For a contribution unit, judge the assigned concrete targets as a contribution to its criteria; the complete integration owner still has to verify the whole original requirement. For a complete unit, review every original implementation and handoff obligation, not only compilation. Check that every deferred verification obligation has an explicit criterion and owner in the contract. A current implementation unit can be accepted with verification pending at that owner; an unowned deferred obligation makes the verdict UNVERIFIABLE.` : "";
  const prompt = auditPrompt(dossier, outcome.result)+guide;

  let answer = "";
  materialize(workspace);
  const snapshot={inputHash:sourceFingerprint(workspace.workDirectory),environmentHash:environmentFingerprint(workspace.workDirectory),definitionHash:executionHash(workspaces.resolvedDefinitionOfDone(args.promptId))};
  let handle:ReturnType<typeof startRun>;
  try {handle = startRun({
    runId,
    adapter: getAdapter(provider),
    prompt,
    cwd: workspace.workDirectory,
    model,
    role: "handoff",
    permissionOverride: "handoff",
    ...(effect?{budget:{maxWallClockMs:managed!.policy.workerMs,maxInputTokens:managed!.policy.workerTokens,maxTotalTokens:managed!.policy.workerTokens},onSpawn:(identity:ProcessIdentity)=>executionStore.attachProcess(effect!.id,identity)}:{}),
    onEvent: (event) => {
      if (event.type === "assistant_text" && event.payload.kind === "message") answer += event.payload.text;
      if (event.type === "result" && event.payload.text) answer = event.payload.text;
      workspaces.recordAgentEvent(runId, event);
      runHub.event(runId, event);
    },
    onEnd: (ended, state, metrics) => {
      void finishAudit(record.id, ended, state, answer, args, metrics, snapshot).catch((error) => log.error("finish failed", error));
    },
  });} catch(error) {
    workspaces.finishAgentRun(runId,"error");runContexts.revoke(runId);
    if(effect) {releaseRuntimeEffect(effect.id);executionStore.settle(effect.id,{generation:effect.generation,actualMs:0,actualTokens:0,result:{auditStartFailed:String(error)},writerDead:true});}
    workspaces.updateCompletionAudit(id,{state:"FAILED",error:String(error),completedAt:new Date().toISOString()});
    throw error;
  }
  workspaces.markAgentRunRunning(runId);
  runHub.start({
    handle,
    workspace: { id: workspace.id, name: workspace.name, workDirectory: workspace.workDirectory },
    source: { type: "audit", auditId: id, promptId: args.promptId, promptKey: saved.externalKey, title: saved.title, sourceRunId: args.sourceRunId },
    role: "handoff",
    permissionMode: handle.permissionMode,
  });
  void handle.done.catch((error) => log.error("run failed", error));
  log.info(`audit started prompt=${args.promptId} provider=${provider} source=${args.sourceRunId}`);
  return { started: true, auditId: id };
  } catch(error) {
    const audit=workspaces.completionAuditById(id);
    if(audit?.auditRunId) {workspaces.finishAgentRun(audit.auditRunId,"error");runContexts.revoke(audit.auditRunId);}
    if(effect) {
      releaseRuntimeEffect(effect.id);
      const current=executionStore.effect(effect.id);
      if(!["SETTLED","CANCELLED"].includes(current.state)) {
        if(current.process) executionStore.quarantine(effect.id,"Audit failed after process registration");
        else executionStore.settle(effect.id,{generation:effect.generation,actualMs:0,actualTokens:0,result:{preflightFailed:String(error)},writerDead:true});
      }
    }
    if(audit) workspaces.updateCompletionAudit(id,{state:"FAILED",error:String(error),completedAt:new Date().toISOString()});
    throw error;
  }
}

function auditPrompt(dossier: string, blockReason: string): string {
  return `You are a read-only completion auditor. You cannot edit files, run mutating commands, or post any orchestration status. Another agent was asked to do the work item below and the station used up its continuations without finishing:

"${blockReason.slice(0, 1000)}"

Your only job is to answer one question from evidence in the working tree: did that agent actually finish this work item, or is real work still missing?

Method, in this order:
1. Read \`definitionOfDone.criteria\` in the dossier — that is the checklist, and each entry carries a criterionId you must quote back. A criterion marked \`alreadyChecked\` was run by the orchestrator itself; its result is a fact you cannot overturn, so report it as you found it. Where no criteria are listed, fall back to \`acceptanceCriteria\` and turn that prose into a checklist of your own.
2. Inspect the current working tree yourself. Read the files the criteria are about. Use git (status, diff, log, show) to see what actually changed. Run the read-only verification commands the work item names — builds, tests, type checks, linters — and read their real output.
3. Judge each criterion only on what you observed. The previous agent's own claims in the transcript are a hint about where to look, never evidence that something is done.

Verdicts:
- COMPLETE — every acceptance criterion is satisfied in the tree right now. Use this only when your own checks passed. This closes the work item, so a wrong COMPLETE silently loses work.
- INCOMPLETE — you found something specific that is missing, broken, or failing. Name it.
- UNVERIFIABLE — you could not check enough to be sure. Not being able to run a command, or an ambiguous criterion, belongs here. This is a safe answer; a guess is not.

A check that only a person can perform — a visual acceptance, an operator sign-off, an unobserved browser walk — does not make the work incomplete. Report it as not observed. When every command check passes, the verdict is COMPLETE.

If your verdict is INCOMPLETE, \`remainingWork\` is a brief for a human (or the next Resume), not a developer agent: name the exact files, routes, ids or commands involved, and say what "done" looks like.

Return one JSON object only, no prose around it, with keys: verdict (COMPLETE, INCOMPLETE, or UNVERIFIABLE), confidence (HIGH, MEDIUM, or LOW), checks (array of {criterionId, criterion, result: PASSED|FAILED|UNVERIFIED, evidence, command} — criterionId is the number from the dossier, or null for a criterion of your own), remainingWork (array of instruction strings, empty if COMPLETE), verificationSummary (one paragraph of the concrete commands you ran and the results you saw — this is recorded as the work item's evidence if you say COMPLETE), reasoning (why this verdict follows from the checks).

DOSSIER
${dossier}`;
}

async function finishAudit(
  id: string,
  runId: string,
  state: "done" | "interrupted" | "error",
  answer: string,
  args: ScheduleAuditArgs,
  metrics?: RunCostMetrics,
  snapshot?:{inputHash:string;environmentHash:string;definitionHash:string},
): Promise<void> {
  workspaces.finishAgentRun(runId, state, "", metrics);
  runContexts.complete(runId);
  runHub.end(runId, state);
  if(!await settleSupervisedRun(runId,true)) return;
  const now = new Date().toISOString();
  const { pipelineScheduler } = await import("../pipeline/pipelineScheduler.ts");

  if (state !== "done") {
    workspaces.updateCompletionAudit(id, { state: "FAILED", error: `Audit agent ended ${state}`, completedAt: now });
    await pipelineScheduler.onAuditSettled({ promptId: args.promptId, sourceRunId: args.sourceRunId, verdict: null,auditId:id });
    runHub.operationsChanged();
    return;
  }

  let report: CompletionAuditReport;
  try {
    report = parseReport(answer);
  } catch (error) {
    workspaces.updateCompletionAudit(id, { state: "FAILED", error: error instanceof Error ? error.message : String(error), completedAt: now });
    await pipelineScheduler.onAuditSettled({ promptId: args.promptId, sourceRunId: args.sourceRunId, verdict: null,auditId:id });
    runHub.operationsChanged();
    return;
  }

  // Before the verdict is acted on: the reviewer's per-criterion answers become
  // `dod_result` rows, so the definition of done accumulates evidence from the
  // review rather than the review being a separate opinion sitting beside it.
  // Only PROSE criteria are taken — a command's exit code is already recorded
  // and is not a model's to overturn.
  const definition=workspaces.resolvedDefinitionOfDone(args.promptId);
  const requiredIds = definition.criteria.filter(item => item.required).map(item => item.id);
  report.verdict = reconcileVerdict(report.verdict, report.checks, requiredIds,definition.criteria.map(c=>c.id));
  const directory=workspaces.get(args.workspaceId).workDirectory;
  const stable=!!snapshot && snapshot.inputHash===sourceFingerprint(directory) && snapshot.environmentHash===environmentFingerprint(directory) && snapshot.definitionHash===executionHash(definition);
  if(!stable && report.verdict==="COMPLETE") report.verdict="UNVERIFIABLE";
  const filed = stable ? recordReviewerVerdicts({ promptId: args.promptId, runId, checks: report.checks,inputHash:snapshot!.inputHash,environmentHash:snapshot!.environmentHash }) : 0;
  const evaluation=workspaces.definitionOfDoneEvaluation(args.promptId);
  if(report.verdict==="COMPLETE" && evaluation.criteria.some(c=>c.required && c.kind!=="PROSE" && c.result!=="PASSED")) report.verdict=evaluation.criteria.some(c=>c.required && c.kind!=="PROSE" && c.result==="FAILED")?"INCOMPLETE":"UNVERIFIABLE";
  if (filed > 0) log.info(`recorded ${filed} definition-of-done verdicts from the reviewer prompt=${args.promptId}`);

  const provider = workspaces.completionAuditById(id)?.provider ?? args.sourceProvider;
  workspaces.updateCompletionAudit(id, {
    state: "READY",
    verdict: report.verdict,
    report,
    reportMarkdown: auditMarkdown(report, provider, args.sourceRunId),
    completedAt: now,
  });
  log.info(`audit verdict=${report.verdict} prompt=${args.promptId} confidence=${report.confidence}`);

  const applied = await pipelineScheduler.onAuditSettled({
    promptId: args.promptId,
    sourceRunId: args.sourceRunId,
    verdict: report.verdict,
    verificationSummary: verificationText(report, provider),
    report,
    auditId: id,
  });
  if (applied) workspaces.updateCompletionAudit(id, { applied: true });
  runHub.operationsChanged();
}

/**
 * What lands on the work item as its completion evidence. It names the auditor
 * and the run it adjudicated, because a station closed this way was never
 * confirmed by the agent that did the work, and anyone reading the record later
 * must be able to see that immediately.
 */
export function verificationText(report: CompletionAuditReport, provider: ProviderId): string {
  const passed = report.checks.filter((check) => check.result === "PASSED");
  const evidence = passed.length === 0 ? "" : `\n\nChecks:\n${passed.map((check) => `- ${check.criterion}${check.command === null ? "" : ` (\`${check.command}\`)`} — ${check.evidence}`).join("\n")}`;
  return `Closed by a read-only ${provider} completion audit, not by the agent that did the work: its run ended without posting a status. ${report.verificationSummary}${evidence}`;
}
