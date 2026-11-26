import type { ProviderId, RunRole, RunState, TokenUsage, WorkspaceRecord, RunSource, AgentInputRequestPayload } from "@hydra/shared";

export type ConnectionState = "connecting" | "open" | "disconnected";

export interface RunStatus {
  runId: string;
  provider: ProviderId;
  /** The model this run resolved to on the server, not the current selection. */
  model: string | null;
  role: RunRole;
  permissionMode: string | null;
  state: RunState;
  elapsedMs: number;
  /** Server timestamp accompanying the last elapsed sample, for waiting clocks. */
  clockAt?: string;
  usage: TokenUsage | null;
  detail: string | null;
  workspace: Pick<WorkspaceRecord, "id" | "name" | "workDirectory">;
  source: RunSource;
  startedAt: string;
}

export interface PendingLaunch {
  requestId: string;
  tabId: string;
  role: RunRole;
  prompt: string;
  provider?: ProviderId;
  model?: string | null;
  workspaceId?: number;
}

export interface PendingAgentInput extends AgentInputRequestPayload {
  runId: string;
  requestedAt?: string;
}
