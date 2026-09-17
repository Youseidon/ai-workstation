import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  describeAcceptedWrite,
  describeRead,
  describeRejectedWrite,
  isDbWrite,
  tablesTouched,
} from "../src/dbAccessLog.ts";
import type { DbOperation } from "../src/dbAccessLog.ts";

const OPERATIONS: DbOperation[] = ["context", "state", "remarks", "status", "decompose", "propose-program", "propose-suite", "revise-program"];

test("reads and writes are told apart, and only writes name tables", () => {
  assert.deepEqual(OPERATIONS.filter(isDbWrite), ["remarks", "status", "decompose", "propose-program", "propose-suite", "revise-program"]);
  for (const operation of OPERATIONS) {
    // A read that claimed to have changed a table would be the worst kind of
    // wrong here: the log exists precisely so the operator does not have to
    // take the app's word for what an agent touched.
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
  // The idempotency ledger returns the stored response for a repeated
  // requestId. Reporting "IN_PROGRESS → DONE" twice would send the operator
  // hunting for a transition that only ever happened once.
  const payload = describeAcceptedWrite({
    operation: "status", before: "DONE", after: "DONE", requestId: "r-1", durationMs: 3,
  });
  assert.equal(payload.outcome, "replayed");
  assert.deepEqual(payload.changed, [], "a replay must not claim to have written anything");
});

test("a remark always counts, since two remarks are not one remark", () => {
  // Unlike a status, a repeated remark genuinely adds a row, so the
  // before/after equality that detects a replayed status must not apply here.
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
  // The most important line in this log. Without it, an agent whose post was
  // rejected looks exactly like one that never tried, and the operator blames
  // the wrong side.
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
  // The value of this log is that it is complete: an endpoint that quietly
  // skipped it would leave a gap exactly where an operator went looking. The
  // route regex in index.ts is the list of endpoints an agent can reach, so it
  // is compared against the operations this module knows how to describe.
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const route = source.match(/agent\\\/runs\\\/\(\[\^\/\]\+\)\\\/\(([a-z|-]+)\)/);
  assert.ok(route !== null, "could not find the agent route pattern");
  assert.deepEqual(route[1]!.split("|").sort(), [...OPERATIONS].sort());

  const handler = source.slice(source.indexOf("const agentMatch"), source.indexOf('url.pathname === "/api/sessions"'));
  // Six call sites: the two reads on a work item are separate branches, an
  // author run's context read is a third, the writes share one POST branch that
  // records accepted and generic refused outcomes, and a Verify refusal on
  // `done` records its own rejected write before returning 409 (so it never
  // looks like a silent miss).
  assert.match(handler, /describeRead\(\{operation:"context"/, "context reads are not logged");
  assert.match(handler, /describeRead\(\{operation:"state"/, "state reads are not logged");
  assert.match(handler, /describeAcceptedWrite\(/, "accepted writes are not logged");
  assert.match(handler, /describeRejectedWrite\(/, "refused writes are not logged");
  assert.match(handler, /verification_failed/, "Verify refusals are not logged");
  assert.equal((handler.match(/recordDbAccess\(/g) ?? []).length, 6);
});
