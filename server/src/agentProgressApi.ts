import type { DbAccessPayload, NormalizedEvent } from "@agent-console/shared";
import { consultWorkspaceMarkdown, contextMarkdown } from "./agentContext.ts";
import { config } from "./config.ts";
import { describeAcceptedWrite, describeRead, describeRejectedWrite, type DbOperation } from "./dbAccessLog.ts";
import { runDefinitionOfDoneCommands } from "./definitionOfDone.ts";
import type { AgentProgressTools } from "./adapters/types.ts";
import { newId } from "./lib/ids.ts";
import { createLogger } from "./lib/logger.ts";
import { hashRunToken, runContexts } from "./runContext.ts";
import { runHub } from "./runHub.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

/*
 * The agent Progress API: how a running agent reads its work item and records
 * remarks and a terminal status. Reached two ways with identical rules - over
 * HTTP with a bearer run credential, or through in-process tools bound to that
 * same credential - so both paths go through the functions below.
 */

const log = createLogger("server");

/**
 * Record one trip an agent made to this app's database.
 *
 * Called where the agent API is entered - the HTTP route handler and the bound
 * tools - rather than by each adapter, so a raw curl, the CLI shim and a
 * provider's own tool call all produce the same line, and no adapter has to
 * cooperate for the operator to see it. The event rides the normal transcript
 * channel, so it streams live and is replayed to a tab that opens mid-run like
 * anything else.
 *
 * Failures here are swallowed. Losing a log line is bad; failing an agent's
 * status post because the logging of it broke would be very much worse.
 */
export function recordDbAccess(runId: string, payload: DbAccessPayload): void {
  try {
    const live = runHub.get(runId);
    const event: NormalizedEvent = {
      id: newId("evt"),
      runId,
      provider: live?.provider ?? "claude",
      model: live?.model ?? null,
      timestamp: new Date().toISOString(),
      type: "db_access",
      payload,
    };
    workspaces.recordAgentEvent(runId, event);
    runHub.event(runId, event);
  } catch (error) {
    log.warn(`could not record database access for run=${runId}`, error);
  }
}

export type AgentApiOperation = "context" | "remarks" | "status" | "state";

export function agentApiUrl(runId: string, operation: AgentApiOperation): string {
  return `${config.agentApiBaseUrl}/api/agent/runs/${runId}/${operation}`;
}

export interface AuthorizedAgentRun {
  workspaceId: number;
  promptId: number | null;
  question: string;
  role: ReturnType<typeof workspaces.authorizeAgentRun>["role"];
}

/** Checks a run credential exactly as the HTTP route always has: live, unexpired and in scope. */
export function authorizeAgentCredential(runId: string, token: string): AuthorizedAgentRun {
  const memory = runContexts.authenticate(runId, token);
  if (!memory) throw new WorkspaceError(401, "invalid_run_token", "Run credential is invalid or expired");
  const persisted = workspaces.authorizeAgentRun(runId, hashRunToken(token));
  if (memory.workspaceId !== persisted.workspaceId || memory.promptId !== persisted.promptId) {
    throw new WorkspaceError(403, "run_scope_mismatch", "Run credential scope does not match");
  }
  return { workspaceId: memory.workspaceId, promptId: memory.promptId, question: memory.question, role: persisted.role };
}

function requireMutatingRole(run: AuthorizedAgentRun): void {
  if (run.role !== "execute") throw new WorkspaceError(403, "consult_read_only", "Read-only runs cannot post remarks or status.");
}

export function consultContextText(workspaceId: number, promptId: number | null, question: string): string {
  const writer = runHub.activeExecuteForWorkspace(workspaceId);
  const liveWriter = writer === undefined ? null : { provider: writer.provider, model: writer.model };
  if (promptId === null) {
    const workspace = workspaces.get(workspaceId);
    return consultWorkspaceMarkdown({
      workspace: { name: workspace.name, workDirectory: workspace.workDirectory, description: workspace.description },
      question,
      liveWriter,
    });
  }
  return contextMarkdown(workspaces.agentContext(workspaceId, promptId), "consult", { liveWriter, question });
}

