import { runHub } from "./runHub.ts";

export const activeRuns = {
  has(runId: string): boolean {
    return runHub.has(runId);
  },
  stop(runId: string): Promise<boolean> {
    return runHub.stop(runId);
  },
};
