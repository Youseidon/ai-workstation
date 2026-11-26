import type { TokenUsage } from "../models/tokenUsage.ts";
import type { ProviderId } from "./providers.ts";

/* -------------------------------------------------------------------------- */
/* Normalized event schema                                                     */
/* -------------------------------------------------------------------------- */

export type RunState = "starting" | "running" | "done" | "interrupted" | "error";

export interface AssistantTextPayload {
  /** Stable id of the text block this belongs to, so deltas can be appended. */
  blockId: string;
  /** When true, `text` is an incremental chunk to append to `blockId`. */
  delta: boolean;
  text: string;
  /** Reasoning/thinking output is rendered differently from final answer text. */
  kind: "message" | "thinking";
}

export interface ToolUsePayload {
  toolUseId: string;
  name: string;
  /** One-line human summary of the input, for the collapsed row. */
  summary: string;
  /** Full input, shown when the row is expanded. */
  input: unknown;
}

export interface ToolResultPayload {
  /** Links back to the `tool_use` event with the same id. */
  toolUseId: string;
  name: string | null;
  isError: boolean;
  /** One-line human summary of the output, for the collapsed row. */
  summary: string;
  /** Full output, shown when the row is expanded. */
  output: string;
  exitCode: number | null;
}

export interface StatusPayload {
  conversation?: { permissionKey: string; context: string; nativeSessionId?: string | null };
  state: RunState;
  elapsedMs: number;
  /** Null when the provider does not report usage (never a fabricated number). */
  usage: TokenUsage | null;
  detail: string | null;
  /**
   * The provider's own id for the conversation this run is having, the moment
   * the provider reveals it (or the id we assigned it up front). It rides a
   * status event rather than the result because the run that most needs it is
   * the one that never reaches a result: a budget stop interrupts the provider,
   * and the wrap-up turn can only resume the same session if the id was already
   * banked. Undefined on every status event that is not announcing one.
   */
  sessionId?: string | null;
}

export interface ResultPayload {
  state: Extract<RunState, "done" | "interrupted" | "error">;
  elapsedMs: number;
  usage: TokenUsage | null;
  /** Final assistant message, when the provider distinguishes one. */
  text: string | null;
  exitCode: number | null;
  /** Orchestrator-owned classification for a forced stop (budget/resource). */
  stopReason?: string | null;
  /** Peak bytes charged to the run cgroup, when systemd reports it. */
  peakMemoryBytes?: number | null;
}

export interface ErrorPayload {
  message: string;
  /** Fatal errors end the run; non-fatal ones are logged and the run continues. */
  fatal: boolean;
  detail: string | null;
}

interface EventBase {
  /** Unique per event, used as a React key. */
  id: string;
  runId: string;
  provider: ProviderId;
  /**
   * The model this run is actually using, or null when the provider was left on
   * its own default. Stamped by the runner so the log can label an entry with
   * the model that produced it, even after the selection has moved on.
   */
  model: string | null;
  /** ISO 8601. */
  timestamp: string;
}

/**
 * One trip an agent made to this app's database, through the only door it has.
 *
 * Synthesized server-side at the agent API's single route handler rather than
 * emitted by an adapter, so it covers every way an agent can reach the data —
 * a raw curl, the CLI shim, or a provider's own tool call — identically and
 * without each adapter having to cooperate.
 *
 * This exists because the operator could not previously see whether an agent
 * had talked to the app at all. A run that silently never posted looked exactly
 * like a run that posted and was ignored, and the difference decides whether to
 * distrust the agent or the app.
 */
export interface DbAccessPayload {
  /** Whether this read the app's state or changed it. */
  direction: "read" | "write";
  operation: "execution" | "check" | "plan" | "context" | "state" | "remarks" | "status" | "checkpoint" | "decompose" | "repair-verify" | "propose-program" | "propose-suite" | "revise-program" | "input" | "inbox" | "reply";
  method: string;
  /** Accepted, refused, or replayed from the idempotency ledger. */
  outcome: "accepted" | "rejected" | "replayed";
  httpStatus: number;
  durationMs: number;
  requestId: string | null;
  /** What actually happened, in a few words: "IN_PROGRESS → DONE". */
  summary: string;
  /** The tables this touched, so a write is never merely implied. */
  changed: string[];
  /** The server's own error code when it refused, e.g. stale_status. */
  errorCode: string | null;
}

export type AgentQuestionKind = "single" | "multiple" | "text";

export interface AgentQuestionOption {
  value: string;
  label: string;
  description: string | null;
}

/** One decision an agent cannot safely make on the operator's behalf. */
export interface AgentQuestion {
  id: string;
  prompt: string;
  kind: AgentQuestionKind;
  options: AgentQuestionOption[];
  required: boolean;
  recommendation: string | null;
  why: string | null;
}

export interface AgentInputRequestPayload {
  requestId: string;
  heading: string;
  questions: AgentQuestion[];
}

export type AgentInputAnswer = string | string[];

export interface AgentInputResponsePayload {
  requestId: string;
  answers: Record<string, AgentInputAnswer>;
}

/**
 * `/btw`: one message between the operator and a run that is already working.
 * `native` reached the provider's open input channel mid-turn; `inbox` waits
 * for the agent's next `agent-step` call; `resume` interrupted the run and
 * continues its provider session with the message.
 */
export type RunMessageDelivery = "native" | "inbox" | "resume";
export type RunMessageState = "QUEUED" | "DELIVERED" | "SUPERSEDED";
export interface RunMessage {
  id: number;
  runId: string;
  direction: "OPERATOR" | "AGENT";
  text: string;
  delivery: RunMessageDelivery;
  state: RunMessageState;
  createdAt: string;
  deliveredAt: string | null;
}
export interface OperatorMessagePayload {
  messageId: number;
  text: string;
  delivery: RunMessageDelivery;
  state: RunMessageState;
}
export interface AgentMessagePayload {
  messageId: number;
  text: string;
}

export type NormalizedEvent =
  | (EventBase & { type: "assistant_text"; payload: AssistantTextPayload })
  | (EventBase & { type: "tool_use"; payload: ToolUsePayload })
  | (EventBase & { type: "tool_result"; payload: ToolResultPayload })
  | (EventBase & { type: "status"; payload: StatusPayload })
  | (EventBase & { type: "result"; payload: ResultPayload })
  | (EventBase & { type: "error"; payload: ErrorPayload })
  | (EventBase & { type: "db_access"; payload: DbAccessPayload })
  | (EventBase & { type: "input_request"; payload: AgentInputRequestPayload })
  | (EventBase & { type: "input_response"; payload: AgentInputResponsePayload })
  | (EventBase & { type: "operator_message"; payload: OperatorMessagePayload })
  | (EventBase & { type: "agent_message"; payload: AgentMessagePayload });

export type NormalizedEventType = NormalizedEvent["type"];

/**
 * What adapters yield: everything except the fields the runner stamps on
 * (`id`, `runId`, `provider`, `model`, `timestamp`).
 */
export type AdapterEvent =
  | { type: "assistant_text"; payload: AssistantTextPayload }
  | { type: "tool_use"; payload: ToolUsePayload }
  | { type: "tool_result"; payload: ToolResultPayload }
  | { type: "status"; payload: Partial<StatusPayload> & { state?: RunState } }
  | { type: "result"; payload: Partial<ResultPayload> }
  | { type: "error"; payload: { message: string; fatal?: boolean; detail?: string | null } };
