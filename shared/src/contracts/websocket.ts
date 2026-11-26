import type { ProviderId, ProviderInfo, RunRole } from "./providers.ts";
import type { AgentInputAnswer, NormalizedEvent, RunState } from "./events.ts";
import type { WorkspaceRecord } from "./workspaces.ts";
import type { TokenUsage } from "../models/tokenUsage.ts";

/* -------------------------------------------------------------------------- */
/* WebSocket protocol                                                          */
/* -------------------------------------------------------------------------- */

export interface ClientRunMessage {
  kind: "run";
  /** Browser-local correlation id used to return a rejected launch to its tab. */
  clientRequestId?: string;
  provider: ProviderId;
  workspaceId: number;
  /** Exactly one of prompt and promptId must be supplied. */
  prompt?: string;
  promptId?: number;
  /**
   * App-owned conversation id shared by every custom execute turn in one Chat
   * tab. Unlike resumeSessionId, this remains stable when the provider changes.
   */
  threadId?: string;
  freshContext?: boolean;
  /**
   * Provider-owned conversation id to continue for a custom chat turn.
   * Only valid with `prompt` on an execute run; saved work items and consults
   * deliberately keep their own independent lifecycle.
   */
  resumeSessionId?: string;
  /**
   * Per-run model override. `null` (or omitted) falls back to the provider's
   * configured model in settings, so switching models in the header never
   * rewrites saved configuration.
   */
  model?: string | null;
  /** Ask about a blocked work item without reopening or executing it. */
  mode?: "execute" | "clarify";
  question?: string;
  /** Default "execute". Unknown values are a malformed frame. */
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

/**
 * Starts an agent verification of a whole suite.
 *
 * Server-initiated on purpose: the browser used to build the dossier itself and
 * fire it as an anonymous custom prompt, which is why the run was never
 * recorded and its report was lost the moment the page changed.
 */
export interface ClientVerifySuiteMessage {
  kind: "verify_suite";
  suiteId: number;
  provider: ProviderId;
  model: string | null;
  /** When set, verify only this work item inside the suite. */
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
  /** Every run in flight right now, with its transcript, for replay. */
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

/** What a run was asked to do. Named, because a run snapshot carries it too. */
export type RunSource =
  | { type: "custom"; displayText: string; threadId?: string; title?: string }
  | { type: "saved"; promptId: number; promptKey: string | null; title: string; programName: string; suiteName: string }
  | { type: "clarification"; promptId: number; promptKey: string | null; title: string; question: string }
  | { type: "verification"; verificationId: number; suiteId: number; suiteKey: string | null; suiteName: string; promptKey: string | null }
  | { type: "consult"; promptId: number | null; promptKey: string | null; title: string | null; question: string }
  | { type: "wrapup"; promptId: number; promptKey: string | null; title: string; sourceRunId: string; stopReason: string | null }
  | { type: "audit"; auditId: string; promptId: number; promptKey: string | null; title: string; sourceRunId: string }
  | { type: "author"; draftId: number; goal: string; programName: string | null; /** True when changing an existing program. */ revision?: boolean }
  /** An agent editing CLAUDE.md or AGENTS.md into a proposal the operator applies. */
  | { type: "instructions"; proposalId: number; file: string; goal: string };

export interface ServerRunStartedMessage {
  clientRequestId?: string;
  kind: "run_started";
  runId: string;
  provider: ProviderId;
  /** The model the run resolved to, after the override/settings fallback. */
  model: string | null;
  workspace: Pick<WorkspaceRecord, "id" | "name" | "workDirectory">;
  source: RunSource;
  role: RunRole;
}

/**
 * A run as the server currently sees it, including every event it has emitted.
 *
 * Runs belong to the server, not to the socket that started them. This is what
 * lets a page opened mid-run — a new tab, a reload, or a navigation to another
 * page in the app — rebuild the transcript and the live status instead of
 * showing an empty log and claiming the agent is idle.
 */
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
  /** Replay buffer, oldest first. */
  events: NormalizedEvent[];
  /** True when the buffer overflowed and the oldest events were dropped. */
  truncated: boolean;
  /**
   * Forced permission/sandbox the process actually started with, for the
   * status bar. Null means "inherited global settings".
   */
  permissionMode: string | null;
}

export interface ServerRunEndedMessage {
  kind: "run_ended";
  runId: string;
  state: Extract<RunState, "done" | "interrupted" | "error">;
}

/** A run request failed before a run id existed. Sent only to its requesting socket. */
export interface ServerRunRejectedMessage {
  kind: "run_rejected";
  clientRequestId: string;
  message: string;
  detail: string | null;
}

export interface ServerPongMessage {
  kind: "pong";
}

/** Broadcast to every tab when provider settings change, so open panels stay in sync. */
export interface ServerSettingsUpdatedMessage {
  kind: "settings_updated";
  providers: ProviderInfo[];
}

/**
 * Tells snapshot-backed views that durable operational data changed.
 *
 * The frame deliberately carries no partial record: the REST snapshot remains
 * the single projection of the database, while the socket makes refreshing it
 * event-driven instead of periodic.
 */
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
