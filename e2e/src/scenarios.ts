import type { HarnessEnvironment } from "./env/orchestrator.ts";
import type { FakeScenario } from "./drivers/fakeProvider.ts";
import { eventually, state, type SavedTask } from "./drivers/state.ts";

let sequence = 0;

/** Creates a saved task in a fresh git workspace, queues fake agent scenarios and starts one run. */
export async function runSavedTask(harness: HarnessEnvironment, args: { content?: string; scenarios: FakeScenario[]; title?: string }): Promise<{ task: SavedTask; runId: string }> {
  sequence += 1;
  const name = `task-${sequence}`;
  const task = await state.createSavedTask({ workDirectory: harness.createGitWorkspace(name), name, title: args.title ?? `Fixture task ${sequence}`, content: args.content ?? "Update the README with one line." });
  harness.fakeProvider.queue(...args.scenarios);
  const started = await state.startSavedTask(task, "grok");
  if ("error" in started) throw new Error(`run did not start: ${started.error}`);
  return { task, runId: started.runId };
}

/**
 * Builds a named pipeline over one suite and returns a `play` you can call.
 *
 * Steps used to hang off the suite (`/api/suites/:id/pipeline/steps`, `/play`).
 * They moved onto named pipelines, the old routes are gone, and a fixture that
 * still used them got a 404 in setup - which reads as "the scenario is broken",
 * not "the API moved". One helper so the next move has one place to land.
 */
export async function pipelineOverSuite(args: { workspaceId: number; suiteId: number; name: string; promptIds: number[]; provider?: string }) {
  const { pipeline } = await state.post<{ pipeline: { id: number } }>("/api/pipelines", {
    workspaceId: args.workspaceId,
    name: args.name,
    description: "",
    suiteIds: [args.suiteId],
  });
  const flowchart = `?suiteId=${args.suiteId}`;
  await state.patch(`/api/pipelines/${pipeline.id}/flowchart${flowchart}`, { defaultProvider: args.provider ?? "grok", defaultModel: null });
  for (const promptId of args.promptIds) {
    await state.post(`/api/pipelines/${pipeline.id}/flowchart/steps${flowchart}`, { promptId });
  }
  return { pipelineId: pipeline.id, play: () => state.post(`/api/pipelines/${pipeline.id}/play`, {}) };
}

export async function waitForRunEnd(task: SavedTask, runId: string, timeoutMs = 60_000) {
  const ended = await eventually(`run ${runId} to end`, async () => {
    const session = (await state.sessionsFor(task)).find((item) => item.id === runId);
    return session && !["STARTING", "RUNNING"].includes(session.state.toUpperCase()) ? session : undefined;
  }, timeoutMs);
  // Read it back from the run's own endpoint once it has ended: the list this
  // polls carries no transcript, so a scenario that asks what the agent emitted
  // would otherwise be told "nothing" and believe it.
  return state.session(ended.id);
}
