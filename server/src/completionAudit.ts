import { AUDIT_CHECK_RESULTS, COMPLETION_VERDICTS, type CompletionAuditCheck, type CompletionAuditReport, type CompletionVerdict, type ProviderId } from "@agent-console/shared";
import { detectProviders, getAdapter } from "./adapters/registry.ts";
import { newId } from "./lib/ids.ts";
import { createLogger } from "./lib/logger.ts";
import { runHub } from "./runHub.ts";
import { runContexts } from "./runContext.ts";
import { startRun } from "./runner.ts";
import { materialize } from "./workspaceInstructions.ts";
import { workspaces, type RunCostMetrics } from "./workspaces.ts";

const log = createLogger("audit");

/*
 * The problem this exists for: a developer agent finishes a work item, then
 * ends without posting DONE. `finishAgentRun` has to assume the worst and marks
 * the station BLOCKED, so the pipeline parks — and an operator who comes back
 * hours later finds a rail stopped on its first station with the work already
 * sitting in the tree. Cursor is the frequent offender, but a crashed process,
 * an exhausted budget or a lost network call produce exactly the same record.
 *
 * The fix is not to trust the previous agent. It is to send a *different*,
 * read-only agent to check the tree against the work item's own acceptance
 * criteria and say whether the work is there. That agent cannot edit anything
 * and cannot post a status; it returns a verdict, and only a COMPLETE verdict
 * with no failed check is allowed to close the station.
 */

/** One audit per source run is automatic; the rest are operator-requested. */
const AUTO_ATTEMPTS_PER_RUN = 1;

/**
 * Read-only is the whole point, so a provider that cannot be held read-only
 * cannot audit — and neither can the agent whose own run is on trial, which
 * would be marking its own homework.
 */
