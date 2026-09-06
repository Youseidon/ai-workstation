/**
 * How a trip to the app's database is described in the log.
 *
 * Pure, so the wording and the read/write classification can be tested without
 * standing up an HTTP server. `index.ts` keeps only the wiring.
 *
 * The operator's question this answers is narrow and specific: *did this agent
 * talk to the app, and what did it change?* Before these lines existed, a run
 * that silently never posted looked exactly like a run that posted and was
 * ignored — and which of those happened decides whether to distrust the agent
 * or the app.
 */

import type { DbAccessPayload } from "@agent-console/shared";

export type DbOperation = "context" | "state" | "remarks" | "status" | "decompose";

/** The endpoints that change state. Everything else is a read. */
const WRITES = new Set<DbOperation>(["remarks", "status", "decompose"]);

/**
 * What an accepted call touched.
 *
 * Listed rather than inferred so a write is never merely implied: the operator
 * sees the tables by name, and a change to what an endpoint writes has to be
 * reflected here deliberately.
 */
const TABLES: Record<DbOperation, string[]> = {
  context: [],
  state: [],
  remarks: ["prompt_remark"],
  status: ["prompt", "prompt_status_event"],
  decompose: ["prompt", "prompt_status_event"],
};

export function isDbWrite(operation: DbOperation): boolean {
  return WRITES.has(operation);
}

export function tablesTouched(operation: DbOperation): string[] {
  return TABLES[operation] ?? [];
}

export interface AcceptedWrite {
  operation: DbOperation;
  /** The work item's status before and after, for a status post. */
  before: string | null;
  after: string | null;
  remarkKind?: string | null;
  requestId: string | null;
  durationMs: number;
}

export function describeAcceptedWrite(args: AcceptedWrite): DbAccessPayload {
  // A status post that left the status where it was is the idempotency ledger
  // replaying an earlier call. Reporting "IN_PROGRESS → DONE" twice would have
  // the operator hunting a transition that only ever happened once.
  const replayed = args.operation !== "remarks" && args.before === args.after;
  const summary =
    args.operation === "remarks"
      ? `+1 ${args.remarkKind ?? "PROGRESS"} remark`
      : args.operation === "decompose"
        ? "split into sub-steps"
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
    // A refusal changed nothing. Naming tables here would be a lie in the one
    // place the operator is least able to check it.
    changed: [],
    errorCode: args.errorCode,
  };
}

export function describeRead(args: {
  operation: Extract<DbOperation, "context" | "state">;
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