export type AgentContextResult =
  | { purpose: "consult"; markdown: string }
  | { purpose: "execute"; context: ReturnType<typeof workspaces.agentContext>; markdown: string };

/**
 * The run's authoritative context. `progress` chooses how the appended
 * instructions tell the agent to report: HTTP calls, or the bound tools.
 * `full` lifts the section caps for a tools run, which has no
 * `agent-step context --full` to ask with.
 */
export function readAgentContext(runId: string, token: string, progress: "http" | "tools", full = false): AgentContextResult {
  const run = authorizeAgentCredential(runId, token);
  if (run.role === "consult") return { purpose: "consult", markdown: consultContextText(run.workspaceId, run.promptId, run.question) };
  if (run.promptId === null) throw new WorkspaceError(409, "run_not_active", "Run is not attached to a work item");
  const context = workspaces.agentContext(run.workspaceId, run.promptId, { full });
  // Tool callers already received the reporting contract in their run prompt, so
  // their context carries no second copy of it, only the work item and how the
  // run ends, in the names of the tools they have.
  const markdown = progress === "http" ? `${contextMarkdown(context)}\n\n${progressApiMarkdown(runId, token)}` : contextMarkdown(context, "execute", { progressTools: PROGRESS_TOOL_NAMES, full });
  return { purpose: "execute", context, markdown };
}

export function readAgentState(runId: string, token: string): { events: unknown[]; remarks: unknown[]; runs: unknown[] } {
  const run = authorizeAgentCredential(runId, token);
  if (run.promptId === null) return { events: [], remarks: [], runs: [] };
  return workspaces.promptHistory(run.promptId);
}

export function postAgentRemark(runId: string, token: string, body: Record<string, unknown>): unknown {
  requireMutatingRole(authorizeAgentCredential(runId, token));
  const result = workspaces.addAgentRemark(runId, body);
  runHub.operationsChanged();
  return result;
}

/** Whether this work item has any Verify command to run before a DONE is weighed. */
export function hasVerifyCommands(promptId: number): boolean {
  try {
    return workspaces.dodCommandPlan(promptId).criteria.some((criterion) => criterion.command !== null);
  } catch {
    return false;
  }
}

/**
 * Records a run's terminal status, running the item's Verify commands first when
 * the status is DONE.
 *
 * The gate that closes an item only reads recorded results, so the commands
 * have to be run before it looks. The HTTP route does that in its handler; this
 * is the same step for a provider that reports through bound tools. Without it
 * every criterion stayed "not run yet", the gate refused a finished item, and
 * the pipeline retried work that was already done until it parked.
 *
 * A failing command is a refusal, not a status: the run is still live and can
 * fix it, so the output goes back to it and the item stays in progress.
 */
export async function postAgentStatus(runId: string, token: string, body: Record<string, unknown>): Promise<unknown> {
  const run = authorizeAgentCredential(runId, token);
  requireMutatingRole(run);
  // With no command to run there is nothing to wait for, and not waiting keeps a
  // done ahead of any status posted after it.
  if (body.status === "DONE" && run.promptId !== null && hasVerifyCommands(run.promptId)) {
    await runDefinitionOfDoneCommands(run.promptId, runId);
    const failures = workspaces.agentDoneVerificationFailures(run.promptId);
    if (failures !== null) {
      workspaces.recordVerificationFailureRemark(run.promptId, runId, failures);
      const detail = failures.map((failure) => `$ ${failure.command}\nexit ${failure.exitCode ?? "none"}: ${failure.evidence}\n${failure.output.trim()}`).join("\n\n").slice(0, 6000);
      throw new WorkspaceError(409, "verification_failed", `Fix this and post \`done\` again. If the command itself is wrong, repair it with \`${PROGRESS_TOOL_NAMES.repairVerify}\`. If it cannot be fixed in this run, post \`continue\` with what remains.\n\n${detail}`);
    }
  }
  const result = workspaces.updateAgentStatus(runId, body);
  runHub.operationsChanged();
  return result;
}

