import { isProviderId, type PromptPipelineRule, type ProviderId, type SuitePipelineRun } from "@agent-console/shared";
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

function terminate(pipeline: SuitePipelineRun, state: "COMPLETE" | "STOPPED", stopReason: string | null): SuitePipelineRun {
  log.info(`${state.toLowerCase()} suite=${pipeline.suiteId} reason=${stopReason ?? "none"}`);
  return workspaces.updatePipelineRun(pipeline.id, {
    state,
    stopReason,
    endedAt: new Date().toISOString(),
    currentRunId: null,
  });
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
    terminate(live, "STOPPED", "no_provider");
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
    return workspaces.updatePipelineRun(live.id, { currentPromptId: promptId, currentRunId: runId });
  } catch (error) {
    terminate(live, "STOPPED", "start_failed");
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
  const unfinished = workspaces.suitePromptRows(live.suiteId).filter((row) => row.status !== "DONE" && row.status !== "SKIPPED");
  if (unfinished.length > 0) return terminate(live, "STOPPED", "blocked_on_dependencies");
  return terminate(live, "COMPLETE", null);
}

async function applyOnDone(pipeline: SuitePipelineRun, rule: PromptPipelineRule): Promise<SuitePipelineRun> {
  if (rule.onDone === "stop") return terminate(pipeline, "STOPPED", "on_done_stop");
  if (rule.onDone === "skip_rest") {
    for (const row of workspaces.suitePromptRows(pipeline.suiteId)) {
      if (row.status === "DONE" || row.status === "SKIPPED") continue;
      workspaces.skipPrompt(row.id, "SYSTEM", "Pipeline skip_rest");
    }
    return terminate(pipeline, "STOPPED", "skip_rest");
  }
  return advance(pipeline);
}

async function applyOnBlocked(pipeline: SuitePipelineRun, rule: PromptPipelineRule, promptId: number, result: string): Promise<SuitePipelineRun> {
  if (rule.onBlocked === "wait") {
    log.info(`wait suite=${pipeline.suiteId} prompt=${promptId}`);
    return workspaces.updatePipelineRun(pipeline.id, { state: "WAITING_HUMAN", currentRunId: null, stopReason: null, endedAt: null });
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
    return workspaces.updatePipelineRun(pipeline.id, { state: "WAITING_HUMAN", currentRunId: null, stopReason: "retry_exhausted", endedAt: null });
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
  terminate(live, "STOPPED", `unexpected_status:${posted.status}`);
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
  if (live.currentRunId !== null && runHub.has(live.currentRunId)) return live;
  if (live.currentPromptId !== null) {
    const ready = workspaces.readyPromptsInSuite(live.workspaceId, live.suiteId);
    if (ready.some((prompt) => prompt.id === live.currentPromptId)) {
      return startCurrentStation(live, live.currentPromptId);
    }
  }
  return advance(live);
}

export const pipelineScheduler = {
  async play(suiteId: number, body: Record<string, unknown> = {}): Promise<SuitePipelineRun> {
    const suite = workspaces.suiteHeader(suiteId);
    const workspace = workspaces.get(suite.workspaceId);
    if (!workspace.workDirectoryExists) {
      throw new WorkspaceError(422, "invalid_directory", `Workspace directory does not exist: ${workspace.workDirectory}`);
    }
    if (workspaces.suitePromptCount(suiteId) === 0) {
      throw new WorkspaceError(422, "empty_suite", "Suite has no work items to play");
    }
    const playProvider = optionalPlayProvider(body, "provider", "provider" in body) as ProviderId | null | undefined;
    const playModel = optionalPlayProvider(body, "model", "model" in body) as string | null | undefined;
    return enqueue(suite.workspaceId, async () => {
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
        throw new WorkspaceError(422, "nothing_ready", "Nothing is ready to play");
      }
      const created = workspaces.createPipelineRun({
        id: newId("pipe"),
        suiteId,
        workspaceId: suite.workspaceId,
        playProvider: playProvider === undefined ? null : playProvider,
        playModel: playModel === undefined ? null : playModel,
      });
      log.info(`play suite=${suiteId} pipeline=${created.id}`);
      return advance(created);
    });
  },

  async pause(suiteId: number): Promise<SuitePipelineRun> {
    const suite = workspaces.suiteHeader(suiteId);
    return enqueue(suite.workspaceId, async () => {
      const active = workspaces.activePipeline(suiteId);
      if (active === null || active.state !== "PLAYING") {
        throw new WorkspaceError(409, "pipeline_not_playing", "Pause requires a playing pipeline");
      }
      log.info(`pause suite=${suiteId}`);
      return workspaces.updatePipelineRun(active.id, { state: "PAUSED" });
    });
  },

  async stop(suiteId: number): Promise<SuitePipelineRun> {
    const suite = workspaces.suiteHeader(suiteId);
    let interruptId: string | null = null;
    const stopped = await enqueue(suite.workspaceId, async () => {
      const active = workspaces.activePipeline(suiteId);
      if (active === null) throw new WorkspaceError(409, "pipeline_not_active", "No active pipeline to stop");
      interruptId = active.currentRunId;
      log.info(`stop suite=${suiteId}`);
      return workspaces.updatePipelineRun(active.id, {
        state: "STOPPED",
        stopReason: "operator_stop",
        endedAt: new Date().toISOString(),
        currentRunId: null,
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
      workspaces.updatePipelineRun(active.id, { state: "PLAYING", stopReason: null, endedAt: null });
      const live = workspaces.pipelineById(active.id);
      if (live === null) return;
      await advance(live);
    });
  },
};
