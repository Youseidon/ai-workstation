import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { migratePreRenameState, PreRenameServerRunningError } from "../../src/infrastructure/stateMigration.ts";

function preRenameState(): { base: string; from: string; to: string } {
  const base = mkdtempSync(join(tmpdir(), "hydra-migration-"));
  const from = join(base, "agent-console/console.sqlite");
  mkdirSync(join(base, "agent-console/provider-sdk/claude"), { recursive: true });
  const db = new Database(from);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept');");
  db.close();
  return { base, from, to: join(base, "hydra/hydra.sqlite") };
}

test("moves the pre-rename database and provider SDK into the hydra state dir", () => {
  const { base, from, to } = preRenameState();
  const result = migratePreRenameState(from, to);
  assert.equal(result.moved, true);
  assert.equal(existsSync(from), false);
  assert.equal(existsSync(`${from}-wal`), false);
  assert.ok(existsSync(join(base, "hydra/provider-sdk/claude")));
  assert.match(readFileSync(join(base, "agent-console/MOVED.txt"), "utf8"), /Hydra/);
  const db = new Database(to, { readonly: true });
  assert.deepEqual(db.prepare("SELECT v FROM t").all(), [{ v: "kept" }]);
  db.close();
});

test("leaves an existing hydra database alone", () => {
  const { from, to } = preRenameState();
  mkdirSync(join(to, ".."), { recursive: true });
  writeFileSync(to, "");
  assert.equal(migratePreRenameState(from, to).moved, false);
  assert.ok(existsSync(from));
});

test("refuses while a pre-rename server still holds the lock", () => {
  const { from, to } = preRenameState();
  writeFileSync(`${from}.lock`, JSON.stringify({ pid: process.pid, mode: "serve", startedAt: null }));
  assert.throws(() => migratePreRenameState(from, to), PreRenameServerRunningError);
  assert.ok(existsSync(from));
  assert.equal(existsSync(to), false);
});

test("treats a lock left by a dead process as stale", () => {
  const { from, to } = preRenameState();
  writeFileSync(`${from}.lock`, "999999999\n");
  assert.equal(migratePreRenameState(from, to).moved, true);
  assert.equal(existsSync(`${from}.lock`), false);
});
