import { consultWorkspaceMarkdown, contextMarkdown } from "./agentContext.ts";
import { config } from "./config.ts";
import type { AgentProgressTools } from "./adapters/types.ts";
import { hashRunToken, runContexts } from "./runContext.ts";
import { runHub } from "./runHub.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

/*
 * The agent Progress API: how a running agent reads its work item and records
 * remarks and a terminal status. Reached two ways with identical rules - over
 * HTTP with a bearer run credential, or through in-process tools bound to that
 * same credential - so both paths go through the functions below.
 */

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
 */
export function readAgentContext(runId: string, token: string, progress: "http" | "tools"): AgentContextResult {
  const run = authorizeAgentCredential(runId, token);
  if (run.role === "consult") return { purpose: "consult", markdown: consultContextText(run.workspaceId, run.promptId, run.question) };
  if (run.promptId === null) throw new WorkspaceError(409, "run_not_active", "Run is not attached to a work item");
  const context = workspaces.agentContext(run.workspaceId, run.promptId);
  // Tool callers already received the reporting contract in their run prompt, so
  // their context is the work item alone, never instructions arriving as tool output.
  const markdown = progress === "http" ? `${contextMarkdown(context)}\n\n${progressApiMarkdown(runId, token)}` : contextMarkdown(context);
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

export function postAgentStatus(runId: string, token: string, body: Record<string, unknown>): unknown {
  requireMutatingRole(authorizeAgentCredential(runId, token));
  const result = workspaces.updateAgentStatus(runId, body);
  runHub.operationsChanged();
  return result;
}

/** Tool handlers bound to one run credential, for providers that run in-process. */
export function bindAgentProgressTools(runId: string, token: string): AgentProgressTools {
  return {
    getContext: () => readAgentContext(runId, token, "tools").markdown,
    postRemark: (input) => postAgentRemark(runId, token, input),
    postStatus: (input) => postAgentStatus(runId, token, input),
  };
}

export const PROGRESS_TOOL_NAMES = {
  getContext: "get_context",
  postRemark: "post_remark",
  postStatus: "post_status",
} as const;

/** The reporting contract for tool callers; it belongs in the trusted run prompt. */
export function progressToolsMarkdown(): string {
  return `## Progress tools

This run is already marked IN_PROGRESS. Record progress only through these tools; never open or modify SQLite directly, and do not call the local HTTP API.

- \`${PROGRESS_TOOL_NAMES.postRemark}\` records a remark: \`requestId\` (unique for this run), \`kind\` (PROGRESS, FINDING, DECISION_NEEDED, BLOCKER, VERIFICATION or COMPLETION) and \`content\`.
- \`${PROGRESS_TOOL_NAMES.postStatus}\` records exactly one terminal status before you finish: \`requestId\`, \`expectedStatus\` "IN_PROGRESS", \`status\` DONE or BLOCKED, \`reason\` and \`verificationSummary\`.

For DONE, \`verificationSummary\` lists the commands run and their observable results.

BLOCKED is only valid for a concrete external dependency that requires human action after safe in-scope alternatives have been exhausted. Remaining implementation work is not a blocker. For BLOCKED, put observed evidence in \`reason\` and the exact action only the human can take in \`verificationSummary\`.

Every requestId must be unique for this run.
`;
}

function progressApiMarkdown(runId: string, token: string): string {
  return `## Progress API\n\nThis run is already marked IN_PROGRESS. Use only these endpoints for orchestration records; never open or modify SQLite directly.\n\nPost a remark with:\n\n\`\`\`bash\ncurl -fsS -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' ${agentApiUrl(runId, "remarks")} -d '{"requestId":"unique-remark-id","kind":"PROGRESS","content":"What changed or was discovered"}'\n\`\`\`\n\nAllowed remark kinds: PROGRESS, FINDING, DECISION_NEEDED, BLOCKER, VERIFICATION, COMPLETION.\n\nBefore finishing, post exactly one terminal prompt status. For success:\n\n\`\`\`bash\ncurl -fsS -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' ${agentApiUrl(runId, "status")} -d '{"requestId":"unique-status-id","expectedStatus":"IN_PROGRESS","status":"DONE","reason":"Completed","verificationSummary":"Commands run and observable results"}'\n\`\`\`\n\nBLOCKED is only valid for a concrete external dependency that requires human action after safe in-scope alternatives have been exhausted. Remaining implementation work is not a blocker. For BLOCKED, provide observed evidence in reason and put the exact action only the human can take in verificationSummary:\n\n\`\`\`bash\ncurl -fsS -X POST -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' ${agentApiUrl(runId, "status")} -d '{"requestId":"unique-status-id","expectedStatus":"IN_PROGRESS","status":"BLOCKED","reason":"Observed evidence showing why execution cannot continue","verificationSummary":"Exact action only the human can take"}'\n\`\`\`\n\nEvery requestId must be unique for this run.\n\n`;
}
