import type { ProviderId, RunRole, RunState, TokenUsage, WorkspaceRecord, RunSource, AgentInputRequestPayload } from "@hydra/shared";

export type ConnectionState = "connecting" | "open" | "disconnected";

export interface RunStatus {
  runId: string;
  provider: ProviderId;
  model: string | null;
  role: RunRole;
  permissionMode: string | null;
  state: RunState;
  elapsedMs: number;
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
