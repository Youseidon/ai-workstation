import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { itemTag, mintItemId } from "../src/teamItems.ts";
import { itemSubject, WorkspaceError, workspaces } from "../src/workspaces.ts";

/*
 * The suite sets AGENT_CONSOLE_DB and SETTINGS_FILE for the whole process. A
 * child given its own repo root must not inherit them, or it writes to the
 * suite's database instead of the root under test. Same reasoning as
 * dodCommands.ts, which strips AGENT_CONSOLE_DB from verification commands.
 *
 * Deleting them is no longer enough. The database now defaults to the XDG
 * state directory rather than the repo root, so a child with only a repo root
 * resolves the developer's own live database - which the dev-on-live guard in
 * workspaces.ts then refuses outright, and would otherwise have written to.
 * The child is therefore pointed at its own file inside the root under test,
 * which is also the path these migration checks open afterwards.
 */
function childEnv(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_CONSOLE_REPO_ROOT: root,
    AGENT_CONSOLE_DB: join(root, ".agent-console/console.sqlite"),
    SETTINGS_FILE: join(root, ".agent-console/settings.json"),
  };
}


const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function boot(root: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "-e", "const { workspaces } = await import('./src/workspaces.ts'); workspaces.close();"], {
    cwd: serverDir,
    env: childEnv(root),
    encoding: "utf8",
    timeout: 60_000,
  });
}

function runWorkspaceScript(root: string, source: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "-e", source], {
    cwd: serverDir,
    env: childEnv(root),
    encoding: "utf8",
    timeout: 60_000,
  });
}

