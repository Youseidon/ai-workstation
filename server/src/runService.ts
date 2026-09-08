import { spawnSync } from "node:child_process";
import { isProviderId, type ProviderId, type ProviderInfo } from "@agent-console/shared";
import { detectProviders, getAdapter } from "./adapters/registry.ts";
import { consultWorkspaceMarkdown, contextMarkdown, liveTreeBanner, progressApiMarkdown } from "./agentContext.ts";
import { config } from "./config.ts";
import { newId } from "./lib/ids.ts";
import { createLogger } from "./lib/logger.ts";
import { isCooling } from "./providerHealth.ts";
import { runHub } from "./runHub.ts";
import { createAgentShim, removeAgentShim } from "./agentShim.ts";
import { runContexts } from "./runContext.ts";
import { startRun } from "./runner.ts";
import { materialize, readBack } from "./workspaceInstructions.ts";
import { pipelineScheduler } from "./pipelineScheduler.ts";
import { DECOMPOSE_MAX_DEPTH, WorkspaceError, workspaces } from "./workspaces.ts";

const CONSULT_LIMIT = 3;

const log = createLogger("run");

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
      const depth = workspaces.decomposeDepth(promptId);
      // One command with this run's credentials already in it, rather than a
      // curl the model has to assemble. Per-run rather than per-process: the
      // Claude adapter runs in this process, so credentials on process.env
      // would be shared by every concurrent run.
      const shimPath = createAgentShim({ runId: plannedRunId, token: credential.token, port: config.port });
      // The context is inlined rather than fetched. Handing it over as a tool
      // result cost a turn before any work started, put it where it could not
      // serve as a cached prompt prefix, and led agents to fetch it more than
      // once and re-read a saved copy — three copies of the same text in one
      // transcript. The endpoint stays for refreshes and for the Progress API.
      resolvedPrompt = [
        `# Execute saved work item ${record.externalKey ?? record.title}`,
        "",
        "The context below is authoritative and complete. There is no Markdown prompt file to find and no tracker file to edit — this work item lives in a database outside this working directory, and the command below is the only thing that can change it. Bank what you verify as you go, and report your own outcome before finishing.",
        "",
        "---",
        "",
        contextMarkdown(workspaces.agentContext(workspaceId, promptId), "execute", { depth, maxDepth: DECOMPOSE_MAX_DEPTH }),
        "",
        progressApiMarkdown({ runId: plannedRunId, token: credential.token, port: config.port, canDecompose: depth < DECOMPOSE_MAX_DEPTH, shimPath }),
      ].join("\n");
    }
  } else {
    resolvedPrompt = prompt?.trim() ?? "";
    customDisplay = resolvedPrompt;
    if (resolvedPrompt === "") throw new WorkspaceError(422, "validation_error", "Prompt is empty");
    if (workspace.description.trim() !== "") resolvedPrompt = `${workspace.description.trim()}\n\n---\n\n# Work item\n\n${resolvedPrompt}`;
  }

  let clarificationAnswer = "";
  let executionAnswer = "";
  // The provider CLI reads these off disk before it reads anything we send, so
  // they have to be in place before the process starts.
  materialize(workspace);
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
    onEnd: (runId, state, metrics) => {
      const endedPromptId = savedPrompt?.id ?? promptId;
      const endedWorkspaceId = workspace.id;
      // A budget stop is not a verdict on the work, and the agent that just hit
      // it is the only cheap source of "what is done and what remains". Before
      // anything concludes anything, it gets a short turn to say so — on the
      // same provider session, so it does not pay to re-read what it just read.
      //
      // The status transition is held back for exactly as long as that takes:
      // applying it here would move the item out of IN_PROGRESS and the wrap-up
      // run's own post would be refused as an invalid transition.
      const wrapUp =
        mode === "execute" &&
        activeContextRunId !== null &&
        endedPromptId !== undefined &&
        typeof metrics.stopReason === "string" &&
        metrics.stopReason.startsWith("budget_") &&
        workspaces.promptOutcome(endedPromptId).status === "IN_PROGRESS"
          ? { promptId: endedPromptId, stopReason: metrics.stopReason, sessionId: metrics.sessionId }
          : null;
      if (activeContextRunId !== null) {
        workspaces.finishAgentRun(activeContextRunId, state, executionAnswer, metrics, { deferStatus: wrapUp !== null });
        runContexts.complete(activeContextRunId);
        // The launcher holds this run's token. The credential is collapsed to a
        // short TTL above, but a live-looking token sitting in tmp after its run
        // is over is not something to leave lying around.
        removeAgentShim(activeContextRunId);
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
      if (mode === "execute") readBack(endedWorkspaceId);
      const tellPipeline = () => {
        if (mode !== "execute" || endedPromptId === undefined) return;
        // Always the *source* run id: the scheduler's `currentRunId` guard keys
        // on the run it started, and the wrap-up's own end must not fire this a
        // second time.
        void pipelineScheduler
          .onExecuteEnded({runId,workspaceId:endedWorkspaceId,promptId:endedPromptId,processState:state})
          .catch((error:unknown)=>log.error(`pipeline advance failed after run ${runId}`,error));
      };
      if (wrapUp === null) { tellPipeline(); return; }
      void (async () => {
        // A cooling source provider cannot resume its session; pick another
        // available provider for a fresh short turn, or skip the wrap-up and
        // continue without notes (prompt 05).
        let wrapProvider = provider;
        let wrapModel = model;
        let wrapSession = wrapUp.sessionId;
        if (isCooling(provider)) {
          const providers = await detectProviders();
          const next = providers.find((item) => item.available && item.id !== provider && !isCooling(item.id));
          if (next === undefined) {
            log.warn(`wrap-up skipped after run ${runId}: ${provider} is cooling and no fallback is free`);
            workspaces.applyDeferredRunEnd(runId);
            return;
          }
          wrapProvider = next.id;
          wrapModel = null;
          wrapSession = null;
          log.info(`wrap-up fallback after run ${runId}: ${provider}→${wrapProvider}`);
        }
        const started = await startWrapUp({
          workspaceId: endedWorkspaceId,
          promptId: wrapUp.promptId,
          sourceRunId: runId,
          provider: wrapProvider,
          model: wrapModel,
          sessionId: wrapSession,
          stopReason: wrapUp.stopReason,
        });
        await started.done;
      })()
        .catch((error: unknown) => {
          // The provider is gone, or the run could not be recorded. The item
          // must land exactly where it would have without this feature rather
          // than sitting IN_PROGRESS forever waiting for a turn that is not
          // coming.
          log.error(`wrap-up could not start after run ${runId}`, error);
          workspaces.applyDeferredRunEnd(runId);
        })
        .finally(tellPipeline);
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

/* -------------------------------------------------------------------------- */
/* The wrap-up turn                                                           */
/* -------------------------------------------------------------------------- */

/** What a wrap-up turn is allowed to spend. Long enough to write, not to work. */
const WRAP_UP_BUDGET = {
  maxToolCalls: 12,
  maxWallClockMs: 4 * 60_000,
  // Never metered: the run this speaks for already spent the money, and a
  // wrap-up refused for cost is the one thing worse than no wrap-up at all.
  maxInputTokens: null,
  maxToolOutputBytes: null,
  noProgressToolCalls: null,
} as const;

/** How much `git status`/`git diff --stat` a fresh-session brief may carry. */
const WRAP_UP_TREE_BUDGET_BYTES = 8192;

export interface StartWrapUpArgs {
  workspaceId: number;
  promptId: number;
  sourceRunId: string;
  provider: ProviderId;
  model: string | null;
  /** The provider session to resume, or null to run a fresh short session. */
  sessionId: string | null;
  /** The source run's stop reason, quoted to the agent verbatim. */
  stopReason: string;
}

/**
 * The turn a run gets after its budget stopped it, whose only job is to write
 * down what it learned.
 *
 * 23 execute runs on this install were killed mid-work by a budget. Every one
 * of them was interrupted with no wrap-up, no notes and no status, and the
 * station landed UNREPORTED with the stop reason as its only record — one work
 * item died that way four times in twenty minutes with nothing written to disk.
 * The reviewer and handoff runs sent afterwards to reconstruct what happened
 * have cost ~30 M input tokens. The agent that did the work is the cheapest and
 * best source of "what is done and what remains": it already has the context,
 * and on a resumed session it does not even have to re-read a file.
 */
export async function startWrapUp(args: StartWrapUpArgs): Promise<{ runId: string; done: Promise<unknown> }> {
  const workspace = workspaces.get(args.workspaceId);
  const record = workspaces.resolvePrompt(args.workspaceId, args.promptId);
  const plannedRunId = newId("run");
  // The prompt's own credential scope, on a new run id: the wrap-up posts
  // against the same work item, and `requireActiveExecuteRun` admits it because
  // it is a live execute run on that prompt.
  const credential = runContexts.create(plannedRunId, args.workspaceId, args.promptId);
  try {
    workspaces.beginWrapUpRun({
      runId: plannedRunId,
      workspaceId: args.workspaceId,
      promptId: args.promptId,
      provider: args.provider,
      model: args.model,
      tokenHash: credential.tokenHash,
      expiresAt: credential.expiresAt,
      sourceRunId: args.sourceRunId,
      sessionId: args.sessionId,
    });
  } catch (error) {
    runContexts.revoke(plannedRunId);
    throw error;
  }
  const shimPath = createAgentShim({ runId: plannedRunId, token: credential.token, port: config.port });
  const resumable = args.sessionId !== null && providerCanResume(args.provider);
  const prompt = wrapUpPrompt({
    stopReason: args.stopReason,
    shimPath,
    runId: plannedRunId,
    token: credential.token,
    port: config.port,
    freshSession: resumable
      ? null
      : {
          title: `${record.externalKey ?? ""} ${record.title}`.trim(),
          remarks: workspaces.recentProgressRemarks(args.promptId, 5),
          tree: workingTreeSummary(workspace.workDirectory),
        },
  });

  let answer = "";
  const handle = startRun({
    runId: plannedRunId,
    adapter: getAdapter(args.provider),
    prompt,
    cwd: workspace.workDirectory,
    model: args.model,
    role: "execute",
    // Same as an execute run. `agent-step` is a shell command talking to
    // 127.0.0.1, and a read-only sandbox blocks that outright on Codex — a
    // wrap-up that cannot reach the door has nothing to write with.
    permissionOverride: "inherit",
    resumeSessionId: resumable ? args.sessionId : null,
    budget: { ...WRAP_UP_BUDGET },
    onEvent: (event) => {
      if (event.type === "assistant_text" && event.payload.kind === "message") answer += event.payload.text;
      if (event.type === "result" && event.payload.text) answer = event.payload.text;
      workspaces.recordAgentEvent(plannedRunId, event);
      runHub.event(plannedRunId, event);
    },
    onEnd: (runId, state, metrics) => {
      // No wrap-up of a wrap-up: if this one trips its own budget it simply
      // ends, and `finishAgentRun` applies the transition the source run's end
      // deferred — attributing the *source* run's stop reason, because that is
      // what stopped the work.
      workspaces.finishAgentRun(runId, state, answer, metrics);
      runContexts.complete(runId);
      removeAgentShim(runId);
      runHub.end(runId, state);
    },
  });
  workspaces.markAgentRunRunning(handle.runId);
  runHub.start({
    handle,
    workspace: { id: workspace.id, name: workspace.name, workDirectory: workspace.workDirectory },
    source: {
      type: "wrapup",
      promptId: args.promptId,
      promptKey: record.externalKey,
      title: record.title,
      sourceRunId: args.sourceRunId,
      stopReason: args.stopReason,
    },
    role: "execute",
    permissionMode: handle.permissionMode,
  });
  // Handed back rather than only logged: the pipeline is not told about the
  // source run until this turn has had its say.
  return { runId: handle.runId, done: handle.done.catch((error: unknown) => log.error("wrap-up failed", error)) };
}

/**
 * Whether this provider can be told to continue its own session.
 *
 * All five installed CLIs can (`cursor-agent --resume=`, `codex exec resume`,
 * the Claude SDK's `resume`, `grok --resume=`, `copilot --resume=`), so this is
 * a list rather than a check — but it is a list so that a provider whose resume
 * flag disappears in an upgrade can be demoted to the fresh-session form in one
 * place instead of failing every wrap-up turn it is given.
 */
function providerCanResume(provider: ProviderId): boolean {
  return provider === "cursor" || provider === "codex" || provider === "claude" || provider === "grok" || provider === "copilot";
}

/**
 * What the working tree looks like right now, for a wrap-up that could not
 * resume the session and therefore has to be told.
 *
 * Captured by the server rather than asked of the agent: a wrap-up turn has 12
 * tool calls, and spending two of them re-discovering what the server already
 * knows is two it cannot spend writing.
 */
function workingTreeSummary(cwd: string): string {
  const read = (args: string[]): string => {
    try {
      const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 1_000_000 });
      if (result.status !== 0) return "";
      return result.stdout.trim();
    } catch {
      return "";
    }
  };
  const status = read(["status", "--short"]);
  const stat = read(["diff", "--stat"]);
  const text = [
    status === "" ? "" : `git status --short:\n${status}`,
    stat === "" ? "" : `git diff --stat:\n${stat}`,
  ].filter((part) => part !== "").join("\n\n");
  if (text === "") return "";
  return text.length <= WRAP_UP_TREE_BUDGET_BYTES
    ? text
    : `${text.slice(0, WRAP_UP_TREE_BUDGET_BYTES)}\n… [truncated by the orchestrator]`;
}

