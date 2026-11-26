import type { DbAccessPayload } from "@hydra/shared";

export type DbOperation = "execution" | "check" | "plan" | "context" | "state" | "remarks" | "status" | "checkpoint" | "decompose" | "repair-verify" | "propose-program" | "propose-suite" | "revise-program" | "input" | "inbox" | "reply";

const WRITES = new Set<DbOperation>(["check", "plan", "remarks", "status", "checkpoint", "decompose", "repair-verify", "propose-program", "propose-suite", "revise-program", "input", "reply"]);

const TABLES: Record<DbOperation, string[]> = {
  execution: [],
  check: ["command_task", "execution_lease", "dod_result"],
  plan: ["execution_event", "agent_command"],
  context: [],
  state: [],
  remarks: ["prompt_remark"],
  status: ["prompt", "prompt_status_event"],
  checkpoint: ["git", "run_change_set"],
  decompose: ["prompt", "prompt_status_event"],
  "repair-verify": ["prompt", "prompt_revision", "definition_of_done", "dod_criterion", "dod_result", "prompt_remark"],
  "propose-program": ["program_draft"],
  "propose-suite": ["program_draft"],
  "revise-program": ["program_draft"],
  input: ["agent_run_event"],
  inbox: [],
  reply: ["run_message", "agent_run_event"],
};

export function isDbWrite(operation: DbOperation): boolean {
  return WRITES.has(operation);
}

export function tablesTouched(operation: DbOperation): string[] {
  return TABLES[operation] ?? [];
}

export interface AcceptedWrite {
  operation: DbOperation;
  before: string | null;
  after: string | null;
  remarkKind?: string | null;
  requestId: string | null;
  durationMs: number;
}

export function describeAcceptedWrite(args: AcceptedWrite): DbAccessPayload {
  const replayed = args.operation === "status" || args.operation === "decompose"
    ? args.before === args.after
    : false;
  const summary =
    args.operation === "check" ? "requested a managed verification recipe"
      : args.operation === "plan" ? "proposed a coverage-preserving remaining plan"
      : args.operation === "remarks"
      ? `+1 ${args.remarkKind ?? "PROGRESS"} remark`
      : args.operation === "decompose"
        ? "split into sub-steps"
        : args.operation === "checkpoint"
          ? "committed a workspace checkpoint"
        : args.operation === "repair-verify"
          ? "repaired and re-ran a failing Verify command"
        : args.operation === "propose-program"
          ? "proposed a program and its suites"
          : args.operation === "propose-suite"
            ? "proposed a suite's work items"
            : args.operation === "revise-program"
              ? "proposed changes to a program"
            : args.operation === "input"
              ? "asked the operator for a decision"
            : `${args.before ?? "?"} → ${args.after ?? "?"}`;
  return {
    direction: "write",
    operation: args.operation,
    method: "POST",
    outcome: replayed ? "replayed" : "accepted",
    httpStatus: 200,
    durationMs: args.durationMs,
    requestId: args.requestId,
    summary,
    changed: replayed ? [] : tablesTouched(args.operation),
    errorCode: null,
  };
}

export function describeRejectedWrite(args: {
  operation: DbOperation;
  httpStatus: number;
  errorCode: string;
  message: string;
  requestId: string | null;
  durationMs: number;
}): DbAccessPayload {
  return {
    direction: "write",
    operation: args.operation,
    method: "POST",
    outcome: "rejected",
    httpStatus: args.httpStatus,
    durationMs: args.durationMs,
    requestId: args.requestId,
    summary: args.message,
    changed: [],
    errorCode: args.errorCode,
  };
}

export function describeRead(args: {
  operation: Extract<DbOperation, "execution" | "context" | "state" | "inbox">;
  summary: string;
  durationMs: number;
}): DbAccessPayload {
  return {
    direction: "read",
    operation: args.operation,
    method: "GET",
    outcome: "accepted",
    httpStatus: 200,
    durationMs: args.durationMs,
    requestId: null,
    summary: args.summary,
    changed: [],
    errorCode: null,
  };
}
