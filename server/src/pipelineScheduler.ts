import { autoHandoffAllowed, isProviderId, type CompletionAuditReport, type CompletionVerdict, type PipelineRun, type PromptPipelineRule, type PromptStatus, type ProviderId, type ReconfigureDirective, type ReconfigureKind, type ReviewAction, type SuitePipelineRun } from "@agent-console/shared";
import { getAdapter } from "./adapters/registry.ts";
import { newId } from "./lib/ids.ts";
import { createLogger } from "./lib/logger.ts";
import { runHub } from "./runHub.ts";
import { settings } from "./settings.ts";
import type { StartExecuteArgs } from "./runService.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

const log = createLogger("pipeline");

type StationStarter = (args: StartExecuteArgs) => Promise<{ runId: string }>;

async function defaultStartStation(args: StartExecuteArgs): Promise<{ runId: string }> {
  const { startExecute } = await import("./runService.ts");
  return startExecute(args);
}

let startStationFn: StationStarter = defaultStartStation;
const ruleByRun = new Map<string, PromptPipelineRule>();
const workspaceTails = new Map<number, Promise<unknown>>();

export function setPipelineStationStarter(starter: StationStarter | null): void {
  startStationFn = starter ?? defaultStartStation;
}

function enqueue<T>(workspaceId: number, work: () => Promise<T>): Promise<T> {
  const previous = workspaceTails.get(workspaceId) ?? Promise.resolve();
  const current = previous.then(work, work);
  workspaceTails.set(workspaceId, current.then(() => undefined, () => undefined));
  return current;
}

/**
 * Whether retries were exhausted against something no further retry can fix.
 *
 * A station that keeps failing to *run* will keep failing to run, so the
 * pipeline stops rather than parking for an operator who has nothing to answer.
 * A station that keeps ending without reporting is a different matter: the work
 * may well be getting done, so that parks and waits for a reviewer.
 *
 * This used to sniff the prompt's result text for the prefixes "Agent process
 * ended" and "No active agent run", which meant rewording an operator-facing
 * sentence silently changed the scheduler's behaviour. The status now carries
 * the fact, so it is read instead of guessed at.
 */
function processFailureBlocked(status: PromptStatus): boolean {
  return status === "FAILED";
}

function optionalPlayProvider(input: Record<string, unknown>, field: "provider" | "model", present: boolean): ProviderId | string | null | undefined {
  if (!present) return undefined;
  const value = input[field];
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new WorkspaceError(422, "validation_error", `${field} must be a string`, { [field]: "Must be a string" });
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (field === "provider") {
    if (!isProviderId(trimmed)) throw new WorkspaceError(422, "validation_error", "provider must be a known provider", { provider: "Unknown provider" });
    return trimmed;
  }
  return trimmed;
}

