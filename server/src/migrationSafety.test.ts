/**
 * Rules about migrations that the type checker cannot enforce.
 *
 * These exist because of a real incident: migration 22 rebuilds `agent_run`,
 * and it called `db.pragma("foreign_keys = OFF")` from *inside* its
 * `db.transaction(...)`. That pragma is a silent no-op inside a transaction —
 * no error, no warning — so foreign keys stayed on and `DROP TABLE agent_run`
 * cascaded into every table that references it, deleting 135,025 transcript
 * events, 302 idempotency records, 11 handoffs and 1 audit.
 *
 * Nothing failed. The migration reported success, the tests passed, and the
 * loss was only visible by counting rows. That is exactly the shape of bug a
 * source-level rule is worth having.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("./workspaces.ts", import.meta.url), "utf8");

/** The body of each `db.transaction(...)` literal, by brace matching. */
function transactionBodies(source: string): string[] {
  const bodies: string[] = [];
  const marker = "db.transaction(";
  let from = 0;
  for (;;) {
    const start = source.indexOf(marker, from);
    if (start === -1) break;
    let depth = 0;
    let index = start + marker.length - 1;
    for (; index < source.length; index += 1) {
      const char = source[index];
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.push(source.slice(start, index + 1));
    from = index + 1;
  }
  return bodies;
}

test("no migration toggles foreign keys inside a transaction", () => {
  // SQLite ignores `PRAGMA foreign_keys` within a transaction, so a rebuild
  // that relies on it there runs with foreign keys still enforced and silently
  // takes every dependent row with it.
  const offenders = transactionBodies(SOURCE)
    .filter((body) => /pragma\(\s*["'`]foreign_keys/i.test(body));
  assert.deepEqual(
    offenders.map((body) => body.slice(0, 80)),
    [],
    "a transaction toggles foreign_keys, which SQLite ignores — move it outside",
  );
});

test("every table rebuild disables foreign keys somewhere", () => {
  // A DROP of a table other tables reference is only safe with foreign keys
  // off. If a migration drops one without the pragma appearing anywhere near
  // it, the cascade is live.
  const bodies = transactionBodies(SOURCE).filter((body) => /DROP TABLE/i.test(body));
  assert.ok(bodies.length > 0, "the brace matcher found no rebuild — it has probably broken");
  for (const body of bodies) {
    const start = SOURCE.indexOf(body);
    // The pragma belongs immediately around the transaction, so a generous
    // window either side is enough to tell "guarded" from "not guarded".
    const window = SOURCE.slice(Math.max(0, start - 1200), start + body.length + 600);
    assert.match(
      window,
      /pragma\(\s*["'`]foreign_keys = OFF/i,
      `a migration drops a table with foreign keys still on: ${body.slice(0, 120)}`,
    );
  }
});

test("the tables that cascade off agent_run are named, so the risk stays visible", () => {
  // Four tables reference agent_run. Anyone rebuilding it should be able to see
  // what is at stake without running a query first.
  for (const table of ["agent_run_event", "agent_command", "handoff", "completion_audit"]) {
    assert.match(SOURCE, new RegExp(`REFERENCES agent_run\\(id\\)|${table}`), `${table} not found`);
  }
});