async function providerFor(requested: ProviderId | undefined, exclude: ProviderId): Promise<ProviderId | null> {
  const providers = await detectProviders();
  const eligible = providers.filter((item) => item.available && item.id !== "cursor" && item.id !== exclude);
  if (eligible.length === 0) return null;
  if (requested !== undefined && eligible.some((item) => item.id === requested)) return requested;
  return eligible[0]!.id;
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
export function reconcileVerdict(claimed: CompletionVerdict, checks: CompletionAuditCheck[]): CompletionVerdict {
  if (claimed !== "COMPLETE") return claimed;
  if (checks.length === 0) return "UNVERIFIABLE";
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
    verdict: reconcileVerdict(claimed, checks),
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
  // The station must be blocked *by the system*. An agent that posted BLOCKED
  // itself asked a human a question, and no amount of tree-reading answers it.
  if (!workspaces.blockedWithoutAgentStatus(args.promptId)) return { started: false, block: "not_auditable" };
  const previous = workspaces.completionAuditsForRun(args.sourceRunId);
  if (previous.some((item) => item.state === "QUEUED" || item.state === "RUNNING")) return { started: false, block: "audit_running" };
  if (args.automatic !== false && previous.length >= AUTO_ATTEMPTS_PER_RUN) return { started: false, block: "attempt_limit" };

  const provider = await providerFor(args.auditProvider, args.sourceProvider);
  if (provider === null) {
    log.warn(`no read-only provider available for audit prompt=${args.promptId}`);
    return { started: false, block: "provider_unavailable" };
  }
  const model = args.auditModel ?? null;
  const id = newId("audit");
  const record = workspaces.createCompletionAudit({ id, workspaceId: args.workspaceId, promptId: args.promptId, sourceRunId: args.sourceRunId, provider, model });

  const runId = newId("run");
  const credential = runContexts.create(runId, args.workspaceId, args.promptId);
  // Recorded with the handoff role: like a handoff this is a read-only
  // support run, and that role is what forces the provider's read-only mode,
  // keeps it out of "a writer is active in this workspace", and stops it
  // owning the station's single active-execute slot.
  workspaces.beginHandoffAgentRun({ runId, workspaceId: args.workspaceId, promptId: args.promptId, provider, model, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt });
  workspaces.updateCompletionAudit(id, { state: "RUNNING", auditRunId: runId });

  const workspace = workspaces.get(args.workspaceId);
  const dossier = workspaces.completionAuditDossier(args.workspaceId, args.promptId, args.sourceRunId);
  const saved = workspaces.resolvePrompt(args.workspaceId, args.promptId);
  const prompt = auditPrompt(dossier, outcome.result);

  let answer = "";
  materialize(workspace);
  const handle = startRun({
    runId,
    adapter: getAdapter(provider),
    prompt,
    cwd: workspace.workDirectory,
    model,
    role: "handoff",
    permissionOverride: "handoff",
    onEvent: (event) => {
      if (event.type === "assistant_text" && event.payload.kind === "message") answer += event.payload.text;
      if (event.type === "result" && event.payload.text) answer = event.payload.text;
      workspaces.recordAgentEvent(runId, event);
      runHub.event(runId, event);
    },
    onEnd: (ended, state, metrics) => {
      void finishAudit(record.id, ended, state, answer, args, metrics).catch((error) => log.error("finish failed", error));
    },
  });
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
}

function auditPrompt(dossier: string, blockReason: string): string {
  return `You are a read-only completion auditor. You cannot edit files, run mutating commands, or post any orchestration status. Another agent was asked to do the work item below and its process ended without ever reporting an outcome, so the orchestrator had to record it as blocked:

"${blockReason.slice(0, 1000)}"

Your only job is to answer one question from evidence in the working tree: did that agent actually finish this work item, or is real work still missing?

Method, in this order:
1. Read the acceptance criteria in the dossier. Turn them into a concrete checklist.
2. Inspect the current working tree yourself. Read the files the criteria are about. Use git (status, diff, log, show) to see what actually changed. Run the read-only verification commands the work item names — builds, tests, type checks, linters — and read their real output.
3. Judge each criterion only on what you observed. The previous agent's own claims in the transcript are a hint about where to look, never evidence that something is done.

Verdicts:
- COMPLETE — every acceptance criterion is satisfied in the tree right now. Use this only when your own checks passed. This closes the work item, so a wrong COMPLETE silently loses work.
- INCOMPLETE — you found something specific that is missing, broken, or failing. Name it.
- UNVERIFIABLE — you could not check enough to be sure. Not being able to run a command, or an ambiguous criterion, belongs here. This is a safe answer; a guess is not.

Return one JSON object only, no prose around it, with keys: verdict (COMPLETE, INCOMPLETE, or UNVERIFIABLE), confidence (HIGH, MEDIUM, or LOW), checks (array of {criterion, result: PASSED|FAILED|UNVERIFIED, evidence, command}), remainingWork (array of strings, empty if COMPLETE), verificationSummary (one paragraph of the concrete commands you ran and the results you saw — this is recorded as the work item's evidence if you say COMPLETE), reasoning (why this verdict follows from the checks).

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
): Promise<void> {
  workspaces.finishAgentRun(runId, state, "", metrics);
  runContexts.complete(runId);
  runHub.end(runId, state);
  const now = new Date().toISOString();
  const { pipelineScheduler } = await import("./pipelineScheduler.ts");

  if (state !== "done") {
    workspaces.updateCompletionAudit(id, { state: "FAILED", error: `Audit agent ended ${state}`, completedAt: now });
    await pipelineScheduler.onAuditSettled({ promptId: args.promptId, sourceRunId: args.sourceRunId, verdict: null });
    runHub.operationsChanged();
    return;
  }

  let report: CompletionAuditReport;
  try {
    report = parseReport(answer);
  } catch (error) {
    workspaces.updateCompletionAudit(id, { state: "FAILED", error: error instanceof Error ? error.message : String(error), completedAt: now });
    await pipelineScheduler.onAuditSettled({ promptId: args.promptId, sourceRunId: args.sourceRunId, verdict: null });
    runHub.operationsChanged();
    return;
  }

  const provider = workspaces.completionAuditById(id)?.provider ?? args.sourceProvider;
  workspaces.updateCompletionAudit(id, {
    state: "READY",
    verdict: report.verdict,
    report,
    reportMarkdown: auditMarkdown(report, provider, args.sourceRunId),
    completedAt: now,
  });
  log.info(`audit verdict=${report.verdict} prompt=${args.promptId} confidence=${report.confidence}`);

  // The verdict is recorded either way. Whether a COMPLETE is allowed to close
  // the station is a separate, operator-owned decision, and it is the
  // scheduler's to make — an audit started by hand on a station no pipeline is
  // sitting on must not silently complete it.
  const applied = await pipelineScheduler.onAuditSettled({ promptId: args.promptId, sourceRunId: args.sourceRunId, verdict: report.verdict, verificationSummary: verificationText(report, provider) });
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