/**
 * The turn itself, in as few words as it can be said.
 *
 * On a resumed session the agent already holds everything: the prompt's whole
 * job is to change what it is doing, not to tell it what it was doing. The
 * fresh-session form adds only what a new session cannot know, and says plainly
 * that it is new so the agent does not claim to have verified something it is
 * reading about for the first time.
 */
function wrapUpPrompt(args: {
  stopReason: string;
  shimPath: string | null;
  runId: string;
  token: string;
  port: number;
  freshSession: { title: string; remarks: Array<{ kind: string; content: string; createdAt: string }>; tree: string } | null;
}): string {
  const step = args.shimPath === null ? null : JSON.stringify(args.shimPath);
  const base = `http://127.0.0.1:${args.port}/api/agent/runs/${args.runId}`;
  const auth = `-H 'Authorization: Bearer ${args.token}' -H 'Content-Type: application/json'`;
  const remark = step === null
    ? `curl -fsS -X POST ${auth} ${base}/remarks -d '{"requestId":"wrapup-progress","kind":"PROGRESS","content":"…"}'`
    : `${step} remark --kind PROGRESS --text "…"`;
  const done = step === null
    ? `curl -fsS -X POST ${auth} ${base}/status -d '{"requestId":"wrapup-status","expectedStatus":"IN_PROGRESS","status":"DONE","reason":"Completed","verificationSummary":"…"}'`
    : `${step} done --verification "…"`;
  const cont = step === null
    ? `curl -fsS -X POST ${auth} ${base}/status -d '{"requestId":"wrapup-status","expectedStatus":"IN_PROGRESS","status":"CONTINUE","reason":"…"}'`
    : `${step} continue --remaining "…"`;
  const blocked = step === null
    ? `curl -fsS -X POST ${auth} ${base}/status -d '{"requestId":"wrapup-status","expectedStatus":"IN_PROGRESS","status":"BLOCKED","reason":"…","verificationSummary":"…"}'`
    : `${step} blocked --reason "…" --action "…"`;

  const context = args.freshSession === null
    ? ""
    : [
        "",
        "This is a **fresh session**: the run that did the work could not be resumed, so you are",
        "reading this rather than remembering it. Report only what the evidence below and the",
        "working tree actually show — do not claim to have verified anything yourself.",
        "",
        `## Work item\n\n${args.freshSession.title}`,
        "",
        "## What the stopped run banked",
        "",
        args.freshSession.remarks.length === 0
          ? "Nothing. It was stopped before it recorded anything."
          : args.freshSession.remarks.map((entry) => `### ${entry.kind} · ${entry.createdAt}\n\n${entry.content.trim()}`).join("\n\n"),
        "",
        ...(args.freshSession.tree === "" ? [] : ["## Working tree", "", "```", args.freshSession.tree, "```", ""]),
      ].join("\n");

  return [
    `Your run was stopped by the orchestrator's budget (\`${args.stopReason}\`), not because anything failed.`,
    "",
    "**Do not edit files or run build/test commands.** Do exactly this, in order:",
    "",
    `1. \`\`\`bash\n${remark}\n\`\`\``,
    "   — what is verified (with the command and result), what is partly done (file paths), and",
    "   any decision you made that the next run must know.",
    "",
    "2. Then exactly one of:",
    "",
    `   - \`\`\`bash\n${done}\n\`\`\``,
    "     only if every acceptance criterion is already verified; or",
    "",
    `   - \`\`\`bash\n${cont}\n\`\`\``,
    "     — the remaining work as concrete instructions for the run that resumes this item on the",
    "     same working tree (files, routes, commands, what \"done\" looks like); or",
    "",
    `   - \`\`\`bash\n${blocked}\n\`\`\``,
    "     only for a concrete external dependency that needs a human.",
    "",
    "A run that ends without one of these is treated as `continue` with no notes.",
    context,
  ].join("\n");
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
  const contextUrl = `http://127.0.0.1:${config.port}/api/agent/runs/${plannedRunId}/context`;
  let resolvedPrompt =
    `${liveBanner}Answer a research question about this working tree. Do not implement, edit, or run mutating commands. Tools that write or execute are unavailable. The tree may be changing under you if a writer is active.\n\nBefore answering, retrieve the authoritative context with:\n\ncurl -fsS -H 'Authorization: Bearer ${credential.token}' ${contextUrl}\n\nDo not post remarks or status. You cannot use the Progress API.\n\n## Question\n\n${question}`;
  if (savedPrompt === null && workspace.description.trim() !== "") {
    resolvedPrompt = `${workspace.description.trim()}\n\n---\n\n${resolvedPrompt}`;
  }

  materialize(workspace);
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
    onEnd: (runId, state, metrics) => {
      workspaces.finishAgentRun(runId, state, "", metrics);
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
  materialize(workspace);
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
