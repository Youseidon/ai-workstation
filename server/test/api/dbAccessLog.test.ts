import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  describeAcceptedWrite,
  describeRead,
  describeRejectedWrite,
  isDbWrite,
  tablesTouched,
} from "../../src/api/dbAccessLog.ts";
import type { DbOperation } from "../../src/api/dbAccessLog.ts";

const OPERATIONS: DbOperation[] = ["execution", "check", "plan", "context", "state", "remarks", "status", "checkpoint", "decompose", "repair-verify", "propose-program", "propose-suite", "revise-program", "input", "inbox", "reply"];

test("reads and writes are told apart, and only writes name tables", () => {
  assert.deepEqual(OPERATIONS.filter(isDbWrite), ["check", "plan", "remarks", "status", "checkpoint", "decompose", "repair-verify", "propose-program", "propose-suite", "revise-program", "input", "reply"]);
  for (const operation of OPERATIONS) {
    assert.equal(tablesTouched(operation).length > 0, isDbWrite(operation), operation);
  }
});

test("a status post reports the transition it actually made", () => {
  const payload = describeAcceptedWrite({
    operation: "status", before: "IN_PROGRESS", after: "DONE", requestId: "r-1", durationMs: 12,
  });
  assert.equal(payload.summary, "IN_PROGRESS → DONE");
  assert.equal(payload.outcome, "accepted");
  assert.equal(payload.direction, "write");
  assert.deepEqual(payload.changed, ["prompt", "prompt_status_event"]);
});

test("a replayed write is not reported as a second transition", () => {
  const payload = describeAcceptedWrite({
    operation: "status", before: "DONE", after: "DONE", requestId: "r-1", durationMs: 3,
  });
  assert.equal(payload.outcome, "replayed");
  assert.deepEqual(payload.changed, [], "a replay must not claim to have written anything");
});

test("a remark always counts, since two remarks are not one remark", () => {
  const payload = describeAcceptedWrite({
    operation: "remarks", before: "IN_PROGRESS", after: "IN_PROGRESS",
    remarkKind: "FINDING", requestId: "r-2", durationMs: 4,
  });
  assert.equal(payload.outcome, "accepted");
  assert.equal(payload.summary, "+1 FINDING remark");
  assert.deepEqual(payload.changed, ["prompt_remark"]);
});

test("a refusal carries the server's own code and claims no change", () => {
  const payload = describeRejectedWrite({
    operation: "status", httpStatus: 409, errorCode: "stale_status",
    message: "Work item is DONE, not IN_PROGRESS", requestId: null, durationMs: 2,
  });
  assert.equal(payload.outcome, "rejected");
  assert.equal(payload.errorCode, "stale_status");
  assert.equal(payload.httpStatus, 409);
  assert.deepEqual(payload.changed, []);
});

test("a read is never reported as a write", () => {
  for (const operation of ["context", "state"] as const) {
    const payload = describeRead({ operation, summary: "read something", durationMs: 1 });
    assert.equal(payload.direction, "read");
    assert.equal(payload.method, "GET");
    assert.deepEqual(payload.changed, []);
  }
});

test("every agent endpoint is instrumented", () => {
  const source = readFileSync(new URL("../../src/api/server.ts", import.meta.url), "utf8");
  const route = source.match(/agent\\\/runs\\\/\(\[\^\/\]\+\)\\\/\(([a-z|-]+)\)/);
  assert.ok(route !== null, "could not find the agent route pattern");
  assert.deepEqual(route[1]!.split("|").sort(), [...OPERATIONS].sort());

  const handler = source.slice(source.indexOf("const agentMatch"), source.indexOf('url.pathname === "/api/sessions"'));
  assert.match(handler, /describeRead\(\{operation:"context"/, "context reads are not logged");
  assert.match(handler, /describeRead\(\{operation:"state"/, "state reads are not logged");
  assert.match(handler, /describeAcceptedWrite\(/, "accepted writes are not logged");
  assert.match(handler, /describeRejectedWrite\(/, "refused writes are not logged");
  assert.match(handler, /verification_failed/, "Verify refusals are not logged");
  assert.equal((handler.match(/recordDbAccess\(/g) ?? []).length, 15);
});
