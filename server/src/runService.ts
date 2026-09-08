import { isProviderId, type ProviderId, type ProviderInfo } from "@agent-console/shared";
import { detectProviders, getAdapter } from "./adapters/registry.ts";
import { consultWorkspaceMarkdown, contextMarkdown, liveTreeBanner } from "./agentContext.ts";
import { config } from "./config.ts";
import { newId } from "./lib/ids.ts";
import { createLogger } from "./lib/logger.ts";
import { runHub } from "./runHub.ts";
import { runContexts } from "./runContext.ts";
import { startRun } from "./runner.ts";
import { savedPromptExecuteReachabilityProblem } from "./settings.ts";
import { pipelineScheduler } from "./pipelineScheduler.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

const CONSULT_LIMIT = 3;

const log = createLogger("run");

export function agentApiUrl(runId: string, operation: "context" | "remarks" | "status" | "state"): string {
  return `${config.agentApiBaseUrl}/api/agent/runs/${runId}/${operation}`;
}

export function agentApiReachabilityProblem(provider: ProviderId): string | null {
  return savedPromptExecuteReachabilityProblem(provider);
}

export interface OfflineAgentStatus {
  status: "DONE" | "BLOCKED";
  reason: string;
  verificationSummary: string;
}

export function offlineStatusRequestId(): string {
  return "offline-status-final";
}

export function parseOfflineAgentStatus(text: string): OfflineAgentStatus | null {
  const candidates = [...text.matchAll(/```(?:agent-status|json)?\s*([\s\S]*?)```/gi)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean)
    .reverse();
  const marker = text.lastIndexOf("AGENT_STATUS");
  if (marker >= 0) {
    const match = text.slice(marker).match(/\{[\s\S]*\}/);
    if (match) candidates.unshift(match[0]);
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const raw = (parsed.agentStatus && typeof parsed.agentStatus === "object" ? parsed.agentStatus : parsed) as Record<string, unknown>;
      const status = raw.status;
      if (status !== "DONE" && status !== "BLOCKED") continue;
      const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
      const verificationSummary = typeof raw.verificationSummary === "string" ? raw.verificationSummary.trim() : "";
      if (status === "DONE" && verificationSummary === "") continue;
      if (status === "BLOCKED" && (reason === "" || verificationSummary === "")) continue;
      return { status, reason: status === "DONE" && reason === "" ? "Completed" : reason, verificationSummary };
    } catch {
      // Keep scanning; agents often include other fenced blocks before the final marker.
    }
  }
  return null;
}

function offlineStatusApplyFailureReason(status: OfflineAgentStatus["status"], error: unknown): string {
  const detail = error instanceof WorkspaceError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
  return `Internal orchestration error: parsed ${status} agent-status, but failed to apply it: ${detail}`;
}

function offlineCompletionProtocol(reason: string): string {
  return `## Offline completion reporting

The local Progress API is not reachable from this provider sandbox:

${reason}

Do not call the Progress API. The full authoritative work-item context is already included above. Before your final response ends, include exactly one fenced \`agent-status\` block so the console can update the prompt after the process exits.

For success:

\`\`\`agent-status
{"status":"DONE","reason":"Completed","verificationSummary":"Commands run and observable results"}
\`\`\`

For a real blocker:

\`\`\`agent-status
{"status":"BLOCKED","reason":"Observed evidence showing why execution cannot continue","verificationSummary":"Exact action only the human can take"}
\`\`\`

The BLOCKED rules from the work-item protocol still apply.`;
}

export interface StartExecuteArgs {
  workspaceId: number;
  provider: string;
  model: string | null;
  prompt?: string;
  promptId?: number;
  mode?: "execute" | "clarify";
  question?: string;
  pipelineRunId?: string;
}

export interface StartConsultArgs {
  workspaceId: number;
  provider: string;
  model: string | null;
  prompt?: string;
  promptId?: number;
  question?: string;
}

export interface StartVerifySuiteArgs {
  suiteId: number;
  provider: string;
  model: string | null;
  /** When set, verify only this work item inside the suite. */
  promptId?: number | null;
}

export class ProviderUnavailableError extends WorkspaceError {
  constructor(providerId: string, detail: string, readonly providers: ProviderInfo[]) {
    super(409, "provider_unavailable", `Provider "${providerId}" is not available.`, { detail });
  }
}

