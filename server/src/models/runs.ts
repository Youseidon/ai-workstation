import type { RunHandle } from "../contracts/runs.ts";
import type { ProviderId, WorkspaceRecord, RunSource, RunRole, RunState, TokenUsage, NormalizedEvent } from "@hydra/shared";


export interface LiveRun {
  handle: RunHandle;
  runId: string;
  provider: ProviderId;
  model: string | null;
  workspace: Pick<WorkspaceRecord, "id" | "name" | "workDirectory">;
  clientRequestId?: string;
  source: RunSource;
  role: RunRole;
  permissionMode: string | null;
  state: RunState;
  startedAt: string;
  elapsedMs: number;
  usage: TokenUsage | null;
  detail: string | null;
  events: NormalizedEvent[];
  truncated: boolean;
}
