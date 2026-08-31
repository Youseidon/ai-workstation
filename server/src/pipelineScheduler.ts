import { isProviderId, type PipelineRun, type PromptPipelineRule, type ProviderId, type SuitePipelineRun } from "@agent-console/shared";
import { getAdapter } from "./adapters/registry.ts";
import { newId } from "./lib/ids.ts";
import { createLogger } from "./lib/logger.ts";
import { runHub } from "./runHub.ts";
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

function processFailureBlocked(result: string): boolean {
  return result.startsWith("Agent process ended") || result.startsWith("No active agent run");
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
      endedAt: null,
      currentSuiteId: suiteRun.suiteId,
      currentSuiteRunId: suiteRun.id,
    });
  }
}

async function startCurrentStation(pipeline: SuitePipelineRun, promptId: number): Promise<SuitePipelineRun> {
  const live = workspaces.pipelineById(pipeline.id) ?? pipeline;
  const rule = workspaces.pipelineRule(promptId);
  const defaults = workspaces.suitePipelineDefaults(live.suiteId);
  const target = resolveExecuteTarget({
    recovering: live.recovering,
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

async function advance(pipeline: SuitePipelineRun): Promise<SuitePipelineRun> {
  const live = workspaces.pipelineById(pipeline.id) ?? pipeline;
  const ready = workspaces.readyPromptsInSuite(live.workspaceId, live.suiteId);
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
    return startCurrentStation(updated, next.id);
  }
  const unfinished = workspaces.remainingPipelinePromptIds(live.suiteId).filter((promptId) => {
    const status=workspaces.promptOutcome(promptId).status;
    return status !== "DONE" && status !== "SKIPPED";
  });
  if (unfinished.length > 0) return terminate(live, "STOPPED", "blocked_on_dependencies");
  return terminate(live, "COMPLETE", null);
}

async function applyOnDone(pipeline: SuitePipelineRun, rule: PromptPipelineRule): Promise<SuitePipelineRun> {
  if (rule.onDone === "stop") return terminate(pipeline, "STOPPED", "on_done_stop");
  if (rule.onDone === "skip_rest") {
    for (const promptId of workspaces.remainingPipelinePromptIds(pipeline.suiteId)) {
      const status=workspaces.promptOutcome(promptId).status;
      if (status === "DONE" || status === "SKIPPED") continue;
      workspaces.skipPrompt(promptId, "SYSTEM", "Pipeline skip_rest");
    }
    return terminate(pipeline, "STOPPED", "skip_rest");
  }
  return advance(pipeline);
}

async function applyOnBlocked(pipeline: SuitePipelineRun, rule: PromptPipelineRule, promptId: number, result: string): Promise<SuitePipelineRun> {
  if (rule.onBlocked === "wait") {
    log.info(`wait suite=${pipeline.suiteId} prompt=${promptId}`);
    const updated = workspaces.updatePipelineRun(pipeline.id, { state: "WAITING_HUMAN", currentRunId: null, stopReason: null, endedAt: null });
    await syncNamedFromSuite(updated);
    return updated;
  }
  if (rule.onBlocked === "retry") {
    if (pipeline.attempt < rule.retryLimit) {
      const attempt = pipeline.attempt + 1;
      log.info(`retry ${attempt}/${rule.retryLimit} suite=${pipeline.suiteId} prompt=${promptId}`);
      workspaces.resetPromptToTodo(promptId, `pipeline retry ${attempt}/${rule.retryLimit}`);
      const updated = workspaces.updatePipelineRun(pipeline.id, { attempt, recovering: false, currentPromptId: promptId, currentRunId: null });
      if (updated.state === "PAUSED") return updated;
      return startCurrentStation(updated, promptId);
    }
    if (processFailureBlocked(result)) return terminate(pipeline, "STOPPED", "retry_exhausted");
    log.info(`retry_exhausted waiting suite=${pipeline.suiteId} prompt=${promptId}`);
    const waiting = workspaces.updatePipelineRun(pipeline.id, { state: "WAITING_HUMAN", currentRunId: null, stopReason: "retry_exhausted", endedAt: null });
    await syncNamedFromSuite(waiting);
    return waiting;
  }
  if (rule.onBlocked === "recover") {
    if (!pipeline.recovering) {
      log.info(`recover suite=${pipeline.suiteId} prompt=${promptId}`);
      workspaces.resetPromptToTodo(promptId, "pipeline recover");
      const updated = workspaces.updatePipelineRun(pipeline.id, {
        recovering: true,
        attempt: pipeline.attempt + 1,
        currentPromptId: promptId,
        currentRunId: null,
      });
      if (updated.state === "PAUSED") return updated;
      return startCurrentStation(updated, promptId);
    }
    log.info(`recover_exhausted suite=${pipeline.suiteId} prompt=${promptId}`);
    return terminate(pipeline, "STOPPED", "recover_exhausted");
  }
  workspaces.skipPrompt(promptId, "SYSTEM", "Pipeline skipped this station after it blocked.");
  return advance(pipeline);
}

async function applyExecuteEnded(pipeline: SuitePipelineRun, runId: string, promptId: number): Promise<void> {
  const live = workspaces.pipelineById(pipeline.id);
  if (live === null || (live.state !== "PLAYING" && live.state !== "PAUSED")) return;
  if (live.currentRunId !== runId) return;
  workspaces.updatePipelineRun(live.id, { currentRunId: null });
  const posted = workspaces.promptOutcome(promptId);
  const rule = ruleByRun.get(runId) ?? workspaces.pipelineRule(promptId);
  ruleByRun.delete(runId);
  if (posted.status === "DONE") {
    await applyOnDone(live, rule);
    return;
  }
  if (posted.status === "BLOCKED") {
    await applyOnBlocked(live, rule, promptId, posted.result);
    return;
  }
  if (posted.status === "SKIPPED") {
    await advance(live);
    return;
  }
  await terminate(live, "STOPPED", `unexpected_status:${posted.status}`);
}

async function resume(pipeline: SuitePipelineRun, playProvider: ProviderId | null | undefined, playModel: string | null | undefined): Promise<SuitePipelineRun> {
  const patch: { state: "PLAYING"; playProvider?: ProviderId | null; playModel?: string | null; endedAt: null; stopReason: null } = {
    state: "PLAYING",
    endedAt: null,
    stopReason: null,
  };
  if (playProvider !== undefined) patch.playProvider = playProvider;
  if (playModel !== undefined) patch.playModel = playModel;
  const live = workspaces.updatePipelineRun(pipeline.id, patch);
  await syncNamedFromSuite(live);
  if (live.currentRunId !== null && runHub.has(live.currentRunId)) return live;
  if (live.currentPromptId !== null) {
    const ready = workspaces.readyPromptsInSuite(live.workspaceId, live.suiteId);
    if (ready.some((prompt) => prompt.id === live.currentPromptId)) {
      return startCurrentStation(live, live.currentPromptId);
    }
  }
  return advance(live);
}

async function playSuiteUnlocked(suiteId: number, body: Record<string, unknown> = {}): Promise<SuitePipelineRun> {
  const suite = workspaces.suiteHeader(suiteId);
  const workspace = workspaces.get(suite.workspaceId);
  if (!workspace.workDirectoryExists) {
    throw new WorkspaceError(422, "invalid_directory", `Workspace directory does not exist: ${workspace.workDirectory}`);
  }
  if (workspaces.enabledPipelineSteps(suiteId).length === 0) {
    throw new WorkspaceError(422, "empty_pipeline", "Add work items to this suite's flowchart before playing");
  }
  const playProvider = optionalPlayProvider(body, "provider", "provider" in body) as ProviderId | null | undefined;
  const playModel = optionalPlayProvider(body, "model", "model" in body) as string | null | undefined;
  const namedRunId = optionalNamedPipelineRunId(body);
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
        const ready = currentId === null ? false : workspaces.readyPromptsInSuite(suite.workspaceId, suiteId).some((prompt) => prompt.id === currentId);
        if (!ready) throw new WorkspaceError(422, "prompt_not_ready", "The waiting station is not ready to resume");
      }
      log.info(`resume suite=${suiteId} from=${active.state}`);
      return resume(active, playProvider, playModel);
    }
  }
  if (owner !== null && owner.suiteId !== suiteId) {
    throw new WorkspaceError(409, "workspace_busy", "Another suite pipeline already owns this workspace.");
  }
  if (workspaces.readyPromptsInSuite(suite.workspaceId, suiteId).length === 0) {
    throw new WorkspaceError(422, "nothing_ready", "Nothing on the flowchart is ready to play");
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
  return advance(created);
}

