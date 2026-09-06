/**
 * The transcript projection for database access.
 *
 * These lines are the operator's evidence that an agent talked to the app at
 * all, so the projection has to be faithful about direction, outcome and what
 * changed — a log that flatters the app is worse than no log.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { DbAccessPayload, NormalizedEvent } from "@agent-console/shared";
import { applyEvent } from "./log";
import type { LogItem } from "./log";

let n = 0;
function dbEvent(payload: Partial<DbAccessPayload> = {}): NormalizedEvent {
  n += 1;
  return {
    id: `evt-${n}`,
    runId: "run-1",
    provider: "claude",
    model: "opus-5",
    timestamp: "2026-09-04T00:00:00.000Z",
    type: "db_access",
    payload: {
      direction: "write", operation: "status", method: "POST", outcome: "accepted",
      httpStatus: 200, durationMs: 8, requestId: "r-1",
      summary: "IN_PROGRESS → DONE", changed: ["prompt", "prompt_status_event"], errorCode: null,
      ...payload,
    },
  };
}

const db = (items: LogItem[]) => items.filter((item): item is Extract<LogItem, { kind: "db" }> => item.kind === "db");

test("a database call becomes its own line, not a footnote on a tool call", () => {
  // Folding it into the curl that made it would bury the one thing the
  // operator came looking for inside a command's output.
  const items = applyEvent([], dbEvent());
  assert.equal(items.length, 1);
  const [line] = db(items);
  assert.equal(line?.kind, "db");
  assert.equal(line?.direction, "write");
  assert.equal(line?.summary, "IN_PROGRESS → DONE");
  assert.deepEqual(line?.changed, ["prompt", "prompt_status_event"]);
});

test("a refusal keeps its error code, so the operator blames the right side", () => {
  const items = applyEvent([], dbEvent({
    outcome: "rejected", httpStatus: 409, errorCode: "stale_status",
    summary: "Work item is DONE, not IN_PROGRESS", changed: [],
  }));
  const [line] = db(items);
  assert.equal(line?.outcome, "rejected");
  assert.equal(line?.errorCode, "stale_status");
  assert.equal(line?.httpStatus, 409);
});

test("reads and writes stay distinguishable after projection", () => {
  const items = applyEvent(applyEvent([], dbEvent({ direction: "read", operation: "context", method: "GET", summary: "read work item S6-07", changed: [] })), dbEvent());
  assert.deepEqual(db(items).map((line) => line.direction), ["read", "write"]);
});

test("database lines accumulate rather than replacing each other", () => {
  // Unlike streamed text, which collapses by blockId, every call is a separate
  // event in the record and none may be swallowed by the next.
  let items: LogItem[] = [];
  for (let i = 0; i < 4; i += 1) items = applyEvent(items, dbEvent({ operation: "remarks", summary: `+1 PROGRESS remark` }));
  assert.equal(db(items).length, 4);
});

test("a status heartbeat still stays out of the transcript", () => {
  // Guards the neighbouring switch arm: db_access was added right beside it,
  // and drowning the log in per-second heartbeats would undo the point.
  const status: NormalizedEvent = {
    id: "s-1", runId: "run-1", provider: "claude", model: null,
    timestamp: "2026-09-04T00:00:00.000Z",
    type: "status", payload: { state: "running", elapsedMs: 1000, usage: null, detail: null },
  };
  assert.deepEqual(applyEvent([], status), []);
});
