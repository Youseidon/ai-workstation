import { classifyFailure, exhaustedUsageWindow, quotaCoolingMinutes, isProviderId, type CompletionAuditReport, type CompletionVerdict, type PipelineRun, type PromptPipelineRule, type PromptStatus, type ProviderId, type RunMessage, type SuitePipelineRun } from "@hydra/shared";
import { collectAccountUsage, detectProviders, getAdapter } from "../../providers/registry.ts";
import { newId } from "../../utils/ids.ts";
import { createLogger } from "../../utils/logger.ts";
import { currentLockMode } from "../../infrastructure/instanceLock.ts";
import { clearCooling, cooling, coolingFor, isCooling, markCooling } from "../../providers/providerHealth.ts";
import { runHub } from "../runs/runHub.ts";
import { setResumeRequester } from "../runs/runMessages.ts";
import { settings } from "../../config/settings.ts";
import type { StartExecuteArgs } from "../../contracts/runRequests.ts";
import { releaseSupervisedRun, trackRuntimeEffect, releaseRuntimeEffect, acceptSupervisedUnit, reserveSupervisedStart, settleSupervisedRun } from "../execution/executionSupervisor.ts";
import { cancelManagedCommands } from "../execution/commandTasks.ts";
import { repositoryResource } from "../../infrastructure/sourceFingerprint.ts";
import { ExecutionError } from "../../repositories/executionStore.ts";
import { executionStore, WorkspaceError, workspaces } from "../../repositories/workspaces.ts";

const log = createLogger("pipeline");

type StationStarter = (args: StartExecuteArgs) => Promise<{ runId: string }>;