/**
 * Replaces a Verify command the server has seen fail, then runs the commands
 * again and returns what still fails, as the HTTP route does.
 *
 * A check can be wrong where the work is right. Without this a run on the tool
 * path could only post a done that the same broken command refused every time.
 */
export async function repairAgentVerify(runId: string, token: string, body: Record<string, unknown>): Promise<unknown> {
  const run = authorizeAgentCredential(runId, token);
  requireMutatingRole(run);
  const result = workspaces.repairAgentVerifyCommand(runId, body);
  if (run.promptId !== null) {
    await runDefinitionOfDoneCommands(run.promptId, runId);
    result.failures = workspaces.agentDoneVerificationFailures(run.promptId) ?? [];
  }
  runHub.operationsChanged();
  return result;
}

/** Tool handlers bound to one run credential, for providers that run in-process. */
export function bindAgentProgressTools(runId: string, token: string): AgentProgressTools {
  // The work item's status, for the "before → after" of a write. Read through the
  // credential so a revoked or foreign run learns nothing; such a call is refused
  // anyway, and its line needs no status.
  const status = (): string | null => {
    try {
      const run = authorizeAgentCredential(runId, token);
      return run.promptId === null ? null : workspaces.promptOutcome(run.promptId).status;
    } catch {
      return null;
    }
  };
  // The tool path's entry in the access log, which the HTTP route writes for
  // itself. A tool call is not an HTTP request, so the method says so; the
  // status code is the one the same call would have got over HTTP.
  const write = <T>(operation: Extract<DbOperation, "remarks" | "status" | "repair-verify">, input: Record<string, unknown>, action: () => T): T => {
    const startedAt = Date.now();
    const requestId = typeof input.requestId === "string" ? input.requestId : null;
    const before = status();
    const accepted = (): void => recordDbAccess(runId, {
      ...describeAcceptedWrite({ operation, before, after: status(), requestId, remarkKind: typeof input.kind === "string" ? input.kind : null, durationMs: Date.now() - startedAt }),
      method: "TOOL",
    });
    const rejected = (error: unknown): void => recordDbAccess(runId, {
      ...describeRejectedWrite({
        operation,
        httpStatus: error instanceof WorkspaceError ? error.status : 400,
        errorCode: error instanceof WorkspaceError ? error.code : "invalid_request",
        message: error instanceof Error ? error.message : String(error),
        requestId,
        durationMs: Date.now() - startedAt,
      }),
      method: "TOOL",
    });
    let result: T;
    try {
      result = action();
    } catch (error) {
      rejected(error);
      throw error;
    }
    if (result instanceof Promise) {
      return result.then((value: unknown) => { accepted(); return value; }, (error: unknown) => { rejected(error); throw error; }) as T;
    }
    accepted();
    return result;
  };
  return {
    getContext: (input) => {
      const startedAt = Date.now();
      const result = readAgentContext(runId, token, "tools", input?.full === true);
      const summary = result.purpose === "execute" ? `read work item ${result.context.prompt.externalKey ?? result.context.prompt.title}` : "read the consult context";
      recordDbAccess(runId, { ...describeRead({ operation: "context", summary, durationMs: Date.now() - startedAt }), method: "TOOL" });
      return result.markdown;
    },
    postRemark: (input) => write("remarks", input, () => postAgentRemark(runId, token, input)),
    postStatus: (input) => write("status", input, () => postAgentStatus(runId, token, input)),
    repairVerify: (input) => write("repair-verify", input, () => repairAgentVerify(runId, token, input)),
  };
}

export const PROGRESS_TOOL_NAMES = {
  getContext: "get_context",
  postRemark: "post_remark",
  postStatus: "post_status",
  repairVerify: "repair_verify",
} as const;