test("TM-T0-5-25: migration 25 preserves C1 threads, anchors and indexes and runs once", () => {
  const root = mkdtempSync(join(tmpdir(), "tm2-migration-25-"));
  try {
    mkdirSync(join(root, ".agent-console"), { recursive: true });
    mkdirSync(join(root, "workspace"));
    const first = boot(root);
    assert.equal(first.status, 0, first.stderr);
    const seeded = runWorkspaceScript(root, `
      const { workspaces } = await import('./src/workspaces.ts');
      const workspace = workspaces.create({ name: 'migration-25', workDirectory: ${JSON.stringify(join(root, "workspace"))} });
      const program = workspaces.createChild('program', workspace.id, { name: 'Program' });
      const suite = workspaces.createChild('suite', program.id, { name: 'Suite' });
      const prompt = workspaces.createChild('prompt', suite.id, { title: 'Pending card', content: 'Answer once' });
      const actor = workspaces.upsertTaskControlActor({ id: 'm25-actor', transport: 'fake_telegram', transportUserId: '101', chatId: '42', label: 'jd' });
      workspaces.createTaskControlAction({ ref: 'm25-action', action: 'answer_and_resume', promptId: prompt.id, actorId: actor.id, chatId: '42', botId: 'telegram-m25', expectedRevision: workspaces.humanInputState(prompt.id).revision, expiresAt: '2099-01-01T00:00:00.000Z' });
      workspaces.close();
    `);
    assert.equal(seeded.status, 0, seeded.stderr);
    const file = join(root, ".agent-console/console.sqlite");
    const database = new Database(file);
    database.pragma("foreign_keys = OFF");
    database.exec(`
      INSERT INTO telegram_outbox
        (id,bot_id,chat_id,topic_id,payload_json,state,attempt_count,last_error,created_at,updated_at,next_attempt_at,sent_message_id,operation,target_outbox_id,payload_version,thread_id)
      VALUES
        (901,'telegram-m25','42',NULL,'{"kind":"text","text":"task anchor"}','SENT',1,NULL,'2026-09-17T00:00:00.000Z','2026-09-17T00:00:01.000Z',NULL,'501','send',NULL,0,NULL),
        (902,'telegram-m25','42',NULL,'{"kind":"text","text":"workstation anchor"}','SENT',1,NULL,'2026-09-17T00:00:02.000Z','2026-09-17T00:00:03.000Z',NULL,'502','send',NULL,0,NULL);
      INSERT INTO telegram_thread
        (id,bot_id,chat_id,subject_kind,subject_id,topic_id,status_message_id,state,created_at,updated_at)
      VALUES
        (801,'telegram-m25','42','task','71',NULL,901,'ACTIVE','2026-09-17T00:00:00.000Z','2026-09-17T00:00:01.000Z'),
        (802,'telegram-m25','42','workstation','workstation',NULL,902,'PIN_PENDING','2026-09-17T00:00:02.000Z','2026-09-17T00:00:03.000Z'),
        (803,'telegram-m25','43','task','72','9',NULL,'ANCHOR_GONE','2026-09-17T00:00:04.000Z','2026-09-17T00:00:05.000Z');
      UPDATE telegram_outbox SET thread_id=801 WHERE id=901;
      UPDATE telegram_outbox SET thread_id=802 WHERE id=902;
      DROP TABLE item_link;
      CREATE TABLE telegram_thread_v24 (
        id INTEGER PRIMARY KEY,
        bot_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        subject_kind TEXT NOT NULL CHECK(subject_kind IN ('task','workstation')),
        subject_id TEXT NOT NULL,
        topic_id TEXT,
        status_message_id INTEGER REFERENCES telegram_outbox(id) ON DELETE SET NULL,
        state TEXT NOT NULL CHECK(state IN ('ACTIVE','PIN_PENDING','ANCHOR_GONE')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO telegram_thread_v24 SELECT * FROM telegram_thread;
      DROP TABLE telegram_thread;
      ALTER TABLE telegram_thread_v24 RENAME TO telegram_thread;
      CREATE UNIQUE INDEX telegram_thread_subject_uq ON telegram_thread(bot_id, chat_id, subject_kind, subject_id);
      -- Migration 48 is what the reconcile a641b0c renumbered this migration 25 to.
      DELETE FROM schema_migration WHERE version=48;
    `);
    const beforeThreads = database.prepare("SELECT * FROM telegram_thread ORDER BY id").all();
    const beforeOutboxLinks = database.prepare("SELECT id,thread_id FROM telegram_outbox WHERE id IN (901,902) ORDER BY id").all();
    const beforeIndex = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='telegram_thread_subject_uq'").get();
    const beforeAction = database.prepare("SELECT ref,action,prompt_id,actor_id,chat_id,bot_id,expected_revision,expires_at FROM task_control_action WHERE ref='m25-action'").get();
    database.close();

    for (const run of [1, 2]) {
      const migrated = boot(root);
      assert.equal(migrated.status, 0, `boot ${run}: ${migrated.stderr}`);
      const check = new Database(file);
      try {
        assert.deepEqual(check.prepare("SELECT * FROM telegram_thread ORDER BY id").all(), beforeThreads, `boot ${run} preserves every thread field`);
        assert.deepEqual(check.prepare("SELECT id,thread_id FROM telegram_outbox WHERE id IN (901,902) ORDER BY id").all(), beforeOutboxLinks, `boot ${run} preserves outbox anchor links`);
        assert.deepEqual(check.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='telegram_thread_subject_uq'").get(), beforeIndex, `boot ${run} preserves the C1 unique index`);
        assert.deepEqual(check.prepare("SELECT ref,action,prompt_id,actor_id,chat_id,bot_id,expected_revision,expires_at FROM task_control_action WHERE ref='m25-action'").get(), beforeAction, `boot ${run} preserves the pre-upgrade action`);
        assert.deepEqual(check.prepare("SELECT version FROM schema_migration WHERE version=48").all(), [{ version: 48 }], "migration is recorded once");
        assert.deepEqual(check.pragma("foreign_key_check"), [], "the rebuilt graph has no foreign-key violations");
        assert.deepEqual(check.prepare("PRAGMA table_info(item_link)").all().map((column) => (column as { name: string }).name), ["item_id", "prompt_id", "role", "epoch", "control_head"]);
        assert.doesNotThrow(() => check.prepare("INSERT OR IGNORE INTO telegram_thread(bot_id,chat_id,subject_kind,subject_id,state,created_at,updated_at) VALUES('telegram-m25','42','item','awi1_000000000000000000000000','ACTIVE','now','now')").run());
        assert.throws(() => check.prepare("INSERT INTO telegram_thread(bot_id,chat_id,subject_kind,subject_id,state,created_at,updated_at) VALUES('telegram-m25','42','unknown','x','ACTIVE','now','now')").run());
        check.prepare("DELETE FROM telegram_thread WHERE subject_kind='item' AND subject_id='awi1_000000000000000000000000'").run();
      } finally {
        check.close();
      }
    }
    const applied = runWorkspaceScript(root, `
      const { workspaces } = await import('./src/workspaces.ts');
      const input = { commandId: 'm25-command', actionRef: 'm25-action', state: 'APPLIED', started: true, runId: 'm25-run', message: 'Answer saved and resume requested.' };
      const first = workspaces.recordTaskControlReceipt(input);
      const duplicate = workspaces.recordTaskControlReceipt(input);
      if (first.commandId !== duplicate.commandId || !duplicate.started || duplicate.runId !== 'm25-run') process.exitCode = 2;
      workspaces.close();
    `);
    assert.equal(applied.status, 0, applied.stderr);
    const restarted = boot(root);
    assert.equal(restarted.status, 0, restarted.stderr);
    const final = new Database(file, { readonly: true });
    try {
      assert.deepEqual(final.prepare("SELECT command_id,state,started,run_id FROM task_control_receipt WHERE action_ref='m25-action'").all(), [{ command_id: "m25-command", state: "APPLIED", started: 1, run_id: "m25-run" }], "the pre-upgrade card records one applied resume receipt across restart");
      assert.equal((final.prepare("SELECT applied_command_id appliedCommandId FROM task_control_action WHERE ref='m25-action'").get() as { appliedCommandId: string }).appliedCommandId, "m25-command");
    } finally {
      final.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TM-T0-5-28: migration 28 marks the anchors exactly once and preserves every outbox row", () => {
  const root = mkdtempSync(join(tmpdir(), "f07-migration-28-"));
  try {
    mkdirSync(join(root, ".agent-console"), { recursive: true });
    mkdirSync(join(root, "workspace"));
    const first = boot(root);
    assert.equal(first.status, 0, first.stderr);

    const file = join(root, ".agent-console/console.sqlite");
    const database = new Database(file);
    database.pragma("foreign_keys = OFF");
    // A chat as F07 finds one: an item thread holding its anchor, a workstation
    // panel still awaiting its pin, an item thread whose anchor was retired by a
    // send that failed for good (B9), an ordinary message inside a thread, and a
    // personal message belonging to no thread at all.
    database.exec(`
      INSERT INTO telegram_outbox
        (id,bot_id,chat_id,topic_id,payload_json,state,attempt_count,last_error,created_at,updated_at,next_attempt_at,sent_message_id,operation,target_outbox_id,payload_version,thread_id)
      VALUES
        (911,'telegram-m28','-42',NULL,'{"kind":"view","text":"item anchor","entities":[],"buttons":[]}','SENT',1,NULL,'2026-09-19T00:00:00.000Z','2026-09-19T00:00:01.000Z',NULL,'601','send',NULL,0,NULL),
        (912,'telegram-m28','-42',NULL,'{"kind":"view","text":"workstation panel","entities":[],"buttons":[]}','QUEUED',0,NULL,'2026-09-19T00:00:02.000Z','2026-09-19T00:00:02.000Z',NULL,NULL,'send',NULL,0,NULL),
        (913,'telegram-m28','-42',NULL,'{"kind":"view","text":"retired anchor","entities":[],"buttons":[]}','FAILED',1,'Bad Request: chat not found','2026-09-19T00:00:03.000Z','2026-09-19T00:00:04.000Z',NULL,NULL,'send',NULL,0,NULL),
        (914,'telegram-m28','-42',NULL,'{"kind":"text","text":"Item not found."}','SENT',1,NULL,'2026-09-19T00:00:05.000Z','2026-09-19T00:00:06.000Z',NULL,'602','send',NULL,0,NULL),
        (915,'telegram-m28','77',NULL,'{"kind":"text","text":"Paired."}','SENT',1,NULL,'2026-09-19T00:00:07.000Z','2026-09-19T00:00:08.000Z',NULL,'603','send',NULL,0,NULL);
      INSERT INTO telegram_thread
        (id,bot_id,chat_id,subject_kind,subject_id,topic_id,status_message_id,state,created_at,updated_at)
      VALUES
        (811,'telegram-m28','-42','item','awi1_1111111111111111111111aa',NULL,911,'ACTIVE','2026-09-19T00:00:00.000Z','2026-09-19T00:00:01.000Z'),
        (812,'telegram-m28','-42','workstation','workstation',NULL,912,'PIN_PENDING','2026-09-19T00:00:02.000Z','2026-09-19T00:00:02.000Z'),
        (813,'telegram-m28','-42','item','awi1_2222222222222222222222bb',NULL,NULL,'ANCHOR_GONE','2026-09-19T00:00:03.000Z','2026-09-19T00:00:04.000Z');
      UPDATE telegram_outbox SET thread_id=811 WHERE id IN (911,914);
      UPDATE telegram_outbox SET thread_id=812 WHERE id=912;
      UPDATE telegram_outbox SET thread_id=813 WHERE id=913;
      ALTER TABLE telegram_outbox DROP COLUMN anchor;
      -- Migration 51 is what the reconcile a641b0c renumbered this migration 28 to.
      DELETE FROM schema_migration WHERE version=51;
    `);
    const OUTBOX_COLUMNS = "id,bot_id,chat_id,topic_id,payload_json,state,attempt_count,last_error,created_at,updated_at,next_attempt_at,sent_message_id,operation,target_outbox_id,payload_version,thread_id";
    const beforeOutbox = database.prepare(`SELECT ${OUTBOX_COLUMNS} FROM telegram_outbox ORDER BY id`).all();
    const beforeThreads = database.prepare("SELECT * FROM telegram_thread ORDER BY id").all();
    const beforeIndex = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='telegram_outbox_state_idx'").get();
    assert.equal(beforeOutbox.length, 5);
    assert.deepEqual(database.prepare("PRAGMA table_info(telegram_outbox)").all().map(column => (column as { name: string }).name).filter(name => name === "anchor"), [], "the pre-28 table has no anchor column");
    database.close();

    // Twice, because a migration that is not idempotent fails the second boot with
    // a duplicate column, and a backfill that is not would re-mark rows the app has
    // since changed.
    for (const run of [1, 2]) {
      const migrated = boot(root);
      assert.equal(migrated.status, 0, `boot ${run}: ${migrated.stderr}`);
      const check = new Database(file, { readonly: true });
      try {
        const columns = check.prepare("PRAGMA table_info(telegram_outbox)").all().map(column => (column as { name: string }).name);
        assert.deepEqual(columns.filter(name => name === "anchor"), ["anchor"], `boot ${run} adds the column exactly once`);
        assert.deepEqual(check.prepare("SELECT version FROM schema_migration WHERE version=51").all(), [{ version: 51 }], `boot ${run} records the migration once`);

        // The backfill marks precisely the rows a thread still points at. Row 913 is
        // the anchor a permanently failed send retired, and nothing in the schema
        // records that any more; it stays 0, which is safe because a thread with no
        // anchor history is due one, so the first pass after the upgrade offers one.
        assert.deepEqual(
          check.prepare("SELECT id,anchor FROM telegram_outbox ORDER BY id").all(),
          [{ id: 911, anchor: 1 }, { id: 912, anchor: 1 }, { id: 913, anchor: 0 }, { id: 914, anchor: 0 }, { id: 915, anchor: 0 }],
          `boot ${run} marks only the rows a thread points at`,
        );
        assert.deepEqual(check.prepare(`SELECT ${OUTBOX_COLUMNS} FROM telegram_outbox ORDER BY id`).all(), beforeOutbox, `boot ${run} leaves every other outbox field, state and thread link unchanged`);
        assert.deepEqual(check.prepare("SELECT * FROM telegram_thread ORDER BY id").all(), beforeThreads, `boot ${run} leaves every thread row and anchor pointer unchanged`);
        assert.deepEqual(check.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='telegram_outbox_state_idx'").get(), beforeIndex, `boot ${run} preserves the outbox index`);
        assert.deepEqual(check.pragma("foreign_key_check"), [], `boot ${run} leaves no foreign-key violation`);
      } finally {
        check.close();
      }
    }

    // A row queued after the upgrade is an anchor only when it was offered as one.
    const queued = runWorkspaceScript(root, `
      const { workspaces } = await import('./src/workspaces.ts');
      const subject = { kind: 'item', id: 'awi1_1111111111111111111111aa' };
      const plain = workspaces.enqueueTelegramOutbox({ botId: 'telegram-m28', chatId: '-42', payload: { kind: 'text', text: 'Item access' }, subject });
      const anchored = workspaces.enqueueTelegramOutbox({ botId: 'telegram-m28', chatId: '-42', payload: { kind: 'text', text: 'anchor' }, subject: { kind: 'item', id: 'awi1_2222222222222222222222bb' }, anchor: { pin: true } });
      console.log(JSON.stringify({ plain, anchored }));
      workspaces.close();
    `);
    assert.equal(queued.status, 0, queued.stderr);
    const ids = JSON.parse(queued.stdout.trim().split("\n").at(-1)!) as { plain: number; anchored: number };
    const after = new Database(file, { readonly: true });
    try {
      assert.equal((after.prepare("SELECT anchor FROM telegram_outbox WHERE id=?").get(ids.plain) as { anchor: number }).anchor, 0, "an ordinary message in an item thread is not an anchor");
      assert.equal((after.prepare("SELECT anchor FROM telegram_outbox WHERE id=?").get(ids.anchored) as { anchor: number }).anchor, 1, "a row offered as the anchor is recorded as one");
    } finally {
      after.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T12 item links mint one opaque identity reused by item threads and tags", () => {
  const directory = mkdtempSync(join(tmpdir(), "tm2-item-link-"));
  const workspace = workspaces.create({ name: directory, workDirectory: directory });
  try {
    const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
    const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
    const prompt = workspaces.createChild("prompt", suite.id, { title: "Shared task", content: "Discuss it" }) as PromptRecord;
    const link = workspaces.createItemLink({ promptId: prompt.id, role: "requester", epoch: 1, controlHead: "abc123" });
    assert.match(link.itemId, /^awi1_[a-f0-9]{24}$/);
    assert.deepEqual(workspaces.createItemLink({ promptId: prompt.id, role: "requester", epoch: 1, controlHead: "abc123" }), link, "a retry reuses the persisted identity");
    assert.deepEqual(workspaces.itemLink(link.itemId), link);
    assert.deepEqual(workspaces.itemLinksForPrompt(prompt.id), [link]);
    assert.deepEqual(itemSubject(link.itemId), { kind: "item", id: link.itemId });
    const first = workspaces.telegramThreadFor({ botId: "telegram-item", chatId: "team-chat", subject: itemSubject(link.itemId) });
    const again = workspaces.telegramThreadFor({ botId: "telegram-item", chatId: "team-chat", subject: itemSubject(link.itemId) });
    assert.equal(again.id, first.id, "the item reuses C1's one-thread-per-subject registry");
    assert.equal(itemTag(link.itemId), itemTag(link.itemId), "the item tag is deterministic");
    assert.match(itemTag(link.itemId), /^#[A-Za-z0-9_]+$/);
    assert.equal(itemTag(link.itemId), `#item_${link.itemId.slice(5)}`);
    assert.throws(
      () => workspaces.createItemLink({ itemId: link.itemId, promptId: prompt.id, role: "executor", epoch: 1 }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "conflict",
    );
  } finally {
    workspaces.removeTelegramRecordsForBot("telegram-item");
    workspaces.remove(workspace.id);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("T12 item ids are short, opaque and do not embed local identifiers", () => {
  const first = mintItemId();
  const second = mintItemId();
  assert.notEqual(first, second);
  assert.ok(first.length <= 32);
  for (const localIdentifier of [process.cwd(), "/tmp/team-item", "task-42", "telegram-user-101"]) {
    assert.equal(first.includes(localIdentifier), false);
  }
  assert.throws(() => itemTag("local/path/task-42"));
});

test("TM-T1-6 registry: one item anchor is edited in place and ANCHOR_GONE accepts one replacement", () => {
  const directory = mkdtempSync(join(tmpdir(), "tm2-item-anchor-"));
  const workspace = workspaces.create({ name: "anchor-workspace", workDirectory: directory });
  const botId = "telegram-item-anchor";
  const chatId = "-100600";
  try {
    const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
    const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
    const prompt = workspaces.createChild("prompt", suite.id, { title: "Shared task", content: "Discuss it" }) as PromptRecord;
    const link = workspaces.createItemLink({ promptId: prompt.id, role: "requester", epoch: 1 });
    const subject = itemSubject(link.itemId);
    const firstPayload = { kind: "view", text: `Open\n${itemTag(link.itemId)}`, entities: [], buttons: [] };
    const first = workspaces.enqueueTelegramOutbox({ botId, chatId, payload: firstPayload, subject, anchor: { pin: true } });
    const thread = workspaces.telegramThreadFor({ botId, chatId, subject });
    assert.equal(thread.statusMessageId, first);
    assert.equal(thread.state, "PIN_PENDING");
    workspaces.markTelegramOutbox(first, "SENT", null, { sentMessageId: "701" });
    workspaces.markTelegramThreadPinAttempted(thread.id);
    assert.equal(workspaces.telegramItemThreadForMessage(botId, chatId, "701")?.subjectId, link.itemId);

    const changedPayload = { ...firstPayload, text: `Blocked\n${itemTag(link.itemId)}` };
    const edit = workspaces.enqueueTelegramEdit({ botId, targetOutboxId: first, payload: changedPayload });
    assert.deepEqual(workspaces.telegramThreadAnchorDelivery(thread.id), {
      outboxId: first,
      messageId: "701",
      desiredPayload: changedPayload,
      deliveredPayload: firstPayload,
      pendingEdit: true,
    });
    workspaces.markTelegramOutbox(edit, "SENT");
    assert.deepEqual(workspaces.telegramThreadAnchorDelivery(thread.id)?.deliveredPayload, changedPayload);

    assert.equal(workspaces.markTelegramThreadAnchorGone(first), 1);
    assert.equal(workspaces.telegramItemThreadForMessage(botId, chatId, "701"), null);
    const replacement = workspaces.enqueueTelegramOutbox({ botId, chatId, payload: changedPayload, subject, anchor: { pin: true } });
    assert.notEqual(replacement, first);
    assert.equal(workspaces.telegramThreadFor({ botId, chatId, subject }).statusMessageId, replacement);
    assert.equal(workspaces.telegramOutboxRow(replacement)?.replyToMessageId, null, "an anchor never replies to itself");
  } finally {
    workspaces.removeTelegramRecordsForBot(botId);
    workspaces.remove(workspace.id);
    rmSync(directory, { recursive: true, force: true });
  }
});

/*
 * M-15, the record half. `closeItemLink` writes the thread row to CLOSED as well
 * as the link, and this asserts the write rather than a rendering of it.
 *
 * It exists because the rendering test alone was not enough. Migration 54 widens
 * the thread-state CHECK, and it was first placed beside migration 53 - earlier
 * in `workspaces.ts` but numbered higher - where migration 48's rebuild of
 * `telegram_thread` silently put the old three-value CHECK back. The server tier
 * was green throughout and a T1 row caught it, with
 * `CHECK constraint failed: state IN ('ACTIVE','PIN_PENDING','ANCHOR_GONE')`.
 * So the write now has a test at the tier that runs in seconds.
 */
test("M-15: closing an item link writes the thread row to CLOSED, and leaves ANCHOR_GONE alone", () => {
  const directory = mkdtempSync(join(tmpdir(), "m15-close-thread-"));
  const workspace = workspaces.create({ name: directory, workDirectory: directory });
  try {
    const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
    const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
    const prompt = workspaces.createChild("prompt", suite.id, { title: "Closed thread", content: "Decide it" }) as PromptRecord;
    const link = workspaces.createItemLink({ promptId: prompt.id, role: "requester", epoch: 1 });
    const thread = workspaces.telegramThreadFor({ botId: "telegram-m15", chatId: "team-chat", subject: itemSubject(link.itemId) });
    assert.equal(thread.state, "ACTIVE", "a fresh item thread starts ACTIVE");

    assert.equal(workspaces.closeItemLink({ itemId: link.itemId, commandId: "close-m15" }), true);
    assert.equal(
      workspaces.telegramThreadFor({ botId: "telegram-m15", chatId: "team-chat", subject: itemSubject(link.itemId) }).state,
      "CLOSED",
      "the close says so on the thread row too",
    );
    // It stays routable, which is the whole reason the views say it rather than
    // the row being consulted: telegramItemThreadForMessage filters ANCHOR_GONE.
    assert.notEqual(
      workspaces.telegramThreadFor({ botId: "telegram-m15", chatId: "team-chat", subject: itemSubject(link.itemId) }).state,
      "ANCHOR_GONE",
      "and does not make the thread unreachable",
    );

    // A second item whose anchor was deleted in Telegram keeps ANCHOR_GONE: that
    // records a fact about the message, which closing the item does not change.
    const gone = workspaces.createItemLink({ promptId: prompt.id, role: "executor", epoch: 1 });
    const goneThread = workspaces.telegramThreadFor({ botId: "telegram-m15", chatId: "team-chat", subject: itemSubject(gone.itemId) });
    const outboxId = workspaces.enqueueTelegramOutbox({
      botId: "telegram-m15", chatId: "team-chat", payload: { kind: "view", text: "anchor", entities: [], buttons: [] },
      subject: itemSubject(gone.itemId), anchor: { pin: true },
    });
    assert.equal(typeof outboxId, "number");
    workspaces.markTelegramThreadAnchorGone(outboxId as number);
    assert.equal(
      workspaces.telegramThreadFor({ botId: "telegram-m15", chatId: "team-chat", subject: itemSubject(gone.itemId) }).state,
      "ANCHOR_GONE",
    );
    assert.equal(goneThread.id > 0, true);
    assert.equal(workspaces.closeItemLink({ itemId: gone.itemId, commandId: "close-m15-gone" }), true);
    assert.equal(
      workspaces.telegramThreadFor({ botId: "telegram-m15", chatId: "team-chat", subject: itemSubject(gone.itemId) }).state,
      "ANCHOR_GONE",
      "ANCHOR_GONE is not overwritten by a close",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