/** Saved, custom, or clarification execute. */
export async function startExecute(args: StartExecuteArgs): Promise<{ runId: string }> {
  const workspaceId = args.workspaceId;
  const providerId = args.provider;
  const model = args.model;
  const mode = args.mode ?? "execute";
  const prompt = args.prompt;
  const promptId = args.promptId;
  const question = args.question;

  const owner = workspaces.activePipelineForWorkspace(workspaceId);
  if (owner !== null) {
    const authorized = args.pipelineRunId === owner.id;
    const clarifyWaiting =
      mode === "clarify" &&
      owner.state === "WAITING_HUMAN" &&
      promptId === owner.currentPromptId;
    if (!authorized && !clarifyWaiting) {
      throw new WorkspaceError(
        409,
        "workspace_busy",
        "A pipeline is already active in this workspace.",
        { detail: "Stop or finish the suite pipeline before starting another execute in this working directory." },
      );
    }
    if (authorized && owner.currentPromptId !== null && promptId !== owner.currentPromptId) {
      throw new WorkspaceError(
        409,
        "workspace_busy",
        "A pipeline is already active in this workspace.",
        { detail: "The pipeline is on a different station." },
      );
    }
  }

  const busy = runHub.activeForWorkspace(workspaceId);
  if (busy !== undefined) {
    throw new WorkspaceError(
      409,
      "workspace_busy",
      `A run is already in progress in this workspace (${busy.provider}${busy.model === null ? "" : ` · ${busy.model}`}).`,
      { detail: "Stop the running agent before starting another in the same working directory." },
    );
  }

  const provider = await requireAvailableProvider(providerId);

  let resolvedPrompt: string;
  let savedPrompt: ReturnType<typeof workspaces.resolvePrompt> | null = null;
  let customDisplay = "";
  let clarificationId: number | null = null;
  let activeContextRunId: string | null = null;
  const plannedRunId = newId("run");

  const workspace = workspaces.get(workspaceId);
  if (!workspace.workDirectoryExists) {
    throw new WorkspaceError(422, "invalid_directory", `Workspace directory does not exist: ${workspace.workDirectory}`);
  }
  if (promptId !== undefined) {
    const record = workspaces.resolvePrompt(workspaceId, promptId);
    savedPrompt = record;
    if (mode === "clarify") {
      if (record.status !== "BLOCKED" && workspaces.pendingHumanQuestion(promptId) === null) throw new WorkspaceError(409, "prompt_not_blocked", "Clarification is only available while a prompt needs input");
      if (typeof question !== "string" || question.trim() === "") throw new WorkspaceError(422, "validation_error", "A clarification question is required");
      clarificationId = workspaces.beginClarification(promptId, question, provider, model);
      resolvedPrompt = `${contextMarkdown(workspaces.agentContext(workspaceId, promptId), "clarify")}\n\n## Human question\n\n${question.trim()}`;
    } else {
      if (!record.ready) throw new WorkspaceError(409, "dependencies_incomplete", `Prompt is waiting on: ${record.blockedBy.join(", ")}`);
      const reachabilityProblem = agentApiReachabilityProblem(provider);
      const credential = runContexts.create(plannedRunId, workspaceId, promptId);
      try {
        workspaces.beginAgentRun({
          runId: plannedRunId,
          workspaceId,
          promptId,
          provider,
          model,
          tokenHash: credential.tokenHash,
          expiresAt: credential.expiresAt,
          role: "execute",
        });
      } catch (error) {
        runContexts.revoke(plannedRunId);
        throw error;
      }
      activeContextRunId = plannedRunId;
      if (reachabilityProblem === null) {
        const contextUrl = agentApiUrl(plannedRunId, "context");
        resolvedPrompt = `Execute saved work item ${record.externalKey ?? record.title}. Before doing anything else, retrieve its authoritative context with:\n\ncurl -fsS -H 'Authorization: Bearer ${credential.token}' ${contextUrl}\n\nThe database endpoint is the source of truth. Do not search for a Markdown prompt file and never modify SQLite directly. Follow the complete context returned by the endpoint, post remarks through its Progress API, and post a final DONE or BLOCKED status before finishing.`;
      } else {
        resolvedPrompt = `${contextMarkdown(workspaces.agentContext(workspaceId, promptId))}\n\n${offlineCompletionProtocol(reachabilityProblem)}`;
      }
    }
  } else {
    resolvedPrompt = prompt?.trim() ?? "";
    customDisplay = resolvedPrompt;
    if (resolvedPrompt === "") throw new WorkspaceError(422, "validation_error", "Prompt is empty");
    if (workspace.description.trim() !== "") resolvedPrompt = `${workspace.description.trim()}\n\n---\n\n# Work item\n\n${resolvedPrompt}`;
  }

  let clarificationAnswer = "";
  let executionAnswer = "";
  let terminalStatusApplyFailure: string | null = null;
  const handle = startRun({
    runId: plannedRunId,
    adapter: getAdapter(provider),
    prompt: resolvedPrompt,
    cwd: workspace.workDirectory,
    model,
    role: "execute",
    permissionOverride: "inherit",
    onEvent: (event) => {
      if (event.type === "assistant_text" && event.payload.kind === "message") {
        if (clarificationId !== null) clarificationAnswer += event.payload.text;
        else if (activeContextRunId !== null) executionAnswer += event.payload.text;
      }
      if (event.type === "result" && event.payload.text) {
        if (clarificationId !== null) clarificationAnswer = event.payload.text;
        else if (activeContextRunId !== null) executionAnswer = event.payload.text;
      }
      if (activeContextRunId !== null) workspaces.recordAgentEvent(activeContextRunId, event);
      runHub.event(plannedRunId, event);
    },
    onEnd: (runId, state) => {
      const endedPromptId = savedPrompt?.id ?? promptId;
      const endedWorkspaceId = workspace.id;
      if (activeContextRunId !== null) {
        if (state === "done") {
          const offlineStatus = parseOfflineAgentStatus(executionAnswer);
          if (offlineStatus !== null) {
            try {
              workspaces.updateAgentStatus(activeContextRunId, {
                requestId: offlineStatusRequestId(),
                expectedStatus: "IN_PROGRESS",
                ...offlineStatus,
              });
            } catch (error) {
              terminalStatusApplyFailure = offlineStatusApplyFailureReason(offlineStatus.status, error);
              log.warn("could not apply offline agent status", error);
            }
          }
        }
        workspaces.finishAgentRun(activeContextRunId, state, executionAnswer, terminalStatusApplyFailure);
        runContexts.complete(activeContextRunId);
        activeContextRunId = null;
      }
      if (clarificationId !== null) {
        workspaces.finishClarification(
          clarificationId,
          state === "done" ? "DONE" : state === "interrupted" ? "INTERRUPTED" : "ERROR",
          clarificationAnswer,
        );
      }
      runHub.end(runId, state);
      if (mode === "execute" && endedPromptId !== undefined) {
        void pipelineScheduler.onExecuteEnded({runId,workspaceId:endedWorkspaceId,promptId:endedPromptId,processState:state});
      }
    },
  });
  // Marked RUNNING before the announcement, so a client that reacts to
  // run_started by refetching never reads a stale STARTING row.
  if (savedPrompt !== null && mode === "execute") workspaces.markAgentRunRunning(handle.runId);
  runHub.start({
    handle,
    workspace: { id: workspace.id, name: workspace.name, workDirectory: workspace.workDirectory },
    source: savedPrompt === null
      ? { type: "custom", displayText: customDisplay }
      : mode === "clarify"
        ? { type: "clarification", promptId: savedPrompt.id, promptKey: savedPrompt.externalKey, title: savedPrompt.title, question: question!.trim() }
        : { type: "saved", promptId: savedPrompt.id, promptKey: savedPrompt.externalKey, title: savedPrompt.title, programName: savedPrompt.programName, suiteName: savedPrompt.suiteName },
    role: "execute",
    permissionMode: handle.permissionMode,
  });
  void handle.done.catch((error: unknown) => log.error("run failed", error));
  return { runId: handle.runId };
}

