import type { TokenUsage } from "../models/tokenUsage.ts";
import type { ProviderId } from "./providers.ts";

export type RunState = "starting" | "running" | "done" | "interrupted" | "error";

export interface AssistantTextPayload {
  blockId: string;
  delta: boolean;
  text: string;
  kind: "message" | "thinking";
}

export interface ToolUsePayload {
  toolUseId: string;
  name: string;
  summary: string;
  input: unknown;
}

export interface ToolResultPayload {
  toolUseId: string;
  name: string | null;
  isError: boolean;
  summary: string;
  output: string;
  exitCode: number | null;
}

export interface StatusPayload {
  conversation?: { permissionKey: string; context: string; nativeSessionId?: string | null };
  state: RunState;
  elapsedMs: number;
  usage: TokenUsage | null;
  detail: string | null;
  sessionId?: string | null;
}

export interface ResultPayload {
  state: Extract<RunState, "done" | "interrupted" | "error">;
  elapsedMs: number;
  usage: TokenUsage | null;
  text: string | null;
  exitCode: number | null;
  stopReason?: string | null;
  peakMemoryBytes?: number | null;
}

export interface ErrorPayload {
  message: string;
  fatal: boolean;
  detail: string | null;
}

interface EventBase {
  id: string;
  runId: string;
  provider: ProviderId;
  model: string | null;
  timestamp: string;
}

export interface DbAccessPayload {
  direction: "read" | "write";
  operation: "execution" | "check" | "plan" | "context" | "state" | "remarks" | "status" | "checkpoint" | "decompose" | "repair-verify" | "propose-program" | "propose-suite" | "revise-program" | "input" | "inbox" | "reply";
  method: string;
  outcome: "accepted" | "rejected" | "replayed";
  httpStatus: number;
  durationMs: number;
  requestId: string | null;
  summary: string;
  changed: string[];
  errorCode: string | null;
}

export type AgentQuestionKind = "single" | "multiple" | "text";

export interface AgentQuestionOption {
  value: string;
  label: string;
  description: string | null;
}

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

export type AdapterEvent =
  | { type: "assistant_text"; payload: AssistantTextPayload }
  | { type: "tool_use"; payload: ToolUsePayload }
  | { type: "tool_result"; payload: ToolResultPayload }
  | { type: "status"; payload: Partial<StatusPayload> & { state?: RunState } }
  | { type: "result"; payload: Partial<ResultPayload> }
  | { type: "error"; payload: { message: string; fatal?: boolean; detail?: string | null } };
