import { isProviderId, type ProviderId, type ProviderInfo } from "@agent-console/shared";
import { detectProviders, getAdapter } from "./adapters/registry.ts";
import { contextMarkdown } from "./agentContext.ts";
import { config } from "./config.ts";
import { newId } from "./lib/ids.ts";
import { createLogger } from "./lib/logger.ts";
import { runHub } from "./runHub.ts";
import { runContexts } from "./runContext.ts";
import { startRun } from "./runner.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

const log = createLogger("run");

export interface StartExecuteArgs {
  workspaceId: number;
  provider: string;
  model: string | null;
  prompt?: string;
  promptId?: number;
  mode?: "execute" | "clarify";
  question?: string;
}

export interface StartVerifySuiteArgs {
  suiteId: number;
  provider: string;
  model: string | null;
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
      if (record.status !== "BLOCKED") throw new WorkspaceError(409, "prompt_not_blocked", "Clarification is only available while a prompt is blocked");
      if (typeof question !== "string" || question.trim() === "") throw new WorkspaceError(422, "validation_error", "A clarification question is required");
      clarificationId = workspaces.beginClarification(promptId, question, provider, model);
      resolvedPrompt = `${contextMarkdown(workspaces.agentContext(workspaceId, promptId), "clarify")}\n\n## Human question\n\n${question.trim()}`;
    } else {
      if (!record.ready) throw new WorkspaceError(409, "dependencies_incomplete", `Prompt is waiting on: ${record.blockedBy.join(", ")}`);
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
      const contextUrl = `http://127.0.0.1:${config.port}/api/agent/runs/${plannedRunId}/context`;
      resolvedPrompt = `Execute saved work item ${record.externalKey ?? record.title}. Before doing anything else, retrieve its authoritative context with:\n\ncurl -fsS -H 'Authorization: Bearer ${credential.token}' ${contextUrl}\n\nThe database endpoint is the source of truth. Do not search for a Markdown prompt file and never modify SQLite directly. Follow the complete context returned by the endpoint, post remarks through its Progress API, and post a final DONE or BLOCKED status before finishing.`;
    }
  } else {
    resolvedPrompt = prompt?.trim() ?? "";
    customDisplay = resolvedPrompt;
    if (resolvedPrompt === "") throw new WorkspaceError(422, "validation_error", "Prompt is empty");
    if (workspace.description.trim() !== "") resolvedPrompt = `${workspace.description.trim()}\n\n---\n\n# Work item\n\n${resolvedPrompt}`;
  }

  let clarificationAnswer = "";
  let executionAnswer = "";
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
      if (activeContextRunId !== null) {
        workspaces.finishAgentRun(activeContextRunId, state, executionAnswer);
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

/**
 * Runs an agent verification of a whole suite.
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
  const context = workspaces.suiteVerificationContext(args.suiteId);
  const verificationId = workspaces.beginSuiteVerification({
    runId: plannedRunId,
    suiteId: args.suiteId,
    provider,
    model: args.model,
    stats: context.stats,
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
    source: { type: "verification", verificationId, suiteId: suite.id, suiteKey: suite.key, suiteName: suite.name },
    role: "execute",
    permissionMode: handle.permissionMode,
  });
  void handle.done.catch((error: unknown) => log.error("verification failed", error));
  return { runId: handle.runId };
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
