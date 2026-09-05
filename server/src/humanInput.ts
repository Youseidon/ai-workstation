import type { PromptRemark, ProviderId } from "@agent-console/shared";
import { isProviderId } from "@agent-console/shared";
import { pipelineScheduler } from "./pipelineScheduler.ts";
import { startExecute } from "./runService.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

export interface HumanResponseResult {
  responseId: number;
  started: boolean;
  runId: string | null;
  error?: string;
}

// Serialize double clicks and retries for a task, including the save/start boundary.
const pending = new Map<number, Promise<unknown>>();
export async function respondAndContinue(promptId: number, input: Record<string, unknown>): Promise<HumanResponseResult> {
  const previous = pending.get(promptId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => submit(promptId, input));
  pending.set(promptId, next);
  try { return await next; }
  finally { if (pending.get(promptId) === next) pending.delete(promptId); }
}

async function submit(promptId: number, input: Record<string, unknown>): Promise<HumanResponseResult> {
  if (!isProviderId(input.provider)) throw new WorkspaceError(422, "provider_required", "Choose an agent to continue.");
  if (input.model !== undefined && input.model !== null && typeof input.model !== "string") throw new WorkspaceError(422, "validation_error", "Model must be a string.");
  const activity = workspaces.promptActivity(promptId);
  const latestResponse = activity.remarks.find(entry => entry.kind === "HUMAN_RESPONSE");
  const content = typeof input.content === "string" ? input.content.trim() : "";
  let response: PromptRemark;
  if (input.responseId !== undefined) {
    if (!latestResponse || latestResponse.id !== input.responseId) throw new WorkspaceError(409, "response_changed", "This response is no longer current. Review the latest question.");
    response = latestResponse;
  } else if (latestResponse?.content === content && activity.item.operationalState !== "AWAITING_RESPONSE") {
    // Also recover when the browser lost the successful save response.
    response = latestResponse;
  } else {
    response = workspaces.respondToBlockedPrompt(promptId, { content });
  }
  const saved = { responseId: response.id, started: false, runId: null };
  if (workspaces.pendingHumanQuestion(promptId) !== null || workspaces.promptOutcome(promptId).status === "BLOCKED") {
    return { ...saved, error: "A new blocker needs attention. Review the latest question before continuing." };
  }
  // A replay must not execute a task twice, including after the first run finishes.
  const successor = activity.sessions.find(run => run.role === "execute" && run.startedAt >= response.createdAt);
  if (successor) return { ...saved, started: true, runId: successor.id };
  try {
    if (workspaces.pendingHumanQuestion(promptId) !== null || workspaces.promptOutcome(promptId).status !== "TODO") {
      throw new Error("A new blocker needs attention. Review the latest question before continuing.");
    }
    const { workspace, prompt } = activity.item;
    const active = workspaces.activePipeline(prompt.suiteId);
    const latest = workspaces.latestPipeline(prompt.suiteId);
    const owner = active ?? ((latest?.stopReason === "start_failed" || latest?.stopReason === "server_restart") ? latest : null);
    if (owner !== null) {
      if (owner.currentPromptId !== promptId) throw new Error("Another task owns this pipeline. Your answer is saved; resume it when that task finishes.");
      if (owner.pipelineRunId !== null) {
        const named = workspaces.namedPipelineRunById(owner.pipelineRunId);
        if (!named) throw new Error("The owning pipeline no longer exists.");
        const run = await pipelineScheduler.playNamed(named.pipelineId);
        const suiteRun = run.currentSuiteRunId === null ? null : workspaces.pipelineById(run.currentSuiteRunId);
        return { ...saved, started: true, runId: suiteRun?.currentRunId ?? null };
      }
      const run = await pipelineScheduler.play(prompt.suiteId);
      return { ...saved, started: true, runId: run.currentRunId };
    }
    const run = await startExecute({ workspaceId: workspace.id, promptId, provider: input.provider as ProviderId, model: (input.model as string | null | undefined) ?? null });
    return { ...saved, started: true, runId: run.runId };
  } catch (error) {
    return { ...saved, error: error instanceof Error ? error.message : String(error) };
  }
}
