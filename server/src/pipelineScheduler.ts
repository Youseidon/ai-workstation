import { classifyFailure, isProviderId, type CompletionAuditReport, type CompletionVerdict, type PipelineRun, type PromptPipelineRule, type PromptStatus, type ProviderId, type SuitePipelineRun } from "@agent-console/shared";
import { detectProviders, getAdapter } from "./adapters/registry.ts";
import { newId } from "./lib/ids.ts";
import { createLogger } from "./lib/logger.ts";
import { currentLockMode } from "./lib/instanceLock.ts";
import { cooling, isCooling, markCooling } from "./providerHealth.ts";
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
  preferPlayTarget?: boolean;
  rule: PromptPipelineRule;
  playProvider: ProviderId | null;
  playModel: string | null;
  defaultProvider: ProviderId | null;
  defaultModel: string | null;
}): { provider: ProviderId; model: string | null } | null {
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

/**
 * Fallback list resolution: station → suite default → house default.
 * Empty at a level means "ask the next level"; the house default is never empty.
 */
export function resolveFallbackProviders(args: {
  rule: PromptPipelineRule;
  suiteFallbackProviders: ProviderId[];
  houseFallbackProviders?: ProviderId[];
}): ProviderId[] {
  if (args.rule.fallbackProviders.length > 0) return args.rule.fallbackProviders;
  if (args.suiteFallbackProviders.length > 0) return args.suiteFallbackProviders;
  const house = args.houseFallbackProviders ?? settings.pipelinePolicy.fallbackProviders;
  return house;
}

async function pickFallbackProvider(args: {
  list: ProviderId[];
  exclude: ReadonlySet<ProviderId>;
}): Promise<ProviderId | null> {
  const providers = await detectProviders();
  const available = new Set(providers.filter((item) => item.available).map((item) => item.id));
  for (const candidate of args.list) {
    if (args.exclude.has(candidate)) continue;
    if (isCooling(candidate)) continue;
    if (!available.has(candidate)) continue;
    return candidate;
  }
  return null;
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

/**
 * Whether a restart-interrupted run is picked back up rather than replaced.
 *
 * `autoResume` does it without being asked and `resumeSameRun` does it when the
 * operator presses Play; what they share is that the *same* run continues, so
 * the decision of which run to act on is one function rather than two policies
 * spelled out at each call site.
 */
function adoptsInterruptedRun(): boolean {
  const policy = settings.pipelinePolicy.onRestart;
  return policy === "autoResume" || policy === "resumeSameRun";
}

function namedPipelineIdFor(live: SuitePipelineRun): number | undefined {
  if (live.pipelineRunId === null) return undefined;
  return workspaces.namedPipelineRunById(live.pipelineRunId)?.pipelineId;
}

type StartStationOpts = {
  preferPlayTarget?: boolean;
  /** Force a specific provider (fallback path). Model null → that provider's default. */
  override?: { provider: ProviderId; model: string | null };
  /** Providers already tried this start chain — never retry them. */
  tried?: ReadonlySet<ProviderId>;
  /**
   * What to do when every fallback is exhausted. Defaults to park —
   * providers may recover, and Resume is the right button. Pass `terminate`
   * only when a cold Play must fail hard (unused today).
   */
  onExhausted?: "park" | "terminate";
};

async function startCurrentStation(
  pipeline: SuitePipelineRun,
  promptId: number,
  preferPlayTargetOrOpts: boolean | StartStationOpts = false,
): Promise<SuitePipelineRun> {
  const opts: StartStationOpts = typeof preferPlayTargetOrOpts === "boolean"
    ? { preferPlayTarget: preferPlayTargetOrOpts }
    : preferPlayTargetOrOpts;
  const preferPlayTarget = opts.preferPlayTarget === true;
  const onExhausted = opts.onExhausted ?? "park";
  const tried = new Set(opts.tried ?? []);

  const live = workspaces.pipelineById(pipeline.id) ?? pipeline;
  const pipelineId = namedPipelineIdFor(live);
  const rule = workspaces.pipelineRule(promptId, pipelineId);
  const defaults = workspaces.suitePipelineDefaults(live.suiteId);
  const resolved = opts.override !== undefined
    ? { provider: opts.override.provider, model: opts.override.model ?? getAdapter(opts.override.provider).model }
    : resolveExecuteTarget({
      preferPlayTarget,
      rule,
      playProvider: live.playProvider,
      playModel: live.playModel,
      defaultProvider: defaults.defaultProvider,
      defaultModel: defaults.defaultModel,
    });
  if (resolved === null) {
    await terminate(live, "STOPPED", "no_provider");
    throw new WorkspaceError(422, "provider_required", "Play needs a provider on the station, the play request, or the suite default.");
  }
  // Skip a primary that is already cooling — go straight to a fallback.
  let target = resolved;
  if (opts.override === undefined && isCooling(target.provider)) {
    tried.add(target.provider);
    const list = resolveFallbackProviders({
      rule,
      suiteFallbackProviders: defaults.defaultFallbackProviders,
    });
    const next = await pickFallbackProvider({ list, exclude: tried });
    if (next === null) {
      return exhaustProviders(live, promptId, onExhausted, `Primary ${target.provider} is cooling and no fallback is available.`);
    }
    workspaces.queueProviderFallback(promptId, {
      from: target.provider,
      to: next,
      failure: "start_failed",
      because: `Primary ${target.provider} is cooling; starting ${next} instead.`,
      previousRunId: null,
    });
    target = { provider: next, model: getAdapter(next).model };
  }
  tried.add(target.provider);
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
    const message = error instanceof Error ? error.message : String(error);
    const failure = classifyFailure({ errorText: message, toolCalls: 0, startFailed: true });
    markCooling(target.provider, failure.id ?? "start_failed", undefined, failure.because);
    const list = resolveFallbackProviders({
      rule,
      suiteFallbackProviders: defaults.defaultFallbackProviders,
    });
    const next = await pickFallbackProvider({ list, exclude: tried });
    if (next !== null) {
      log.info(`provider-fallback start suite=${live.suiteId} prompt=${promptId} ${target.provider}→${next} because=${failure.id}`);
      workspaces.queueProviderFallback(promptId, {
        from: target.provider,
        to: next,
        failure: failure.id,
        because: failure.because,
        previousRunId: null,
      });
      return startCurrentStation(live, promptId, {
        override: { provider: next, model: null },
        tried,
        onExhausted,
      });
    }
    return exhaustProviders(live, promptId, onExhausted, message);
  }
}

async function exhaustProviders(
  pipeline: SuitePipelineRun,
  promptId: number,
  onExhausted: "park" | "terminate",
  detail: string,
): Promise<SuitePipelineRun> {
  if (onExhausted === "park") {
    const coolingNow = cooling();
    log.info(
      `park no_provider_available suite=${pipeline.suiteId} prompt=${promptId} cooling=${coolingNow.map((c) => c.provider).join(",") || "none"} detail=${detail.slice(0, 120)}`,
    );
    return park(pipeline, promptId, "no_provider_available");
  }
  await terminate(pipeline, "STOPPED", "start_failed");
  throw new WorkspaceError(500, "start_failed", detail || "The agent process failed to start.");
}

async function advance(pipeline: SuitePipelineRun, preferPlayTarget = false): Promise<SuitePipelineRun> {
  const live = workspaces.pipelineById(pipeline.id) ?? pipeline;
  const pipelineId = namedPipelineIdFor(live);
  const ready = workspaces.readyPromptsInSuite(live.workspaceId, live.suiteId, pipelineId);
  const next = ready[0];
  if (next !== undefined) {
    log.info(`advance suite=${live.suiteId} prompt=${next.id}`);
    const updated = workspaces.updatePipelineRun(live.id, {
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
 * Pure decision table for a finished execute run.
 *
 * Kept free of I/O so a test can enumerate every (status × trigger) row —
 * including the `unexpected_status` tripwire — without standing up a database.
 * `applyExecuteEnded` is the only caller that turns a decision into work.
 */
export type ExecuteEndedDecision =
  | { action: "applyOnDone" }
  | { action: "advance" }
  | { action: "park"; waitReason: "human_question" }
  | { action: "continuation"; causeKind: "agent_continue" | "unfinished" }
  | { action: "terminate"; stopReason: string };

export function decideExecuteEnded(status: PromptStatus, trigger: string | null): ExecuteEndedDecision {
  if (status === "DONE") return { action: "applyOnDone" };
  if (status === "SKIPPED") return { action: "advance" };
  if (status === "BLOCKED" && trigger === "agent_post") return { action: "park", waitReason: "human_question" };
  if (status === "TODO" && trigger === "agent_decompose") return { action: "advance" };
  if (status === "TODO" && trigger === "agent_continue") return { action: "continuation", causeKind: "agent_continue" };
  if (status === "UNREPORTED") return { action: "continuation", causeKind: "unfinished" };
  if (status === "FAILED" && (trigger === "run_crashed" || trigger === "run_start_failed")) {
    return { action: "continuation", causeKind: "unfinished" };
  }
  if (status === "NEEDS_REVIEW") return { action: "continuation", causeKind: "unfinished" };
  return { action: "terminate", stopReason: `unexpected_status:${status}` };
}

/** Brief the next run is handed when the previous one left none of its own. */
function unfinishedCause(promptId: number, result: string): string {
  // Newest last. A refused `done` banks a VERIFICATION remark with the failing
  // command's output; that has to lead the brief, or the next run rediscovers
  // the failure from scratch.
  const remarks = workspaces.recentProgressRemarks(promptId, 5);
  const verifications = remarks.filter((row) => row.kind === "VERIFICATION").map((row) => row.content.trim()).filter((text) => text !== "");
  const progress = remarks.filter((row) => row.kind === "PROGRESS").map((row) => row.content.trim()).filter((text) => text !== "");
  const stop = result.trim() !== "" ? result.trim() : "The run ended without posting a final status.";
  const parts = [stop];
  if (verifications.length > 0) {
    parts.push(`Last refused verification:\n${verifications[verifications.length - 1]}`);
  }
  if (progress.length > 0) {
    parts.push(`Last progress:\n${progress.map((text) => `- ${text}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * Re-queue the same station, or park once its allowance is spent.
 *
 * Counted by ledger rows with `rule_id = "continuation"` since the most recent
 * USER row — an operator Resume grants a fresh allowance. The station rule's
 * `onUnfinished` can still short-circuit to skip or wait before any of that.
 */
async function continuation(
  pipeline: SuitePipelineRun,
  rule: PromptPipelineRule,
  promptId: number,
  previousRunId: string,
  cause: string,
): Promise<SuitePipelineRun> {
  if (rule.onUnfinished === "skip") {
    workspaces.skipPrompt(promptId, "SYSTEM", "Pipeline skipped this station after it did not finish.");
    return advance(pipeline);
  }
  if (rule.onUnfinished === "wait") {
    return park(pipeline, promptId, "station_rule_wait");
  }

  const n = workspaces.continuationCount(promptId);
  const N = settings.pipelinePolicy.maxContinuations;
  if (n < N) {
    workspaces.queueContinuation(promptId, {
      attempt: n + 1,
      of: N,
      cause,
      previousRunId,
      // The agent already wrote its own CONTINUATION on `agent_continue`; a
      // second SYSTEM one would bury it. For every other unfinished ending the
      // agent left none, so the cause sentence becomes the brief.
      writeSystemRemark: !workspaces.runHasContinuationRemark(promptId, previousRunId),
    });
    log.info(`continuation ${n + 1}/${N} suite=${pipeline.suiteId} prompt=${promptId} cause=${cause.slice(0, 120)}`);
    const updated = workspaces.updatePipelineRun(pipeline.id, { currentPromptId: promptId, currentRunId: null });
    // Pause means the operator asked the rail to stop; a continuation is still
    // the rail moving, so it waits for Play like every other start.
    if (updated.state === "PAUSED") return updated;
    // A continuation that cannot start either parks rather than stopping the
    // whole suite — the provider may recover, and Resume is the right button.
    return startCurrentStation(updated, promptId, { onExhausted: "park" });
  }

  if (settings.pipelinePolicy.reviewAfterContinuations) {
    try {
      const source = workspaces.runSummary(previousRunId);
      const { scheduleCompletionAudit } = await import("./completionAudit.ts");
      const result = await scheduleCompletionAudit({
        workspaceId: pipeline.workspaceId,
        promptId,
        sourceRunId: previousRunId,
        sourceProvider: source.provider,
        automatic: true,
      });
      if (result.started) return park(pipeline, promptId, "review_running");
      log.warn(`post-continuation audit declined suite=${pipeline.suiteId} prompt=${promptId} block=${result.block}`);
    } catch (error) {
      log.warn(`post-continuation audit failed to start suite=${pipeline.suiteId} prompt=${promptId}`, error);
    }
  }
  return park(pipeline, promptId, "continuations_exhausted");
}

async function applyExecuteEnded(pipeline: SuitePipelineRun, runId: string, promptId: number): Promise<void> {
  const live = workspaces.pipelineById(pipeline.id);
  if (live === null || (live.state !== "PLAYING" && live.state !== "PAUSED")) return;
  // Replay / late onEnd: only the run the rail is currently pointing at may move it.
  if (live.currentRunId !== runId) return;
  workspaces.updatePipelineRun(live.id, { currentRunId: null });
  const posted = workspaces.promptOutcome(promptId);
  const pipelineId = namedPipelineIdFor(live);
  const rule = ruleByRun.get(runId) ?? workspaces.pipelineRule(promptId, pipelineId);
  ruleByRun.delete(runId);
  const trigger = workspaces.latestStatusTrigger(promptId);

  // Sub-step DONE/SKIPPED never applies the parent's onDone (stop / skip_rest);
  // that policy is reserved for the station itself finishing.
  const parentId = workspaces.parentPromptId(promptId);
  if (parentId !== null && (posted.status === "DONE" || posted.status === "SKIPPED")) {
    await advance(live);
    return;
  }

  // Provider fallback sits in front of the FAILED → continuation row: a
  // capacity / quota / start failure says nothing about the work, so swap
  // providers immediately without spending a continuation.
  if (
    posted.status === "FAILED"
    && (trigger === "run_crashed" || trigger === "run_start_failed")
  ) {
    const facts = workspaces.runFailureFacts(runId);
    const failure = classifyFailure({
      errorText: facts.errorText || posted.result,
      toolCalls: facts.toolCalls,
      startFailed: trigger === "run_start_failed",
    });
    if (failure.class === "transient_provider") {
      markCooling(facts.provider, failure.id ?? "died_before_work", undefined, failure.because);
      const defaults = workspaces.suitePipelineDefaults(live.suiteId);
      const list = resolveFallbackProviders({
        rule,
        suiteFallbackProviders: defaults.defaultFallbackProviders,
      });
      const next = await pickFallbackProvider({
        list,
        exclude: new Set([facts.provider]),
      });
      if (next !== null) {
        log.info(`provider-fallback ended suite=${live.suiteId} prompt=${promptId} ${facts.provider}→${next} id=${failure.id}`);
        workspaces.queueProviderFallback(promptId, {
          from: facts.provider,
          to: next,
          failure: failure.id,
          because: failure.because,
          previousRunId: runId,
        });
        if (live.state === "PAUSED") return;
        await startCurrentStation(live, promptId, {
          override: { provider: next, model: null },
          tried: new Set([facts.provider]),
          onExhausted: "park",
        });
        return;
      }
      // No fallback free: fall through to continuation with the failure class
      // in the cause, so the same provider may recover on the next attempt.
      const decision = decideExecuteEnded(posted.status, trigger);
      if (decision.action === "continuation") {
        const cause = `${failure.because} ${unfinishedCause(promptId, posted.result)}`.trim();
        await continuation(live, rule, promptId, runId, cause);
        return;
      }
    }
  }

  const decision = decideExecuteEnded(posted.status, trigger);
  if (decision.action === "applyOnDone") {
    await applyOnDone(live, rule);
    return;
  }
  if (decision.action === "advance") {
    await advance(live);
    return;
  }
  if (decision.action === "park") {
    await park(live, promptId, decision.waitReason);
    return;
  }
  if (decision.action === "continuation") {
    const cause = decision.causeKind === "agent_continue"
      ? (workspaces.latestContinuationRemark(promptId) ?? "The agent asked to be resumed on the same working tree.")
      : unfinishedCause(promptId, posted.result);
    await continuation(live, rule, promptId, runId, cause);
    return;
  }
  await terminate(live, "STOPPED", decision.stopReason);
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
function notReadyReason(
  workspaceId: number,
  blockingPromptId: number | null,
  descendantId: number | null,
  waitReason: string | null = null,
): string {
  if (blockingPromptId === null) return "Every station on this pipeline is already finished.";
  const target = descendantId ?? blockingPromptId;
  const prompt = workspaces.resolvePrompt(workspaceId, target);
  const label = prompt.externalKey ?? prompt.title;
  if (waitReason === "human_question" || prompt.status === "BLOCKED") {
    return `${label} asked a question only you can answer. Answer or skip it, then Resume.`;
  }
  if (waitReason === "continuations_exhausted") {
    return `${label} was continued until its allowance ran out and is still not finished. Read the last brief, fix what is in the way, then Resume.`;
  }
  if (waitReason === "review_running") {
    return `${label} is waiting on a read-only reviewer checking the station after its continuations ran out.`;
  }
  if (waitReason === "station_rule_wait") {
    return `${label} is parked by its station rule (on unfinished = wait). Resume or change the rule, then play again.`;
  }
  if (waitReason === "no_provider_available") {
    return `${label} could not start: every configured provider is unavailable or cooling. Wait for one to recover, or assign another, then Resume.`;
  }
  if (prompt.recoverable) {
    return `${label} needs recovery before this pipeline can continue — its last run stopped without posting a status. Retry or skip it, then play again.`;
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
        if (!ready) throw new WorkspaceError(422, "prompt_not_ready", currentId === null ? "This run has no station to resume." : notReadyReason(suite.workspaceId, currentId, null, active.waitReason));
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
  // An interrupted run is not "active", so it would otherwise be abandoned in
  // favour of a fresh one. Adopting it keeps the attempt counter and the station
  // it was holding, which is the whole point of both policies that continue a
  // run rather than replace it.
  if (adoptsInterruptedRun()) {
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

/**
 * The run Stop acts on.
 *
 * Under `autoResume` a run interrupted by a restart is not "active" and yet is
 * about to relaunch itself, so Stop has to be able to reach it — the transition
 * row offers Stop for exactly that reason. Stopping it writes `operator_stop`,
 * which is also what takes it out of `resumeInterrupted`'s query: the operator
 * saying stop always beats the timer.
 */
function stoppableSuiteRun(suiteId: number): SuitePipelineRun | null {
  const active = workspaces.activePipeline(suiteId);
  if (active !== null) return active;
  if (settings.pipelinePolicy.onRestart !== "autoResume") return null;
  const latest = workspaces.latestPipeline(suiteId);
  return latest !== null && latest.state === "INTERRUPTED" && latest.stopReason === "server_restart" ? latest : null;
}

/** The named-run half of `stoppableSuiteRun`; same reasoning. */
function stoppableNamedRun(pipelineId: number): PipelineRun | null {
  const active = workspaces.activeNamedPipelineRun(pipelineId);
  if (active !== null) return active;
  if (settings.pipelinePolicy.onRestart !== "autoResume") return null;
  const latest = workspaces.latestNamedPipelineRun(pipelineId);
  return latest !== null && latest.state === "INTERRUPTED" && latest.stopReason === "server_restart" ? latest : null;
}

async function stopSuiteUnlocked(suiteId: number): Promise<{ stopped: SuitePipelineRun; interruptId: string | null }> {
  const active = stoppableSuiteRun(suiteId);
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
  // Same adoption as `playSuiteUnlocked`, one level up: a named run interrupted
  // by a restart owns the suite run under it, so continuing it here is what lets
  // that suite run be continued rather than superseded.
  const interrupted = adoptsInterruptedRun() ? workspaces.latestNamedPipelineRun(pipelineId) : null;
  const active = workspaces.activeNamedPipelineRun(pipelineId)
    ?? (interrupted !== null && interrupted.state === "INTERRUPTED" && interrupted.stopReason === "server_restart" ? interrupted : null);
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
const AUDIT_COMPLETE_REASON = "A read-only completion audit verified this work item against its acceptance criteria after the station's continuations ran out.";

/**
 * Act on the post-continuation audit. COMPLETE → close (DoD gate) → advance;
 * anything else → park `continuations_exhausted` with the report already on the
 * prompt's audit record. Runs inside the workspace queue.
 */
async function settleAudit(args: {
  promptId: number;
  sourceRunId: string;
  verdict: CompletionVerdict | null;
  verificationSummary?: string;
  report?: CompletionAuditReport | null;
  auditId?: string | null;
}): Promise<boolean> {
  const home = workspaces.promptHome(args.promptId);
  const active = workspaces.activePipeline(home.suiteId);
  // Only a run parked on this exact station for the post-N review may be moved.
  const parked = active !== null
    && active.state === "WAITING_HUMAN"
    && active.currentPromptId === args.promptId
    && active.waitReason === "review_running";

  if (args.verdict === "COMPLETE") {
    try {
      const { runDefinitionOfDoneCommands } = await import("./definitionOfDone.ts");
      await runDefinitionOfDoneCommands(args.promptId, args.sourceRunId);
      const written = workspaces.completePrompt(args.promptId, "SYSTEM", {
        reason: AUDIT_COMPLETE_REASON,
        verificationSummary: args.verificationSummary ?? "",
      });
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
      log.info(`audit COMPLETE refused by the definition of done suite=${home.suiteId} prompt=${args.promptId}`);
    } catch (error) {
      log.warn(`audit COMPLETE could not be applied prompt=${args.promptId}`, error);
    }
  }

  if (!parked) return false;
  // Report stays on the completion_audit row; the wait reason is what the rail shows.
  await park(active, args.promptId, "continuations_exhausted");
  return false;
}

/**
 * How far back an auto-resume reaches.
 *
 * A restart that happened minutes ago is the case this exists for. A machine
 * that has been off for a week is not: relaunching an agent into a working tree
 * whose state nobody remembers is a worse outcome than a pipeline that waits.
 */
const RESUME_WINDOW_HOURS = 24;

/**
 * Put the station a restart caught mid-run back on the queue, and say which.
 *
 * The status write is the only thing that happens to the work item — the tree
 * is untouched and nothing is concluded about the work. A station that cannot
 * be re-queued (already terminal, or a run genuinely still alive) is left as it
 * is and the pipeline is resumed anyway, which lands on the next ready station.
 */
function requeueStation(suiteRun: SuitePipelineRun): number | null {
  if (suiteRun.currentPromptId === null) return null;
  return workspaces.requeueStationAfterRestart(suiteRun.currentPromptId) ? suiteRun.currentPromptId : null;
}

async function resumeInterruptedSuite(run: SuitePipelineRun): Promise<void> {
  // Re-read: between the query and this turn of the queue an operator may have
  // stopped it, or a resume of the named run above may already have taken it.
  const live = workspaces.pipelineById(run.id);
  if (live === null || live.state !== "INTERRUPTED" || live.stopReason !== "server_restart") return;
  const station = requeueStation(live);
  log.info(`auto-resume pipeline=${live.id} suite=${live.suiteId} station=${station ?? "next-ready"}`);
  await resume(live, undefined, undefined);
}

async function resumeInterruptedNamed(run: PipelineRun): Promise<void> {
  const live = workspaces.namedPipelineRunById(run.id);
  if (live === null || live.state !== "INTERRUPTED" || live.stopReason !== "server_restart") return;
  const suiteRun = live.currentSuiteRunId === null ? null : workspaces.pipelineById(live.currentSuiteRunId);
  const station = suiteRun === null ? null : requeueStation(suiteRun);
  log.info(`auto-resume pipeline=${live.id} suite=${live.currentSuiteId ?? "none"} station=${station ?? "next-ready"}`);
  // `playNamedUnlocked` adopts the interrupted run under this policy, so the
  // suite run beneath it is continued rather than replaced, and
  // `syncNamedFromSuite` carries the new state back up. Resuming both would
  // start the station twice.
  await playNamedUnlocked(live.pipelineId);
}

/**
 * Pick up every pipeline the last shutdown interrupted.
 *
 * Called once, a few seconds after boot. 22 of the owner's first 34 pipeline
 * runs ended `server_restart` and then sat there: the rail had no way back on
 * its own, so an overnight suite was really a bet on nobody editing code.
 *
 * Each pipeline is wrapped on its own — one workspace whose directory has since
 * been deleted must not stop the rest — and each goes through `enqueue` like
 * every other entry point, so a resume cannot interleave with a run ending.
 */
async function resumeInterruptedAll(): Promise<void> {
  if (settings.pipelinePolicy.onRestart !== "autoResume") return;
  if (runHub.isClosing()) return;
  /*
   * Only a `serve` process relaunches work, and this is not a formality.
   *
   * `dev:sandbox` copies the *database* but not the workspaces: every row still
   * names the owner's real working directories. Without this, starting a
   * development server picked up the live console's interrupted pipeline and
   * launched a Cursor agent into `~/projects/materio-forge` — observed, and the
   * reason the check exists. A copy of the state is not a copy of the world.
   */
  if (currentLockMode() !== "serve") {
    const pending = workspaces.interruptedRunsToResume(RESUME_WINDOW_HOURS);
    const count = pending.suiteRuns.length + pending.namedRuns.length;
    // Said out loud rather than skipped silently: an operator who expected the
    // rail to come back has to learn why it did not.
    if (count > 0) {
      log.info(
        `auto-resume standing down: ${count} interrupted pipeline(s) left alone because this is not `
        + "a `serve` process. Run `npm run serve` to have them picked back up.",
      );
    }
    return;
  }
  const { suiteRuns, namedRuns } = workspaces.interruptedRunsToResume(RESUME_WINDOW_HOURS);
  for (const named of namedRuns) {
    try {
      await enqueue(named.workspaceId, () => resumeInterruptedNamed(named));
    } catch (error) {
      log.warn(`auto-resume failed pipeline=${named.id}`, error);
    }
  }
  for (const suiteRun of suiteRuns) {
    // A named run owns the suite runs it started. If it was resumable it has
    // just been resumed with this one underneath it; if it was not — stopped,
    // or outside the window — then neither is this.
    if (suiteRun.pipelineRunId !== null) continue;
    try {
      await enqueue(suiteRun.workspaceId, () => resumeInterruptedSuite(suiteRun));
    } catch (error) {
      log.warn(`auto-resume failed pipeline=${suiteRun.id}`, error);
    }
  }
}

export const pipelineScheduler = {
  /** Boot-time auto-resume. `index.ts` calls it once the server is listening. */
  resumeInterrupted(): Promise<void> {
    return resumeInterruptedAll();
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
      const active = stoppableNamedRun(pipelineId);
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
   * The post-continuation audit finished. COMPLETE closes and advances; any
   * other verdict (including a null one from a failed auditor) parks
   * `continuations_exhausted`.
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