/** Research consult: forced sandbox, no writer lock, no prompt status mutation. */
export async function startConsult(args: StartConsultArgs): Promise<{ runId: string }> {
  if (args.provider === "cursor") {
    throw new WorkspaceError(422, "consult_not_supported", "Cursor cannot run as a consult; it has no sandbox.");
  }

  const workspaceId = args.workspaceId;
  if (runHub.consultsForWorkspace(workspaceId).length >= CONSULT_LIMIT) {
    throw new WorkspaceError(
      422,
      "consult_limit",
      "This workspace already has 3 consults running.",
      { detail: "Stop a consult before starting another." },
    );
  }

  const provider = await requireAvailableProvider(args.provider);
  const workspace = workspaces.get(workspaceId);
  if (!workspace.workDirectoryExists) {
    throw new WorkspaceError(422, "invalid_directory", `Workspace directory does not exist: ${workspace.workDirectory}`);
  }

  const questionText = [args.question, args.prompt]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value !== "") ?? "";

  let savedPrompt: ReturnType<typeof workspaces.resolvePrompt> | null = null;
  if (args.promptId !== undefined) {
    savedPrompt = workspaces.resolvePrompt(workspaceId, args.promptId);
  } else if (questionText === "") {
    throw new WorkspaceError(422, "validation_error", "Prompt is empty");
  }

  const question = questionText !== ""
    ? questionText
    : `Research ${savedPrompt!.externalKey ?? savedPrompt!.title}`;

  const plannedRunId = newId("run");
  const promptId = savedPrompt?.id ?? null;
  const credential = runContexts.create(plannedRunId, workspaceId, promptId, undefined, question);
  try {
    workspaces.beginConsultRun({
      runId: plannedRunId,
      workspaceId,
      promptId,
      provider,
      model: args.model,
      tokenHash: credential.tokenHash,
      expiresAt: credential.expiresAt,
    });
  } catch (error) {
    runContexts.revoke(plannedRunId);
    throw error;
  }

  const writer = runHub.activeExecuteForWorkspace(workspaceId);
  const liveBanner = liveTreeBanner(writer === undefined ? null : { provider: writer.provider, model: writer.model });
  const context = consultContextText(workspaceId, promptId, question);
  let resolvedPrompt =
    `${liveBanner}Answer a research question about this working tree. Do not implement, edit, or run mutating commands. Tools that write or execute are unavailable. The tree may be changing under you if a writer is active.\n\n${context}`;
  if (savedPrompt === null && workspace.description.trim() !== "") {
    resolvedPrompt = `${workspace.description.trim()}\n\n---\n\n${resolvedPrompt}`;
  }

  const handle = startRun({
    runId: plannedRunId,
    adapter: getAdapter(provider),
    prompt: resolvedPrompt,
    cwd: workspace.workDirectory,
    model: args.model,
    role: "consult",
    permissionOverride: "consult",
    onEvent: (event) => {
      workspaces.recordAgentEvent(plannedRunId, event);
      runHub.event(plannedRunId, event);
    },
    onEnd: (runId, state) => {
      workspaces.finishAgentRun(runId, state);
      runContexts.complete(runId);
      runHub.end(runId, state);
    },
  });
  workspaces.markAgentRunRunning(handle.runId);
  runHub.start({
    handle,
    workspace: { id: workspace.id, name: workspace.name, workDirectory: workspace.workDirectory },
    source: {
      type: "consult",
      promptId,
      promptKey: savedPrompt?.externalKey ?? null,
      title: savedPrompt?.title ?? null,
      question,
    },
    role: "consult",
    permissionMode: handle.permissionMode,
  });
  void handle.done.catch((error: unknown) => log.error("consult failed", error));
  return { runId: handle.runId };
}