/** The reporting contract for tool callers; it belongs in the trusted run prompt. */
export function progressToolsMarkdown(): string {
  return `## Progress tools

This run is already marked IN_PROGRESS. Record progress only through these tools; never open or modify SQLite directly, and do not call the local HTTP API.

- \`${PROGRESS_TOOL_NAMES.getContext}\` returns this work item's context again. Where a section says it was truncated, call it with \`full: true\` for everything.
- \`${PROGRESS_TOOL_NAMES.postRemark}\` records a remark: \`requestId\` (unique for this run), \`kind\` (PROGRESS, FINDING, DECISION_NEEDED, BLOCKER, VERIFICATION or COMPLETION) and \`content\`.
- \`${PROGRESS_TOOL_NAMES.postStatus}\` records exactly one terminal status before you finish: \`requestId\`, \`expectedStatus\` "IN_PROGRESS", \`status\` DONE, CONTINUE or BLOCKED, \`reason\`, \`verificationSummary\` and, for BLOCKED, an optional \`options\` list.

For DONE, \`verificationSummary\` lists the commands run and their observable results. The server then runs the work item's Verify commands; if one fails, the DONE is refused with its output and nothing is recorded. Fix the work and post DONE again.

- \`${PROGRESS_TOOL_NAMES.repairVerify}\` replaces a Verify command that is itself wrong: \`requestId\`, \`oldCommand\` (exactly as the refusal printed it), \`newCommand\` and \`reason\`. It only works on a command a refused DONE has just shown failing, and it returns what still fails. Use it when the check is defective, never to make failing work pass.

CONTINUE is for work that cannot finish in this run: put what remains in \`reason\`, as concrete instructions for the run that resumes this item on this working tree, and what you verified in \`verificationSummary\`.

BLOCKED is only valid for a concrete external dependency that requires human action after safe in-scope alternatives have been exhausted. Remaining implementation work is not a blocker. For BLOCKED, put observed evidence in \`reason\` and the exact action only the human can take in \`verificationSummary\`.

When the human is choosing between courses of action, report them in \`options\`: a list of \`{"label": "...", "advantages": ["..."], "disadvantages": ["..."]}\`. Report only choices and trade-offs you actually weighed; omit \`options\` when there are none. Nothing generates them later, so a trade-off you leave out never reaches the human.

Every requestId must be unique for this run.
`;
}

function progressApiMarkdown(runId: string, token: string): string {
  return `## Progress API\n\nThis run is already marked IN_PROGRESS. Use only these endpoints for orchestration records; never open or modify SQLite directly.\n\nPost a remark with:\n\n\`\`\`bash\ncurl -fsS -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' ${agentApiUrl(runId, "remarks")} -d '{"requestId":"unique-remark-id","kind":"PROGRESS","content":"What changed or was discovered"}'\n\`\`\`\n\nAllowed remark kinds: PROGRESS, FINDING, DECISION_NEEDED, BLOCKER, VERIFICATION, COMPLETION.\n\nBefore finishing, post exactly one terminal prompt status. For success:\n\n\`\`\`bash\ncurl -fsS -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' ${agentApiUrl(runId, "status")} -d '{"requestId":"unique-status-id","expectedStatus":"IN_PROGRESS","status":"DONE","reason":"Completed","verificationSummary":"Commands run and observable results"}'\n\`\`\`\n\nBLOCKED is only valid for a concrete external dependency that requires human action after safe in-scope alternatives have been exhausted. Remaining implementation work is not a blocker. For BLOCKED, provide observed evidence in reason and put the exact action only the human can take in verificationSummary:\n\n\`\`\`bash\ncurl -fsS -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' ${agentApiUrl(runId, "status")} -d '{"requestId":"unique-status-id","expectedStatus":"IN_PROGRESS","status":"BLOCKED","reason":"Observed evidence showing why execution cannot continue","verificationSummary":"Exact action only the human can take"}'\n\`\`\`\n\nWhen the human is choosing between courses of action, add an optional \`options\` array to a BLOCKED status: \`"options":[{"label":"Ship red","advantages":["On brand"],"disadvantages":["Clashes with the charts"]}]\`. Report only choices and trade-offs you actually weighed; omit it when there are none. Nothing generates them later, so a trade-off you leave out never reaches the human.\n\nEvery requestId must be unique for this run.\n\n`;
}
