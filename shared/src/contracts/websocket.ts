import type { ProviderId, ProviderInfo, RunRole } from "./providers.ts";
import type { AgentInputAnswer, NormalizedEvent, RunState } from "./events.ts";
import type { WorkspaceRecord } from "./workspaces.ts";
import type { TokenUsage } from "../models/tokenUsage.ts";

export interface ClientRunMessage {
  kind: "run";
  clientRequestId?: string;
  provider: ProviderId;
  workspaceId: number;
  prompt?: string;
  promptId?: number;
  threadId?: string;
  freshContext?: boolean;
  resumeSessionId?: string;
  model?: string | null;
  mode?: "execute" | "clarify";
  question?: string;
  role?: RunRole;
}

export interface ClientInterruptMessage {
  kind: "interrupt";
  runId: string;
}

export interface ClientRefreshProvidersMessage {
  kind: "refresh_providers";
}

export interface ClientPingMessage {
  kind: "ping";
}

export interface ClientInputResponseMessage {
  kind: "input_response";
  runId: string;
  requestId: string;
  answers: Record<string, AgentInputAnswer>;
}

export interface ClientVerifySuiteMessage {
  kind: "verify_suite";
  suiteId: number;
  provider: ProviderId;
  model: string | null;
  promptId?: number | null;
}

export type ClientMessage =
  | ClientVerifySuiteMessage
  | ClientRunMessage
  | ClientInterruptMessage
  | ClientInputResponseMessage
  | ClientRefreshProvidersMessage
  | ClientPingMessage;

export interface ServerHelloMessage {
  kind: "hello";
  providers: ProviderInfo[];
  activeRuns: RunSnapshot[];
}

export interface ServerProvidersMessage {
  kind: "providers";
  providers: ProviderInfo[];
}

export interface ServerEventMessage {
  kind: "event";
  event: NormalizedEvent;
}

export type RunSource =
  | { type: "custom"; displayText: string; threadId?: string; title?: string }
  | { type: "saved"; promptId: number; promptKey: string | null; title: string; programName: string; suiteName: string }
  | { type: "clarification"; promptId: number; promptKey: string | null; title: string; question: string }
  | { type: "verification"; verificationId: number; suiteId: number; suiteKey: string | null; suiteName: string; promptKey: string | null }
  | { type: "consult"; promptId: number | null; promptKey: string | null; title: string | null; question: string }
  | { type: "wrapup"; promptId: number; promptKey: string | null; title: string; sourceRunId: string; stopReason: string | null }
  | { type: "audit"; auditId: string; promptId: number; promptKey: string | null; title: string; sourceRunId: string }
  | { type: "author"; draftId: number; goal: string; programName: string | null;  revision?: boolean }
  | { type: "instructions"; proposalId: number; file: string; goal: string };

export interface ServerRunStartedMessage {
  clientRequestId?: string;
  kind: "run_started";
  runId: string;
  provider: ProviderId;
  model: string | null;
  workspace: Pick<WorkspaceRecord, "id" | "name" | "workDirectory">;
  source: RunSource;
  role: RunRole;
}

export interface RunSnapshot {
  clientRequestId?: string;
  runId: string;
  provider: ProviderId;
  model: string | null;
  workspace: Pick<WorkspaceRecord, "id" | "name" | "workDirectory">;
  source: RunSource;
  role: RunRole;
  state: RunState;
  startedAt: string;
  elapsedMs: number;
  usage: TokenUsage | null;
  detail: string | null;
  events: NormalizedEvent[];
  truncated: boolean;
  permissionMode: string | null;
}

export interface ServerRunEndedMessage {
  kind: "run_ended";
  runId: string;
  state: Extract<RunState, "done" | "interrupted" | "error">;
}

export interface ServerRunRejectedMessage {
  kind: "run_rejected";
  clientRequestId: string;
  message: string;
  detail: string | null;
}

export interface ServerPongMessage {
  kind: "pong";
}

export interface ServerSettingsUpdatedMessage {
  kind: "settings_updated";
  providers: ProviderInfo[];
}

export interface ServerOperationsChangedMessage {
  kind: "operations_changed";
}

export type ServerMessage =
  | ServerHelloMessage
  | ServerProvidersMessage
  | ServerEventMessage
  | ServerRunStartedMessage
  | ServerRunEndedMessage
  | ServerRunRejectedMessage
  | ServerSettingsUpdatedMessage
  | ServerOperationsChangedMessage
  | ServerPongMessage;