/**
 * Runs an agent verification of a suite, or of one work item inside it.
 *
 * The dossier is built here rather than in the browser, and the run is
 * recorded before it starts, so its events persist and its report survives
 * the page that launched it.
 */
export async function startVerifySuite(args: StartVerifySuiteArgs): Promise<{ runId: string }> {
  const provider = await requireAvailableProvider(args.provider);
  const plannedRunId = newId("run");
  const suite = workspaces.suiteHeader(args.suiteId);
  const workspace = workspaces.get(suite.workspaceId);
  if (!workspace.workDirectoryExists) {
    throw new WorkspaceError(422, "invalid_directory", `Workspace directory does not exist: ${workspace.workDirectory}`);
  }
  const busy = runHub.activeForWorkspace(workspace.id);
  if (busy !== undefined) {
    throw new WorkspaceError(409, "workspace_busy", `A run is already in progress in this workspace (${busy.provider}). Stop it before verifying.`);
  }
  const scopePromptId = args.promptId ?? null;
  const context = workspaces.suiteVerificationContext(args.suiteId, scopePromptId);
  const verificationId = workspaces.beginSuiteVerification({
    runId: plannedRunId,
    suiteId: args.suiteId,
    provider,
    model: args.model,
    stats: context.stats,
    scopePromptId: context.scopePromptId,
  });

  // The agent's closing message is the report; keep the last full one.
  let report = "";
  const handle = startRun({
    runId: plannedRunId,
    adapter: getAdapter(provider),
    prompt: context.prompt,
    cwd: workspace.workDirectory,
    model: args.model,
    role: "execute",
    permissionOverride: "inherit",
    onEvent: (event) => {
      if (event.type === "assistant_text" && event.payload.kind === "message") report += event.payload.text;
      if (event.type === "result" && event.payload.text) report = event.payload.text;
      workspaces.recordVerificationEvent(verificationId, event);
      runHub.event(plannedRunId, event);
    },
    onEnd: (runId, state) => {
      workspaces.finishSuiteVerification(verificationId, state, report);
      runHub.end(runId, state);
    },
  });
  runHub.start({
    handle,
    workspace: { id: workspace.id, name: workspace.name, workDirectory: workspace.workDirectory },
    source: {
      type: "verification",
      verificationId,
      suiteId: suite.id,
      suiteKey: suite.key,
      suiteName: suite.name,
      promptKey: context.scopePromptKey,
    },
    role: "execute",
    permissionMode: handle.permissionMode,
  });
  void handle.done.catch((error: unknown) => log.error("verification failed", error));
  return { runId: handle.runId };
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

async function requireAvailableProvider(providerId: string): Promise<ProviderId> {
  if (!isProviderId(providerId)) {
    throw new WorkspaceError(422, "unknown_provider", `Unknown provider "${providerId}".`);
  }
  const providers = await detectProviders(true);
  const info = providers.find((provider) => provider.id === providerId);
  if (info === undefined || !info.available) {
    throw new ProviderUnavailableError(providerId, info?.reason ?? "detection failed", providers);
  }
  return providerId;
}