async function defaultStartStation(args: StartExecuteArgs): Promise<{ runId: string }> {
  const { startExecute } = await import("../runs/runService.ts");
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
  const provider = args.rule.provider ?? args.defaultProvider ?? args.playProvider;
  if (provider === null) return null;
  // Models belong to their provider; a suite model cannot follow a prompt
  // override to a different provider (nor can a play-request model).
  const model = (args.rule.provider !== null ? args.rule.model
    : args.defaultProvider !== null ? args.defaultModel : args.playModel) ?? getAdapter(provider).model;
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
  await refreshUsageCooling();
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

async function refreshUsageCooling(force = false): Promise<void> {
  for (const usage of await collectAccountUsage(force)) {
    const window = exhaustedUsageWindow(usage);
    if (window === null) continue;
    const reset = window.resetsAt === null ? NaN : Date.parse(window.resetsAt);
    const minutes = Number.isFinite(reset) ? (reset - Date.now()) / 60_000 : window.durationMinutes ?? (window.kind === "weekly" ? 10080 : 300);
    if (!Number.isFinite(reset) && isCooling(usage.provider)) continue;
    markCooling(usage.provider, "quota", minutes,
      `${usage.provider} reached its ${window.kind} limit${Number.isFinite(reset) ? `; resets ${window.resetsAt}` : ""}.`, Number.isFinite(reset) ? reset : undefined);
  }
}

function autoReassignFor(pipeline: SuitePipelineRun): boolean {
  const pipelineId = namedPipelineIdFor(pipeline);
  return pipelineId === undefined ? false : workspaces.getPipeline(pipelineId).autoReassign;
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
function adoptsInterruptedRun(promptId?:number): boolean {
  const contract=promptId===undefined?null:executionStore.forPrompt(promptId);
  if(contract?.engine==="supervised" && contract.desired==="RUNNING") return true;
  const policy = settings.pipelinePolicy.onRestart;
  return policy === "autoResume" || policy === "resumeSameRun";
}

function namedPipelineIdFor(live: SuitePipelineRun): number | undefined {
  if (live.pipelineRunId === null) return undefined;
  return workspaces.namedPipelineRunById(live.pipelineRunId)?.pipelineId;
}

/**
 * The park reason for a start the workspace refused, or null when the failure
 * is the provider's.
 *
 * `startExecute` throws for two unrelated kinds of reason. A provider that is
 * missing, at capacity or failing to launch is worth a fallback. A working tree
 * with changes no run accounts for, a repository another writer holds, a busy
 * workspace — those refuse every provider alike, so walking the fallback list
 * only cooled each one in turn and parked the run as `no_provider_available`,
 * which named the wrong problem and left Resume with nobody to start.
 */
export function startRefusalReason(error: unknown): string | null {
  if (!(error instanceof WorkspaceError) || error.code === "provider_unavailable") return null;
  return error.code === "git_worktree_dirty" ? "worktree_dirty" : `start_refused:${error.code}`;
}

/** Parks where nothing ran: the station is exactly as it was before the start. */
function isStartPark(waitReason: string | null): boolean {
  return waitReason === "no_provider_available"
    || waitReason === "provider_unavailable"
    || waitReason === "worktree_dirty"
    || (waitReason !== null && waitReason.startsWith("start_refused:"));
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
  /** "Interrupt & deliver now": continue the interrupted provider session with the operator's note. */
  redirect?: PendingRedirect;
};

/** A `/btw` the operator chose not to wait for: the run is being interrupted to deliver it. */
interface PendingRedirect {
  messageId: number;
  text: string;
  provider: ProviderId;
  sessionId: string | null;
}
const redirects = new Map<string, PendingRedirect>();

/**
 * Stops a pipeline run so an operator note reaches it now rather than on the
 * agent's next `agent-step` call. Only the rail's current run qualifies: the
 * scheduler is what restarts it, and a run it does not own would just stop.
 */
async function interruptToDeliver(runId: string, message: RunMessage): Promise<void> {
  const owner = workspaces.suitePipelineForRun(runId);
  const run = runHub.get(runId);
  if (owner === null || run === undefined || owner.state !== "PLAYING") {
    throw new WorkspaceError(409, "btw_interrupt_pipeline_only", "Interrupt & deliver is for a running pipeline station. In Chat, stop the run and send your message as the next turn.");
  }
  redirects.set(runId, { messageId: message.id, text: message.text, provider: run.provider, sessionId: run.handle.sessionId() });
  log.info(`btw interrupt run=${runId} message=${message.id}`);
  await runHub.stop(runId);
}
setResumeRequester(interruptToDeliver);

/** Shows the delivered note at the top of the run that carries it. */
function announceRedirect(runId: string, redirect: PendingRedirect, resumed: boolean): void {
  const live = runHub.get(runId);
  if (live === undefined) return;
  const event = {
    id: newId("evt"), runId, provider: live.provider, model: live.model, timestamp: new Date().toISOString(),
    type: "operator_message" as const,
    payload: { messageId: redirect.messageId, text: redirect.text, delivery: "resume" as const, state: "DELIVERED" as const },
  };
  workspaces.recordAgentEvent(runId, event);
  runHub.event(runId, event);
  log.info(`btw delivered message=${redirect.messageId} run=${runId} ${resumed ? "resumed-session" : "fresh-run-briefing"}`);
}

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
  const defaults = workspaces.suitePipelineDefaults(live.suiteId, pipelineId);
  const autoReassign = autoReassignFor(live);
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
  if (autoReassign && opts.override === undefined) await refreshUsageCooling();
  if (autoReassign && opts.override === undefined && isCooling(target.provider)) {
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
      failure: coolingFor(target.provider)?.id ?? "start_failed",
      because: `${coolingFor(target.provider)?.because ?? `Primary ${target.provider} is cooling.`} Starting ${next} instead.`,
      previousRunId: null,
    });
    target = { provider: next, model: getAdapter(next).model };
  }
  tried.add(target.provider);
  workspaces.updatePipelineRun(live.id, { currentPromptId: promptId, currentRunId: null });
  try {
    // The same provider can pick its interrupted session back up; any other
    // starts fresh, so the note goes in as a briefing at the top of the prompt.
    const redirect = opts.redirect;
    const resumable = redirect !== undefined && redirect.sessionId !== null && redirect.provider === target.provider;
    if (redirect !== undefined && !resumable) workspaces.addPromptBriefing(promptId, { content: redirect.text });
    const startArgs:StartExecuteArgs={
      workspaceId:live.workspaceId,provider:target.provider,model:target.model,promptId,pipelineRunId:live.id,
      ...(resumable?{redirect:{sessionId:redirect.sessionId!,text:redirect.text}}:{}),
    };
    const adopted=executionStore.forPrompt(promptId);
    if(adopted?.engine==="shadow") executionStore.decision(adopted.id,"shadow_decision",{action:"start",promptId,target,legacyPipeline:live.id});
    if(adopted?.engine==="supervised" && executionStore.pending().some(e=>e.contractId===adopted.id && e.promptId===promptId && e.payload.kind==="audit")) return park(live,promptId,"review_running");
    const prepared=await reserveSupervisedStart(startArgs,undefined,autoReassign?async from=>{
      const next=await pickFallbackProvider({list:resolveFallbackProviders({rule,suiteFallbackProviders:defaults.defaultFallbackProviders}),exclude:new Set([from as ProviderId])});
      return next?{provider:next,model:getAdapter(next).model}:null;
    }:undefined);
    if(prepared && !executionStore.claim(prepared.effect.id)) return workspaces.pipelineById(live.id) ?? live;
    if(prepared) trackRuntimeEffect(prepared.effect.id);
    let result:{runId:string};
    try { result=await startStationFn(prepared?.args ?? startArgs); }
    catch(error) {
      if(prepared) {
        releaseRuntimeEffect(prepared.effect.id);
        // startExecute rejects preflight before spawning; an attached process
        // needs OS reconciliation even if the caller received an exception.
        const effect=executionStore.effect(prepared.effect.id);
        if(effect.process) executionStore.quarantine(effect.id,"Start failed after process registration");
        else executionStore.settle(effect.id,{generation:effect.generation,actualMs:0,actualTokens:0,result:{startFailed:String(error)},writerDead:true});
      }
      throw error;
    }
    const {runId}=result;

    if (redirect !== undefined) {
      workspaces.settleRunMessage(redirect.messageId, "QUEUED", "DELIVERED");
      announceRedirect(runId, redirect, resumable);
    }
    ruleByRun.set(runId, rule);
    const updated = workspaces.updatePipelineRun(live.id, { currentPromptId: promptId, currentRunId: runId });
    await syncNamedFromSuite(updated);
    return updated;
  } catch (error) {
    if(error instanceof ExecutionError) {
      const c=executionStore.forPrompt(promptId);
      if(c) executionStore.decision(c.id,"execution_exception",{code:error.code,reason:error.message,promptId});
      return park(live,promptId,error.code==="provider_unavailable"?"provider_unavailable":`execution:${error.code}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    const refusal = startRefusalReason(error);
    if (refusal !== null) {
      const detail = error instanceof WorkspaceError && typeof error.details?.detail === "string" ? ` detail=${error.details.detail.slice(0, 400)}` : "";
      log.warn(`start refused suite=${live.suiteId} prompt=${promptId} provider=${target.provider} reason=${refusal} message=${message}${detail}`);
      return park(live, promptId, refusal);
    }
    const failure = classifyFailure({ errorText: message, toolCalls: 0, startFailed: true });
    markCooling(target.provider, failure.id ?? "start_failed", failure.id === "quota" ? quotaCoolingMinutes(message) : undefined, failure.because);
    if (!autoReassign) return park(live, promptId, "provider_unavailable");
    if (failure.id === "quota" || failure.id === "rate_limit") await refreshUsageCooling(true);
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

/**
 * An agent asked for a person. Close the station when command checks allow it,
 * and keep working when they do not. Either way the rail does not park.
 */
async function waiveHumanGate(
  pipeline: SuitePipelineRun,
  rule: PromptPipelineRule,
  promptId: number,
  runId: string,
): Promise<void> {
  const note = workspaces.promptOutcome(promptId).result.trim();
  const summary = note === ""
    ? "Human review was waived by the pipeline rule. It was not recorded as passed."
    : note;
  let written: PromptStatus = "NEEDS_REVIEW";
  try {
    written = workspaces.completePrompt(promptId, "SYSTEM", {
      reason: "The pipeline does not stop for a human review. The requested review was waived and was not recorded as passed.",
      verificationSummary: summary,
    });
  } catch (error) {
    log.warn(`human gate could not be waived prompt=${promptId}`, error);
  }
  if (written === "DONE") {
    await applyOnDone(pipeline, rule);
    return;
  }
  await continuation(
    pipeline,
    rule,
    promptId,
    runId,
    "Human review is waived. Fix the failing commands and post done. Do not post blocked.",
    "unfinished",
  );
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
  const contract=executionStore.forPrompt(promptId);
  if(contract?.engine==="supervised" && (waitReason==="no_provider_available"||waitReason==="provider_unavailable"||waitReason==="execution:resource_busy"||waitReason==="execution:writer_uncertain"||waitReason==="start_refused:git_repository_busy")) {
    const next=cooling().map(c=>Date.parse(c.until)).filter(time=>Number.isFinite(time)&&time>Date.now()).sort((a,b)=>a-b)[0] ?? Date.now()+60000;
    executionStore.scheduleWake(contract.id,pipeline.id,promptId,next,waitReason);
  }
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
  | { action: "waiveHuman" }
  | { action: "continuation"; causeKind: "agent_continue" | "unfinished" }
  | { action: "terminate"; stopReason: string };

export function decideExecuteEnded(status: PromptStatus, trigger: string | null): ExecuteEndedDecision {
  if (status === "DONE") return { action: "applyOnDone" };
  if (status === "SKIPPED") return { action: "advance" };
  // A blocked post is a request to stop for a person. The pipeline does not.
  if (status === "BLOCKED" && trigger === "agent_post") return { action: "waiveHuman" };
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

/** Every automatic successor, including CONTINUE, spends the same allowance. */
async function continuation(
  pipeline: SuitePipelineRun,
  rule: PromptPipelineRule,
  promptId: number,
  previousRunId: string,
  cause: string,
  causeKind: "agent_continue" | "unfinished" = "unfinished",
): Promise<SuitePipelineRun> {
  if (rule.onUnfinished === "skip") {
    workspaces.skipPrompt(promptId, "SYSTEM", "Pipeline skipped this station after it did not finish.");
    return advance(pipeline);
  }
  // `wait` asks the rail to stop for a person. The pipeline rule does not.

  const adopted=executionStore.forPrompt(promptId);
  if(adopted?.engine==="supervised") {
    const evaluation=workspaces.definitionOfDoneEvaluation(promptId);
    if(pipeline.state==="PLAYING" && adopted.desired==="RUNNING" && workspaces.runHasCompletionRemark(promptId,previousRunId) && evaluation.criteria.some(c=>c.required && c.kind==="PROSE" && c.result!=="PASSED") && evaluation.criteria.filter(c=>c.required && c.kind!=="PROSE").every(c=>c.result==="PASSED")) {
      try {
        const {scheduleCompletionAudit}=await import("../verification/completionAudit.ts");
        const source=workspaces.runSummary(previousRunId);
        const audit=await scheduleCompletionAudit({workspaceId:pipeline.workspaceId,promptId,sourceRunId:previousRunId,sourceProvider:source.provider,automatic:true});
        if(audit.started) return park(pipeline,promptId,"review_running");
      } catch(error) {executionStore.decision(adopted.id,"review_start_failed",{reason:String(error)});}
    }
    workspaces.queueContinuation(promptId,{attempt:Math.min(executionStore.unitUsage(adopted.id,promptId).workers+1,adopted.policy.unitAttempts),of:adopted.policy.unitAttempts,cause,previousRunId,writeSystemRemark:!workspaces.runHasContinuationRemark(promptId,previousRunId)});
    const updated=workspaces.updatePipelineRun(pipeline.id,{currentPromptId:promptId,currentRunId:null});
    if(updated.state==="PAUSED") return updated;
    return startCurrentStation(updated,promptId,{onExhausted:"park"});
  }
  const N = settings.pipelinePolicy.maxContinuations;
  const n = workspaces.continuationCount(promptId);

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
      countsTowardAllowance: true,
    });
    log.info(
      `continuation ${n + 1}/${N} suite=${pipeline.suiteId} prompt=${promptId} cause=${cause.slice(0, 120)}`,
    );
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
      const { scheduleCompletionAudit } = await import("../verification/completionAudit.ts");
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
  let posted = workspaces.promptOutcome(promptId);
  const adopted=executionStore.forPrompt(promptId);
  if(adopted?.engine==="supervised") {
    const proposed=executionStore.events(adopted.id).filter(e=>e.kind==="plan_proposed").at(-1);
    if(proposed && (proposed.payload as import("@hydra/shared").ExecutionPlan).revision>adopted.revision) {
      workspaces.activateExecutionPlan(adopted.id,proposed.payload as import("@hydra/shared").ExecutionPlan);
      posted=workspaces.promptOutcome(promptId);
    }
    if(posted.status==="DONE" && !acceptSupervisedUnit(promptId)) {
      workspaces.refuseSupervisedCompletion(promptId,"Completion needs fresh evidence for every assigned criterion");
      posted=workspaces.promptOutcome(promptId);
    }
  }
  releaseSupervisedRun(runId);
  const pipelineId = namedPipelineIdFor(live);
  const rule = ruleByRun.get(runId) ?? workspaces.pipelineRule(promptId, pipelineId);
  ruleByRun.delete(runId);
  const trigger = workspaces.latestStatusTrigger(promptId);

  const redirect = redirects.get(runId);
  redirects.delete(runId);
  if (redirect !== undefined) {
    if (posted.status === "DONE" || posted.status === "SKIPPED") {
      // It finished before the interrupt landed; the note has nothing to change.
      workspaces.settleRunMessage(redirect.messageId, "QUEUED", "SUPERSEDED");
    } else {
      // An operator-ordered stop is not an unfinished ending: it spends no
      // allowance, and the next run continues the same session where it can.
      workspaces.queueContinuation(promptId, {
        attempt: workspaces.continuationCount(promptId) + 1,
        of: settings.pipelinePolicy.maxContinuations,
        cause: "The operator interrupted the run to send a message.",
        previousRunId: runId,
        writeSystemRemark: !workspaces.runHasContinuationRemark(promptId, runId),
        countsTowardAllowance: false,
      });
      const updated = workspaces.updatePipelineRun(live.id, { currentPromptId: promptId, currentRunId: null });
      if (updated.state === "PAUSED") {
        // No run is coming to read it now, so keep it with the step.
        workspaces.addPromptBriefing(promptId, { content: redirect.text });
        workspaces.settleRunMessage(redirect.messageId, "QUEUED", "DELIVERED");
        return;
      }
      await startCurrentStation(updated, promptId, { onExhausted: "park", redirect });
      return;
    }
  }

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
      markCooling(facts.provider, failure.id ?? "died_before_work", failure.id === "quota" ? quotaCoolingMinutes(facts.errorText || posted.result) : undefined, failure.because);
      if (!autoReassignFor(live)) {
        if (live.state !== "PAUSED") await park(live, promptId, "provider_unavailable");
        else workspaces.updatePipelineRun(live.id, { waitReason: "provider_unavailable" });
        return;
      }
      if (failure.id === "quota" || failure.id === "rate_limit") await refreshUsageCooling(true);
      const defaults = workspaces.suitePipelineDefaults(live.suiteId, pipelineId);
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
      if (live.state !== "PAUSED") await park(live, promptId, "no_provider_available");
      else workspaces.updatePipelineRun(live.id, { waitReason: "no_provider_available" });
      return;
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
  if (decision.action === "waiveHuman") {
    await waiveHumanGate(live, rule, promptId, runId);
    return;
  }
  if (decision.action === "continuation") {
    const cause = decision.causeKind === "agent_continue"
      ? (workspaces.latestContinuationRemark(promptId) ?? "The agent asked to be resumed on the same working tree.")
      : unfinishedCause(promptId, posted.result);
    await continuation(live, rule, promptId, runId, cause, decision.causeKind);
    return;
  }
  await terminate(live, "STOPPED", decision.stopReason);
}

async function resume(pipeline: SuitePipelineRun, playProvider: ProviderId | null | undefined, playModel: string | null | undefined, preferPlayTarget = false): Promise<SuitePipelineRun> {
  if(pipeline.currentPromptId!==null) {const c=executionStore.forPrompt(pipeline.currentPromptId);if(c)executionStore.setDesired(c.id,"RUNNING");}

  // Prompt 03 AC4: Resume after an exhausted / review park must write a USER
  // ledger row so continuationCount resets. Without this the next unfinished
  // ending re-parks immediately and the documented button is a treadmill.
  const priorWait = pipeline.waitReason;
  const stationId = pipeline.currentPromptId;
  if (
    stationId !== null
    && (priorWait === "continuations_exhausted" || priorWait === "review_running")
  ) {
    workspaces.grantFreshContinuations(
      stationId,
      priorWait === "review_running"
        ? "You resumed while a post-continuation review was running; the station gets a fresh unfinished-continuation allowance."
        : "You resumed after unfinished continuations ran out; the station gets a fresh allowance.",
    );
  }
  if (isStartPark(priorWait)) {
    // Resume is the operator saying "try now", so it has to be a real attempt:
    // providers get a fresh try rather than the rest of a cooling timer, and a
    // station whose last run died on the way here goes back on the queue
    // instead of failing the ready check that made Resume refuse outright.
    if (priorWait === "no_provider_available") clearCooling();
    if (stationId !== null && workspaces.endedWithoutAgentStatus(stationId)) {
      workspaces.grantFreshContinuations(
        stationId,
        "You resumed after the station could not be started; it was re-queued on the same working tree.",
      );
    }
  }
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
  if (blockingPromptId === null) return "Every station in this suite is already finished.";
  const target = descendantId ?? blockingPromptId;
  const prompt = workspaces.resolvePrompt(workspaceId, target);
  const label = prompt.externalKey ?? prompt.title;
  if (waitReason === "human_question" || prompt.status === "BLOCKED") {
    return `${label} asked a question only you can answer. Answer or skip it, then Resume.`;
  }
  if (waitReason === "continuations_exhausted") {
    return `${label} hit unfinished endings until its allowance ran out and is still not finished. Resume grants a fresh allowance.`;
  }
  if (waitReason === "review_running") {
    return `${label} is waiting on a read-only reviewer checking the station after its continuations ran out.`;
  }
  if (waitReason === "station_rule_wait") {
    return `${label} is parked by its station rule (on unfinished = wait). Resume or change the rule, then play again.`;
  }
  if (waitReason === "no_provider_available") {
    return `${label} could not start: every configured provider is unavailable or cooling. Resume tries them again now; assign another first if they are still out.`;
  }
  if (waitReason === "provider_unavailable") {
    return `${label}'s assigned agent could not run. Choose another agent or enable automatic reassignment, then Resume.`;
  }
  if (waitReason === "worktree_dirty") {
    return `${label} could not start: the working tree has changes no agent run accounts for. Commit or stash them, then Resume.`;
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

/**
 * "Run with context": the operator's note for one station, written before the
 * play so the station's first run already has it at the top of its prompt.
 * Refused while that station's run is live — a note the running agent will not
 * read until its next run is a `/btw`, and the UI offers that instead.
 */
function applyPlayBriefing(workspaceId: number, body: Record<string, unknown>): void {
  const briefing = body.briefing;
  if (briefing === undefined || briefing === null) return;
  if (typeof briefing !== "object" || Array.isArray(briefing)) throw new WorkspaceError(422, "validation_error", "briefing must be an object");
  const { promptId, content } = briefing as Record<string, unknown>;
  if (typeof promptId !== "number" || !Number.isSafeInteger(promptId) || promptId <= 0) throw new WorkspaceError(422, "validation_error", "briefing.promptId must be a work item id");
  workspaces.resolvePrompt(workspaceId, promptId);
  const live = runHub.activeForWorkspace(workspaceId);
  if (live !== undefined && "promptId" in live.source && live.source.promptId === promptId) {
    throw new WorkspaceError(409, "prompt_run_active", "That station is running now. Stop it and rerun with this context, or send it to the running agent with /btw.");
  }
  workspaces.addPromptBriefing(promptId, { content });
}

async function playSuiteUnlocked(suiteId: number, body: Record<string, unknown> = {}): Promise<SuitePipelineRun> {
  const suite = workspaces.suiteHeader(suiteId);
  const workspace = workspaces.get(suite.workspaceId);
  if (!workspace.workDirectoryExists) {
    throw new WorkspaceError(422, "invalid_directory", `Workspace directory does not exist: ${workspace.workDirectory}`);
  }
  applyPlayBriefing(suite.workspaceId, body);
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
  // Writers, not just execute runs: an author run drafting a program holds the
  // same working directory.
  const busy = runHub.activeForWorkspace(suite.workspaceId);
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
        // Exhaust / review parks are resumed by writing a USER ledger row that
        // resets the unfinished allowance and forces TODO. That happens inside
        // resume(); the ready gate below would 422 on UNREPORTED/FAILED first.
        // A start park is the same shape: the station may still carry the
        // FAILED its last run died with, and resume() re-queues it.
        const exhaustPark = active.waitReason === "continuations_exhausted"
          || active.waitReason === "review_running"
          || isStartPark(active.waitReason);
        if (!exhaustPark) {
          // The waiting item may be a sub-step, which never appears in the
          // station list — ask the prompt itself as well.
          const ready = currentId !== null && (
            workspaces.readyPromptsInSuite(suite.workspaceId, suiteId, pipelineId).some((prompt) => prompt.id === currentId)
            || workspaces.resolvePrompt(suite.workspaceId, currentId).ready
          );
          if (!ready) {
            throw new WorkspaceError(
              422,
              "prompt_not_ready",
              currentId === null ? "This run has no station to resume." : notReadyReason(suite.workspaceId, currentId, null, active.waitReason),
            );
          }
        } else if (currentId === null) {
          throw new WorkspaceError(422, "prompt_not_ready", "This run has no station to resume.");
        }
      }
      log.info(`resume suite=${suiteId} from=${active.state}`);
      return resume(active, playProvider, playModel, preferPlayTarget);
    }
  }
  if (owner !== null && owner.suiteId !== suiteId) {
    throw new WorkspaceError(409, "workspace_busy", "Another suite pipeline already owns this workspace.");
  }
  const latestInterrupted=workspaces.latestPipeline(suiteId);
  if (adoptsInterruptedRun(latestInterrupted?.currentPromptId ?? undefined)) {
    const latest = latestInterrupted;
    if (latest !== null && latest.state === "INTERRUPTED" && (namedRunId === null || latest.pipelineRunId === namedRunId)) {
      log.info(`adopt interrupted suite=${suiteId} pipeline=${latest.id}`);
      const adopted=latest.currentPromptId===null?null:executionStore.forPrompt(latest.currentPromptId);
      if(adopted?.engine==="supervised") requeueStation(latest);
      return resume(latest, playProvider, playModel, preferPlayTarget);
    }
  }
  for(const promptId of workspaces.remainingPipelinePromptIds(suiteId,namedPipelineId)) {
    const c=executionStore.forPrompt(promptId);if(c && c.phase!=="delivered")executionStore.setDesired(c.id,"RUNNING");
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
  if(active.currentPromptId!==null) {const c=executionStore.forPrompt(active.currentPromptId);if(c)executionStore.setDesired(c.id,"PAUSED");}
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
  if(active.currentPromptId!==null) {const c=executionStore.forPrompt(active.currentPromptId);if(c)executionStore.setDesired(c.id,"STOPPED");}
  const stopped = workspaces.updatePipelineRun(active.id, {
    state: "STOPPED",
    stopReason: "operator_stop",
    endedAt: new Date().toISOString(),
    currentRunId: null,
  });
  await syncNamedFromSuite(stopped);
  return { stopped, interruptId };
}

/**
 * A stage whose every station is already DONE or SKIPPED. A fresh named run
 * starts at stage one, so without skipping these a pipeline stopped part-way
 * could never be played again: the first, long-finished suite refuses with
 * `nothing_ready` before the rail ever reaches the stage with work left.
 * A stage with no steps is not "finished" — the suite play reports it as empty.
 */
function namedStageFinished(pipelineId: number, suiteId: number): boolean {
  const steps = workspaces.remainingPipelinePromptIds(suiteId, pipelineId);
  return steps.length > 0 && steps.every((promptId) => {
    const status = workspaces.promptOutcome(promptId).status;
    return status === "DONE" || status === "SKIPPED";
  });
}

async function startNextNamedStage(named: PipelineRun, preferPlayTarget = false): Promise<PipelineRun> {
  const pipeline = workspaces.getPipeline(named.pipelineId);
  let nextIndex = named.currentSuiteId === null ? 0 : pipeline.stages.findIndex((stage) => stage.suiteId === named.currentSuiteId) + 1;
  while (nextIndex < pipeline.stages.length && namedStageFinished(named.pipelineId, pipeline.stages[nextIndex]!.suiteId)) {
    log.info(`named-skip-finished pipeline=${named.pipelineId} suite=${pipeline.stages[nextIndex]!.suiteId}`);
    nextIndex++;
  }
  const next = pipeline.stages[nextIndex];
  if (next === undefined) {
    const pendingContracts=pipeline.stages.flatMap(stage=>workspaces.remainingPipelinePromptIds(stage.suiteId,named.pipelineId)).map(id=>executionStore.forPrompt(id)).filter(c=>c?.engine==="supervised" && c.phase!=="delivered");
    if(pendingContracts.length>0) return workspaces.updateNamedPipelineRun(named.id,{state:"STOPPED",stopReason:"execution:unverified_obligations",endedAt:new Date().toISOString()});
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
  applyPlayBriefing(pipeline.workspaceId, body);
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
  const latestInterrupted=workspaces.latestNamedPipelineRun(pipelineId);
  const interruptedPrompt=latestInterrupted?.currentSuiteRunId?workspaces.pipelineById(latestInterrupted.currentSuiteRunId)?.currentPromptId:undefined;
  const interrupted = adoptsInterruptedRun(interruptedPrompt ?? undefined) ? latestInterrupted : null;
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
    if(live.state==="INTERRUPTED") workspaces.updateNamedPipelineRun(live.id,{state:"PLAYING",endedAt:null,stopReason:null});
    const suiteRun = await playSuiteUnlocked(live.currentSuiteId, suiteBody);
    const progressed=workspaces.namedPipelineRunById(live.id)!;
    if(suiteRun.state==="COMPLETE" && (progressed.currentSuiteId!==live.currentSuiteId || progressed.state==="COMPLETE")) return progressed;
    return workspaces.updateNamedPipelineRun(live.id, {
      state: suiteRun.state,
      currentSuiteId: live.currentSuiteId,
      currentSuiteRunId: suiteRun.id,
      endedAt: null,
      stopReason: suiteRun.stopReason,
      // Suite resume clears the park reason; copy it or the named run keeps a
      // stale continuations_exhausted while already PLAYING.
      waitReason: suiteRun.waitReason,
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
  // Refuse before creating a run that would only record itself COMPLETE.
  if (pipeline.stages.every((stage) => namedStageFinished(pipelineId, stage.suiteId))) {
    throw new WorkspaceError(422, "nothing_ready", "Every station on this pipeline is already finished.");
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
 * Restarts a pipeline parked on a station a human has just resolved — answered,
 * skipped, or marked complete. Only a rail actually waiting on *this* station
 * moves; anything else is left exactly as it is. `advance` starts an answered
 * station again because its status is TODO, while terminal stations move on.
 */
async function resumeAfterHumanResolution(promptId: number): Promise<void> {
  const home = workspaces.promptHome(promptId);
  await enqueue(home.workspaceId, async () => {
    const active = workspaces.activePipeline(home.suiteId);
    const pipeline = active ?? workspaces.latestPipeline(home.suiteId);
    const parked = pipeline?.state === "WAITING_HUMAN";
    const restartInterrupted = pipeline?.state === "INTERRUPTED"
      && pipeline.stopReason === "server_restart"
      && pipeline.waitReason === "human_question";
    if (
      pipeline === null
      || (!parked && !restartInterrupted)
      || pipeline.currentPromptId !== promptId
    ) return;
    // Do not revive an older interrupted rail underneath a newer owner of the
    // same workspace. A normal WAITING_HUMAN rail is itself that owner.
    const owner = workspaces.activePipelineForWorkspace(home.workspaceId);
    if (owner !== null && owner.id !== pipeline.id) return;
    const playing = workspaces.updatePipelineRun(pipeline.id, { state: "PLAYING", stopReason: null, waitReason: null, endedAt: null });
    if (restartInterrupted && playing.pipelineRunId !== null) {
      const parent = workspaces.namedPipelineRunById(playing.pipelineRunId);
      if (parent?.state === "INTERRUPTED" && parent.stopReason === "server_restart") {
        workspaces.updateNamedPipelineRun(parent.id, {
          state: "PLAYING",
          stopReason: null,
          waitReason: null,
          endedAt: null,
        });
      }
    }
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
 * Act on the post-continuation audit. Every verdict tries to close the station.
 * Command checks still have to pass. A human-review check is waived and is not
 * recorded as passed. A refused close parks `continuations_exhausted`. Runs
 * inside the workspace queue.
 */
async function settleAudit(args: {
  promptId: number;
  sourceRunId: string;
  verdict: CompletionVerdict | null;
  verificationSummary?: string;
  report?: CompletionAuditReport | null;
  auditId?: string | null;
}): Promise<boolean> {
  const releaseAudit=()=>{const audit=args.auditId?workspaces.completionAuditById(args.auditId):null;if(audit?.auditRunId)releaseSupervisedRun(audit.auditRunId);};
  const home = workspaces.promptHome(args.promptId);
  const active = workspaces.activePipeline(home.suiteId);
  const contract=executionStore.forPrompt(args.promptId);
  if(contract?.engine==="supervised") {
    if(workspaces.latestExecuteRunId(args.promptId)!==args.sourceRunId) return false;
    if(args.auditId) {
      const audit=workspaces.completionAuditById(args.auditId),effect=audit?.auditRunId?executionStore.byRun(audit.auditRunId):null;
      if(effect && effect.generation!==contract.generation) return false;
    }
  }
  // Only a run parked on this exact station for the post-N review may be moved.
  const parked = active !== null
    && active.state === "WAITING_HUMAN"
    && active.currentPromptId === args.promptId
    && (active.waitReason === "review_running" || (contract?.engine==="supervised" && contract.desired==="RUNNING"));

  if (args.verdict === "COMPLETE" || args.verdict === "INCOMPLETE" || args.verdict === "UNVERIFIABLE" || args.verdict === null) {
    try {
      const { runDefinitionOfDoneCommands } = await import("../verification/definitionOfDone.ts");
      const adopted=executionStore.forPrompt(args.promptId);
      if(adopted?.engine!=="supervised") await runDefinitionOfDoneCommands(args.promptId, args.sourceRunId);
      const waived = args.verdict !== "COMPLETE";
      const postedSummary = (args.verificationSummary ?? "").trim();
      const verificationSummary = postedSummary !== ""
        ? postedSummary
        : waived
          ? "Human-review checks were waived."
          : "A read-only completion audit found the command checks satisfied.";
      let written = workspaces.completePrompt(args.promptId, "SYSTEM", {
        reason: waived
          ? "The pipeline does not stop for a human review or an unobserved check. Command checks still have to pass. Waived checks were not recorded as passed."
          : AUDIT_COMPLETE_REASON,
        verificationSummary,
      });
      if(written==="DONE" && !acceptSupervisedUnit(args.promptId)) {
        workspaces.refuseSupervisedCompletion(args.promptId,"Completion evidence is missing or stale");written="NEEDS_REVIEW";
      }
      if (written === "DONE") {
        releaseAudit();
        log.info(`audit closed station suite=${home.suiteId} prompt=${args.promptId}`);
        if (parked) {
          const playing = workspaces.updatePipelineRun(active.id, { state: "PLAYING", stopReason: null, waitReason: null, endedAt: null });
          await syncNamedFromSuite(playing);
          const live = workspaces.pipelineById(playing.id);
          if (live !== null) await advance(live);
        }
        return true;
      }
      log.info(`audit close refused by the definition of done suite=${home.suiteId} prompt=${args.promptId}`);
    } catch (error) {
      log.warn(`audit close could not be applied prompt=${args.promptId}`, error);
    }
  }

  releaseAudit();
  if (!parked) return false;
  const adopted=executionStore.forPrompt(args.promptId);
  if(adopted?.engine==="supervised" && adopted.desired==="RUNNING") {
    const playing=workspaces.updatePipelineRun(active.id,{state:"PLAYING",waitReason:null,stopReason:null,endedAt:null});
    workspaces.queueContinuation(args.promptId,{attempt:Math.min(executionStore.unitUsage(adopted.id,args.promptId).workers+1,adopted.policy.unitAttempts),of:adopted.policy.unitAttempts,cause:"Reviewer found remaining work; repair from the recorded criterion evidence",previousRunId:args.sourceRunId,writeSystemRemark:true});
    await startCurrentStation(playing,args.promptId,{onExhausted:"park"});return false;
  }
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
    const station=named.currentSuiteRunId ? workspaces.pipelineById(named.currentSuiteRunId)?.currentPromptId : null;
    const contract=station?executionStore.forPrompt(station):null;
    if(settings.pipelinePolicy.onRestart!=="autoResume" && !(contract?.engine==="supervised"&&contract.desired==="RUNNING")) continue;
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
    const contract=suiteRun.currentPromptId?executionStore.forPrompt(suiteRun.currentPromptId):null;
    if(settings.pipelinePolicy.onRestart!=="autoResume" && !(contract?.engine==="supervised"&&contract.desired==="RUNNING")) continue;
    try {
      await enqueue(suiteRun.workspaceId, () => resumeInterruptedSuite(suiteRun));
    } catch (error) {
      log.warn(`auto-resume failed pipeline=${suiteRun.id}`, error);
    }
  }
}

export const pipelineScheduler = {
  async wakeDue():Promise<void> {
    if(currentLockMode()!=="serve" || runHub.isClosing()) return;
    for(const wake of executionStore.dueWakes()) {
      const c=executionStore.contract(wake.contractId);
      if(c.desired!=="RUNNING") continue;
      const pipeline=workspaces.pipelineById(wake.pipelineId);
      if(!pipeline || pipeline.state!=="WAITING_HUMAN") {executionStore.clearWake(c.id);continue;}
      if(Date.now()>=c.policy.deadline) {executionStore.clearWake(c.id);executionStore.decision(c.id,"execution_exception",{reason:"delivery_deadline",promptId:wake.promptId});continue;}
      const resourceWait=wake.reason==="execution:resource_busy" || wake.reason==="execution:writer_uncertain" || wake.reason==="start_refused:git_repository_busy";
      if(resourceWait && executionStore.writerOwner(repositoryResource(workspaces.get(pipeline.workspaceId).workDirectory))!==null) {executionStore.scheduleWake(c.id,pipeline.id,wake.promptId,Date.now()+15000,wake.reason);continue;}
      const providers=await detectProviders(true);
      const rule=workspaces.pipelineRule(wake.promptId,namedPipelineIdFor(pipeline));
      const defaults=workspaces.suitePipelineDefaults(pipeline.suiteId,namedPipelineIdFor(pipeline));
      const primary=rule.provider ?? defaults.defaultProvider ?? pipeline.playProvider;
      const allowed=autoReassignFor(pipeline)?[primary,...resolveFallbackProviders({rule,suiteFallbackProviders:defaults.defaultFallbackProviders})]:[primary];
      const available=providers.some(p=>allowed.includes(p.id)&&p.available&&!isCooling(p.id));
      if(!available) {executionStore.scheduleWake(c.id,pipeline.id,wake.promptId,Date.now()+60000,wake.reason);continue;}
      await enqueue(pipeline.workspaceId,async()=>{
        const live=workspaces.pipelineById(pipeline.id);
        if(live?.state!=="WAITING_HUMAN" || executionStore.contract(c.id).desired!=="RUNNING") return;
        executionStore.clearWake(c.id);
        workspaces.requeueTechnicalWait(wake.promptId,"Provider availability was restored; retrying automatically inside the original allowance");
        const playing=workspaces.updatePipelineRun(live.id,{state:"PLAYING",waitReason:null,stopReason:null,endedAt:null});
        const outcome=workspaces.promptOutcome(wake.promptId);
        if(outcome.status==="DONE" || outcome.status==="SKIPPED") await advance(playing);
        else await startCurrentStation(playing,wake.promptId);
      });
    }
  },
  async onBudgetAmended(promptId:number):Promise<void> {
    const home=workspaces.promptHome(promptId),changed=executionStore.forPrompt(promptId);
    if(!changed) return;
    await enqueue(home.workspaceId,async()=>{
      const live=workspaces.activePipelineForWorkspace(home.workspaceId);
      if(!live || live.state!=="WAITING_HUMAN" || live.currentPromptId===null || !["execution:budget_exhausted","execution:recovery_exhausted","execution:recovery_required","execution:provider_change_limit"].includes(live.waitReason ?? ""))return;
      const current=executionStore.forPrompt(live.currentPromptId);
      if(!current || current.desired!=="RUNNING" || current.budgetScope!==changed.budgetScope)return;
      const playing=workspaces.updatePipelineRun(live.id,{state:"PLAYING",waitReason:null,stopReason:null,endedAt:null});
      workspaces.requeueTechnicalWait(live.currentPromptId,"The operator approved an additional allocation; historical usage and recovery history are retained");
      await startCurrentStation(playing,live.currentPromptId);
    });
  },
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
        if (result.interruptId !== null) {await cancelManagedCommands(result.interruptId);await runHub.stop(result.interruptId);}
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
    if (interruptId !== null) {await cancelManagedCommands(interruptId);await runHub.stop(interruptId);}
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
    if(!await settleSupervisedRun(args.runId,true)) {
      const owner=workspaces.pipelineByCurrentRun(args.runId);
      if(owner) await enqueue(args.workspaceId,()=>park(owner,args.promptId,"execution:writer_uncertain"));
      return;
    }
    const pointed = workspaces.pipelineByCurrentRun(args.runId);
    if (pointed === null) {releaseSupervisedRun(args.runId);return;}
    try {await enqueue(args.workspaceId, () => applyExecuteEnded(pointed, args.runId, args.promptId));}
    finally {releaseSupervisedRun(args.runId);}
  },

  /**
   * The post-continuation audit finished. COMPLETE closes and advances; any
   * other verdict (including a null one from a failed auditor) parks
   * `continuations_exhausted`.
   */
  async onAuditSettled(args: { promptId: number; sourceRunId: string; verdict: CompletionVerdict | null; verificationSummary?: string; report?: CompletionAuditReport | null; auditId?: string | null }): Promise<boolean> {
    const home = workspaces.promptHome(args.promptId);
    return enqueue(home.workspaceId,async()=>{try{return await settleAudit(args);}finally{const audit=args.auditId?workspaces.completionAuditById(args.auditId):null;if(audit?.auditRunId)releaseSupervisedRun(audit.auditRunId);}});
  },

  onPromptSkipped(promptId: number): Promise<void> {
    return resumeAfterHumanResolution(promptId);
  },

  /** The operator answered the question that parked this station. */
  onPromptResponded(promptId: number): Promise<void> {
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
