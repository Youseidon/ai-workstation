/**
 * A database last migrated before the reconcile with upstream must still boot.
 *
 * Team numbered its migrations 14-29 until the reconcile moved them to 37-52,
 * because upstream had taken 14-36 for its own. A database from before that
 * records "14-27 applied" and means the Team tables. Read as upstream's
 * numbers, the server skipped upstream's 14-27, resumed at 28 and died on
 * `no such table: pipeline_step` - a table upstream's 14 would have created.
 *
 * The fixture is the schema of such a database, taken as it was found.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = readFileSync(new URL("./fixtures/pre-reconcile-team-schema.sql", import.meta.url), "utf8");

// Same reasoning as teamItems.test.ts: the child must not inherit the suite's
// database, and must not fall back to the developer's live one.
function boot(root: string, file: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "-e", "const { workspaces } = await import('./src/workspaces.ts'); workspaces.close();"], {
    cwd: serverDir,
    env: {
      ...process.env,
      AGENT_CONSOLE_REPO_ROOT: root,
      AGENT_CONSOLE_DB: file,
      SETTINGS_FILE: join(root, ".agent-console/settings.json"),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
}

function seed(file: string, highest = 27) {
  const database = new Database(file);
  database.exec(SCHEMA);
  const at = "2026-09-20T00:00:00.000Z";
  const record = database.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(?,?)");
  for (let version = 1; version <= highest; version += 1) record.run(version, `2026-09-${String(version).padStart(2, "0")}T00:00:00.000Z`);
  database.exec(`
    INSERT INTO workspace(id,name,work_directory,created_at,updated_at) VALUES(1,'legacy','/tmp/legacy','${at}','${at}');
    INSERT INTO program(id,workspace_id,name,sort_order,created_at,updated_at) VALUES(1,1,'program',0,'${at}','${at}');
    INSERT INTO suite(id,program_id,name,sort_order,created_at,updated_at) VALUES(1,1,'suite',0,'${at}','${at}');
    INSERT INTO prompt(id,suite_id,title,content,sort_order,created_at,updated_at) VALUES(1,1,'first','do it',0,'${at}','${at}');
    INSERT INTO prompt_pipeline_rule(prompt_id,provider,on_blocked,updated_at,enabled) VALUES(1,'claude','skip','${at}',1);
    INSERT INTO pipeline(id,workspace_id,name,created_at,updated_at,execution_provider,execution_model) VALUES(1,1,'main','${at}','${at}','codex','gpt');
    INSERT INTO pipeline_stage(pipeline_id,suite_id,sort_order) VALUES(1,1,0);
    INSERT INTO agent_run(id,workspace_id,prompt_id,provider,state,started_at,context_token_hash,token_expires_at) VALUES('run-1',1,1,'claude','COMPLETED','${at}','hash','${at}');
    INSERT INTO agent_run_event(run_id,event_json,created_at) VALUES('run-1','{}','${at}'),('run-1','{}','${at}');
    INSERT INTO prompt_status_event(prompt_id,run_id,previous_status,new_status,reason,actor_type,created_at,options_json)
      VALUES(1,'run-1','TODO','DONE','done','agent','${at}','["a"]');
    INSERT INTO telegram_outbox(id,bot_id,chat_id,payload_json,state,created_at,updated_at) VALUES(1,'bot','-1','{}','SENT','${at}','${at}');
  `);
  database.close();
}

test("a database on the pre-reconcile Team numbering migrates to the current schema", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-console-reconcile-"));
  const file = join(root, ".agent-console/console.sqlite");
  mkdirSync(dirname(file), { recursive: true });
  try {
    seed(file);

    // Twice: the second boot must find nothing left to reconcile.
    for (const run of [1, 2]) {
      const migrated = boot(root, file);
      assert.equal(migrated.status, 0, `boot ${run}: ${migrated.stderr}`);
      const check = new Database(file, { readonly: true });
      try {
        const versions = (check.prepare("SELECT version FROM schema_migration ORDER BY version").all() as Array<{ version: number }>).map(row => row.version);
        const highest = versions.at(-1) as number;
        assert.deepEqual(versions, Array.from({ length: highest }, (_, index) => index + 1), `boot ${run} leaves no gap in the recorded history`);
        assert.ok(highest >= 54, `boot ${run} reaches the current schema`);

        // Team's rows keep the date they were really applied on, under the new number.
        assert.deepEqual(
          check.prepare("SELECT version,applied_at FROM schema_migration WHERE version IN (37,50)").all(),
          [{ version: 37, applied_at: "2026-09-14T00:00:00.000Z" }, { version: 50, applied_at: "2026-09-27T00:00:00.000Z" }],
        );
        assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migration_team_legacy'").get(), undefined, "the holding table is gone");

        // Upstream's 14-36 ran against it: the table the crash was about exists,
        // and migration 31 carried the station rule into it.
        assert.deepEqual(
          check.prepare("SELECT pipeline_id,prompt_id,provider,on_unfinished FROM pipeline_step").all(),
          [{ pipeline_id: 1, prompt_id: 1, provider: "claude", on_unfinished: "skip" }],
        );

        // Nothing either side owns was lost. `agent_run` is rebuilt twice on the
        // way, which is where rows that reference it have been lost before.
        assert.deepEqual(check.prepare("SELECT execution_provider,execution_model FROM pipeline WHERE id=1").get(), { execution_provider: "codex", execution_model: "gpt" });
        assert.deepEqual(check.prepare("SELECT options_json FROM prompt_status_event").all(), [{ options_json: '["a"]' }]);
        assert.equal((check.prepare("SELECT count(*) AS count FROM agent_run_event WHERE run_id='run-1'").get() as { count: number }).count, 2);
        assert.equal((check.prepare("SELECT count(*) AS count FROM telegram_outbox").get() as { count: number }).count, 1);
        assert.deepEqual(check.pragma("foreign_key_check"), []);
      } finally {
        check.close();
      }
      const backups = readdirSync(dirname(file)).filter(name => name.includes(".pre-reconcile-"));
      assert.equal(backups.length, 1, `boot ${run}: one backup, taken before the first change`);
      const backup = new Database(join(dirname(file), backups[0] as string), { readonly: true });
      try {
        assert.deepEqual(backup.prepare("SELECT MAX(version) AS version FROM schema_migration").get(), { version: 27 }, "the backup is the database as it was found");
        assert.equal(backup.prepare("SELECT 1 FROM sqlite_master WHERE name='pipeline_step'").get(), undefined);
      } finally {
        backup.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a boot killed between the two halves of the reconcile resumes", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-console-reconcile-"));
  const file = join(root, ".agent-console/console.sqlite");
  mkdirSync(dirname(file), { recursive: true });
  try {
    seed(file);
    // The state the first half leaves behind: Team's rows moved aside, upstream's
    // block not yet started.
    const database = new Database(file);
    database.exec(`
      CREATE TABLE schema_migration_team_legacy (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migration_team_legacy(version,applied_at) SELECT version + 23, applied_at FROM schema_migration WHERE version >= 14;
      DELETE FROM schema_migration WHERE version >= 14;
    `);
    database.close();

    const migrated = boot(root, file);
    assert.equal(migrated.status, 0, migrated.stderr);
    const check = new Database(file, { readonly: true });
    try {
      const versions = (check.prepare("SELECT version FROM schema_migration ORDER BY version").all() as Array<{ version: number }>).map(row => row.version);
      assert.deepEqual(versions, Array.from({ length: versions.at(-1) as number }, (_, index) => index + 1));
      assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migration_team_legacy'").get(), undefined);
      assert.equal((check.prepare("SELECT count(*) AS count FROM pipeline_step").get() as { count: number }).count, 1);
    } finally {
      check.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a history recorded past the last pre-reconcile Team migration is refused, not guessed at", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-console-reconcile-"));
  const file = join(root, ".agent-console/console.sqlite");
  mkdirSync(dirname(file), { recursive: true });
  try {
    // Team's old numbering ended at 29, so a 30 beside a missing `pipeline_step`
    // is a history neither side wrote.
    seed(file, 30);
    const refused = boot(root, file);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Cannot reconcile migration history: version 30 is recorded/);
    const check = new Database(file, { readonly: true });
    try {
      assert.deepEqual(check.prepare("SELECT COUNT(*) AS count, MAX(version) AS version FROM schema_migration").get(), { count: 30, version: 30 }, "nothing was changed");
      assert.equal(check.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migration_team_legacy'").get(), undefined);
    } finally {
      check.close();
    }
    assert.deepEqual(readdirSync(dirname(file)).filter(name => name.includes(".pre-reconcile-")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
