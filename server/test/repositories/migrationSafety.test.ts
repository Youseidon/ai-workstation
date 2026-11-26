import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("../../src/repositories/workspaces.ts", import.meta.url), "utf8");

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
  const offenders = transactionBodies(SOURCE)
    .filter((body) => /pragma\(\s*["'`]foreign_keys/i.test(body));
  assert.deepEqual(
    offenders.map((body) => body.slice(0, 80)),
    [],
    "a transaction toggles foreign_keys, which SQLite ignores — move it outside",
  );
});

test("every table rebuild disables foreign keys somewhere", () => {
  const bodies = transactionBodies(SOURCE).filter((body) => /DROP TABLE/i.test(body));
  assert.ok(bodies.length > 0, "the brace matcher found no rebuild — it has probably broken");
  for (const body of bodies) {
    const start = SOURCE.indexOf(body);
    const window = SOURCE.slice(Math.max(0, start - 1200), start + body.length + 600);
    assert.match(
      window,
      /pragma\(\s*["'`]foreign_keys = OFF/i,
      `a migration drops a table with foreign keys still on: ${body.slice(0, 120)}`,
    );
  }
});

test("the tables that cascade off agent_run are named, so the risk stays visible", () => {
  for (const table of ["agent_run_event", "agent_command", "completion_audit"]) {
    assert.match(SOURCE, new RegExp(`REFERENCES agent_run\\(id\\)|${table}`), `${table} not found`);
  }
});
