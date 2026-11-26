import { runHub } from "./runHub.ts";

/**
 * The liveness view of running agents, for callers that only need to ask "is
 * this run still going?" or "stop it".
 *
 * This is a thin face over `runHub`, which is the single registry of live runs.
 * Keeping one registry matters: a second, separately-maintained map would
 * eventually disagree about whether a run is active, and `processActive` on a
 * prompt is what decides whether the UI offers "recover" or "stop".
 */
export const activeRuns = {
  has(runId: string): boolean {
    return runHub.has(runId);
  },
  stop(runId: string): Promise<boolean> {
    return runHub.stop(runId);
  },
};
