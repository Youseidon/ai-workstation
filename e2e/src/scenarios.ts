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

export async function waitForRunEnd(task: SavedTask, runId: string, timeoutMs = 60_000) {
  return eventually(`run ${runId} to end`, async () => {
    const session = (await state.sessionsFor(task)).find((item) => item.id === runId);
    return session && !["STARTING", "RUNNING"].includes(session.state.toUpperCase()) ? session : undefined;
  }, timeoutMs);
}