async function pauseSuiteUnlocked(suiteId: number): Promise<SuitePipelineRun> {
  const active = workspaces.activePipeline(suiteId);
  if (active === null || active.state !== "PLAYING") {
    throw new WorkspaceError(409, "pipeline_not_playing", "Pause requires a playing pipeline");
  }
  log.info(`pause suite=${suiteId}`);
  const updated = workspaces.updatePipelineRun(active.id, { state: "PAUSED" });
  await syncNamedFromSuite(updated);
  return updated;
}

async function stopSuiteUnlocked(suiteId: number): Promise<{ stopped: SuitePipelineRun; interruptId: string | null }> {
  const active = workspaces.activePipeline(suiteId);
  if (active === null) throw new WorkspaceError(409, "pipeline_not_active", "No active pipeline to stop");
  const interruptId = active.currentRunId;
  log.info(`stop suite=${suiteId}`);
  const stopped = workspaces.updatePipelineRun(active.id, {
    state: "STOPPED",
    stopReason: "operator_stop",
    endedAt: new Date().toISOString(),
    currentRunId: null,
  });
  await syncNamedFromSuite(stopped);
  return { stopped, interruptId };
}

async function startNextNamedStage(named: PipelineRun): Promise<PipelineRun> {
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
  const active = workspaces.activeNamedPipelineRun(pipelineId);
  if (active !== null) {
    if (active.state === "PLAYING") {
      throw new WorkspaceError(409, "pipeline_active", "This pipeline is already playing");
    }
    const patch: { playProvider?: ProviderId | null; playModel?: string | null } = {};
    if (playProvider !== undefined) patch.playProvider = playProvider;
    if (playModel !== undefined) patch.playModel = playModel;
    const live = Object.keys(patch).length > 0 ? workspaces.updateNamedPipelineRun(active.id, patch) : active;
    if (live.currentSuiteId === null) return startNextNamedStage(live);
    log.info(`named-resume pipeline=${pipelineId} from=${live.state} suite=${live.currentSuiteId}`);
    const suiteBody: Record<string, unknown> = { pipelineRunId: live.id };
    if (live.playProvider !== null) suiteBody.provider = live.playProvider;
    if (live.playModel !== null) suiteBody.model = live.playModel;
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
  return startNextNamedStage(created);
}

export const pipelineScheduler = {
  async play(suiteId: number, body: Record<string, unknown> = {}): Promise<SuitePipelineRun> {
    const suite = workspaces.suiteHeader(suiteId);
    return enqueue(suite.workspaceId, () => playSuiteUnlocked(suiteId, body));
  },

  async pause(suiteId: number): Promise<SuitePipelineRun> {
    const suite = workspaces.suiteHeader(suiteId);
    return enqueue(suite.workspaceId, () => pauseSuiteUnlocked(suiteId));
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
        await pauseSuiteUnlocked(active.currentSuiteId);
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
    const pointed = workspaces.pipelineByCurrentRun(args.runId);
    if (pointed === null) return;
    await enqueue(args.workspaceId, () => applyExecuteEnded(pointed, args.runId, args.promptId));
  },

  async onPromptSkipped(promptId: number): Promise<void> {
    const home = workspaces.promptHome(promptId);
    await enqueue(home.workspaceId, async () => {
      const active = workspaces.activePipeline(home.suiteId);
      if (active === null || active.state !== "WAITING_HUMAN" || active.currentPromptId !== promptId) return;
      const playing = workspaces.updatePipelineRun(active.id, { state: "PLAYING", stopReason: null, endedAt: null });
      await syncNamedFromSuite(playing);
      const live = workspaces.pipelineById(playing.id);
      if (live === null) return;
      await advance(live);
    });
  },
};