function optionalNamedPipelineRunId(input: Record<string, unknown>): string | null {
  if (!("pipelineRunId" in input)) return null;
  const value = input.pipelineRunId;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new WorkspaceError(422, "validation_error", "pipelineRunId must be a string", { pipelineRunId: "Must be a string" });
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function resolveExecuteTarget(args: {
  recovering: boolean;
  preferPlayTarget?: boolean;
  rule: PromptPipelineRule;
  playProvider: ProviderId | null;
  playModel: string | null;
  defaultProvider: ProviderId | null;
  defaultModel: string | null;
}): { provider: ProviderId; model: string | null } | null {
  if (args.recovering) {
    if (args.rule.recoverProvider === null) return null;
    return {
      provider: args.rule.recoverProvider,
      model: args.rule.recoverModel ?? getAdapter(args.rule.recoverProvider).model,
    };
  }
  if (args.preferPlayTarget && args.playProvider !== null) {
    return {
      provider: args.playProvider,
      model: args.playModel ?? getAdapter(args.playProvider).model,
    };
  }
  const provider = args.rule.provider ?? args.playProvider ?? args.defaultProvider;
  if (provider === null) return null;
  const model = args.rule.model ?? args.playModel ?? args.defaultModel ?? getAdapter(provider).model;
  return { provider, model };
}

async function terminate(pipeline: SuitePipelineRun, state: "COMPLETE" | "STOPPED", stopReason: string | null): Promise<SuitePipelineRun> {
  log.info(`${state.toLowerCase()} suite=${pipeline.suiteId} reason=${stopReason ?? "none"}`);
  const updated = workspaces.updatePipelineRun(pipeline.id, {
    state,
    stopReason,
    endedAt: new Date().toISOString(),
    currentRunId: null,
  });
  await syncNamedFromSuite(updated);
  return updated;
}

async function syncNamedFromSuite(suiteRun: SuitePipelineRun): Promise<void> {
  if (suiteRun.pipelineRunId === null) return;
  const parent = workspaces.namedPipelineRunById(suiteRun.pipelineRunId);
  if (parent === null) return;
  if (parent.state === "COMPLETE" || parent.state === "STOPPED" || parent.state === "INTERRUPTED") return;
  if (suiteRun.state === "COMPLETE") {
    log.info(`named-advance pipeline=${parent.pipelineId} from-suite=${suiteRun.suiteId}`);
    await startNextNamedStage(parent);
    return;
  }
  if (suiteRun.state === "STOPPED" || suiteRun.state === "INTERRUPTED") {
    workspaces.updateNamedPipelineRun(parent.id, {
      state: suiteRun.state,
      stopReason: suiteRun.stopReason,
      endedAt: suiteRun.endedAt ?? new Date().toISOString(),
      currentSuiteId: suiteRun.suiteId,
      currentSuiteRunId: suiteRun.id,
    });
    return;
  }
  if (suiteRun.state === "PLAYING" || suiteRun.state === "WAITING_HUMAN" || suiteRun.state === "PAUSED") {
    workspaces.updateNamedPipelineRun(parent.id, {
      state: suiteRun.state,
      stopReason: suiteRun.stopReason,
      waitReason: suiteRun.waitReason,
      endedAt: null,
      currentSuiteId: suiteRun.suiteId,
      currentSuiteRunId: suiteRun.id,
    });
  }
}

function namedPipelineIdFor(live: SuitePipelineRun): number | undefined {
  if (live.pipelineRunId === null) return undefined;
  return workspaces.namedPipelineRunById(live.pipelineRunId)?.pipelineId;
}

async function startCurrentStation(pipeline: SuitePipelineRun, promptId: number, preferPlayTarget = false): Promise<SuitePipelineRun> {
  const live = workspaces.pipelineById(pipeline.id) ?? pipeline;
  const pipelineId = namedPipelineIdFor(live);
  const rule = workspaces.pipelineRule(promptId, pipelineId);
  const defaults = workspaces.suitePipelineDefaults(live.suiteId);
  const target = resolveExecuteTarget({
    recovering: live.recovering,
    preferPlayTarget,
    rule,
    playProvider: live.playProvider,
    playModel: live.playModel,
    defaultProvider: defaults.defaultProvider,
    defaultModel: defaults.defaultModel,
  });
  if (target === null) {
    await terminate(live, "STOPPED", "no_provider");
    throw new WorkspaceError(422, "provider_required", "Play needs a provider on the station, the play request, or the suite default.");
  }
  workspaces.updatePipelineRun(live.id, { currentPromptId: promptId, currentRunId: null });
  try {
    const { runId } = await startStationFn({
      workspaceId: live.workspaceId,
      provider: target.provider,
      model: target.model,
      promptId,
      pipelineRunId: live.id,
    });
    ruleByRun.set(runId, rule);
    const updated = workspaces.updatePipelineRun(live.id, { currentPromptId: promptId, currentRunId: runId });
    await syncNamedFromSuite(updated);
    return updated;
  } catch (error) {
    await terminate(live, "STOPPED", "start_failed");
    throw error;
  }
}

async function advance(pipeline: SuitePipelineRun, preferPlayTarget = false): Promise<SuitePipelineRun> {
  const live = workspaces.pipelineById(pipeline.id) ?? pipeline;
  const pipelineId = namedPipelineIdFor(live);
  const ready = workspaces.readyPromptsInSuite(live.workspaceId, live.suiteId, pipelineId);
  const next = ready[0];
  if (next !== undefined) {
    log.info(`advance suite=${live.suiteId} prompt=${next.id}`);
    const updated = workspaces.updatePipelineRun(live.id, {
      attempt: 0,
      recovering: false,
      currentPromptId: next.id,
      currentRunId: null,
    });
    if (updated.state === "PAUSED") return updated;
    return startCurrentStation(updated, next.id, preferPlayTarget);
  }
  const unfinished = workspaces.remainingPipelinePromptIds(live.suiteId, pipelineId).filter((promptId) => {
    const status=workspaces.promptOutcome(promptId).status;
    return status !== "DONE" && status !== "SKIPPED";
  });
  if (unfinished.length > 0) {
    // The blocking step is a station whose depth-first sub-step run isn't
    // finished yet, not a station genuinely waiting on another station.
    const blockingPromptId = unfinished[0]!;
    const child = workspaces.nextOpenChild(blockingPromptId);
    if (child !== null) {
      log.info(`advance suite=${live.suiteId} prompt=${blockingPromptId} sub-step=${child.id}`);
      const updated = workspaces.updatePipelineRun(live.id, {
        attempt: 0,
        recovering: false,
        currentPromptId: child.id,
        currentRunId: null,
      });
      if (updated.state === "PAUSED") return updated;
      return startCurrentStation(updated, child.id, preferPlayTarget);
    }
    return terminate(live, "STOPPED", "blocked_on_dependencies");
  }
  return terminate(live, "COMPLETE", null);
}

async function applyOnDone(pipeline: SuitePipelineRun, rule: PromptPipelineRule): Promise<SuitePipelineRun> {
  if (rule.onDone === "stop") return terminate(pipeline, "STOPPED", "on_done_stop");
  const pipelineId = namedPipelineIdFor(pipeline);
  if (rule.onDone === "skip_rest") {
    for (const promptId of workspaces.remainingPipelinePromptIds(pipeline.suiteId, pipelineId)) {
      const status=workspaces.promptOutcome(promptId).status;
      if (status === "DONE" || status === "SKIPPED") continue;
      workspaces.skipPrompt(promptId, "SYSTEM", "Pipeline skip_rest");
    }
    return terminate(pipeline, "STOPPED", "skip_rest");
  }
  return advance(pipeline);
}

/** Park the run for a human, recording why without pretending it ended. */
async function park(pipeline: SuitePipelineRun, promptId: number, waitReason: string | null): Promise<SuitePipelineRun> {
  log.info(`wait suite=${pipeline.suiteId} prompt=${promptId} reason=${waitReason ?? "station_rule"}`);
  const updated = workspaces.updatePipelineRun(pipeline.id, {
    state: "WAITING_HUMAN",
    currentRunId: null,
    stopReason: null,
    waitReason,
    endedAt: null,
  });
  await syncNamedFromSuite(updated);
  return updated;
}

/**
 * Summon a read-only handoff agent for a station that blocked, instead of just
 * parking. The run still parks — the handoff decides what happens next: on
 * CONTINUE it resets the station to TODO and plays this pipeline again, and on
 * anything else the run simply stays parked for a human.
 *
 * Returns false when no handoff could start, so the caller parks normally
 * rather than claiming one is running.
 */
async function tryAutoHandoff(pipeline: SuitePipelineRun, promptId: number, sourceRunId: string): Promise<boolean> {
  try {
    const source = workspaces.runSummary(sourceRunId);
    const { scheduleHandoff } = await import("./handoffCoordinator.ts");
    const namedPipelineId = namedPipelineIdFor(pipeline);
    const result = await scheduleHandoff({
      workspaceId: pipeline.workspaceId,
      promptId,
      sourceRunId,
      sourceProvider: source.provider,
      sourceModel: source.model,
      processState: "done",
      ...(namedPipelineId === undefined ? {} : { namedPipelineId }),
    });
    return result.started;
  } catch (error) {
    log.warn(`auto-handoff failed suite=${pipeline.suiteId} prompt=${promptId}`, error);
    return false;
  }
}

/**
 * Summon a read-only auditor for a station that blocked without any agent ever
 * posting a status. The distinction is the whole point: that block means "the
 * process ended and we do not know what happened", which is the one case where
 * the work may already be finished and only the status post was lost.
 *
 * `scheduleCompletionAudit` re-checks that itself and declines otherwise, so a
 * station that blocked with a real question for a human is never audited past.
 */
async function tryCompletionAudit(pipeline: SuitePipelineRun, promptId: number, sourceRunId: string): Promise<boolean> {
  if (settings.pipelinePolicy.auditOnBlocked === "off") return false;
  try {
    const source = workspaces.runSummary(sourceRunId);
    const { scheduleCompletionAudit } = await import("./completionAudit.ts");
    const result = await scheduleCompletionAudit({
      workspaceId: pipeline.workspaceId,
      promptId,
      sourceRunId,
      sourceProvider: source.provider,
      automatic: true,
    });
    return result.started;
  } catch (error) {
    log.warn(`audit failed to start suite=${pipeline.suiteId} prompt=${promptId}`, error);
    return false;
  }
}

interface BlockedOptions {
  /** Set once an audit has already had its say, so the gate cannot loop. */
  audited?: boolean;
  /** Wait reason to park under, when the audit explained why we are here. */
  parkReason?: string | null;
}

async function applyOnBlocked(pipeline: SuitePipelineRun, rule: PromptPipelineRule, promptId: number, result: string, sourceRunId?: string, options: BlockedOptions = {}): Promise<SuitePipelineRun> {
  // A paused run must not spend an attempt. Retry and recover both mutate the
  // prompt and the counter before starting anything, so the hold is checked
  // here rather than after those writes — otherwise pausing on a blocked
  // station silently burned a retry the operator never saw run.
  const held = workspaces.pipelineById(pipeline.id)?.state === "PAUSED";

  // Before any rule runs, find out whether there is anything left to do. Every
  // rule is the wrong move when the work is already finished: "wait" strands
  // the rail for hours, and "retry" and "recover" pay another full developer
  // run to redo work that is sitting in the tree. This gate applies to all of
  // them — except "skip", where the operator has already said the station's
  // outcome does not matter.
  if (!held && !options.audited && sourceRunId !== undefined && rule.onBlocked !== "skip") {
    if (await tryCompletionAudit(pipeline, promptId, sourceRunId)) {
      return park(pipeline, promptId, "audit_running");
    }
  }

  if (rule.onBlocked === "wait") {
    // Whether a handoff is worth an agent run. The status is what makes this
    // decidable: before it was stored, "the agent asked a question" and "the run
    // said nothing" were both spelled BLOCKED, so this could not tell them
    // apart and summarised questions nobody needed summarised.
    const allowed = sourceRunId !== undefined && !held && autoHandoffAllowed({
      trigger: settings.pipelinePolicy.handoffTrigger,
      status: workspaces.promptOutcome(promptId).status,
      producedWork: workspaces.promptProducedWork(promptId),
      reviewed: options.audited === true || options.parkReason === "audit_incomplete",
    });
    if (allowed && sourceRunId !== undefined) {
      if (await tryAutoHandoff(pipeline, promptId, sourceRunId)) {
        return park(pipeline, promptId, "handoff_running");
      }
    }
    return park(pipeline, promptId, options.parkReason ?? null);
  }
  if (rule.onBlocked === "retry") {
    if (pipeline.attempt < rule.retryLimit) {
      if (held) return workspaces.pipelineById(pipeline.id) ?? pipeline;
      const attempt = pipeline.attempt + 1;
      log.info(`retry ${attempt}/${rule.retryLimit} suite=${pipeline.suiteId} prompt=${promptId}`);
      workspaces.resetPromptToTodo(promptId, `pipeline retry ${attempt}/${rule.retryLimit}`);
      const updated = workspaces.updatePipelineRun(pipeline.id, { attempt, recovering: false, currentPromptId: promptId, currentRunId: null });
      return startCurrentStation(updated, promptId);
    }
    if (processFailureBlocked(workspaces.promptOutcome(promptId).status)) return terminate(pipeline, "STOPPED", "retry_exhausted");
    return park(pipeline, promptId, "retry_exhausted");
  }
  if (rule.onBlocked === "recover") {
    if (!pipeline.recovering) {
      if (held) return workspaces.pipelineById(pipeline.id) ?? pipeline;
      log.info(`recover suite=${pipeline.suiteId} prompt=${promptId}`);
      workspaces.resetPromptToTodo(promptId, "pipeline recover");
      const updated = workspaces.updatePipelineRun(pipeline.id, {
        recovering: true,
        attempt: pipeline.attempt + 1,
        currentPromptId: promptId,
        currentRunId: null,
      });
      return startCurrentStation(updated, promptId);
    }
    log.info(`recover_exhausted suite=${pipeline.suiteId} prompt=${promptId}`);
    return terminate(pipeline, "STOPPED", "recover_exhausted");
  }
  workspaces.skipPrompt(promptId, "SYSTEM", "Pipeline skipped this station after it blocked.");
  return advance(pipeline);
}

/**
 * Statuses that hand the station to `applyOnBlocked` — the path for "this run
 * did not finish the work, decide what to do about it".
 *
 * All three are the same situation from the scheduler's point of view: the run
 * is over and the item is not closed. They differ in *why*, which is what the
 * status now records and what the reviewer keys off, but not in what the
 * pipeline must do next. Listing them here rather than testing `!== "DONE"`
 * keeps `unexpected_status` meaning something: a status the scheduler genuinely
 * does not know how to handle should still stop the run rather than be guessed at.
 */
const UNFINISHED_STATUSES = new Set<PromptStatus>(["BLOCKED", "UNREPORTED", "FAILED", "NEEDS_REVIEW"]);

async function applyExecuteEnded(pipeline: SuitePipelineRun, runId: string, promptId: number): Promise<void> {
  const live = workspaces.pipelineById(pipeline.id);
  if (live === null || (live.state !== "PLAYING" && live.state !== "PAUSED")) return;
  if (live.currentRunId !== runId) return;
  workspaces.updatePipelineRun(live.id, { currentRunId: null });
  const posted = workspaces.promptOutcome(promptId);
  const pipelineId = namedPipelineIdFor(live);
  const rule = ruleByRun.get(runId) ?? workspaces.pipelineRule(promptId, pipelineId);
  ruleByRun.delete(runId);
  if (posted.status === "TODO") {
    // The run decomposed this prompt into sub-steps instead of finishing it;
    // hand off to the first one.
    await advance(live);
    return;
  }
  const parentId = workspaces.parentPromptId(promptId);
  if (parentId !== null) {
    // This run belonged to a sub-step. Its own on_done/on_blocked outcome
    // never stops or skip-rests the station's own rule — that policy is
    // reserved for the station (the parent) actually finishing.
    if (posted.status === "DONE" || posted.status === "SKIPPED") {
      await advance(live);
      return;
    }
    if (UNFINISHED_STATUSES.has(posted.status)) {
      await applyOnBlocked(live, rule, promptId, posted.result, runId);
      return;
    }
    await terminate(live, "STOPPED", `unexpected_status:${posted.status}`);
    return;
  }
  if (posted.status === "DONE") {
    await applyOnDone(live, rule);
    return;
  }
  if (UNFINISHED_STATUSES.has(posted.status)) {
    await applyOnBlocked(live, rule, promptId, posted.result, runId);
    return;
  }
  if (posted.status === "SKIPPED") {
    await advance(live);
    return;
  }
  await terminate(live, "STOPPED", `unexpected_status:${posted.status}`);
}

async function resume(pipeline: SuitePipelineRun, playProvider: ProviderId | null | undefined, playModel: string | null | undefined, preferPlayTarget = false): Promise<SuitePipelineRun> {
  const patch: { state: "PLAYING"; playProvider?: ProviderId | null; playModel?: string | null; endedAt: null; stopReason: null; waitReason: null } = {
    state: "PLAYING",
    endedAt: null,
    stopReason: null,
    waitReason: null,
  };
  if (playProvider !== undefined) patch.playProvider = playProvider;
  if (playModel !== undefined) patch.playModel = playModel;
  const live = workspaces.updatePipelineRun(pipeline.id, patch);
  await syncNamedFromSuite(live);
  if (live.currentRunId !== null && runHub.has(live.currentRunId)) return live;
  if (live.currentPromptId !== null) {
    const pipelineId = namedPipelineIdFor(live);
    const ready = workspaces.readyPromptsInSuite(live.workspaceId, live.suiteId, pipelineId);
    if (ready.some((prompt) => prompt.id === live.currentPromptId)) {
      return startCurrentStation(live, live.currentPromptId, preferPlayTarget);
    }
  }
  return advance(live, preferPlayTarget);
}

/**
 * Why a suite will not start, named down to the exact work item. "Nothing is
 * ready" on its own sends the operator hunting: the blocker is usually one
 * sub-step several levels below a station, invisible from the flowchart.
 */
function notReadyReason(workspaceId: number, blockingPromptId: number | null, descendantId: number | null): string {
  if (blockingPromptId === null) return "Every station on this pipeline is already finished.";
  const target = descendantId ?? blockingPromptId;
  const prompt = workspaces.resolvePrompt(workspaceId, target);
  const label = prompt.externalKey ?? prompt.title;
  if (prompt.recoverable) {
    return `${label} needs recovery before this pipeline can continue — its last run stopped without posting a status. Retry or skip it, then play again.`;
  }
  if (prompt.status === "BLOCKED") {
    return `${label} is blocked and needs a human response. Answer or skip it, then play again.`;
  }
  if (prompt.blockedBy.length > 0) {
    return `${label} is waiting on ${prompt.blockedBy.join(", ")}.`;
  }
  if (prompt.status === "IN_PROGRESS") {
    return `${label} is still marked in progress from an earlier run. Recover it, then play again.`;
  }
  return `${label} is not ready to run.`;
}

async function playSuiteUnlocked(suiteId: number, body: Record<string, unknown> = {}): Promise<SuitePipelineRun> {
  const suite = workspaces.suiteHeader(suiteId);
  const workspace = workspaces.get(suite.workspaceId);
  if (!workspace.workDirectoryExists) {
    throw new WorkspaceError(422, "invalid_directory", `Workspace directory does not exist: ${workspace.workDirectory}`);
  }
  const namedRunId = optionalNamedPipelineRunId(body);
  const namedPipelineId = namedRunId === null ? undefined : workspaces.namedPipelineRunById(namedRunId)?.pipelineId;
  if (workspaces.enabledPipelineSteps(suiteId, namedPipelineId).length === 0) {
    throw new WorkspaceError(422, "empty_pipeline", "Add work items to this suite's flowchart before playing");
  }
  const playProvider = optionalPlayProvider(body, "provider", "provider" in body) as ProviderId | null | undefined;
  const playModel = optionalPlayProvider(body, "model", "model" in body) as string | null | undefined;
  const preferPlayTarget = body.preferPlayTarget === true;
  const owner = workspaces.activePipelineForWorkspace(suite.workspaceId);
  const active = workspaces.activePipeline(suiteId);
  const busy = runHub.activeExecuteForWorkspace(suite.workspaceId);
  if (busy !== undefined && active?.currentRunId !== busy.runId) {
    throw new WorkspaceError(
      409,
      "workspace_busy",
      `A run is already in progress in this workspace (${busy.provider}${busy.model === null ? "" : ` · ${busy.model}`}).`,
      { detail: "Stop the running agent before playing a suite in the same working directory." },
    );
  }
  if (active !== null) {
    if (namedRunId !== null && active.pipelineRunId !== namedRunId) {
      throw new WorkspaceError(409, "workspace_busy", "Another suite pipeline already owns this workspace.");
    }
    if (active.state === "PLAYING") {
      throw new WorkspaceError(409, "pipeline_active", "This suite is already playing");
    }
    if (active.state === "WAITING_HUMAN" || active.state === "PAUSED") {
      if (active.state === "WAITING_HUMAN") {
        const currentId = active.currentPromptId;
        const pipelineId = namedPipelineId ?? namedPipelineIdFor(active);
        // The waiting item may be a sub-step, which never appears in the
        // station list — ask the prompt itself as well.
        const ready = currentId !== null && (
          workspaces.readyPromptsInSuite(suite.workspaceId, suiteId, pipelineId).some((prompt) => prompt.id === currentId)
          || workspaces.resolvePrompt(suite.workspaceId, currentId).ready
        );
        if (!ready) throw new WorkspaceError(422, "prompt_not_ready", currentId === null ? "This run has no station to resume." : notReadyReason(suite.workspaceId, currentId, null));
      }
      log.info(`resume suite=${suiteId} from=${active.state}`);
      return resume(active, playProvider, playModel, preferPlayTarget);
    }
  }
  if (owner !== null && owner.suiteId !== suiteId) {
    throw new WorkspaceError(409, "workspace_busy", "Another suite pipeline already owns this workspace.");
  }
  const topLevelReady = workspaces.readyPromptsInSuite(suite.workspaceId, suiteId, namedPipelineId);
  if (topLevelReady.length === 0) {
    const unfinished = workspaces.remainingPipelinePromptIds(suiteId, namedPipelineId).filter((promptId) => {
      const status = workspaces.promptOutcome(promptId).status;
      return status !== "DONE" && status !== "SKIPPED";
    });
    const blocking = unfinished[0] ?? null;
    const descendant = blocking === null ? null : workspaces.nextOpenChild(blocking);
    const descendantReady = descendant === null ? false : workspaces.resolvePrompt(suite.workspaceId, descendant.id).ready;
    if (!descendantReady) {
      throw new WorkspaceError(422, "nothing_ready", notReadyReason(suite.workspaceId, blocking, descendant?.id ?? null));
    }
  }
  // `resumeSameRun`: an interrupted run is not "active", so it would otherwise be
  // abandoned in favour of a fresh one. Adopting it keeps the attempt counter and
  // the station it was holding, which is the whole point of the policy.
  if (settings.pipelinePolicy.onRestart === "resumeSameRun") {
    const latest = workspaces.latestPipeline(suiteId);
    if (latest !== null && latest.state === "INTERRUPTED" && (namedRunId === null || latest.pipelineRunId === namedRunId)) {
      log.info(`adopt interrupted suite=${suiteId} pipeline=${latest.id}`);
      return resume(latest, playProvider, playModel, preferPlayTarget);
    }
  }
  const created = workspaces.createPipelineRun({
    id: newId("pipe"),
    suiteId,
    workspaceId: suite.workspaceId,
    playProvider: playProvider === undefined ? null : playProvider,
    playModel: playModel === undefined ? null : playModel,
    pipelineRunId: namedRunId,
  });
  log.info(`play suite=${suiteId} pipeline=${created.id}`);
  return advance(created, preferPlayTarget);
}

/**
 * Pause holds the rail. Under the `immediate` policy it also interrupts the
 * agent working right now — the difference from Stop being that the run stays
 * PAUSED, and so still resumable, rather than becoming terminal.
 */
async function pauseSuiteUnlocked(suiteId: number): Promise<{ paused: SuitePipelineRun; interruptId: string | null }> {
  const active = workspaces.activePipeline(suiteId);
  if (active === null || active.state !== "PLAYING") {
    throw new WorkspaceError(409, "pipeline_not_playing", "Pause requires a playing pipeline");
  }
  const immediate = settings.pipelinePolicy.pauseMode === "immediate";
  log.info(`pause suite=${suiteId} mode=${immediate ? "immediate" : "graceful"}`);
  const updated = workspaces.updatePipelineRun(active.id, { state: "PAUSED" });
  await syncNamedFromSuite(updated);
  return { paused: updated, interruptId: immediate ? active.currentRunId : null };
}

async function stopSuiteUnlocked(suiteId: number): Promise<{ stopped: SuitePipelineRun; interruptId: string | null }> {
  const active = workspaces.activePipeline(suiteId);
  if (active === null) throw new WorkspaceError(409, "pipeline_not_active", "No active pipeline to stop");
  // With `stopInterruptsAgent` off, Stop only ends auto-advance: the agent
  // already working keeps its station and finishes on its own.
  const interruptId = settings.pipelinePolicy.stopInterruptsAgent ? active.currentRunId : null;
  log.info(`stop suite=${suiteId} interrupt=${interruptId !== null}`);
  const stopped = workspaces.updatePipelineRun(active.id, {
    state: "STOPPED",
    stopReason: "operator_stop",
    endedAt: new Date().toISOString(),
    currentRunId: null,
  });
  await syncNamedFromSuite(stopped);
  return { stopped, interruptId };
}

async function startNextNamedStage(named: PipelineRun, preferPlayTarget = false): Promise<PipelineRun> {
  const pipeline = workspaces.getPipeline(named.pipelineId);
  const currentIndex = named.currentSuiteId === null ? -1 : pipeline.stages.findIndex((stage) => stage.suiteId === named.currentSuiteId);
  const next = pipeline.stages[currentIndex + 1];
  if (next === undefined) {
    log.info(`named-complete pipeline=${named.pipelineId}`);
    return workspaces.updateNamedPipelineRun(named.id, {
      state: "COMPLETE",
      endedAt: new Date().toISOString(),
      stopReason: null,
    });
  }
  const body: Record<string, unknown> = { pipelineRunId: named.id };
  if (named.playProvider !== null) body.provider = named.playProvider;
  if (named.playModel !== null) body.model = named.playModel;
  if (preferPlayTarget) body.preferPlayTarget = true;
  try {
    const suiteRun = await playSuiteUnlocked(next.suiteId, body);
    return workspaces.updateNamedPipelineRun(named.id, {
      state: suiteRun.state,
      currentSuiteId: next.suiteId,
      currentSuiteRunId: suiteRun.id,
      endedAt: null,
      stopReason: suiteRun.stopReason,
    });
  } catch (error) {
    workspaces.updateNamedPipelineRun(named.id, {
      state: "STOPPED",
      currentSuiteId: next.suiteId,
      stopReason: error instanceof WorkspaceError ? error.code : "start_failed",
      endedAt: new Date().toISOString(),
    });
    throw error;
  }
}

async function playNamedUnlocked(pipelineId: number, body: Record<string, unknown> = {}): Promise<PipelineRun> {
  const pipeline = workspaces.getPipeline(pipelineId);
  const workspace = workspaces.get(pipeline.workspaceId);
  if (!workspace.workDirectoryExists) {
    throw new WorkspaceError(422, "invalid_directory", `Workspace directory does not exist: ${workspace.workDirectory}`);
  }
  if (pipeline.stages.length === 0) {
    throw new WorkspaceError(422, "empty_pipeline", "Add at least one suite before playing this pipeline");
  }
  const missing = pipeline.stages.filter((stage) => stage.stepCount === 0);
  if (missing.length > 0) {
    throw new WorkspaceError(422, "empty_pipeline", `Add work items to ${missing[0]!.suiteName} before playing`);
  }
  const playProvider = optionalPlayProvider(body, "provider", "provider" in body) as ProviderId | null | undefined;
  const playModel = optionalPlayProvider(body, "model", "model" in body) as string | null | undefined;
  const preferPlayTarget = body.preferPlayTarget === true;
  const active = workspaces.activeNamedPipelineRun(pipelineId);
  if (active !== null) {
    if (active.state === "PLAYING") {
      throw new WorkspaceError(409, "pipeline_active", "This pipeline is already playing");
    }
    const patch: { playProvider?: ProviderId | null; playModel?: string | null } = {};
    if (playProvider !== undefined) patch.playProvider = playProvider;
    if (playModel !== undefined) patch.playModel = playModel;
    const live = Object.keys(patch).length > 0 ? workspaces.updateNamedPipelineRun(active.id, patch) : active;
    if (live.currentSuiteId === null) return startNextNamedStage(live, preferPlayTarget);
    log.info(`named-resume pipeline=${pipelineId} from=${live.state} suite=${live.currentSuiteId}`);
    const suiteBody: Record<string, unknown> = { pipelineRunId: live.id };
    if (live.playProvider !== null) suiteBody.provider = live.playProvider;
    if (live.playModel !== null) suiteBody.model = live.playModel;
    if (preferPlayTarget) suiteBody.preferPlayTarget = true;
    const suiteRun = await playSuiteUnlocked(live.currentSuiteId, suiteBody);
    return workspaces.updateNamedPipelineRun(live.id, {
      state: suiteRun.state,
      currentSuiteId: live.currentSuiteId,
      currentSuiteRunId: suiteRun.id,
      endedAt: null,
      stopReason: suiteRun.stopReason,
    });
  }
  const namedOwner = workspaces.activeNamedPipelineForWorkspace(pipeline.workspaceId);
  if (namedOwner !== null) {
    throw new WorkspaceError(409, "workspace_busy", "Another pipeline already owns this workspace.");
  }
  const suiteOwner = workspaces.activePipelineForWorkspace(pipeline.workspaceId);
  if (suiteOwner !== null) {
    throw new WorkspaceError(409, "workspace_busy", "Another suite pipeline already owns this workspace.");
  }
  const created = workspaces.createNamedPipelineRun({
    id: newId("npipe"),
    pipelineId,
    workspaceId: pipeline.workspaceId,
    playProvider: playProvider === undefined ? null : playProvider,
    playModel: playModel === undefined ? null : playModel,
  });
  log.info(`play named pipeline=${pipelineId} run=${created.id}`);
  return startNextNamedStage(created, preferPlayTarget);
}

/**
 * Restarts a pipeline parked on a station a human has just resolved out of band
 * — skipped, or marked complete. Only a rail actually waiting on *this* station
 * moves; anything else is left exactly as it is.
 */
async function resumeAfterHumanResolution(promptId: number): Promise<void> {
  const home = workspaces.promptHome(promptId);
  await enqueue(home.workspaceId, async () => {
    const active = workspaces.activePipeline(home.suiteId);
    if (active === null || active.state !== "WAITING_HUMAN" || active.currentPromptId !== promptId) return;
    const playing = workspaces.updatePipelineRun(active.id, { state: "PLAYING", stopReason: null, waitReason: null, endedAt: null });
    await syncNamedFromSuite(playing);
    const live = workspaces.pipelineById(playing.id);
    if (live === null) return;
    await advance(live);
  });
}

/**
 * The reason recorded on a station that an audit closed. Deliberately explicit
 * about who decided: nobody reading this record later should have to work out
 * that the agent which did the work never confirmed it.
 */
const AUDIT_COMPLETE_REASON = "A read-only completion audit verified this work item against its acceptance criteria after the run that did the work ended without posting a status.";

/**
 * Act on a finished audit. Runs inside the workspace queue, so it must never
 * call back into anything that enqueues — the tail it would wait on is the one
 * it is already holding.
 *
 * Returns whether the verdict actually closed the station, which is what the
 * audit record stores as `applied`.
 */
async function settleAudit(args: { promptId: number; sourceRunId: string; verdict: CompletionVerdict | null; verificationSummary?: string; report?: CompletionAuditReport | null; auditId?: string | null }): Promise<boolean> {
  const home = workspaces.promptHome(args.promptId);
  const active = workspaces.activePipeline(home.suiteId);
  // Only a run parked on this exact station by this audit may be moved by it.
  const parked = active !== null
    && active.state === "WAITING_HUMAN"
    && active.currentPromptId === args.promptId
    && active.waitReason === "audit_running";

  // What the operator has said this verdict should do, for this situation, at
  // the narrowest scope that says anything. This used to be one global
  // three-way switch, so "close a run that went quiet" and "close one whose
  // process crashed" could not be answered differently.
  const trigger = workspaces.reviewSituation(args.promptId) ?? "unreported";
  const reviewer = workspaces.reviewerConfig(trigger, args.promptId);
  const action = args.verdict === "COMPLETE" ? reviewer.onComplete
    : args.verdict === "INCOMPLETE" ? reviewer.onIncomplete
    : reviewer.onUnverifiable;

  // Set when the definition of done refused a close the reviewer wanted to make.
  // It changes what the station parks under, so the operator reads "a criterion
  // did not pass" rather than "an audit could not confirm it".
  let refusedByDod = false;
  if (args.verdict === "COMPLETE" && action === "close") {
    try {
      // A reviewer's COMPLETE is an opinion; the definition-of-done commands are
      // not. Run them here so the gate inside `completePrompt` is reading fresh
      // evidence rather than whatever was last recorded — this is the one path
      // where a machine closes a station unattended, so it is the one that most
      // needs the checks to have actually happened.
      const { runDefinitionOfDoneCommands } = await import("./definitionOfDone.ts");
      await runDefinitionOfDoneCommands(args.promptId, args.sourceRunId);
      const written = workspaces.completePrompt(args.promptId, "SYSTEM", {
        reason: AUDIT_COMPLETE_REASON,
        verificationSummary: args.verificationSummary ?? "",
      });
      // The gate refused: the item is on NEEDS_REVIEW with the failing criteria
      // recorded, not on DONE. Reporting this as applied would tell the audit
      // record it closed a station it did not close. It falls through to the
      // station rule below rather than returning, because a pipeline parked on
      // `audit_running` is only ever unparked down there — returning here would
      // leave the rail waiting on an audit that has already finished.
      if (written === "DONE") {
        log.info(`audit closed station suite=${home.suiteId} prompt=${args.promptId}`);
        if (parked) {
          const playing = workspaces.updatePipelineRun(active.id, { state: "PLAYING", stopReason: null, waitReason: null, endedAt: null });
          await syncNamedFromSuite(playing);
          const live = workspaces.pipelineById(playing.id);
          if (live !== null) await advance(live);
        }
        return true;
      }
      refusedByDod = true;
      log.info(`audit COMPLETE refused by the definition of done suite=${home.suiteId} prompt=${args.promptId}`);
    } catch (error) {
      // The station moved under us, or the verdict carried no evidence to
      // record. Either way it is not complete, so fall through to the rule.
      log.warn(`audit COMPLETE could not be applied prompt=${args.promptId}`, error);
    }
  }

  if (!parked) return false;
  const playing = workspaces.updatePipelineRun(active.id, { state: "PLAYING", stopReason: null, waitReason: null, endedAt: null });
  await syncNamedFromSuite(playing);
  const live = workspaces.pipelineById(playing.id) ?? playing;
  const rule = workspaces.pipelineRule(args.promptId, namedPipelineIdFor(live));
  const outcome = workspaces.promptOutcome(args.promptId);
  const parkReason = refusedByDod ? "dod_unmet"
    : args.verdict === "INCOMPLETE" ? "audit_incomplete"
    : args.verdict === "UNVERIFIABLE" ? "audit_unverifiable"
    : null;

  /*
   * What the reviewer's verdict actually does.
   *
   * `action` used to be computed here and then read exactly once, for
   * COMPLETE + close. Every other combination the reviewer matrix offers —
   * `handoff`, `retry`, `park`, `markReview` — was stored, rendered in the
   * settings screen, editable, and inert: the run fell through to the station
   * rule as if the reviewer had said nothing. That is most of why a reviewer
   * whose verdicts were correct never changed an outcome.
   *
   * A refused close is deliberately not routed here. The definition of done
   * has already spoken, and `dod_unmet` is the reason the operator needs to
   * see — not a second opinion from the reviewer's own configuration.
   *
   * A null verdict is not routed here either. It means the auditor's own run
   * died without producing one, and acting on `onUnverifiable` would attribute
   * an opinion to an agent that never gave it. The station falls back to its
   * rule, having lost nothing but the cost of the read-only run.
   */
  if (!refusedByDod && args.verdict !== null) {
    const handled = await applyReviewAction({
      pipeline: live,
      action,
      promptId: args.promptId,
      verdict: args.verdict,
      report: args.report ?? null,
      auditId: args.auditId ?? null,
      sourceRunId: args.sourceRunId,
      parkReason,
    });
    if (handled) return false;
  }

  await applyOnBlocked(live, rule, args.promptId, outcome.result, args.sourceRunId, { audited: true, parkReason });
  return false;
}

/**
 * Apply the pipeline changes the reviewer asked for, as far as the operator
 * allows. Every directive is recorded either way — an applied one so the change
 * is attributable and reversible, a refused one because a reviewer that keeps
 * asking for a capped change is evidence the cap is wrong.
 *
 * `decompose` is recorded but never applied here: splitting a work item is an
 * agent-only command (it needs an active execute run, so the split is always
 * attributable to one). The remediation brief carries it as an instruction
 * instead, which is why this returns what it accepted.
 */
function applyReconfigure(pipeline: SuitePipelineRun, promptId: number, auditId: string | null, directives: readonly ReconfigureDirective[]): ReconfigureKind[] {
  const policy = settings.pipelinePolicy;
  const accepted: ReconfigureKind[] = [];
  for (const directive of directives) {
    const record = (applied: boolean, refusedReason: string | null, multiplier: number | null = null) => {
      workspaces.recordReviewerReconfigure({
        promptId, auditId, kind: directive.kind, multiplier,
        provider: directive.provider, why: directive.why, applied, refusedReason,
      });
    };
    if (!policy.reviewerReconfigure.includes(directive.kind)) {
      record(false, "The operator has not allowed a reviewer to make this kind of change.");
      continue;
    }
    if (directive.kind === "raiseBudget") {
      const cap = policy.maxReviewerBudgetMultiplier;
      if (cap <= 1) {
        record(false, "Budget raises are capped at 1x, which disables them.");
        continue;
      }
      // A missing multiplier means "more than it had"; 2x is the smallest
      // raise that is worth restarting a run for.
      const wanted = directive.multiplier === null || directive.multiplier < 1 ? 2 : directive.multiplier;
      const granted = Math.min(wanted, cap);
      record(true, granted < wanted ? `Asked for ${wanted}x, capped at ${cap}x.` : null, granted);
      log.info(`reviewer raised budget prompt=${promptId} to ${granted}x`);
      accepted.push(directive.kind);
      continue;
    }
    if (directive.kind === "switchProvider") {
      if (!isProviderId(directive.provider)) {
        record(false, `"${directive.provider ?? "none"}" is not a provider this install knows.`);
        continue;
      }
      try {
        // A sub-step under a named pipeline carries its rule on the pipeline
        // step, not on the prompt, and writing the wrong one would switch an
        // agent everywhere except where the run actually reads it.
        const namedId = namedPipelineIdFor(pipeline);
        if (namedId === undefined) workspaces.upsertPipelineRule(promptId, { provider: directive.provider });
        else workspaces.upsertNamedPipelineRule(namedId, promptId, { provider: directive.provider });
        record(true, null);
        log.info(`reviewer switched provider prompt=${promptId} to ${directive.provider}`);
        accepted.push(directive.kind);
      } catch (error) {
        record(false, error instanceof Error ? error.message : String(error));
      }
      continue;
    }
    // decompose — carried in the brief, not applied here.
    record(true, null);
    accepted.push(directive.kind);
  }
  return accepted;
}

/** The brief a remediation run is given: what to do, and what not to redo. */
function remediationBrief(report: CompletionAuditReport, accepted: readonly ReconfigureKind[]): string {
  const bullets = (items: readonly string[]) => (items.length === 0 ? "- None recorded." : items.map((item) => `- ${item}`).join("\n"));
  const confirmed = report.checks.filter((check) => check.result === "PASSED").map((check) => check.criterion);
  const split = accepted.includes("decompose")
    ? "\n\n## Split this first\n\nA reviewer judged this item too large to finish in one run. Before doing any of the work above, split it with `decompose` and let the sub-steps carry it.\n"
    : "";
  return `# What is still missing

A read-only reviewer inspected the working tree after the previous run and found the work below still outstanding. **This list is your task.** Do exactly it.

## Do this

${bullets(report.remainingWork)}${split}

## Already confirmed done — do not redo

${bullets(confirmed)}

## How the reviewer reached that

${report.reasoning || "_Not given._"}
`;
}

/**
 * Start a developer run scoped to the work the reviewer named, and let the rail
 * carry on by itself.
 *
 * The bound that matters is `maxRemediationAttempts`: a remediation run can end
 * unfinished, be reviewed again, and be remediated again. The count comes off
 * the status ledger rather than the run or the pipeline row, both of which this
 * path resets.
 */
async function tryRemediate(args: {
  pipeline: SuitePipelineRun;
  promptId: number;
  report: CompletionAuditReport | null;
  auditId: string | null;
}): Promise<boolean> {
  const { pipeline, promptId, report } = args;
  const limit = settings.pipelinePolicy.maxRemediationAttempts;
  if (limit <= 0) return false;
  // Nothing to instruct. A run started on an empty brief would rediscover the
  // problem from scratch, which is the loop this replaces — so this falls back
  // to the station rule and the operator sees the reviewer's report instead.
  if (report === null || report.remainingWork.length === 0) {
    log.info(`reviewer named no remaining work prompt=${promptId}; falling back to the station rule`);
    return false;
  }
  const spent = workspaces.remediationCount(promptId);
  if (spent >= limit) {
    log.info(`remediation limit reached prompt=${promptId} (${spent}/${limit})`);
    return false;
  }

  // Order matters: a raised budget or a switched agent has to be in force
  // before the run starts, or the remediation dies exactly where its
  // predecessor did.
  const accepted = applyReconfigure(pipeline, promptId, args.auditId, report.reconfigure);

  workspaces.preparePromptForRemediation(promptId, args.auditId ?? "unknown", remediationBrief(report, accepted));
  const updated = workspaces.updatePipelineRun(pipeline.id, { currentPromptId: promptId, currentRunId: null });
  log.info(`remediating prompt=${promptId} attempt=${spent + 1}/${limit} items=${report.remainingWork.length}`);
  await startCurrentStation(updated, promptId);
  return true;
}

/**
 * Carry out the reviewer's configured action. Returns whether it took
 * responsibility for the run; `false` falls back to the station's own rule,
 * which is the right answer whenever the action cannot be carried out — a
 * `remediate` with nothing to remediate, a `handoff` that could not start.
 */
async function applyReviewAction(args: {
  pipeline: SuitePipelineRun;
  action: ReviewAction;
  promptId: number;
  verdict: CompletionVerdict;
  report: CompletionAuditReport | null;
  auditId: string | null;
  sourceRunId: string;
  parkReason: string | null;
}): Promise<boolean> {
  const { pipeline, action, promptId } = args;

  if (action === "close") {
    // Reached only on a verdict that is not COMPLETE — the COMPLETE path
    // returned long before this. An operator can select `close` against
    // INCOMPLETE in the matrix, and honouring it would mark work done on the
    // reviewer's own evidence that it is not. Refused, loudly, and the station
    // falls to its rule.
    log.warn(`reviewer action "close" refused on a ${args.verdict} verdict prompt=${promptId}`);
    return false;
  }

  if (action === "remediate") return tryRemediate(args);

  if (action === "retry") {
    log.info(`reviewer retry prompt=${promptId}`);
    workspaces.resetPromptToTodo(promptId, "A reviewer's verdict retried this station.");
    const updated = workspaces.updatePipelineRun(pipeline.id, { currentPromptId: promptId, currentRunId: null });
    await startCurrentStation(updated, promptId);
    return true;
  }

  if (action === "handoff") {
    // The same gate the automatic path uses. A brief summarising a run that
    // produced nothing is a full agent run spent describing an empty tree, and
    // choosing `handoff` in the matrix is not a reason to pay for one — it says
    // what to do when there *is* something to hand over. Refused, the station
    // falls back to its rule and the operator still gets the reviewer's report.
    const allowed = autoHandoffAllowed({
      trigger: settings.pipelinePolicy.handoffTrigger,
      status: workspaces.promptOutcome(promptId).status,
      producedWork: workspaces.promptProducedWork(promptId),
      reviewed: true,
    });
    if (allowed && await tryAutoHandoff(pipeline, promptId, args.sourceRunId)) {
      await park(pipeline, promptId, "handoff_running");
      return true;
    }
    return false;
  }

  if (action === "markReview") {
    workspaces.markPromptNeedsReview(promptId, "A reviewer could not settle this work item, so it is flagged for you.");
    await park(pipeline, promptId, args.parkReason);
    return true;
  }

  // "park" — hold here with the reviewer's reason, whatever the station rule
  // would otherwise have done.
  await park(pipeline, promptId, args.parkReason);
  return true;
}

export const pipelineScheduler = {
  async play(suiteId: number, body: Record<string, unknown> = {}): Promise<SuitePipelineRun> {
    const suite = workspaces.suiteHeader(suiteId);
    return enqueue(suite.workspaceId, () => playSuiteUnlocked(suiteId, body));
  },

  async pause(suiteId: number): Promise<SuitePipelineRun> {
    const suite = workspaces.suiteHeader(suiteId);
    let interruptId: string | null = null;
    const paused = await enqueue(suite.workspaceId, async () => {
      const result = await pauseSuiteUnlocked(suiteId);
      interruptId = result.interruptId;
      return result.paused;
    });
    if (interruptId !== null) await runHub.stop(interruptId);
    return paused;
  },

  async stop(suiteId: number): Promise<SuitePipelineRun> {
    const suite = workspaces.suiteHeader(suiteId);
    let interruptId: string | null = null;
    const stopped = await enqueue(suite.workspaceId, async () => {
      const result = await stopSuiteUnlocked(suiteId);
      interruptId = result.interruptId;
      return result.stopped;
    });
    if (interruptId !== null) await runHub.stop(interruptId);
    return stopped;
  },

  async playNamed(pipelineId: number, body: Record<string, unknown> = {}): Promise<PipelineRun> {
    const pipeline = workspaces.getPipeline(pipelineId);
    return enqueue(pipeline.workspaceId, () => playNamedUnlocked(pipelineId, body));
  },

  async pauseNamed(pipelineId: number): Promise<PipelineRun> {
    const pipeline = workspaces.getPipeline(pipelineId);
    return enqueue(pipeline.workspaceId, async () => {
      const active = workspaces.activeNamedPipelineRun(pipelineId);
      if (active === null || active.state !== "PLAYING") {
        throw new WorkspaceError(409, "pipeline_not_playing", "Pause requires a playing pipeline");
      }
      if (active.currentSuiteId !== null) {
        const result = await pauseSuiteUnlocked(active.currentSuiteId);
        if (result.interruptId !== null) await runHub.stop(result.interruptId);
      } else {
        workspaces.updateNamedPipelineRun(active.id, { state: "PAUSED" });
      }
      return workspaces.namedPipelineRunById(active.id)!;
    });
  },

  async stopNamed(pipelineId: number): Promise<PipelineRun> {
    const pipeline = workspaces.getPipeline(pipelineId);
    let interruptId: string | null = null;
    const stopped = await enqueue(pipeline.workspaceId, async () => {
      const active = workspaces.activeNamedPipelineRun(pipelineId);
      if (active === null) throw new WorkspaceError(409, "pipeline_not_active", "No active pipeline to stop");
      if (active.currentSuiteId !== null) {
        try {
          const result = await stopSuiteUnlocked(active.currentSuiteId);
          interruptId = result.interruptId;
        } catch (error) {
          if (!(error instanceof WorkspaceError) || error.code !== "pipeline_not_active") throw error;
        }
      }
      return workspaces.updateNamedPipelineRun(active.id, {
        state: "STOPPED",
        stopReason: "operator_stop",
        endedAt: new Date().toISOString(),
      });
    });
    if (interruptId !== null) await runHub.stop(interruptId);
    return stopped;
  },

  async onExecuteEnded(args: {
    runId: string;
    workspaceId: number;
    promptId: number;
    processState: "done" | "interrupted" | "error";
  }): Promise<void> {
    // A run that ended because the server is shutting down is not a station
    // outcome: advancing here would start the successor inside a dying process
    // and orphan it. The pipeline is left PLAYING so the next boot marks it
    // interrupted and the operator resumes or retries deliberately.
    if (runHub.isClosing()) return;
    const pointed = workspaces.pipelineByCurrentRun(args.runId);
    if (pointed === null) return;
    await enqueue(args.workspaceId, () => applyExecuteEnded(pointed, args.runId, args.promptId));
  },

  /**
   * A completion audit finished. `verdict` is null when the auditor itself
   * failed, which is treated exactly like UNVERIFIABLE: the station falls back
   * to its own rule, having lost nothing but the cost of the read-only run.
   */
  async onAuditSettled(args: { promptId: number; sourceRunId: string; verdict: CompletionVerdict | null; verificationSummary?: string; report?: CompletionAuditReport | null; auditId?: string | null }): Promise<boolean> {
    const home = workspaces.promptHome(args.promptId);
    return enqueue(home.workspaceId, () => settleAudit(args));
  },

  onPromptSkipped(promptId: number): Promise<void> {
    return resumeAfterHumanResolution(promptId);
  },

  /**
   * The operator marked a parked station complete by hand. Same resumption as a
   * skip: the station is terminal either way, so the rail can move on.
   */
  onPromptCompleted(promptId: number): Promise<void> {
    return resumeAfterHumanResolution(promptId);
  },
};
