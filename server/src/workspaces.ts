import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { USAGE_REPORT_PRICING_NOTE, addUsageToTotals, defaultPromptPipelineRule, emptyUsageTotals, estimateCost, isOnBlockedAction, isOnDoneAction, isProviderId, isRunRole, usageFromEvents, type AgentRunActivity, type AgentSession, type AgentStatusOption, type ClarificationExchange, type HandoffBrief, type HandoffRecord, type HandoffRecommendation, type HumanInputRequest, type NormalizedEvent, type OperationsPrompt, type OperationsSession, type OperationsSnapshot, type OperationsSuite, type PipelineAvailablePrompt, type PipelineRecord, type PipelineRun, type PipelineRunDetail, type PipelineStage, type PipelineState, type ProgramRecord, type PromptActivity, type PromptOperationalState, type PromptOption, type PromptPipelineRule, type PromptRecord, type PromptRemark, type PromptStatusEvent, type ProviderId, type RunRole, type SessionUsageRow, type StartUnknownClassification, type SuitePipelineDefaults, type SuitePipelineRun, type SuitePipelineView, type SuiteRecord, type SuiteUsageRow, type SuiteVerificationBadge, type SuiteVerificationContext, type SuiteVerificationDetail, type SuiteVerificationItem, type SuiteVerificationRecord, type SuiteVerificationStats, type SuiteVerificationVerdict, type TaskControlAction, type TaskControlActionReference, type TaskControlReceipt, type TaskUsageRow, type UsageReport, type UsageTotals, type WorkspaceRecord, type WorkspaceTree } from "@agent-console/shared";
import { config } from "./config.ts";
import type { ImportedProgram } from "./promptImport.ts";
import { activeRuns } from "./activeRuns.ts";
import { OPERATIONAL_STATES, operationalState } from "./operationalState.ts";
import { compactWorkItem, deriveVerdict, dossierHeading, parseReportItems, summarize, uniqueCommands } from "./suiteVerification.ts";
import { isItemId, mintItemId } from "./teamItems.ts";
import { isItemGrantCapability, type ItemGrantCapability } from "./teamGrants.ts";

const databasePath = resolve(config.repoRoot, ".agent-console/console.sqlite");
mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
const db = new Database(databasePath);
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
for(const file of [databasePath,`${databasePath}-wal`,`${databasePath}-shm`])if(existsSync(file))chmodSync(file,0o600);

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migration (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
`);

const migrate = db.transaction(() => {
  const version = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
  if (version < 1) {
    db.exec(`
    CREATE TABLE workspace (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      work_directory TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE program (
      id INTEGER PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      overview TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, name), UNIQUE(workspace_id, sort_order)
    );
    CREATE INDEX program_workspace_idx ON program(workspace_id);
    CREATE TABLE suite (
      id INTEGER PRIMARY KEY,
      program_id INTEGER NOT NULL REFERENCES program(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      overview TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(program_id, name), UNIQUE(program_id, sort_order)
    );
    CREATE INDEX suite_program_idx ON suite(program_id);
    CREATE TABLE prompt (
      id INTEGER PRIMARY KEY,
      suite_id INTEGER NOT NULL REFERENCES suite(id) ON DELETE CASCADE,
      title TEXT NOT NULL COLLATE NOCASE,
      content TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(suite_id, title), UNIQUE(suite_id, sort_order)
    );
    CREATE INDEX prompt_suite_idx ON prompt(suite_id);
    `);
    db.prepare("INSERT INTO schema_migration(version, applied_at) VALUES (1, ?)").run(new Date().toISOString());
  }
  if (version < 2) {
    db.exec(`
      ALTER TABLE program ADD COLUMN external_key TEXT;
      ALTER TABLE suite ADD COLUMN external_key TEXT;
      ALTER TABLE prompt ADD COLUMN external_key TEXT;
      ALTER TABLE prompt ADD COLUMN status TEXT NOT NULL DEFAULT 'TODO';
      ALTER TABLE prompt ADD COLUMN completed_at TEXT;
      ALTER TABLE prompt ADD COLUMN result TEXT NOT NULL DEFAULT '';
      ALTER TABLE prompt ADD COLUMN is_gate INTEGER NOT NULL DEFAULT 0;
      CREATE UNIQUE INDEX program_external_key_uq ON program(workspace_id, external_key) WHERE external_key IS NOT NULL;
      CREATE UNIQUE INDEX suite_external_key_uq ON suite(program_id, external_key) WHERE external_key IS NOT NULL;
      CREATE UNIQUE INDEX prompt_external_key_uq ON prompt(suite_id, external_key) WHERE external_key IS NOT NULL;
      CREATE TABLE prompt_dependency (
        prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
        depends_on_prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
        PRIMARY KEY(prompt_id, depends_on_prompt_id),
        CHECK(prompt_id <> depends_on_prompt_id)
      );
      CREATE INDEX prompt_dependency_target_idx ON prompt_dependency(depends_on_prompt_id);
      CREATE TABLE program_gate (
        id INTEGER PRIMARY KEY,
        program_id INTEGER NOT NULL REFERENCES program(id) ON DELETE CASCADE,
        prompt_id INTEGER NOT NULL UNIQUE REFERENCES prompt(id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL,
        UNIQUE(program_id, code), UNIQUE(program_id, sort_order)
      );
      CREATE INDEX program_gate_program_idx ON program_gate(program_id);
    `);
    db.prepare("INSERT INTO schema_migration(version, applied_at) VALUES (2, ?)").run(new Date().toISOString());
  }
  if(version<3){
    db.exec(`
      CREATE TABLE agent_run (
        id TEXT PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        model TEXT,
        state TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        context_token_hash TEXT NOT NULL,
        token_expires_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX active_prompt_run_uq ON agent_run(prompt_id) WHERE state IN ('STARTING','RUNNING');
      CREATE INDEX agent_run_prompt_idx ON agent_run(prompt_id,started_at);
      CREATE TABLE prompt_status_event (
        id INTEGER PRIMARY KEY,
        prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES agent_run(id) ON DELETE SET NULL,
        previous_status TEXT NOT NULL,
        new_status TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        verification_summary TEXT NOT NULL DEFAULT '',
        actor_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX prompt_status_event_prompt_idx ON prompt_status_event(prompt_id,created_at);
      CREATE TABLE prompt_remark (
        id INTEGER PRIMARY KEY,
        prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES agent_run(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX prompt_remark_prompt_idx ON prompt_remark(prompt_id,created_at);
      CREATE TABLE agent_command (
        run_id TEXT NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        response TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id,request_id)
      );
    `);
    const now=new Date().toISOString();
    db.prepare(`INSERT INTO prompt_status_event(prompt_id,previous_status,new_status,reason,verification_summary,actor_type,created_at) SELECT id,status,status,'Imported status',result,'IMPORT',? FROM prompt`).run(now);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(3,?)").run(now);
  }
  if(version<4){
    db.exec(`CREATE TABLE clarification_exchange (id INTEGER PRIMARY KEY,prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,question TEXT NOT NULL,answer TEXT,provider TEXT NOT NULL,model TEXT,state TEXT NOT NULL,created_at TEXT NOT NULL,answered_at TEXT);CREATE INDEX clarification_prompt_idx ON clarification_exchange(prompt_id,created_at);`);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(4,?)").run(new Date().toISOString());
  }
  if(version<5){
    db.exec(`CREATE TABLE agent_run_event (id INTEGER PRIMARY KEY,run_id TEXT NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,event_json TEXT NOT NULL,created_at TEXT NOT NULL);CREATE INDEX agent_run_event_run_idx ON agent_run_event(run_id,id);`);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(5,?)").run(new Date().toISOString());
  }
  if(version<6){
    // Verifications get their own tables rather than riding on agent_run.
    // agent_run.prompt_id is NOT NULL and sixty-odd queries depend on that;
    // relaxing it in SQLite means rebuilding a table that holds real sessions.
    // A verification is also a different thing from a work-item execution: it
    // has a verdict, per-item outcomes and a written report.
    db.exec(`
      CREATE TABLE suite_verification (
        id INTEGER PRIMARY KEY,
        suite_id INTEGER NOT NULL REFERENCES suite(id) ON DELETE CASCADE,
        workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        run_id TEXT,
        provider TEXT,
        model TEXT,
        state TEXT NOT NULL,
        verdict TEXT,
        summary_json TEXT NOT NULL DEFAULT '{}',
        report_markdown TEXT NOT NULL DEFAULT '',
        stats_json TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE INDEX suite_verification_suite_idx ON suite_verification(suite_id,started_at);
      CREATE UNIQUE INDEX suite_verification_run_uq ON suite_verification(run_id) WHERE run_id IS NOT NULL;
      CREATE TABLE suite_verification_item (
        id INTEGER PRIMARY KEY,
        verification_id INTEGER NOT NULL REFERENCES suite_verification(id) ON DELETE CASCADE,
        prompt_id INTEGER REFERENCES prompt(id) ON DELETE SET NULL,
        prompt_key TEXT,
        title TEXT NOT NULL,
        check_result TEXT NOT NULL,
        evidence TEXT NOT NULL DEFAULT '',
        commands TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX suite_verification_item_idx ON suite_verification_item(verification_id,sort_order);
      CREATE TABLE suite_verification_event (
        id INTEGER PRIMARY KEY,
        verification_id INTEGER NOT NULL REFERENCES suite_verification(id) ON DELETE CASCADE,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX suite_verification_event_idx ON suite_verification_event(verification_id,id);
    `);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(6,?)").run(new Date().toISOString());
  }
  if(version<7){
    db.exec(`ALTER TABLE agent_run ADD COLUMN role TEXT NOT NULL DEFAULT 'execute';`);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(7,?)").run(new Date().toISOString());
  }
  if(version<8){
    db.exec(`
      ALTER TABLE suite ADD COLUMN default_provider TEXT;
      ALTER TABLE suite ADD COLUMN default_model TEXT;
      CREATE TABLE prompt_pipeline_rule (
        prompt_id INTEGER PRIMARY KEY REFERENCES prompt(id) ON DELETE CASCADE,
        provider TEXT,
        model TEXT,
        on_done TEXT NOT NULL DEFAULT 'continue'
          CHECK(on_done IN ('continue','stop','skip_rest')),
        on_blocked TEXT NOT NULL DEFAULT 'wait'
          CHECK(on_blocked IN ('wait','retry','recover','skip')),
        retry_limit INTEGER NOT NULL DEFAULT 1
          CHECK(retry_limit BETWEEN 1 AND 5),
        recover_provider TEXT,
        recover_model TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE suite_pipeline_run (
        id TEXT PRIMARY KEY,
        suite_id INTEGER NOT NULL REFERENCES suite(id) ON DELETE CASCADE,
        workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        state TEXT NOT NULL
          CHECK(state IN ('PLAYING','WAITING_HUMAN','PAUSED','COMPLETE','STOPPED','INTERRUPTED')),
        current_prompt_id INTEGER REFERENCES prompt(id) ON DELETE SET NULL,
        current_run_id TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        recovering INTEGER NOT NULL DEFAULT 0,
        play_provider TEXT,
        play_model TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        stop_reason TEXT
      );
      CREATE INDEX suite_pipeline_run_suite_idx ON suite_pipeline_run(suite_id, started_at);
      CREATE UNIQUE INDEX suite_pipeline_active_uq
        ON suite_pipeline_run(suite_id)
        WHERE state IN ('PLAYING','WAITING_HUMAN','PAUSED');
    `);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(8,?)").run(new Date().toISOString());
  }
});
migrate();

{
  // Rebuild agent_run so prompt_id is nullable. SQLite ignores PRAGMA foreign_keys
  // inside a transaction, so this swap sits outside the v1–8 migrate() transaction.
  const version = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
  if (version < 9) {
    db.pragma("foreign_keys = OFF");
    const migrate9 = db.transaction(() => {
      db.exec(`
        CREATE TABLE agent_run_new (
          id TEXT PRIMARY KEY,
          workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          prompt_id INTEGER REFERENCES prompt(id) ON DELETE CASCADE,
          role TEXT NOT NULL DEFAULT 'execute' CHECK(role IN ('execute','consult')),
          provider TEXT NOT NULL,
          model TEXT,
          state TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          context_token_hash TEXT NOT NULL,
          token_expires_at TEXT NOT NULL
        );
        INSERT INTO agent_run_new
          SELECT id, workspace_id, prompt_id, COALESCE(role,'execute'),
                 provider, model, state, started_at, ended_at,
                 context_token_hash, token_expires_at
          FROM agent_run;
        DROP TABLE agent_run;
        ALTER TABLE agent_run_new RENAME TO agent_run;
        CREATE UNIQUE INDEX active_prompt_run_uq
          ON agent_run(prompt_id)
          WHERE state IN ('STARTING','RUNNING') AND role = 'execute';
        CREATE INDEX agent_run_prompt_idx ON agent_run(prompt_id, started_at);
        CREATE INDEX agent_run_workspace_role_idx ON agent_run(workspace_id, role, started_at);
      `);
      db.prepare("INSERT INTO schema_migration(version, applied_at) VALUES(9, ?)").run(new Date().toISOString());
    });
    migrate9();
    db.pragma("foreign_keys = ON");
  }
  const afterNine = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
  if (afterNine < 10) {
    db.exec(`
      ALTER TABLE prompt_pipeline_rule ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE prompt_pipeline_rule ADD COLUMN step_order INTEGER NOT NULL DEFAULT 0;
    `);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(10,?)").run(new Date().toISOString());
  }
  const afterTen = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
  if (afterTen < 11) {
    db.exec(`
      CREATE TABLE pipeline (
        id INTEGER PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, name)
      );
      CREATE INDEX pipeline_workspace_idx ON pipeline(workspace_id);
      CREATE TABLE pipeline_stage (
        pipeline_id INTEGER NOT NULL REFERENCES pipeline(id) ON DELETE CASCADE,
        suite_id INTEGER NOT NULL REFERENCES suite(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL,
        PRIMARY KEY (pipeline_id, suite_id)
      );
      CREATE INDEX pipeline_stage_suite_idx ON pipeline_stage(suite_id);
      CREATE TABLE pipeline_run (
        id TEXT PRIMARY KEY,
        pipeline_id INTEGER NOT NULL REFERENCES pipeline(id) ON DELETE CASCADE,
        workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        state TEXT NOT NULL
          CHECK(state IN ('PLAYING','WAITING_HUMAN','PAUSED','COMPLETE','STOPPED','INTERRUPTED')),
        current_suite_id INTEGER REFERENCES suite(id) ON DELETE SET NULL,
        current_suite_run_id TEXT,
        play_provider TEXT,
        play_model TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        stop_reason TEXT
      );
      CREATE INDEX pipeline_run_pipeline_idx ON pipeline_run(pipeline_id, started_at);
      CREATE UNIQUE INDEX pipeline_run_active_uq
        ON pipeline_run(pipeline_id)
        WHERE state IN ('PLAYING','WAITING_HUMAN','PAUSED');
      ALTER TABLE suite_pipeline_run ADD COLUMN pipeline_run_id TEXT;
    `);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(11,?)").run(new Date().toISOString());
  }
  const afterEleven = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
  if (afterEleven < 12) {
    // Optional scope lets a verification cover one work item without a new table.
    db.exec(`ALTER TABLE suite_verification ADD COLUMN scope_prompt_id INTEGER REFERENCES prompt(id) ON DELETE SET NULL;`);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(12,?)").run(new Date().toISOString());
  }
  const afterTwelve = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
  if (afterTwelve < 13) {
    db.pragma("foreign_keys = OFF");
    const migrate13 = db.transaction(() => {
      db.exec(`
        CREATE TABLE agent_run_handoff (
          id TEXT PRIMARY KEY,
          workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          prompt_id INTEGER REFERENCES prompt(id) ON DELETE CASCADE,
          role TEXT NOT NULL DEFAULT 'execute' CHECK(role IN ('execute','consult','handoff')),
          provider TEXT NOT NULL,
          model TEXT,
          state TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          context_token_hash TEXT NOT NULL,
          token_expires_at TEXT NOT NULL
        );
        INSERT INTO agent_run_handoff SELECT * FROM agent_run;
        DROP TABLE agent_run;
        ALTER TABLE agent_run_handoff RENAME TO agent_run;
        CREATE UNIQUE INDEX active_prompt_run_uq ON agent_run(prompt_id)
          WHERE state IN ('STARTING','RUNNING') AND role = 'execute';
        CREATE INDEX agent_run_prompt_idx ON agent_run(prompt_id,started_at);
        CREATE INDEX agent_run_workspace_role_idx ON agent_run(workspace_id,role,started_at);
        CREATE TABLE handoff (
          id TEXT PRIMARY KEY,
          workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
          prompt_id INTEGER
            NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
          source_run_id TEXT NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
          handoff_run_id TEXT REFERENCES agent_run(id) ON DELETE SET NULL,
          successor_run_id TEXT REFERENCES agent_run(id) ON DELETE SET NULL,
          provider TEXT NOT NULL,
          model TEXT,
          state TEXT NOT NULL CHECK(state IN ('QUEUED','RUNNING','READY','FAILED','SUPERSEDED')),
          recommendation TEXT,
          brief_json TEXT,
          brief_markdown TEXT NOT NULL DEFAULT '',
          error TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          UNIQUE(source_run_id)
        );
        CREATE INDEX handoff_prompt_idx ON handoff(prompt_id,created_at);
        CREATE UNIQUE INDEX handoff_active_prompt_uq ON handoff(prompt_id) WHERE state IN ('QUEUED','RUNNING');
      `);
      db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(13,?)").run(new Date().toISOString());
    });
    migrate13();
    db.pragma("foreign_keys = ON");
  }
}

db.transaction(() => {
  // Each migration is gated on its own recorded row, not on the highest one, so a
  // database missing one step still gets it (and a later one is never re-applied).
  const applied = new Set((db.prepare("SELECT version FROM schema_migration").all() as Array<{ version: number }>).map((row) => row.version));
  const pending = (version: number) => !applied.has(version);
  if (pending(14)) {
    db.exec("ALTER TABLE pipeline ADD COLUMN execution_provider TEXT; ALTER TABLE pipeline ADD COLUMN execution_model TEXT;");
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(14,?)").run(new Date().toISOString());
  }
  if (pending(15)) {
    db.exec(`CREATE TABLE human_response_hold (
      prompt_id INTEGER PRIMARY KEY REFERENCES prompt(id) ON DELETE CASCADE,
      response_id INTEGER NOT NULL REFERENCES prompt_remark(id) ON DELETE CASCADE
    );`);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(15,?)").run(new Date().toISOString());
  }
  if (pending(16)) {
    db.exec(`
      CREATE TABLE task_control_actor (
        id TEXT PRIMARY KEY,
        transport TEXT NOT NULL,
        transport_user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        topic_id TEXT,
        label TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        UNIQUE(transport, transport_user_id, chat_id, topic_id)
      );
      CREATE TABLE task_control_action (
        ref TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK(action IN ('save_human_response','answer_and_resume')),
        prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL REFERENCES task_control_actor(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL,
        topic_id TEXT,
        bot_id TEXT NOT NULL,
        message_id TEXT,
        expected_revision TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        applied_command_id TEXT
      );
      CREATE INDEX task_control_action_prompt_idx ON task_control_action(prompt_id, created_at);
      CREATE TABLE task_control_receipt (
        command_id TEXT PRIMARY KEY,
        action_ref TEXT NOT NULL REFERENCES task_control_action(ref) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK(state IN ('APPLIED','REJECTED')),
        response_id INTEGER,
        started INTEGER NOT NULL DEFAULT 0,
        run_id TEXT,
        message TEXT NOT NULL,
        error_code TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX task_control_receipt_action_applied_uq ON task_control_receipt(action_ref) WHERE state='APPLIED';
      CREATE TABLE telegram_outbox (
        id INTEGER PRIMARY KEY,
        bot_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        topic_id TEXT,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('QUEUED','SENT','FAILED')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX telegram_outbox_state_idx ON telegram_outbox(state, updated_at);
    `);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(16,?)").run(new Date().toISOString());
  }
  if (pending(17)) {
    db.exec(`
      CREATE TABLE telegram_inbox (
        bot_id TEXT NOT NULL,
        update_id INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        processed_at TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(bot_id, update_id)
      );
      CREATE INDEX telegram_inbox_processed_idx ON telegram_inbox(bot_id, processed_at, update_id);
      CREATE TABLE telegram_poll_cursor (
        bot_id TEXT PRIMARY KEY,
        next_update_id INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(17,?)").run(new Date().toISOString());
  }
  if (pending(18)) {
    db.exec(`
      CREATE TABLE task_control_pairing_challenge (
        challenge TEXT PRIMARY KEY,
        transport TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        topic_id TEXT,
        label TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        actor_id TEXT REFERENCES task_control_actor(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(18,?)").run(new Date().toISOString());
  }
  if (pending(19)) {
    db.exec(`
      CREATE TABLE workspace_start_intent (
        id TEXT PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        effective_directory TEXT NOT NULL,
        prompt_id INTEGER REFERENCES prompt(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        model TEXT,
        source TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('START_INTENT','RUNNING','KNOWN_STOPPED','KNOWN_NO_SPAWN','START_UNKNOWN')),
        detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        released_at TEXT
      );
      CREATE UNIQUE INDEX workspace_start_intent_active_dir_uq
        ON workspace_start_intent(effective_directory)
        WHERE released_at IS NULL;
      CREATE INDEX workspace_start_intent_workspace_idx ON workspace_start_intent(workspace_id, created_at);
      CREATE INDEX workspace_start_intent_prompt_idx ON workspace_start_intent(prompt_id, created_at);
    `);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(19,?)").run(new Date().toISOString());
  }
  if (pending(20)) {
    // Live Telegram (L1): durable retry schedule and the Bot API message id of a
    // sent card, plus the answer text a button tap will submit, since Telegram
    // callback data cannot carry it. No token is stored anywhere in this schema.
    db.exec(`
      ALTER TABLE telegram_outbox ADD COLUMN next_attempt_at TEXT;
      ALTER TABLE telegram_outbox ADD COLUMN sent_message_id TEXT;
      CREATE INDEX telegram_outbox_sent_message_idx ON telegram_outbox(bot_id, chat_id, sent_message_id);
      CREATE TABLE telegram_action_content (
        action_ref TEXT PRIMARY KEY REFERENCES task_control_action(ref) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(20,?)").run(new Date().toISOString());
  }
  if (pending(21)) {
    // L3 F1 (RTC-21): an outbox row either sends a new message or edits the
    // message an earlier send row delivered. Queued edits of one message
    // coalesce into a single row; payload_version lets a delivery that raced a
    // newer edit leave the row queued instead of marking the newer text sent.
    db.exec(`
      ALTER TABLE telegram_outbox ADD COLUMN operation TEXT NOT NULL DEFAULT 'send' CHECK(operation IN ('send','edit'));
      ALTER TABLE telegram_outbox ADD COLUMN target_outbox_id INTEGER REFERENCES telegram_outbox(id) ON DELETE CASCADE;
      ALTER TABLE telegram_outbox ADD COLUMN payload_version INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX telegram_outbox_target_idx ON telegram_outbox(target_outbox_id, state);
    `);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(21,?)").run(new Date().toISOString());
  }
  if (pending(22)) {
    // L3 A2 (RTC-22): the options an agent offered with one BLOCKED status. They
    // belong to that status event, not to the task, so a later block replaces
    // them and a stale list can never reach a later question.
    db.exec(`ALTER TABLE prompt_status_event ADD COLUMN options_json TEXT;`);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(22,?)").run(new Date().toISOString());
  }
  if (pending(23)) {
    // L3 C1 (RTC-25): one thread per subject of a chat. Telegram gives this bot no
    // topics, so `topic_id` stays null and every subject resolves to the paired chat;
    // the column exists for C2, which fills it once a real topic recording exists.
    // `status_message_id` is the outbox row carrying the subject's anchor message, not
    // a Bot API id: that row already records the delivered message id, so the registry
    // never holds a second, divergent copy of it.
    db.exec(`
      CREATE TABLE telegram_thread (
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
      CREATE UNIQUE INDEX telegram_thread_subject_uq ON telegram_thread(bot_id, chat_id, subject_kind, subject_id);
      ALTER TABLE telegram_outbox ADD COLUMN thread_id INTEGER REFERENCES telegram_thread(id) ON DELETE SET NULL;
    `);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(23,?)").run(new Date().toISOString());
  }
  if (pending(24)) {
    // TM1: a team roster is a local cache of refs/aw/team. Group actors use a
    // non-null topic sentinel because SQLite considers NULL values distinct in
    // the existing actor uniqueness constraint.
    db.exec(`
      CREATE TABLE team_roster (
        team_id TEXT PRIMARY KEY,
        group_chat_id TEXT NOT NULL,
        remote_url TEXT NOT NULL,
        revision TEXT NOT NULL,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX task_control_actor_team_group_uq
        ON task_control_actor(transport, transport_user_id, chat_id)
        WHERE topic_id='__team_group__';
    `);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(24,?)").run(new Date().toISOString());
  }
})();

{
  const applied = db.prepare("SELECT 1 FROM schema_migration WHERE version=25").get();
  if (!applied) {
    // telegram_outbox points back to telegram_thread. Keep foreign-key actions
    // disabled during the atomic swap so dropping the old parent cannot clear
    // existing thread_id values through ON DELETE SET NULL.
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE telegram_thread_v25 (
            id INTEGER PRIMARY KEY,
            bot_id TEXT NOT NULL,
            chat_id TEXT NOT NULL,
            subject_kind TEXT NOT NULL CHECK(subject_kind IN ('task','workstation','item')),
            subject_id TEXT NOT NULL,
            topic_id TEXT,
            status_message_id INTEGER REFERENCES telegram_outbox(id) ON DELETE SET NULL,
            state TEXT NOT NULL CHECK(state IN ('ACTIVE','PIN_PENDING','ANCHOR_GONE')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO telegram_thread_v25
            (id,bot_id,chat_id,subject_kind,subject_id,topic_id,status_message_id,state,created_at,updated_at)
          SELECT id,bot_id,chat_id,subject_kind,subject_id,topic_id,status_message_id,state,created_at,updated_at
          FROM telegram_thread;
          DROP TABLE telegram_thread;
          ALTER TABLE telegram_thread_v25 RENAME TO telegram_thread;
          CREATE UNIQUE INDEX telegram_thread_subject_uq ON telegram_thread(bot_id, chat_id, subject_kind, subject_id);
          CREATE TABLE item_link (
            item_id TEXT PRIMARY KEY,
            prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK(role IN ('requester','executor')),
            epoch INTEGER NOT NULL CHECK(epoch >= 1),
            control_head TEXT
          );
          CREATE INDEX item_link_prompt_idx ON item_link(prompt_id);
        `);
        db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(25,?)").run(new Date().toISOString());
      })();
    } finally {
      db.pragma("foreign_keys = ON");
    }
    const violations = db.pragma("foreign_key_check") as Array<Record<string, unknown>>;
    if (violations.length > 0) throw new Error(`Migration 25 left ${violations.length} foreign-key violation(s)`);
  }
}

{
  const applied = db.prepare("SELECT 1 FROM schema_migration WHERE version=26").get();
  if (!applied) {
    // Receipts and Telegram action content point back to this table. Disable
    // foreign-key actions only for the atomic swap so those durable rows survive.
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE task_control_action_v26 (
            ref TEXT PRIMARY KEY,
            action TEXT NOT NULL CHECK(action IN ('save_human_response','answer_and_resume','resume_saved','grant','revoke','close_thread')),
            prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
            actor_id TEXT NOT NULL REFERENCES task_control_actor(id) ON DELETE CASCADE,
            chat_id TEXT NOT NULL,
            topic_id TEXT,
            bot_id TEXT NOT NULL,
            message_id TEXT,
            expected_revision TEXT NOT NULL,
            provider TEXT,
            model TEXT,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            applied_command_id TEXT,
            subject_kind TEXT NOT NULL DEFAULT 'task' CHECK(subject_kind IN ('task','item')),
            item_id TEXT REFERENCES item_link(item_id) ON DELETE CASCADE,
            payload_json TEXT,
            CHECK((subject_kind='task' AND item_id IS NULL) OR (subject_kind='item' AND item_id IS NOT NULL))
          );
          INSERT INTO task_control_action_v26
            (ref,action,prompt_id,actor_id,chat_id,topic_id,bot_id,message_id,expected_revision,provider,model,expires_at,created_at,applied_command_id)
          SELECT ref,action,prompt_id,actor_id,chat_id,topic_id,bot_id,message_id,expected_revision,provider,model,expires_at,created_at,applied_command_id
          FROM task_control_action;
          DROP TABLE task_control_action;
          ALTER TABLE task_control_action_v26 RENAME TO task_control_action;
          CREATE INDEX task_control_action_prompt_idx ON task_control_action(prompt_id, created_at);
          CREATE TABLE item_grant (
            item_id TEXT NOT NULL REFERENCES item_link(item_id) ON DELETE CASCADE,
            person_id TEXT NOT NULL,
            capability TEXT NOT NULL CHECK(capability IN ('context','answer','resume')),
            granted_command_id TEXT NOT NULL,
            granted_at TEXT NOT NULL,
            revoked_command_id TEXT,
            revoked_at TEXT,
            CHECK((revoked_command_id IS NULL AND revoked_at IS NULL) OR (revoked_command_id IS NOT NULL AND revoked_at IS NOT NULL))
          );
          CREATE UNIQUE INDEX item_grant_active_uq
            ON item_grant(item_id, person_id, capability)
            WHERE revoked_at IS NULL;
          CREATE INDEX item_grant_item_idx ON item_grant(item_id, person_id, granted_at);
        `);
        db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(26,?)").run(new Date().toISOString());
      })();
    } finally {
      db.pragma("foreign_keys = ON");
    }
    const violations = db.pragma("foreign_key_check") as Array<Record<string, unknown>>;
    if (violations.length > 0) throw new Error(`Migration 26 left ${violations.length} foreign-key violation(s)`);
  }
}

/** Turns a suite_verification row plus its items into the wire shape. */
function hydrateVerification(row:Record<string,unknown>):SuiteVerificationRecord {
  const id=row.id as number;
  const suite=db.prepare(`SELECT s.id,s.external_key key,s.name,g.name programName,w.name workspaceName,w.id workspaceId FROM suite s JOIN program g ON g.id=s.program_id JOIN workspace w ON w.id=g.workspace_id WHERE s.id=?`).get(row.suite_id) as SuiteVerificationRecord["suite"];
  const items=(db.prepare("SELECT prompt_id promptId,prompt_key promptKey,title,check_result check_result,evidence,commands FROM suite_verification_item WHERE verification_id=? ORDER BY sort_order,id").all(id) as Array<Record<string,unknown>>)
    .map(item=>({promptId:item.promptId as number|null,promptKey:item.promptKey as string|null,title:item.title as string,check:item.check_result as SuiteVerificationItem["check"],evidence:item.evidence as string,commands:item.commands as string}));
  const parse=<T,>(value:unknown,fallback:T):T=>{try{return value===null||value===undefined?fallback:JSON.parse(value as string) as T;}catch{return fallback;}};
  return{
    id,
    suite,
    kind:row.kind as SuiteVerificationRecord["kind"],
    runId:row.run_id as string|null,
    provider:row.provider as string|null,
    model:row.model as string|null,
    state:row.state as SuiteVerificationRecord["state"],
    verdict:row.verdict as SuiteVerificationVerdict|null,
    summary:parse(row.summary_json,{total:0,verified:0,warnings:0,failed:0,unverified:0}),
    reportMarkdown:(row.report_markdown as string)??"",
    stats:parse<SuiteVerificationStats|null>(row.stats_json,null),
    scopePromptId:(row.scope_prompt_id as number|null)??null,
    startedAt:row.started_at as string,
    endedAt:row.ended_at as string|null,
    items,
  };
}

const recoverAbandonedRuns=db.transaction(()=>{
  const rows=db.prepare("SELECT id,prompt_id,workspace_id FROM agent_run WHERE state IN ('STARTING','RUNNING')").all() as Array<{id:string;prompt_id:number|null;workspace_id:number}>;
  const now=new Date().toISOString();
  // A verification still marked RUNNING after a restart died with the process;
  // leaving it live would strand the suite badge on "verifying" forever.
  db.prepare("UPDATE suite_verification SET state='INTERRUPTED',ended_at=? WHERE state='RUNNING'").run(now);
  db.prepare("UPDATE handoff SET state='FAILED',error='Server restarted while handoff was active',completed_at=? WHERE state IN ('QUEUED','RUNNING')").run(now);
  for(const row of rows){
    const existing=db.prepare("SELECT id FROM workspace_start_intent WHERE id=? AND released_at IS NULL").get(row.id) as {id:string}|undefined;
    if(existing){
      db.prepare("UPDATE workspace_start_intent SET state='START_UNKNOWN',detail=?,updated_at=? WHERE id=? AND released_at IS NULL")
        .run("Server restarted while this start was not known stopped; ownership remains held.",now,row.id);
      continue;
    }
    const workspace=db.prepare("SELECT work_directory FROM workspace WHERE id=?").get(row.workspace_id) as {work_directory:string}|undefined;
    if(workspace){
      db.prepare("INSERT OR IGNORE INTO workspace_start_intent(id,workspace_id,effective_directory,prompt_id,provider,model,source,state,detail,created_at,updated_at) SELECT id,workspace_id,?,prompt_id,provider,model,'restart-reconciliation','START_UNKNOWN',?,started_at,? FROM agent_run WHERE id=?")
        .run(effectiveDirectory(workspace.work_directory),"Server restarted with an active run row but no in-memory supervisor.",now,row.id);
    }
  }
  db.prepare("UPDATE workspace_start_intent SET state='START_UNKNOWN',detail=?,updated_at=? WHERE released_at IS NULL AND state='START_INTENT'")
    .run("Server restarted after reserving ownership but before spawn was observed.",now);
  const orphaned=db.prepare(`SELECT p.id,(SELECT r.id FROM agent_run r WHERE r.prompt_id=p.id AND r.role='execute' ORDER BY r.started_at DESC LIMIT 1) runId FROM prompt p WHERE p.status='IN_PROGRESS' AND NOT EXISTS(SELECT 1 FROM agent_run active WHERE active.prompt_id=p.id AND active.state IN ('STARTING','RUNNING') AND active.role='execute')`).all() as Array<{id:number;runId:string|null}>;
  for(const prompt of orphaned){const reason="No active agent run exists for this IN_PROGRESS prompt; the latest run ended without a terminal prompt status.";db.prepare("UPDATE prompt SET status='BLOCKED',result=?,updated_at=? WHERE id=?").run(reason,now,prompt.id);db.prepare("INSERT INTO prompt_status_event(prompt_id,run_id,previous_status,new_status,reason,actor_type,created_at) VALUES(?,?,'IN_PROGRESS','BLOCKED',?,'SYSTEM',?)").run(prompt.id,prompt.runId,reason,now);db.prepare("INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,?,'BLOCKER',?,'SYSTEM',?)").run(prompt.id,prompt.runId,reason,now);}
  db.prepare("UPDATE suite_pipeline_run SET state='INTERRUPTED',ended_at=?,stop_reason='server_restart' WHERE state IN ('PLAYING','PAUSED','WAITING_HUMAN')").run(now);
  db.prepare("UPDATE pipeline_run SET state='INTERRUPTED',ended_at=?,stop_reason='server_restart' WHERE state IN ('PLAYING','PAUSED','WAITING_HUMAN')").run(now);
});
recoverAbandonedRuns();

type WorkspaceRow = { id: number; name: string; description: string; work_directory: string; created_at: string; updated_at: string };
type ProgramRow = { id: number; workspace_id: number; name: string; overview: string; sort_order: number; created_at: string; updated_at: string; external_key: string | null };
type SuiteRow = { id: number; program_id: number; name: string; overview: string; sort_order: number; created_at: string; updated_at: string; external_key: string | null; default_provider?: string | null; default_model?: string | null };
type PromptRow = { id: number; suite_id: number; title: string; content: string; sort_order: number; created_at: string; updated_at: string; external_key: string | null; status: PromptRecord["status"]; completed_at: string | null; result: string; is_gate: number };
type PipelineRuleRow = { prompt_id: number; provider: string | null; model: string | null; on_done: string; on_blocked: string; retry_limit: number; recover_provider: string | null; recover_model: string | null; updated_at: string; enabled?: number; step_order?: number };
type PipelineRunRow = { id: string; suite_id: number; workspace_id: number; state: string; current_prompt_id: number | null; current_run_id: string | null; attempt: number; recovering: number; play_provider: string | null; play_model: string | null; started_at: string; ended_at: string | null; stop_reason: string | null; pipeline_run_id: string | null };
type NamedPipelineRow = { id: number; workspace_id: number; name: string; description: string; execution_provider: string | null; execution_model: string | null; created_at: string; updated_at: string };
type NamedPipelineRunRow = { id: string; pipeline_id: number; workspace_id: number; state: string; current_suite_id: number | null; current_suite_run_id: string | null; play_provider: string | null; play_model: string | null; started_at: string; ended_at: string | null; stop_reason: string | null };
type TaskControlActorRow = { id: string; transport: string; transport_user_id: string; chat_id: string; topic_id: string | null; label: string; enabled: number; created_at: string };
export const TEAM_GROUP_TOPIC_SENTINEL = "__team_group__";
export interface TeamRosterCacheRow {
  teamId: string;
  groupChatId: string;
  remoteUrl: string;
  revision: string;
  record: unknown;
  updatedAt: string;
}

export type ItemLinkRole = "requester" | "executor";
export interface ItemLinkRow {
  itemId: string;
  promptId: number;
  role: ItemLinkRole;
  epoch: number;
  controlHead: string | null;
}

export interface ItemGrantRow {
  itemId: string;
  personId: string;
  capability: ItemGrantCapability;
  grantedCommandId: string;
  grantedAt: string;
  revokedCommandId: string | null;
  revokedAt: string | null;
}

/**
 * What a Telegram message is about (L3 C1). `task` is one saved task, `workstation`
 * everything that belongs to the workstation itself; `pipeline` and the L2 kinds are
 * added here when they exist.
 */
export type TelegramSubjectKind = "task" | "workstation" | "item";
export interface TelegramSubject { kind: TelegramSubjectKind; id: string }
/** The one workstation subject of a chat: commands, help, pairing and quota all share it. */
export const WORKSTATION_SUBJECT: TelegramSubject = { kind: "workstation", id: "workstation" };
export const taskSubject = (promptId: number): TelegramSubject => ({ kind: "task", id: String(promptId) });
export const itemSubject = (itemId: string): TelegramSubject => {
  if (!isItemId(itemId)) throw new WorkspaceError(422, "validation_error", "A valid Team item id is required.");
  return { kind: "item", id: itemId };
};

export interface TelegramThreadRow {
  id: number;
  botId: string;
  chatId: string;
  subjectKind: TelegramSubjectKind;
  subjectId: string;
  /** Always null while this bot has no topics; C2 fills it. */
  topicId: string | null;
  /** The outbox row carrying this subject's anchor message, or null when it has none. */
  statusMessageId: number | null;
  state: "ACTIVE" | "PIN_PENDING" | "ANCHOR_GONE";
}

const THREAD_COLUMNS = "SELECT id,bot_id botId,chat_id chatId,subject_kind subjectKind,subject_id subjectId,topic_id topicId,status_message_id statusMessageId,state FROM telegram_thread";
type TaskControlActionRow = { ref: string; action: TaskControlAction; prompt_id: number; actor_id: string; chat_id: string; topic_id: string | null; bot_id: string; message_id: string | null; expected_revision: string; provider: string | null; model: string | null; expires_at: string; created_at: string; applied_command_id: string | null; subject_kind: "task" | "item"; item_id: string | null; payload_json: string | null };
type TaskControlReceiptRow = { command_id: string; action_ref: string; state: TaskControlReceipt["state"]; response_id: number | null; started: number; run_id: string | null; message: string; error_code: string | null; created_at: string; action: TaskControlAction; prompt_id: number };
type StartIntentState = "START_INTENT" | "RUNNING" | "KNOWN_STOPPED" | "KNOWN_NO_SPAWN" | "START_UNKNOWN";
type StartIntentRow = { id: string; workspace_id: number; effective_directory: string; prompt_id: number | null; provider: string; model: string | null; source: string; state: StartIntentState; detail: string | null; created_at: string; updated_at: string; released_at: string | null };

function asProviderId(value: string | null | undefined): ProviderId | null {
  return value !== null && value !== undefined && isProviderId(value) ? value : null;
}

function pipelineRuleDto(promptId: number, row: PipelineRuleRow | undefined): PromptPipelineRule {
  if (row === undefined) return defaultPromptPipelineRule(promptId);
  const onDone = isOnDoneAction(row.on_done) ? row.on_done : "continue";
  const onBlocked = isOnBlockedAction(row.on_blocked) ? row.on_blocked : "wait";
  return {
    promptId,
    provider: asProviderId(row.provider),
    model: row.model,
    onDone,
    onBlocked,
    retryLimit: row.retry_limit,
    recoverProvider: asProviderId(row.recover_provider),
    recoverModel: row.recover_model,
    enabled: row.enabled === 1,
    stepOrder: row.step_order ?? 0,
  };
}

function pipelineRunDto(row: PipelineRunRow): SuitePipelineRun {
  return {
    id: row.id,
    suiteId: row.suite_id,
    workspaceId: row.workspace_id,
    state: row.state as PipelineState,
    currentPromptId: row.current_prompt_id,
    currentRunId: row.current_run_id,
    attempt: row.attempt,
    recovering: row.recovering === 1,
    playProvider: asProviderId(row.play_provider),
    playModel: row.play_model,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    stopReason: row.stop_reason,
    pipelineRunId: row.pipeline_run_id ?? null,
  };
}

function namedPipelineRunDto(row: NamedPipelineRunRow): PipelineRun {
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    workspaceId: row.workspace_id,
    state: row.state as PipelineState,
    currentSuiteId: row.current_suite_id,
    currentSuiteRunId: row.current_suite_run_id,
    playProvider: asProviderId(row.play_provider),
    playModel: row.play_model,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    stopReason: row.stop_reason,
  };
}

function optionalProviderField(value: unknown, field: string): ProviderId | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !isProviderId(value)) {
    throw new WorkspaceError(422, "validation_error", `${field} must be a known provider`, { [field]: "Unknown provider" });
  }
  return value;
}

function optionalModelField(value: unknown, field: string): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new WorkspaceError(422, "validation_error", `${field} must be a string`, { [field]: "Must be a string" });
  const text = value.trim();
  return text === "" ? null : requireText(text, field, 200);
}

const workspaceDto = (row: WorkspaceRow): WorkspaceRecord => ({ id: row.id, name: row.name, description: row.description, workDirectory: row.work_directory, workDirectoryExists: existsSync(row.work_directory), createdAt: row.created_at, updatedAt: row.updated_at });
const promptDto = (row: PromptRow): PromptRecord => ({ id: row.id, suiteId: row.suite_id, title: row.title, content: row.content, sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at, externalKey: row.external_key, status: row.status, completedAt: row.completed_at, result: row.result, isGate: row.is_gate === 1 });

function handoffDto(row:Record<string,unknown>):HandoffRecord {
  let brief:HandoffBrief|null=null;
  try { brief=row.brief_json?JSON.parse(row.brief_json as string) as HandoffBrief:null; } catch { brief=null; }
  return {
    id:row.id as string, workspaceId:row.workspace_id as number, promptId:row.prompt_id as number,
    sourceRunId:row.source_run_id as string, handoffRunId:row.handoff_run_id as string|null,
    successorRunId:row.successor_run_id as string|null, provider:row.provider as ProviderId,
    model:row.model as string|null, state:row.state as HandoffRecord["state"],
    recommendation:row.recommendation as HandoffRecommendation|null, brief,
    briefMarkdown:row.brief_markdown as string, error:row.error as string|null,
    createdAt:row.created_at as string, completedAt:row.completed_at as string|null,
  };
}

function requireText(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new WorkspaceError(422, "validation_error", `${field} must be a string`, { [field]: "Required" });
  const text = value.trim();
  if (!allowEmpty && text === "") throw new WorkspaceError(422, "validation_error", `${field} is required`, { [field]: "Required" });
  if (text.length > max) throw new WorkspaceError(422, "validation_error", `${field} is too long`, { [field]: `Maximum ${max} characters` });
  return text;
}

function directory(value: unknown): string {
  const input = requireText(value, "workDirectory", 4096);
  const absolute = isAbsolute(input) ? resolve(input) : resolve(config.repoRoot, input);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new WorkspaceError(422, "invalid_directory", "Work directory must be an existing directory", { workDirectory: "Directory does not exist" });
  return realpathSync(absolute);
}

function effectiveDirectory(path: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(config.repoRoot, path);
  try { return realpathSync(absolute); }
  catch { return absolute; }
}

function nextOrder(table: "program" | "suite" | "prompt", parentColumn: "workspace_id" | "program_id" | "suite_id", parentId: number): number {
  return (db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM ${table} WHERE ${parentColumn} = ?`).get(parentId) as { value: number }).value;
}

export class WorkspaceError extends Error {
  constructor(public status: number, public code: string, message: string, public fields?: Record<string, string>) { super(message); }
}

export interface AgentPromptContext {
  workspace:{id:number;name:string;workDirectory:string;description:string};
  program:{id:number;externalKey:string|null;name:string;overview:string};
  suite:{id:number;externalKey:string|null;name:string;overview:string};
  prompt:PromptRecord;
  dependencies:Array<{externalKey:string|null;title:string;status:PromptRecord["status"];result:string}>;
  gate:{code:string;name:string;description:string}|null;
  history:{remarks:PromptRemark[];events:PromptStatusEvent[]};
  clarifications:ClarificationExchange[];
}

function sqliteGuard<T>(operation: () => T): T {
  try { return operation(); } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) throw new WorkspaceError(409, "conflict", "A sibling with that name, order, or directory already exists");
    if (error instanceof Error && error.message.includes("FOREIGN KEY constraint failed")) throw new WorkspaceError(404, "not_found", "Parent record was not found");
    throw error;
  }
}

const REMARK_KINDS=new Set(["PROGRESS","FINDING","DECISION_NEEDED","BLOCKER","VERIFICATION","COMPLETION"]);
function commandResult(runId:string,requestId:unknown,operation:string,execute:()=>unknown):unknown {
  if(typeof requestId!=="string"||!/^[-0-9a-zA-Z]{8,100}$/.test(requestId)) throw new WorkspaceError(422,"validation_error","requestId must be a unique 8-100 character identifier");
  const existing=db.prepare("SELECT operation,response FROM agent_command WHERE run_id=? AND request_id=?").get(runId,requestId) as {operation:string;response:string}|undefined;
  if(existing){if(existing.operation!==operation)throw new WorkspaceError(409,"request_id_conflict","requestId was already used for another operation");return JSON.parse(existing.response) as unknown;}
  const response=execute(); db.prepare("INSERT INTO agent_command(run_id,request_id,operation,response,created_at) VALUES(?,?,?,?,?)").run(runId,requestId,operation,JSON.stringify(response),new Date().toISOString()); return response;
}

const beginRunTransaction=db.transaction((args:{runId:string;workspaceId:number;promptId:number;provider:string;model:string|null;tokenHash:string;expiresAt:string;role?:RunRole})=>{
  const prompt=db.prepare(`SELECT p.id,p.status FROM prompt p JOIN suite s ON s.id=p.suite_id JOIN program g ON g.id=s.program_id WHERE p.id=? AND g.workspace_id=?`).get(args.promptId,args.workspaceId) as {id:number;status:PromptRecord["status"]}|undefined;
  if(!prompt)throw new WorkspaceError(404,"not_found","Prompt was not found in this workspace");
  if ((args.role ?? "execute") === "execute" && db.prepare("SELECT 1 FROM human_response_hold WHERE prompt_id=?").get(args.promptId)) {
    throw new WorkspaceError(409, "human_response_held", "Your answer is saved. Use Resume with saved answer before starting this task.");
  }
  const active=db.prepare("SELECT id,provider,model,state,started_at startedAt FROM agent_run WHERE prompt_id=? AND state IN ('STARTING','RUNNING') AND role='execute' ORDER BY started_at DESC LIMIT 1").get(args.promptId) as {id:string;provider:string;model:string|null;state:string;startedAt:string}|undefined;
  if(active)throw new WorkspaceError(409,"prompt_run_active",`This prompt already has an active session: ${active.id} (${active.provider}${active.model?` / ${active.model}`:""}, ${active.state.toLowerCase()}, started ${active.startedAt}). Open Sessions to inspect it before starting another run.`,{runId:active.id,state:active.state,provider:active.provider,startedAt:active.startedAt});
  const now=new Date().toISOString(); db.prepare("INSERT INTO agent_run(id,workspace_id,prompt_id,provider,model,state,started_at,context_token_hash,token_expires_at,role) VALUES(?,?,?,?,?,'STARTING',?,?,?,?)").run(args.runId,args.workspaceId,args.promptId,args.provider,args.model,now,args.tokenHash,args.expiresAt,args.role??"execute");
  if(prompt.status==="TODO"){
    db.prepare("UPDATE prompt SET status='IN_PROGRESS',updated_at=? WHERE id=?").run(now,args.promptId);
    db.prepare("INSERT INTO prompt_status_event(prompt_id,run_id,previous_status,new_status,reason,actor_type,created_at) VALUES(?,?,'TODO','IN_PROGRESS','Agent run started','SYSTEM',?)").run(args.promptId,args.runId,now);
  }
});

function requireActiveExecuteRun(runId:string):{prompt_id:number;role:RunRole} {
  const run=db.prepare("SELECT prompt_id,role FROM agent_run WHERE id=? AND state IN ('STARTING','RUNNING')").get(runId) as {prompt_id:number|null;role:RunRole}|undefined;
  if(!run)throw new WorkspaceError(409,"run_not_active","Run is not active");
  if(run.role!=="execute")throw new WorkspaceError(403,"consult_read_only","Read-only runs cannot post remarks or status.");
  if(run.prompt_id===null)throw new WorkspaceError(409,"run_not_active","Run is not attached to a work item");
  return {prompt_id:run.prompt_id,role:run.role};
}

const beginConsultTransaction=db.transaction((args:{runId:string;workspaceId:number;promptId:number|null;provider:string;model:string|null;tokenHash:string;expiresAt:string})=>{
  if(!db.prepare("SELECT 1 FROM workspace WHERE id=?").get(args.workspaceId))throw new WorkspaceError(404,"not_found","Workspace not found");
  if(args.promptId!==null){
    const prompt=db.prepare(`SELECT p.id FROM prompt p JOIN suite s ON s.id=p.suite_id JOIN program g ON g.id=s.program_id WHERE p.id=? AND g.workspace_id=?`).get(args.promptId,args.workspaceId);
    if(!prompt)throw new WorkspaceError(404,"not_found","Prompt was not found in this workspace");
  }
  const now=new Date().toISOString();
  db.prepare("INSERT INTO agent_run(id,workspace_id,prompt_id,provider,model,state,started_at,context_token_hash,token_expires_at,role) VALUES(?,?,?,?,?,'STARTING',?,?,?,'consult')").run(args.runId,args.workspaceId,args.promptId,args.provider,args.model,now,args.tokenHash,args.expiresAt);
});

const agentRemarkTransaction=db.transaction((runId:string,input:Record<string,unknown>)=>commandResult(runId,input.requestId,"remark",()=>{
  const run=requireActiveExecuteRun(runId);
  const kind=typeof input.kind==="string"?input.kind:"";if(!REMARK_KINDS.has(kind))throw new WorkspaceError(422,"validation_error","Unknown remark kind");const content=requireText(input.content,"content",20000);
  const now=new Date().toISOString();const id=Number(db.prepare("INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,?,?,?, 'AGENT',?)").run(run.prompt_id,runId,kind,content,now).lastInsertRowid);return{id,promptId:run.prompt_id,runId,kind,content,actorType:"AGENT",createdAt:now};
}));

/*
 * Options an agent offers with a BLOCKED status (L3 A2, RTC-22). Optional: a status
 * without them is unchanged. Bounds here are generous because the phone card, not the
 * record, decides what fits; an option whose label is empty is dropped rather than
 * stored, so every stored option can be rendered.
 */
const MAX_STORED_OPTIONS=20;
const MAX_STORED_TRADE_OFFS=10;
function statusOptions(value:unknown):AgentStatusOption[]|null {
  if(value===undefined||value===null)return null;
  if(!Array.isArray(value))throw new WorkspaceError(422,"validation_error","options must be an array of {label, advantages, disadvantages}",{options:"Required"});
  if(value.length>MAX_STORED_OPTIONS)throw new WorkspaceError(422,"validation_error","Too many options",{options:`Maximum ${MAX_STORED_OPTIONS} options`});
  const tradeOffs=(items:unknown,field:string):string[]=>{
    if(items===undefined||items===null)return [];
    if(!Array.isArray(items))throw new WorkspaceError(422,"validation_error",`${field} must be an array of strings`,{[field]:"Required"});
    if(items.length>MAX_STORED_TRADE_OFFS)throw new WorkspaceError(422,"validation_error",`Too many ${field}`,{[field]:`Maximum ${MAX_STORED_TRADE_OFFS} entries`});
    return items.map(item=>requireText(item,field,20000,true)).filter(item=>item!=="");
  };
  const options=value.map(entry=>{
    const item=entry!==null&&typeof entry==="object"?entry as Record<string,unknown>:{};
    return {label:requireText(item.label??"","label",20000,true),advantages:tradeOffs(item.advantages,"advantages"),disadvantages:tradeOffs(item.disadvantages,"disadvantages")};
  }).filter(option=>option.label!=="");
  return options.length>0?options:null;
}

const agentStatusTransaction=db.transaction((runId:string,input:Record<string,unknown>)=>commandResult(runId,input.requestId,"status",()=>{
  const run=requireActiveExecuteRun(runId);
  const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(run.prompt_id) as {status:PromptRecord["status"]};const expected=input.expectedStatus;const target=input.status;
  if(expected!==prompt.status)throw new WorkspaceError(409,"stale_status",`Prompt status is ${prompt.status}, not ${String(expected)}`);
  if(prompt.status!=="IN_PROGRESS"||(target!=="DONE"&&target!=="BLOCKED"))throw new WorkspaceError(422,"invalid_transition","Agents may only change IN_PROGRESS to DONE or BLOCKED");
  const reason=requireText(input.reason,"reason",10000,target==="DONE");const verification=requireText(input.verificationSummary??"","verificationSummary",20000,false);
  if(target==="DONE"&&verification==="")throw new WorkspaceError(422,"validation_error","DONE requires a verification summary");
  if(target==="BLOCKED"&&reason==="")throw new WorkspaceError(422,"validation_error","BLOCKED requires an evidence-based reason");
  if(target==="BLOCKED"&&verification==="")throw new WorkspaceError(422,"validation_error","BLOCKED requires verificationSummary to state the exact action only the human can take");
  const options=target==="BLOCKED"?statusOptions(input.options):null;
  const now=new Date().toISOString();const result=target==="DONE"?verification:`${reason}\n\nRequired human action: ${verification}`;db.prepare("UPDATE prompt SET status=?,result=?,completed_at=?,updated_at=? WHERE id=?").run(target,result,target==="DONE"?now:null,now,run.prompt_id);
  const eventId=Number(db.prepare("INSERT INTO prompt_status_event(prompt_id,run_id,previous_status,new_status,reason,verification_summary,actor_type,created_at,options_json) VALUES(?,?,?,?,?,?,'AGENT',?,?)").run(run.prompt_id,runId,prompt.status,target,reason,verification,now,options===null?null:JSON.stringify(options)).lastInsertRowid);
  db.prepare("INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,?,?,?, 'AGENT',?)").run(run.prompt_id,runId,target==="DONE"?"COMPLETION":"BLOCKER",result,now);
  return{eventId,promptId:run.prompt_id,previousStatus:prompt.status,status:target,result,createdAt:now,options:options??[]};
}));

const importProgramTransaction = db.transaction((workspaceId: number, pack: ImportedProgram): number => {
  if (!db.prepare("SELECT 1 FROM workspace WHERE id=?").get(workspaceId)) throw new WorkspaceError(404,"not_found","Workspace not found");
  if (db.prepare("SELECT 1 FROM program WHERE workspace_id=? AND external_key=?").get(workspaceId,pack.key)) throw new WorkspaceError(409,"conflict",`Program ${pack.key} already exists in this workspace`);
  const now=new Date().toISOString();
  db.prepare("UPDATE workspace SET description=?,updated_at=? WHERE id=?").run(pack.workspaceDescription,now,workspaceId);
  const programOrder=nextOrder("program","workspace_id",workspaceId);
  const programId=Number(db.prepare("INSERT INTO program(workspace_id,name,overview,sort_order,created_at,updated_at,external_key) VALUES(?,?,?,?,?,?,?)").run(workspaceId,pack.name,pack.overview,programOrder,now,now,pack.key).lastInsertRowid);
  const promptIds=new Map<string,number>();
  pack.suites.forEach((suite,suiteOrder)=>{
    const suiteId=Number(db.prepare("INSERT INTO suite(program_id,name,overview,sort_order,created_at,updated_at,external_key) VALUES(?,?,?,?,?,?,?)").run(programId,suite.name,"",suiteOrder,now,now,suite.key).lastInsertRowid);
    suite.prompts.forEach((prompt,promptOrder)=>{
      const promptId=Number(db.prepare("INSERT INTO prompt(suite_id,title,content,sort_order,created_at,updated_at,external_key,status,completed_at,result,is_gate) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(suiteId,prompt.title,prompt.content,promptOrder,now,now,prompt.key,prompt.status,prompt.completedAt,prompt.result,prompt.isGate?1:0).lastInsertRowid);
      promptIds.set(prompt.key,promptId);
    });
  });
  for(const dependency of pack.dependencies) db.prepare("INSERT INTO prompt_dependency(prompt_id,depends_on_prompt_id) VALUES(?,?)").run(promptIds.get(dependency.promptKey),promptIds.get(dependency.dependsOnKey));
  pack.gates.forEach((gate,index)=>db.prepare("INSERT INTO program_gate(program_id,prompt_id,code,name,description,sort_order) VALUES(?,?,?,?,?,?)").run(programId,promptIds.get(gate.promptKey),gate.code,gate.name,gate.description,index));
  return programId;
});

export const workspaces = {
  databasePath,
  list(): WorkspaceRecord[] { return (db.prepare("SELECT * FROM workspace ORDER BY name COLLATE NOCASE").all() as WorkspaceRow[]).map(workspaceDto); },
  get(id: number): WorkspaceRecord {
    const row = db.prepare("SELECT * FROM workspace WHERE id = ?").get(id) as WorkspaceRow | undefined;
    if (!row) throw new WorkspaceError(404, "not_found", "Workspace not found");
    return workspaceDto(row);
  },
  create(input: Record<string, unknown>): WorkspaceRecord { return sqliteGuard(() => {
    const now = new Date().toISOString();
    const result = db.prepare("INSERT INTO workspace(name, description, work_directory, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(requireText(input.name, "name", 120), requireText(input.description ?? "", "description", 64000, true), directory(input.workDirectory), now, now);
    return this.get(Number(result.lastInsertRowid));
  }); },
  update(id: number, input: Record<string, unknown>): WorkspaceRecord { return sqliteGuard(() => {
    const current = this.get(id);
    db.prepare("UPDATE workspace SET name=?, description=?, work_directory=?, updated_at=? WHERE id=?").run(
      input.name === undefined ? current.name : requireText(input.name, "name", 120),
      input.description === undefined ? current.description : requireText(input.description, "description", 64000, true),
      input.workDirectory === undefined ? current.workDirectory : directory(input.workDirectory), new Date().toISOString(), id);
    return this.get(id);
  }); },
  remove(id: number): void { if (db.prepare("DELETE FROM workspace WHERE id=?").run(id).changes === 0) throw new WorkspaceError(404, "not_found", "Workspace not found"); },
  tree(id: number): WorkspaceTree {
    const workspace = this.get(id);
    const programs = (db.prepare("SELECT * FROM program WHERE workspace_id=? ORDER BY sort_order").all(id) as ProgramRow[]).map((p): ProgramRecord => ({ id:p.id, workspaceId:p.workspace_id, name:p.name, overview:p.overview, sortOrder:p.sort_order, createdAt:p.created_at, updatedAt:p.updated_at, externalKey:p.external_key, suites:(db.prepare("SELECT * FROM suite WHERE program_id=? ORDER BY sort_order").all(p.id) as SuiteRow[]).map((s): SuiteRecord => ({ id:s.id, programId:s.program_id, name:s.name, overview:s.overview, sortOrder:s.sort_order, createdAt:s.created_at, updatedAt:s.updated_at, externalKey:s.external_key, prompts:(db.prepare("SELECT * FROM prompt WHERE suite_id=? ORDER BY sort_order").all(s.id) as PromptRow[]).map(promptDto) })) }));
    return { ...workspace, programs };
  },
  pendingHumanQuestion(promptId: number): string | null {
    const prompt = db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as { status: string } | undefined;
    if (!prompt || !["TODO", "BLOCKED"].includes(prompt.status)) return null;
    const handoff = this.handoffsForPrompt(promptId)[0];
    if (!handoff || handoff.state !== "READY" || (handoff.recommendation !== "WAIT_FOR_HUMAN" && !handoff.brief?.blockers.some(item => item.requiresHuman))) return null;
    const since = handoff.completedAt ?? handoff.createdAt;
    if (db.prepare("SELECT 1 FROM prompt_remark WHERE prompt_id=? AND kind='HUMAN_RESPONSE' AND created_at>=? LIMIT 1").get(promptId, since)) return null;
    return handoff.brief?.blockers.filter(item => item.requiresHuman).map(item => [item.description, item.requiredAction].filter(Boolean).join("\n\n")).join("\n\n") || "The handoff agent needs your input. Review its recommendation and provide instructions to continue.";
  },
  humanInputState(promptId: number): PromptActivity["humanInput"] {
    const prompt = db.prepare(`SELECT p.id,p.title,p.content,p.status,p.result,p.updated_at,
      s.overview suite_overview,g.overview program_overview,w.work_directory
      FROM prompt p JOIN suite s ON s.id=p.suite_id JOIN program g ON g.id=s.program_id
      JOIN workspace w ON w.id=g.workspace_id WHERE p.id=?`).get(promptId) as { status: string } | undefined;
    if (!prompt) throw new WorkspaceError(404, "not_found", "Prompt not found");
    const decision = db.prepare("SELECT id,content FROM prompt_remark WHERE prompt_id=? AND kind IN ('BLOCKER','DECISION_NEEDED','HUMAN_RESPONSE') ORDER BY id DESC LIMIT 1").get(promptId) ?? null;
    const event = db.prepare("SELECT id FROM prompt_status_event WHERE prompt_id=? ORDER BY id DESC LIMIT 1").get(promptId) ?? null;
    const handoff = this.handoffsForPrompt(promptId)[0] ?? null;
    const hold = db.prepare("SELECT response_id responseId FROM human_response_hold WHERE prompt_id=?").get(promptId) as { responseId: number } | undefined;
    const revision = createHash("sha256").update(JSON.stringify({ prompt, decision, event, handoff, hold: hold ?? null })).digest("hex");
    return { revision, savedResponseId: prompt.status === "TODO" && this.pendingHumanQuestion(promptId) === null ? hold?.responseId ?? null : null };
  },
  assertHumanInputRevision(promptId: number, expected: unknown): void {
    if (expected === undefined) return; // Legacy local callers have no revision yet.
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw new WorkspaceError(422, "validation_error", "A valid question revision is required.");
    if (this.humanInputState(promptId).revision !== expected) throw new WorkspaceError(409, "question_changed", "The task or question changed. Review it before submitting your answer.");
  },
  upsertTaskControlActor(input: { id: string; transport: "fake_telegram" | "telegram"; transportUserId: string; chatId: string; topicId?: string | null; label: string; enabled?: boolean }): TaskControlActorRow { return sqliteGuard(() => {
    const now = new Date().toISOString();
    const id = requireText(input.id, "id", 120);
    const transportUserId = requireText(input.transportUserId, "transportUserId", 120);
    const chatId = requireText(input.chatId, "chatId", 120);
    const topicId = input.topicId === undefined || input.topicId === null ? null : requireText(input.topicId, "topicId", 120);
    const label = requireText(input.label, "label", 200);
    db.prepare(`
      INSERT INTO task_control_actor(id,transport,transport_user_id,chat_id,topic_id,label,enabled,created_at)
      VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET transport=excluded.transport,transport_user_id=excluded.transport_user_id,chat_id=excluded.chat_id,topic_id=excluded.topic_id,label=excluded.label,enabled=excluded.enabled
    `).run(id, input.transport, transportUserId, chatId, topicId, label, input.enabled === false ? 0 : 1, now);
    return db.prepare("SELECT id,transport,transport_user_id,chat_id,topic_id,label,enabled,created_at FROM task_control_actor WHERE id=?").get(id) as TaskControlActorRow;
  }); },
  createTaskControlPairing(input: { challenge: string; transport: "fake_telegram" | "telegram"; chatId: string; topicId?: string | null; label: string; expiresAt: string }): { challenge: string; expiresAt: string } { return sqliteGuard(() => {
    const expires = new Date(input.expiresAt);
    if (Number.isNaN(expires.getTime())) throw new WorkspaceError(422, "validation_error", "expiresAt must be an ISO timestamp.");
    const challenge = requireText(input.challenge, "challenge", 160);
    db.prepare("INSERT INTO task_control_pairing_challenge(challenge,transport,chat_id,topic_id,label,expires_at,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(challenge, input.transport, requireText(input.chatId, "chatId", 120), input.topicId ?? null, requireText(input.label, "label", 200), input.expiresAt, new Date().toISOString());
    return { challenge, expiresAt: input.expiresAt };
  }); },
  consumeTaskControlPairing(input: { challenge: string; transport: "fake_telegram" | "telegram"; transportUserId: string; chatId: string; topicId?: string | null }): TaskControlActorRow { return sqliteGuard(() => db.transaction(() => {
    const challenge = requireText(input.challenge, "challenge", 160);
    const row = db.prepare("SELECT challenge,transport,chat_id,topic_id,label,expires_at,consumed_at FROM task_control_pairing_challenge WHERE challenge=?").get(challenge) as { challenge: string; transport: string; chat_id: string; topic_id: string | null; label: string; expires_at: string; consumed_at: string | null } | undefined;
    if (!row) throw new WorkspaceError(404, "pairing_not_found", "Pairing challenge was not found.");
    if (row.consumed_at !== null) throw new WorkspaceError(409, "pairing_consumed", "Pairing challenge was already used.");
    if (Date.parse(row.expires_at) <= Date.now()) throw new WorkspaceError(409, "pairing_expired", "Pairing challenge expired.");
    if (row.transport !== input.transport || row.chat_id !== input.chatId || row.topic_id !== (input.topicId ?? null)) throw new WorkspaceError(403, "pairing_context_mismatch", "Pairing challenge belongs to another chat or topic.");
    const actorId = `${input.transport}-${input.transportUserId}-${input.chatId}-${input.topicId ?? "main"}`;
    const actor = this.upsertTaskControlActor({ id: actorId, transport: input.transport, transportUserId: input.transportUserId, chatId: input.chatId, topicId: input.topicId ?? null, label: row.label });
    db.prepare("UPDATE task_control_pairing_challenge SET consumed_at=?,actor_id=? WHERE challenge=?").run(new Date().toISOString(), actor.id, challenge);
    return actor;
  })()); },
  taskControlActorFor(input: { transport: "fake_telegram" | "telegram"; transportUserId: string; chatId: string; topicId?: string | null }): TaskControlActorRow | null {
    const topicId = input.topicId === undefined ? null : input.topicId;
    return (db.prepare("SELECT id,transport,transport_user_id,chat_id,topic_id,label,enabled,created_at FROM task_control_actor WHERE transport=? AND transport_user_id=? AND chat_id=? AND topic_id IS ?").get(input.transport, input.transportUserId, input.chatId, topicId) as TaskControlActorRow | undefined) ?? null;
  },
  taskControlTeamActorFor(input: { transport: "fake_telegram" | "telegram"; transportUserId: string; chatId: string }): TaskControlActorRow | null {
    return (db.prepare("SELECT id,transport,transport_user_id,chat_id,topic_id,label,enabled,created_at FROM task_control_actor WHERE transport=? AND transport_user_id=? AND chat_id=? AND topic_id=?")
      .get(input.transport, input.transportUserId, input.chatId, TEAM_GROUP_TOPIC_SENTINEL) as TaskControlActorRow | undefined) ?? null;
  },
  taskControlActorById(id: string): TaskControlActorRow | null {
    return (db.prepare("SELECT id,transport,transport_user_id,chat_id,topic_id,label,enabled,created_at FROM task_control_actor WHERE id=?").get(id) as TaskControlActorRow | undefined) ?? null;
  },
  taskControlPersonalActor(transport: "fake_telegram" | "telegram", transportUserId: string): TaskControlActorRow | null {
    return (db.prepare("SELECT id,transport,transport_user_id,chat_id,topic_id,label,enabled,created_at FROM task_control_actor WHERE transport=? AND transport_user_id=? AND topic_id IS NULL ORDER BY created_at LIMIT 1").get(transport, requireText(transportUserId, "transportUserId", 120)) as TaskControlActorRow | undefined) ?? null;
  },
  upsertTeamGroupActor(input: { id: string; transport: "fake_telegram" | "telegram"; transportUserId: string; chatId: string; label: string; enabled?: boolean }): TaskControlActorRow {
    return this.upsertTaskControlActor({ ...input, topicId: TEAM_GROUP_TOPIC_SENTINEL });
  },
  teamRoster(teamId: string): TeamRosterCacheRow | null {
    const row = db.prepare("SELECT team_id teamId,group_chat_id groupChatId,remote_url remoteUrl,revision,record_json record,updated_at updatedAt FROM team_roster WHERE team_id=?").get(requireText(teamId, "teamId", 120)) as Omit<TeamRosterCacheRow, "record"> & { record: string } | undefined;
    return row === undefined ? null : { ...row, record: JSON.parse(row.record) as unknown };
  },
  teamRosters(): TeamRosterCacheRow[] {
    const rows = db.prepare("SELECT team_id teamId,group_chat_id groupChatId,remote_url remoteUrl,revision,record_json record,updated_at updatedAt FROM team_roster ORDER BY updated_at DESC").all() as Array<Omit<TeamRosterCacheRow, "record"> & { record: string }>;
    return rows.map(row => ({ ...row, record: JSON.parse(row.record) as unknown }));
  },
  upsertTeamRoster(input: { teamId: string; groupChatId: string; remoteUrl: string; revision: string; record: unknown }): TeamRosterCacheRow {
    const teamId = requireText(input.teamId, "teamId", 120);
    const groupChatId = requireText(input.groupChatId, "groupChatId", 120);
    const remoteUrl = requireText(input.remoteUrl, "remoteUrl", 4096);
    const revision = requireText(input.revision, "revision", 120);
    const updatedAt = new Date().toISOString();
    const record = JSON.stringify(input.record);
    db.prepare(`INSERT INTO team_roster(team_id,group_chat_id,remote_url,revision,record_json,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(team_id) DO UPDATE SET group_chat_id=excluded.group_chat_id,remote_url=excluded.remote_url,revision=excluded.revision,record_json=excluded.record_json,updated_at=excluded.updated_at`)
      .run(teamId, groupChatId, remoteUrl, revision, record, updatedAt);
    return { teamId, groupChatId, remoteUrl, revision, record: input.record, updatedAt };
  },
  createItemLink(input: { itemId?: string; promptId: number; role: ItemLinkRole; epoch: number; controlHead?: string | null }): ItemLinkRow { return sqliteGuard(() => db.transaction(() => {
    if (input.itemId !== undefined && !isItemId(input.itemId)) throw new WorkspaceError(422, "validation_error", "A valid Team item id is required.");
    if (input.role !== "requester" && input.role !== "executor") throw new WorkspaceError(422, "validation_error", "Item role must be requester or executor.");
    if (!Number.isSafeInteger(input.epoch) || input.epoch < 1) throw new WorkspaceError(422, "validation_error", "Item epoch must be a positive integer.");
    const controlHead = input.controlHead === undefined || input.controlHead === null ? null : requireText(input.controlHead, "controlHead", 160);
    if (input.itemId === undefined) {
      const existing = db.prepare("SELECT item_id itemId,prompt_id promptId,role,epoch,control_head controlHead FROM item_link WHERE prompt_id=? AND role=? ORDER BY rowid LIMIT 1").get(input.promptId, input.role) as ItemLinkRow | undefined;
      if (existing) return existing;
    }
    const itemId = input.itemId ?? mintItemId();
    db.prepare("INSERT INTO item_link(item_id,prompt_id,role,epoch,control_head) VALUES(?,?,?,?,?)")
      .run(itemId, input.promptId, input.role, input.epoch, controlHead);
    return { itemId, promptId: input.promptId, role: input.role, epoch: input.epoch, controlHead };
  })()); },
  itemLink(itemId: string): ItemLinkRow | null {
    if (!isItemId(itemId)) return null;
    return (db.prepare("SELECT item_id itemId,prompt_id promptId,role,epoch,control_head controlHead FROM item_link WHERE item_id=?").get(itemId) as ItemLinkRow | undefined) ?? null;
  },
  itemLinksForPrompt(promptId: number): ItemLinkRow[] {
    return db.prepare("SELECT item_id itemId,prompt_id promptId,role,epoch,control_head controlHead FROM item_link WHERE prompt_id=? ORDER BY rowid").all(promptId) as ItemLinkRow[];
  },
  itemLinks(): ItemLinkRow[] {
    return db.prepare("SELECT item_id itemId,prompt_id promptId,role,epoch,control_head controlHead FROM item_link ORDER BY rowid").all() as ItemLinkRow[];
  },
  grantItemCapability(input: { itemId: string; personId: string; capability: ItemGrantCapability; commandId: string; grantedAt?: string }): ItemGrantRow { return sqliteGuard(() => db.transaction(() => {
    if (!isItemId(input.itemId) || this.itemLink(input.itemId) === null) throw new WorkspaceError(404, "item_not_found", "Team item not found.");
    if (!isItemGrantCapability(input.capability)) throw new WorkspaceError(422, "validation_error", "Item capability must be context, answer or resume.");
    const personId = requireText(input.personId, "personId", 160);
    const commandId = requireText(input.commandId, "commandId", 160);
    const existing = db.prepare(`SELECT item_id itemId,person_id personId,capability,granted_command_id grantedCommandId,
      granted_at grantedAt,revoked_command_id revokedCommandId,revoked_at revokedAt
      FROM item_grant WHERE item_id=? AND person_id=? AND capability=? AND revoked_at IS NULL`)
      .get(input.itemId, personId, input.capability) as ItemGrantRow | undefined;
    if (existing !== undefined) return existing;
    const grantedAt = input.grantedAt ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(grantedAt))) throw new WorkspaceError(422, "validation_error", "grantedAt must be an ISO timestamp.");
    db.prepare("INSERT INTO item_grant(item_id,person_id,capability,granted_command_id,granted_at) VALUES(?,?,?,?,?)")
      .run(input.itemId, personId, input.capability, commandId, grantedAt);
    return { itemId: input.itemId, personId, capability: input.capability, grantedCommandId: commandId, grantedAt, revokedCommandId: null, revokedAt: null };
  })()); },
  revokeItemCapability(input: { itemId: string; personId: string; capability: ItemGrantCapability; commandId: string; revokedAt?: string }): boolean { return sqliteGuard(() => {
    if (!isItemGrantCapability(input.capability)) throw new WorkspaceError(422, "validation_error", "Item capability must be context, answer or resume.");
    const revokedAt = input.revokedAt ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(revokedAt))) throw new WorkspaceError(422, "validation_error", "revokedAt must be an ISO timestamp.");
    return db.prepare(`UPDATE item_grant SET revoked_command_id=?,revoked_at=?
      WHERE item_id=? AND person_id=? AND capability=? AND revoked_at IS NULL`)
      .run(requireText(input.commandId, "commandId", 160), revokedAt, input.itemId, requireText(input.personId, "personId", 160), input.capability).changes > 0;
  }); },
  revokeItemGrants(input: { itemId: string; commandId: string; personId?: string; revokedAt?: string }): number { return sqliteGuard(() => {
    const revokedAt = input.revokedAt ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(revokedAt))) throw new WorkspaceError(422, "validation_error", "revokedAt must be an ISO timestamp.");
    const commandId = requireText(input.commandId, "commandId", 160);
    if (input.personId === undefined) {
      return db.prepare("UPDATE item_grant SET revoked_command_id=?,revoked_at=? WHERE item_id=? AND revoked_at IS NULL")
        .run(commandId, revokedAt, input.itemId).changes;
    }
    return db.prepare("UPDATE item_grant SET revoked_command_id=?,revoked_at=? WHERE item_id=? AND person_id=? AND revoked_at IS NULL")
      .run(commandId, revokedAt, input.itemId, requireText(input.personId, "personId", 160)).changes;
  }); },
  revokePersonItemGrants(input: { personId: string; commandId: string; revokedAt?: string }): number { return sqliteGuard(() => {
    const revokedAt = input.revokedAt ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(revokedAt))) throw new WorkspaceError(422, "validation_error", "revokedAt must be an ISO timestamp.");
    return db.prepare("UPDATE item_grant SET revoked_command_id=?,revoked_at=? WHERE person_id=? AND revoked_at IS NULL")
      .run(requireText(input.commandId, "commandId", 160), revokedAt, requireText(input.personId, "personId", 160)).changes;
  }); },
  itemGrants(itemId: string, options?: { activeOnly?: boolean; personId?: string }): ItemGrantRow[] {
    if (!isItemId(itemId)) return [];
    const clauses = ["item_id=?"];
    const values: string[] = [itemId];
    if (options?.activeOnly === true) clauses.push("revoked_at IS NULL");
    if (options?.personId !== undefined) { clauses.push("person_id=?"); values.push(options.personId); }
    return db.prepare(`SELECT item_id itemId,person_id personId,capability,granted_command_id grantedCommandId,
      granted_at grantedAt,revoked_command_id revokedCommandId,revoked_at revokedAt
      FROM item_grant WHERE ${clauses.join(" AND ")} ORDER BY granted_at,rowid`).all(...values) as ItemGrantRow[];
  },
  hasItemCapability(itemId: string, personId: string, capability: ItemGrantCapability): boolean {
    if (!isItemId(itemId) || !isItemGrantCapability(capability)) return false;
    return db.prepare("SELECT 1 FROM item_grant WHERE item_id=? AND person_id=? AND capability=? AND revoked_at IS NULL")
      .get(itemId, personId, capability) !== undefined;
  },
  createTaskControlAction(input: { ref: string; action: TaskControlAction; promptId: number; actorId: string; chatId: string; topicId?: string | null; botId: string; messageId?: string | null; expectedRevision: string; provider?: ProviderId | null; model?: string | null; expiresAt: string; subjectKind?: "task" | "item"; itemId?: string | null; payload?: unknown }): TaskControlActionReference { return sqliteGuard(() => {
    if (!["save_human_response", "answer_and_resume", "resume_saved", "grant", "revoke", "close_thread"].includes(input.action)) throw new WorkspaceError(422, "validation_error", "Unknown task-control action");
    this.assertHumanInputRevision(input.promptId, input.expectedRevision);
    const ref = requireText(input.ref, "ref", 160);
    const actor = db.prepare("SELECT id FROM task_control_actor WHERE id=? AND enabled=1").get(input.actorId);
    if (!actor) throw new WorkspaceError(403, "actor_not_enrolled", "Task-control actor is not enrolled.");
    const expires = new Date(input.expiresAt);
    if (Number.isNaN(expires.getTime())) throw new WorkspaceError(422, "validation_error", "expiresAt must be an ISO timestamp.");
    const chatId = requireText(input.chatId, "chatId", 120);
    const topicId = input.topicId === undefined || input.topicId === null ? null : requireText(input.topicId, "topicId", 120);
    const botId = requireText(input.botId, "botId", 120);
    const messageId = input.messageId === undefined || input.messageId === null ? null : requireText(input.messageId, "messageId", 120);
    const model = input.model === undefined || input.model === null ? null : requireText(input.model, "model", 200);
    const subjectKind = input.subjectKind ?? "task";
    const itemId = input.itemId === undefined || input.itemId === null ? null : input.itemId;
    if (subjectKind === "item") {
      if (itemId === null || !isItemId(itemId)) throw new WorkspaceError(422, "validation_error", "An item action requires a valid Team item id.");
      const link = this.itemLink(itemId);
      if (link === null || link.promptId !== input.promptId) throw new WorkspaceError(409, "item_conflict", "The Team item does not belong to this task.");
    } else if (itemId !== null) {
      throw new WorkspaceError(422, "validation_error", "A task action cannot carry a Team item id.");
    }
    let payloadJson: string | null = null;
    if (input.payload !== undefined) {
      try { payloadJson = JSON.stringify(input.payload); } catch { throw new WorkspaceError(422, "validation_error", "Action payload must be JSON serializable."); }
      if (payloadJson === undefined) throw new WorkspaceError(422, "validation_error", "Action payload must be JSON serializable.");
    }
    db.prepare(`
      INSERT INTO task_control_action(ref,action,prompt_id,actor_id,chat_id,topic_id,bot_id,message_id,expected_revision,provider,model,expires_at,created_at,subject_kind,item_id,payload_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(ref, input.action, input.promptId, input.actorId, chatId, topicId, botId, messageId, input.expectedRevision, input.provider ?? null, model, input.expiresAt, new Date().toISOString(), subjectKind, itemId, payloadJson);
    return { ref, action: input.action, promptId: input.promptId, expectedRevision: input.expectedRevision, expiresAt: input.expiresAt };
  }); },
  taskControlAction(ref: string): TaskControlActionRow | null {
    return (db.prepare("SELECT ref,action,prompt_id,actor_id,chat_id,topic_id,bot_id,message_id,expected_revision,provider,model,expires_at,created_at,applied_command_id,subject_kind,item_id,payload_json FROM task_control_action WHERE ref=?").get(ref) as TaskControlActionRow | undefined) ?? null;
  },
  taskControlReceiptForAction(ref: string): TaskControlReceipt | null {
    const row = db.prepare(`
      SELECT r.command_id,r.action_ref,r.state,r.response_id,r.started,r.run_id,r.message,r.error_code,r.created_at,a.action,a.prompt_id
      FROM task_control_receipt r JOIN task_control_action a ON a.ref=r.action_ref
      WHERE r.action_ref=? AND r.state='APPLIED' ORDER BY r.created_at LIMIT 1
    `).get(ref) as TaskControlReceiptRow | undefined;
    return row ? { commandId: row.command_id, state: row.state, action: row.action, promptId: row.prompt_id, message: row.message, responseId: row.response_id, started: row.started === 1, runId: row.run_id, errorCode: row.error_code, createdAt: row.created_at } : null;
  },
  recordTaskControlReceipt(input: { commandId: string; actionRef: string; state: TaskControlReceipt["state"]; responseId?: number | null; started?: boolean; runId?: string | null; message: string; errorCode?: string | null }): TaskControlReceipt { return sqliteGuard(() => {
    const existing = db.prepare(`
      SELECT r.command_id,r.action_ref,r.state,r.response_id,r.started,r.run_id,r.message,r.error_code,r.created_at,a.action,a.prompt_id
      FROM task_control_receipt r JOIN task_control_action a ON a.ref=r.action_ref
      WHERE r.command_id=?
    `).get(input.commandId) as TaskControlReceiptRow | undefined;
    if (existing) return { commandId: existing.command_id, state: existing.state, action: existing.action, promptId: existing.prompt_id, message: existing.message, responseId: existing.response_id, started: existing.started === 1, runId: existing.run_id, errorCode: existing.error_code, createdAt: existing.created_at };
    const action = this.taskControlAction(input.actionRef);
    if (!action) throw new WorkspaceError(404, "action_not_found", "Task-control action was not found.");
    const now = new Date().toISOString();
    db.prepare("INSERT INTO task_control_receipt(command_id,action_ref,state,response_id,started,run_id,message,error_code,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(input.commandId, input.actionRef, input.state, input.responseId ?? null, input.started === true ? 1 : 0, input.runId ?? null, input.message, input.errorCode ?? null, now);
    if (input.state === "APPLIED") db.prepare("UPDATE task_control_action SET applied_command_id=? WHERE ref=?").run(input.commandId, input.actionRef);
    return { commandId: input.commandId, state: input.state, action: action.action, promptId: action.prompt_id, message: input.message, responseId: input.responseId ?? null, started: input.started === true, runId: input.runId ?? null, errorCode: input.errorCode ?? null, createdAt: now };
  }); },
  /**
   * The thread of one subject in one chat (L3 C1). Created on first use and never
   * duplicated: the same subject always resolves to the same row, and its
   * destination is the chat with `topic_id` (null while Telegram gives this bot no
   * topics, which is exactly the L1 destination).
   */
  telegramThreadFor(input: { botId: string; chatId: string; subject: TelegramSubject }): TelegramThreadRow { return sqliteGuard(() => db.transaction(() => {
    const botId = requireText(input.botId, "botId", 120);
    const chatId = requireText(input.chatId, "chatId", 120);
    const subjectId = requireText(input.subject.id, "subjectId", 120);
    const now = new Date().toISOString();
    db.prepare("INSERT OR IGNORE INTO telegram_thread(bot_id,chat_id,subject_kind,subject_id,topic_id,status_message_id,state,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,'ACTIVE',?,?)")
      .run(botId, chatId, input.subject.kind, subjectId, now, now);
    return db.prepare(`${THREAD_COLUMNS} WHERE bot_id=? AND chat_id=? AND subject_kind=? AND subject_id=?`).get(botId, chatId, input.subject.kind, subjectId) as TelegramThreadRow;
  })()); },
  telegramThreads(botId?: string): TelegramThreadRow[] {
    return (botId === undefined
      ? db.prepare(`${THREAD_COLUMNS} ORDER BY id`).all()
      : db.prepare(`${THREAD_COLUMNS} WHERE bot_id=? ORDER BY id`).all(botId)) as TelegramThreadRow[];
  },
  telegramItemThreadForMessage(botId: string, chatId: string, sentMessageId: string): TelegramThreadRow | null {
    const row = db.prepare(`SELECT t.id,t.bot_id botId,t.chat_id chatId,t.subject_kind subjectKind,t.subject_id subjectId,t.topic_id topicId,t.status_message_id statusMessageId,t.state
      FROM telegram_thread t JOIN telegram_outbox o ON o.id=t.status_message_id
      WHERE t.bot_id=? AND t.chat_id=? AND t.subject_kind='item'
        AND t.state<>'ANCHOR_GONE' AND o.state='SENT' AND o.sent_message_id=?`)
      .get(botId, chatId, sentMessageId) as TelegramThreadRow | undefined;
    return row ?? null;
  },
  telegramThreadAnchorDelivery(threadId: number): { outboxId: number; messageId: string | null; desiredPayload: unknown; deliveredPayload: unknown | null; pendingEdit: boolean } | null {
    const anchor = db.prepare(`SELECT o.id,o.payload_json payload,o.state,o.sent_message_id messageId
      FROM telegram_thread t JOIN telegram_outbox o ON o.id=t.status_message_id WHERE t.id=?`).get(threadId) as { id: number; payload: string; state: string; messageId: string | null } | undefined;
    if (!anchor) return null;
    const latest = db.prepare("SELECT payload_json payload,state,next_attempt_at nextAttemptAt FROM telegram_outbox WHERE operation='edit' AND target_outbox_id=? ORDER BY id DESC LIMIT 1")
      .get(anchor.id) as { payload: string; state: string; nextAttemptAt: string | null } | undefined;
    const delivered = db.prepare("SELECT payload_json payload FROM telegram_outbox WHERE operation='edit' AND target_outbox_id=? AND state='SENT' ORDER BY id DESC LIMIT 1")
      .get(anchor.id) as { payload: string } | undefined;
    return {
      outboxId: anchor.id,
      messageId: anchor.messageId,
      desiredPayload: JSON.parse(latest?.payload ?? anchor.payload) as unknown,
      deliveredPayload: delivered !== undefined ? JSON.parse(delivered.payload) as unknown : anchor.state === "SENT" ? JSON.parse(anchor.payload) as unknown : null,
      pendingEdit: latest !== undefined && (latest.state === "QUEUED" || (latest.state === "FAILED" && latest.nextAttemptAt !== null)),
    };
  },
  /**
   * Records which outbox row carries a subject's anchor. `pin` asks for the one pin
   * a control panel gets; the pin is attempted once after delivery and never again,
   * so a refused pin can never hold up the message.
   */
  setTelegramThreadAnchor(threadId: number, outboxId: number, options: { pin?: boolean } = {}): void {
    db.prepare("UPDATE telegram_thread SET status_message_id=?,state=?,updated_at=? WHERE id=?")
      .run(outboxId, options.pin === true ? "PIN_PENDING" : "ACTIVE", new Date().toISOString(), threadId);
  },
  /** The operator deleted an anchor (its edit or its send failed for good): the next message registers a new one. */
  markTelegramThreadAnchorGone(outboxId: number): number {
    return db.prepare("UPDATE telegram_thread SET status_message_id=NULL,state='ANCHOR_GONE',updated_at=? WHERE status_message_id=?")
      .run(new Date().toISOString(), outboxId).changes;
  },
  /** Anchors whose one pin is still owed and whose message has been delivered. */
  telegramThreadsAwaitingPin(botId: string): Array<{ id: number; chatId: string; messageId: string }> {
    return db.prepare(`SELECT t.id,t.chat_id chatId,o.sent_message_id messageId FROM telegram_thread t JOIN telegram_outbox o ON o.id=t.status_message_id
      WHERE t.bot_id=? AND t.state='PIN_PENDING' AND o.state='SENT' AND o.sent_message_id IS NOT NULL ORDER BY t.id`)
      .all(botId) as Array<{ id: number; chatId: string; messageId: string }>;
  },
  /** The pin was attempted, whatever Telegram answered: a panel is pinned once, never in a loop. */
  markTelegramThreadPinAttempted(threadId: number): void {
    db.prepare("UPDATE telegram_thread SET state='ACTIVE',updated_at=? WHERE id=? AND state='PIN_PENDING'").run(new Date().toISOString(), threadId);
  },
  /**
   * Queues a message. With a `subject`, the destination comes from that subject's
   * thread (C1) rather than from a caller-chosen topic, and the row is recorded
   * against the thread so it is delivered as a reply to the subject's anchor.
   * `anchor` offers this row as the anchor, which it becomes only when the subject
   * has none: an anchor is never silently replaced.
   */
  enqueueTelegramOutbox(input: { botId: string; chatId: string; topicId?: string | null; payload: unknown; subject?: TelegramSubject; anchor?: { pin?: boolean } }): number { return sqliteGuard(() => db.transaction(() => {
    const thread = input.subject === undefined ? null : this.telegramThreadFor({ botId: input.botId, chatId: input.chatId, subject: input.subject });
    const now = new Date().toISOString();
    const id = Number(db.prepare("INSERT INTO telegram_outbox(bot_id,chat_id,topic_id,payload_json,state,created_at,updated_at,thread_id) VALUES(?,?,?,?, 'QUEUED',?,?,?)")
      // The thread owns the destination; while it has no topic of its own (C1: this bot
      // has none), a reply still lands in the topic of the message it answers (F2).
      .run(requireText(input.botId, "botId", 120), requireText(input.chatId, "chatId", 120), thread?.topicId ?? input.topicId ?? null, JSON.stringify(input.payload), now, now, thread?.id ?? null).lastInsertRowid);
    if (thread !== null && input.anchor !== undefined && (thread.statusMessageId === null || thread.state === "ANCHOR_GONE")) {
      this.setTelegramThreadAnchor(thread.id, id, input.anchor);
    }
    return id;
  })()); },
  /**
   * Queues an edit of the message a SENT-or-pending send row delivers. A queued
   * or retrying edit of the same message is replaced rather than stacked, so
   * only the latest content is ever sent. The chat, topic and bot come from the
   * target row, so an edit can never address another chat's message.
   */
  enqueueTelegramEdit(input: { botId: string; targetOutboxId: number; payload: unknown }): number { return sqliteGuard(() => db.transaction(() => {
    const target = db.prepare("SELECT id,bot_id botId,chat_id chatId,topic_id topicId,operation FROM telegram_outbox WHERE id=?").get(input.targetOutboxId) as { id: number; botId: string; chatId: string; topicId: string | null; operation: string } | undefined;
    if (!target || target.botId !== input.botId || target.operation !== "send") throw new WorkspaceError(404, "outbox_target_not_found", "That Telegram message was not sent by this bot.");
    const now = new Date().toISOString();
    const payload = JSON.stringify(input.payload);
    const pending = db.prepare("SELECT id FROM telegram_outbox WHERE target_outbox_id=? AND operation='edit' AND (state='QUEUED' OR (state='FAILED' AND next_attempt_at IS NOT NULL)) ORDER BY id DESC LIMIT 1").get(target.id) as { id: number } | undefined;
    if (pending) {
      // A retrying edit keeps its schedule, so a 429 wait is still honoured.
      db.prepare("UPDATE telegram_outbox SET payload_json=?,payload_version=payload_version+1,updated_at=? WHERE id=?").run(payload, now, pending.id);
      return pending.id;
    }
    return Number(db.prepare("INSERT INTO telegram_outbox(bot_id,chat_id,topic_id,payload_json,state,created_at,updated_at,operation,target_outbox_id) VALUES(?,?,?,?,'QUEUED',?,?,'edit',?)")
      .run(target.botId, target.chatId, target.topicId, payload, now, now, target.id).lastInsertRowid);
  })()); },
  /**
   * `nextAttemptAt` schedules a durable retry of a FAILED row; null leaves it
   * failed for good. `sentMessageId` records the Bot API message id of a SENT row.
   * With `ifPayloadVersion`, a SENT mark applies only if no newer edit replaced
   * the payload meanwhile; otherwise the row stays queued for the newer content.
   */
  markTelegramOutbox(id: number, state: "SENT" | "FAILED", error: string | null = null, delivery: { nextAttemptAt?: string | null; sentMessageId?: string | null; ifPayloadVersion?: number } = {}): void {
    const now = new Date().toISOString();
    if (delivery.ifPayloadVersion !== undefined) {
      const changed = db.prepare("UPDATE telegram_outbox SET state='QUEUED',attempt_count=attempt_count+1,last_error=NULL,updated_at=?,next_attempt_at=NULL WHERE id=? AND payload_version<>?").run(now, id, delivery.ifPayloadVersion).changes;
      if (changed > 0) return;
    }
    db.prepare("UPDATE telegram_outbox SET state=?,attempt_count=attempt_count+1,last_error=?,updated_at=?,next_attempt_at=?,sent_message_id=COALESCE(?,sent_message_id) WHERE id=?")
      .run(state, error, now, state === "FAILED" ? delivery.nextAttemptAt ?? null : null, delivery.sentMessageId ?? null, id);
  },
  /** An unpaired chat must not receive queued edits, which could restore working buttons there. */
  dropQueuedTelegramEdits(botId: string, chatId: string): number {
    return db.prepare("DELETE FROM telegram_outbox WHERE bot_id=? AND chat_id=? AND operation='edit' AND (state='QUEUED' OR (state='FAILED' AND next_attempt_at IS NOT NULL))").run(botId, chatId).changes;
  },
  /**
   * One outbox row with what a sender needs, including an edit's target message id
   * once its send has one, and the anchor its subject's thread replies to (C1):
   * a later message for a subject quotes that subject's anchor, which is how a flat
   * chat shows what belongs together. The anchor itself never replies to itself.
   */
  telegramOutboxRow(id: number): { id: number; botId: string; chatId: string; topicId: string | null; payload: unknown; state: "QUEUED" | "SENT" | "FAILED"; attemptCount: number; operation: "send" | "edit"; payloadVersion: number; replyToMessageId: string | null; targetOutboxId: number | null; target: { state: "QUEUED" | "SENT" | "FAILED"; sentMessageId: string | null; retrying: boolean } | null } | null {
    const row = db.prepare(`SELECT o.id,o.bot_id botId,o.chat_id chatId,o.topic_id topicId,o.payload_json payload,o.state,o.attempt_count attemptCount,o.operation,o.payload_version payloadVersion,o.target_outbox_id targetOutboxId,
      t.state targetState,t.sent_message_id targetMessageId,t.next_attempt_at targetNextAttempt,a.sent_message_id replyToMessageId
      FROM telegram_outbox o
      LEFT JOIN telegram_outbox t ON t.id=o.target_outbox_id
      LEFT JOIN telegram_thread th ON th.id=o.thread_id AND th.state<>'ANCHOR_GONE'
      LEFT JOIN telegram_outbox a ON a.id=th.status_message_id AND a.id<>o.id AND a.state='SENT'
      WHERE o.id=?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as number, botId: row.botId as string, chatId: row.chatId as string, topicId: row.topicId as string | null, payload: JSON.parse(row.payload as string) as unknown,
      state: row.state as "QUEUED" | "SENT" | "FAILED", attemptCount: row.attemptCount as number, operation: row.operation as "send" | "edit", payloadVersion: row.payloadVersion as number,
      replyToMessageId: row.operation === "send" ? (row.replyToMessageId as string | null) ?? null : null,
      targetOutboxId: (row.targetOutboxId as number | null) ?? null,
      target: row.operation === "edit" ? { state: row.targetState as "QUEUED" | "SENT" | "FAILED", sentMessageId: row.targetMessageId as string | null, retrying: row.targetNextAttempt !== null } : null,
    };
  },
  /**
   * Rows a live sender should attempt now: never-sent rows, and failed rows whose retry is due.
   * An edit waits until its target send has a message id; an edit whose send failed for good is due
   * so the sender can record it failed without a Bot API call.
   */
  dueTelegramOutbox(botId: string, now: Date, limit = 20): Array<{ id: number; chatId: string; attemptCount: number }> {
    return db.prepare(`SELECT o.id,o.chat_id chatId,o.attempt_count attemptCount FROM telegram_outbox o LEFT JOIN telegram_outbox t ON t.id=o.target_outbox_id
      WHERE o.bot_id=? AND (o.state='QUEUED' OR (o.state='FAILED' AND o.next_attempt_at IS NOT NULL AND o.next_attempt_at<=?))
        AND (o.operation='send' OR (t.state='SENT' AND t.sent_message_id IS NOT NULL) OR (t.state='FAILED' AND t.next_attempt_at IS NULL))
      ORDER BY o.id LIMIT ?`)
      .all(botId, now.toISOString(), limit) as Array<{ id: number; chatId: string; attemptCount: number }>;
  },
  telegramOutboxCounts(botId: string): { queued: number; retrying: number; failed: number } {
    const row = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN state='QUEUED' THEN 1 ELSE 0 END),0) queued,
      COALESCE(SUM(CASE WHEN state='FAILED' AND next_attempt_at IS NOT NULL THEN 1 ELSE 0 END),0) retrying,
      COALESCE(SUM(CASE WHEN state='FAILED' AND next_attempt_at IS NULL THEN 1 ELSE 0 END),0) failed
      FROM telegram_outbox WHERE bot_id=?`).get(botId) as { queued: number; retrying: number; failed: number };
    return row;
  },
  /** The payload of the card a Telegram message id belongs to, for mapping replies. */
  telegramOutboxBySentMessage(botId: string, chatId: string, sentMessageId: string): { id: number; topicId: string | null; payload: unknown } | null {
    const row = db.prepare("SELECT id,topic_id topicId,payload_json payload FROM telegram_outbox WHERE bot_id=? AND chat_id=? AND sent_message_id=? AND state='SENT' AND operation='send' ORDER BY id DESC LIMIT 1")
      .get(botId, chatId, sentMessageId) as { id: number; topicId: string | null; payload: string } | undefined;
    return row ? { ...row, payload: JSON.parse(row.payload) as unknown } : null;
  },
  teamItemAccessOutbox(botId: string, itemId: string): { id: number; payload: unknown; sentMessageId: string | null } | null {
    if (!isItemId(itemId)) return null;
    const row = db.prepare(`SELECT id,payload_json payload,sent_message_id sentMessageId FROM telegram_outbox
      WHERE bot_id=? AND operation='send' AND json_extract(payload_json,'$.kind')='team_item_access'
        AND json_extract(payload_json,'$.itemId')=? ORDER BY id DESC LIMIT 1`)
      .get(requireText(botId, "botId", 120), itemId) as { id: number; payload: string; sentMessageId: string | null } | undefined;
    return row === undefined ? null : { ...row, payload: JSON.parse(row.payload) as unknown };
  },
  /**
   * Binds question-card actions to the Bot API message that actually carries
   * their buttons, replacing the placeholder id assigned before sending.
   */
  bindTaskControlActionsToMessage(botId: string, refs: string[], messageId: string): void {
    const update = db.prepare("UPDATE task_control_action SET message_id=? WHERE bot_id=? AND ref=?");
    db.transaction(() => { for (const ref of refs) update.run(requireText(messageId, "messageId", 120), botId, ref); })();
  },
  setTelegramActionContent(ref: string, content: string): void { return sqliteGuard(() => {
    const text = requireText(content, "content", 10000);
    db.prepare("INSERT INTO telegram_action_content(action_ref,content,created_at) VALUES(?,?,?) ON CONFLICT(action_ref) DO UPDATE SET content=excluded.content")
      .run(ref, text, new Date().toISOString());
  }); },
  telegramActionContent(ref: string): string | null {
    return (db.prepare("SELECT content FROM telegram_action_content WHERE action_ref=?").get(ref) as { content: string } | undefined)?.content ?? null;
  },
  hasTeamThreadRequestOutbox(botId: string, requestId: string, kind: "team_thread_request" | "team_thread_confirmation"): boolean {
    return db.prepare(`SELECT 1 FROM telegram_outbox
      WHERE bot_id=? AND json_extract(payload_json,'$.kind')=? AND json_extract(payload_json,'$.requestId')=? LIMIT 1`)
      .get(requireText(botId, "botId", 120), kind, requireText(requestId, "requestId", 120)) !== undefined;
  },
  hasTeamThreadRequestActions(requestId: string): boolean {
    return db.prepare(`SELECT 1 FROM telegram_action_content
      WHERE json_extract(content,'$.kind')='team_thread_request_action'
        AND json_extract(content,'$.requestId')=? LIMIT 1`)
      .get(requireText(requestId, "requestId", 120)) !== undefined;
  },
  teamThreadRequestAppliedReceipt(requestId: string): TaskControlReceipt | null {
    const row = db.prepare(`
      SELECT r.command_id,r.action_ref,r.state,r.response_id,r.started,r.run_id,r.message,r.error_code,r.created_at,a.action,a.prompt_id
      FROM task_control_receipt r
      JOIN task_control_action a ON a.ref=r.action_ref
      JOIN telegram_action_content c ON c.action_ref=a.ref
      WHERE r.state='APPLIED'
        AND json_extract(c.content,'$.kind')='team_thread_request_action'
        AND json_extract(c.content,'$.requestId')=?
      ORDER BY r.created_at LIMIT 1
    `).get(requireText(requestId, "requestId", 120)) as TaskControlReceiptRow | undefined;
    return row ? { commandId: row.command_id, state: row.state, action: row.action, promptId: row.prompt_id, message: row.message, responseId: row.response_id, started: row.started === 1, runId: row.run_id, errorCode: row.error_code, createdAt: row.created_at } : null;
  },
  hasTaskControlActionForRevision(input: { promptId: number; actorId: string; botId: string; revision: string }): boolean {
    return db.prepare("SELECT 1 FROM task_control_action WHERE prompt_id=? AND actor_id=? AND bot_id=? AND expected_revision=? LIMIT 1")
      .get(input.promptId, input.actorId, input.botId, input.revision) !== undefined;
  },
  taskControlActors(transport: "fake_telegram" | "telegram"): TaskControlActorRow[] {
    return db.prepare("SELECT id,transport,transport_user_id,chat_id,topic_id,label,enabled,created_at FROM task_control_actor WHERE transport=? AND enabled=1 ORDER BY created_at")
      .all(transport) as TaskControlActorRow[];
  },
  /** Saved tasks in the same attention state the operations view shows as awaiting a response. */
  promptsAwaitingResponse(): PromptOption[] {
    const awaiting: PromptOption[] = [];
    for (const workspace of db.prepare("SELECT id FROM workspace ORDER BY id").all() as Array<{ id: number }>) {
      for (const prompt of this.promptOptions(workspace.id)) {
        if (prompt.status === "DONE" || prompt.status === "SKIPPED") continue;
        if (operationalState(prompt, this.pendingHumanQuestion(prompt.id) !== null) === "AWAITING_RESPONSE") awaiting.push(prompt);
      }
    }
    return awaiting;
  },
  telegramOutbox(): Array<{ id: number; botId: string; chatId: string; topicId: string | null; payload: unknown; state: "QUEUED" | "SENT" | "FAILED"; attemptCount: number; lastError: string | null }> {
    return (db.prepare("SELECT id,bot_id botId,chat_id chatId,topic_id topicId,payload_json payload,state,attempt_count attemptCount,last_error lastError FROM telegram_outbox ORDER BY id").all() as Array<{ id: number; botId: string; chatId: string; topicId: string | null; payload: string; state: "QUEUED" | "SENT" | "FAILED"; attemptCount: number; lastError: string | null }>)
      .map(row => ({ ...row, payload: JSON.parse(row.payload) as unknown }));
  },
  telegramCursor(botId: string): number {
    const row = db.prepare("SELECT next_update_id nextUpdateId FROM telegram_poll_cursor WHERE bot_id=?").get(botId) as { nextUpdateId: number } | undefined;
    return row?.nextUpdateId ?? 0;
  },
  saveTelegramUpdates(botId: string, updates: Array<{ updateId: number; payload: unknown }>): number {
    return sqliteGuard(() => db.transaction(() => {
      const insert = db.prepare("INSERT OR IGNORE INTO telegram_inbox(bot_id,update_id,payload_json,created_at) VALUES(?,?,?,?)");
      const now = new Date().toISOString();
      let saved = 0;
      for (const update of updates) {
        if (!Number.isSafeInteger(update.updateId) || update.updateId < 0) throw new WorkspaceError(422, "invalid_update_id", "Telegram update id must be a non-negative integer.");
        saved += insert.run(requireText(botId, "botId", 120), update.updateId, JSON.stringify(update.payload), now).changes;
      }
      return saved;
    })());
  },
  advanceTelegramCursor(botId: string, nextUpdateId: number): void {
    if (!Number.isSafeInteger(nextUpdateId) || nextUpdateId < 0) throw new WorkspaceError(422, "invalid_update_id", "Telegram cursor must be a non-negative integer.");
    db.prepare("INSERT INTO telegram_poll_cursor(bot_id,next_update_id,updated_at) VALUES(?,?,?) ON CONFLICT(bot_id) DO UPDATE SET next_update_id=excluded.next_update_id,updated_at=excluded.updated_at")
      .run(requireText(botId, "botId", 120), nextUpdateId, new Date().toISOString());
  },
  markTelegramUpdateProcessed(botId: string, updateId: number): void {
    db.prepare("UPDATE telegram_inbox SET processed_at=? WHERE bot_id=? AND update_id=? AND processed_at IS NULL").run(new Date().toISOString(), botId, updateId);
  },
  telegramInbox(botId: string): Array<{ botId: string; updateId: number; payload: unknown; processedAt: string | null; createdAt: string }> {
    return (db.prepare("SELECT bot_id botId,update_id updateId,payload_json payload,processed_at processedAt,created_at createdAt FROM telegram_inbox WHERE bot_id=? ORDER BY update_id").all(botId) as Array<{ botId: string; updateId: number; payload: string; processedAt: string | null; createdAt: string }>)
      .map(row => ({ ...row, payload: JSON.parse(row.payload) as unknown }));
  },
  pendingTelegramInbox(botId: string): Array<{ botId: string; updateId: number; payload: unknown; processedAt: string | null; createdAt: string }> {
    return (db.prepare("SELECT bot_id botId,update_id updateId,payload_json payload,processed_at processedAt,created_at createdAt FROM telegram_inbox WHERE bot_id=? AND processed_at IS NULL ORDER BY update_id").all(botId) as Array<{ botId: string; updateId: number; payload: string; processedAt: string | null; createdAt: string }>)
      .map(row => ({ ...row, payload: JSON.parse(row.payload) as unknown }));
  },
  removeTaskControlActor(id: string): void {
    db.prepare("DELETE FROM task_control_actor WHERE id=?").run(id);
  },
  /** Revokes an actor without deleting the actions and receipts that reference it. */
  /**
   * Unpairing stops future authority (user-flows B29). Actor ids are stable per
   * user and chat, so pairing again re-enables the same actor; its outstanding
   * buttons must not come back to life with it, so they are ended here.
   */
  disableTaskControlActor(id: string): boolean {
    return db.transaction(() => {
      const now = new Date().toISOString();
      const disabled = db.prepare("UPDATE task_control_actor SET enabled=0 WHERE id=? AND enabled=1").run(id).changes > 0;
      if (disabled) {
        db.prepare("UPDATE task_control_action SET expires_at=? WHERE actor_id=? AND expires_at>? AND ref NOT IN (SELECT action_ref FROM task_control_receipt)").run(now, id, now);
      }
      return disabled;
    })();
  },
  removeTelegramRecordsForBot(botId: string): void {
    db.transaction(() => {
      db.prepare("DELETE FROM task_control_receipt WHERE action_ref IN (SELECT ref FROM task_control_action WHERE bot_id=?)").run(botId);
      db.prepare("DELETE FROM telegram_action_content WHERE action_ref IN (SELECT ref FROM task_control_action WHERE bot_id=?)").run(botId);
      db.prepare("DELETE FROM task_control_action WHERE bot_id=?").run(botId);
      db.prepare("DELETE FROM telegram_outbox WHERE bot_id=?").run(botId);
      db.prepare("DELETE FROM telegram_thread WHERE bot_id=?").run(botId);
      db.prepare("DELETE FROM telegram_inbox WHERE bot_id=?").run(botId);
      db.prepare("DELETE FROM telegram_poll_cursor WHERE bot_id=?").run(botId);
      db.prepare("DELETE FROM task_control_pairing_challenge WHERE actor_id IS NULL OR actor_id NOT IN (SELECT id FROM task_control_actor)").run();
    })();
  },
  holdHumanResponse(promptId: number, responseId: number): void {
    const response = db.prepare("SELECT id FROM prompt_remark WHERE prompt_id=? AND kind='HUMAN_RESPONSE' ORDER BY id DESC LIMIT 1").get(promptId) as { id: number } | undefined;
    if (response?.id !== responseId) throw new WorkspaceError(409, "response_changed", "This response is no longer current.");
    db.prepare("INSERT INTO human_response_hold(prompt_id,response_id) VALUES(?,?) ON CONFLICT(prompt_id) DO UPDATE SET response_id=excluded.response_id").run(promptId, responseId);
  },
  releaseHumanResponse(promptId: number, responseId: number): void {
    db.prepare("DELETE FROM human_response_hold WHERE prompt_id=? AND response_id=?").run(promptId, responseId);
  },
  promptOptions(id: number): PromptOption[] {
    this.get(id);
    const rows = db.prepare(`SELECT p.id,p.title,p.content,p.external_key externalKey,p.status,s.id suiteId,s.name suiteName,g.id programId,g.name programName FROM prompt p JOIN suite s ON s.id=p.suite_id JOIN program g ON g.id=s.program_id WHERE g.workspace_id=? ORDER BY g.sort_order,s.sort_order,p.sort_order`).all(id) as Array<Omit<PromptOption, "ready" | "blockedBy" | "currentRun" | "recoverable" | "recovery">>;
    const latest = db.prepare("SELECT id,provider,model,role,state,started_at startedAt,ended_at endedAt FROM agent_run WHERE prompt_id=? ORDER BY CASE WHEN role='execute' AND state IN ('STARTING','RUNNING') THEN 0 ELSE 1 END, started_at DESC LIMIT 1");
    const result = db.prepare("SELECT result FROM prompt WHERE id=?");
    const dependency = db.prepare(`SELECT prerequisite.external_key FROM prompt_dependency d JOIN prompt prerequisite ON prerequisite.id=d.depends_on_prompt_id WHERE d.prompt_id=? AND prerequisite.status<>'DONE' ORDER BY prerequisite.external_key`);
    const hold = db.prepare("SELECT 1 FROM human_response_hold WHERE prompt_id=?");
    const activeIntent = db.prepare("SELECT state,id FROM workspace_start_intent WHERE id=? AND released_at IS NULL");
    const latestUnknownIntent = db.prepare("SELECT id,state FROM workspace_start_intent WHERE prompt_id=? AND released_at IS NULL AND state='START_UNKNOWN' ORDER BY created_at DESC LIMIT 1");
    return rows.map(row => {
      const blockedBy = (dependency.all(row.id) as Array<{ external_key: string }>).map(x => x.external_key);
      const run = latest.get(row.id) as { id: string; provider: string; model: string | null; role: RunRole; state: string; startedAt: string; endedAt: string | null } | undefined;
      const processActive = run ? run.role === "execute" && activeRuns.has(run.id) : false;
      const interrupted = run?.state === "INTERRUPTED" || run?.state === "ERROR";
      const abandoned = row.status === "IN_PROGRESS" && !!run && !processActive && (run.state === "STARTING" || run.state === "RUNNING");
      const promptResult = (result.get(row.id) as { result: string }).result;
      const systemInterrupted = row.status === "BLOCKED" && interrupted && (promptResult.startsWith("Agent process ended") || promptResult.startsWith("No active agent run"));
      const humanResponseHeld = !!hold.get(row.id);
      const intent = run === undefined
        ? latestUnknownIntent.get(row.id) as { id: string; state: StartIntentState } | undefined
        : activeIntent.get(run.id) as { id: string; state: StartIntentState } | undefined;
      const startUnknown = intent?.state === "START_UNKNOWN";
      const recoverable = !startUnknown && blockedBy.length === 0 && (abandoned || systemInterrupted);
      return {
        ...row,
        humanResponseHeld,
        ready: !humanResponseHeld && row.status === "TODO" && blockedBy.length === 0 && this.pendingHumanQuestion(row.id) === null,
        blockedBy,
        currentRun: run ? { ...run, processActive } : null,
        recoverable,
        recovery: startUnknown
          ? {
              kind: "start_unknown",
              message: "Ownership is unknown after restart. Confirm the provider process state outside Agent Console before recovery; recovery stays blocked until the server classifies the previous start as known stopped or no spawn.",
              startIntentId: intent.id,
            }
          : recoverable
            ? {
                kind: "recoverable",
                message: "The previous run is known stopped or did not spawn; recovery can return this work item to ready.",
              }
            : { kind: "none", message: null },
      };
    });
  },
  resolvePrompt(workspaceId: number, promptId: number): PromptOption {
    const row = this.promptOptions(workspaceId).find(prompt => prompt.id === promptId);
    if (!row) throw new WorkspaceError(404, "not_found", "Prompt was not found in this workspace"); return row;
  },
  agentContext(workspaceId:number,promptId:number):AgentPromptContext {
    const row=db.prepare(`SELECT p.*,s.id context_suite_id,s.external_key suite_external_key,s.name suite_name,s.overview suite_overview,g.id context_program_id,g.external_key program_external_key,g.name program_name,g.overview program_overview,w.id context_workspace_id,w.name workspace_name,w.work_directory,w.description workspace_description FROM prompt p JOIN suite s ON s.id=p.suite_id JOIN program g ON g.id=s.program_id JOIN workspace w ON w.id=g.workspace_id WHERE p.id=? AND w.id=?`).get(promptId,workspaceId) as (PromptRow&Record<string,unknown>)|undefined;
    if(!row) throw new WorkspaceError(404,"not_found","Prompt was not found in this workspace");
    const dependencies=db.prepare(`SELECT p.external_key externalKey,p.title,p.status,p.result FROM prompt_dependency d JOIN prompt p ON p.id=d.depends_on_prompt_id WHERE d.prompt_id=? ORDER BY p.external_key`).all(promptId) as AgentPromptContext["dependencies"];
    const gate=db.prepare("SELECT code,name,description FROM program_gate WHERE prompt_id=?").get(promptId) as AgentPromptContext["gate"]|undefined;
    const history=this.promptHistory(promptId);
    return {workspace:{id:Number(row.context_workspace_id),name:String(row.workspace_name),workDirectory:String(row.work_directory),description:String(row.workspace_description)},program:{id:Number(row.context_program_id),externalKey:row.program_external_key as string|null,name:String(row.program_name),overview:String(row.program_overview)},suite:{id:Number(row.context_suite_id),externalKey:row.suite_external_key as string|null,name:String(row.suite_name),overview:String(row.suite_overview)},prompt:promptDto(row),dependencies,gate:gate??null,history:{remarks:[...history.remarks].reverse() as PromptRemark[],events:[...history.events].reverse() as PromptStatusEvent[]},clarifications:this.clarifications(promptId)};
  },
  createChild(kind: "program"|"suite"|"prompt", parentId: number, input: Record<string, unknown>): unknown { return sqliteGuard(() => {
    const now = new Date().toISOString();
    if (kind === "program") { this.get(parentId); const r=db.prepare("INSERT INTO program(workspace_id,name,overview,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(parentId,requireText(input.name,"name",120),requireText(input.overview??"","overview",10000,true),nextOrder("program","workspace_id",parentId),now,now); return this.tree(parentId).programs.find(x=>x.id===Number(r.lastInsertRowid)); }
    if (kind === "suite") { const parent=db.prepare("SELECT workspace_id FROM program WHERE id=?").get(parentId) as {workspace_id:number}|undefined; if(!parent) throw new WorkspaceError(404,"not_found","Program not found"); const r=db.prepare("INSERT INTO suite(program_id,name,overview,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(parentId,requireText(input.name,"name",120),requireText(input.overview??"","overview",10000,true),nextOrder("suite","program_id",parentId),now,now); return this.tree(parent.workspace_id).programs.flatMap(x=>x.suites).find(x=>x.id===Number(r.lastInsertRowid)); }
    const parent=db.prepare("SELECT g.workspace_id FROM suite s JOIN program g ON g.id=s.program_id WHERE s.id=?").get(parentId) as {workspace_id:number}|undefined; if(!parent) throw new WorkspaceError(404,"not_found","Suite not found"); const r=db.prepare("INSERT INTO prompt(suite_id,title,content,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(parentId,requireText(input.title,"title",160),requireText(input.content,"content",64000),nextOrder("prompt","suite_id",parentId),now,now); return this.tree(parent.workspace_id).programs.flatMap(x=>x.suites).flatMap(x=>x.prompts).find(x=>x.id===Number(r.lastInsertRowid));
  }); },
  updateChild(kind: "program"|"suite"|"prompt", id:number, input:Record<string,unknown>): unknown { return sqliteGuard(() => {
    const table=kind; const row=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<string,unknown>|undefined; if(!row) throw new WorkspaceError(404,"not_found",`${kind} not found`); const now=new Date().toISOString();
    if(kind==="prompt") { db.prepare("UPDATE prompt SET title=?,content=?,updated_at=? WHERE id=?").run(input.title===undefined?row.title:requireText(input.title,"title",160),input.content===undefined?row.content:requireText(input.content,"content",64000),now,id); }
    else { db.prepare(`UPDATE ${table} SET name=?,overview=?,updated_at=? WHERE id=?`).run(input.name===undefined?row.name:requireText(input.name,"name",120),input.overview===undefined?row.overview:requireText(input.overview,"overview",10000,true),now,id); }
    return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  }); },
  removeChild(kind:"program"|"suite"|"prompt",id:number):void { if(db.prepare(`DELETE FROM ${kind} WHERE id=?`).run(id).changes===0) throw new WorkspaceError(404,"not_found",`${kind} not found`); },
  importProgram(workspaceId:number,pack:ImportedProgram):WorkspaceTree { return sqliteGuard(()=>{ importProgramTransaction(workspaceId,pack); return this.tree(workspaceId); }); },
  reserveStartIntent(args:{runId:string;workspaceId:number;promptId?:number|null;provider:string;model:string|null;source:string}):void { sqliteGuard(()=>db.transaction(()=>{
    const workspace=db.prepare("SELECT id,work_directory FROM workspace WHERE id=?").get(args.workspaceId) as {id:number;work_directory:string}|undefined;
    if(!workspace)throw new WorkspaceError(404,"not_found","Workspace not found");
    const dir=effectiveDirectory(workspace.work_directory);
    const existing=db.prepare("SELECT id,state,provider,model,created_at createdAt FROM workspace_start_intent WHERE effective_directory=? AND released_at IS NULL ORDER BY created_at DESC LIMIT 1").get(dir) as {id:string;state:StartIntentState;provider:string;model:string|null;createdAt:string}|undefined;
    if(existing&&existing.id!==args.runId){
      throw new WorkspaceError(409,"workspace_busy",`A start already owns this working directory (${existing.provider}${existing.model===null?"":` · ${existing.model}`}, ${existing.state}, started ${existing.createdAt}).`,{runId:existing.id,state:existing.state,detail:"Recover or stop the existing owner before starting another agent in this working directory."});
    }
    const active=db.prepare("SELECT id,provider,model,state,started_at startedAt FROM agent_run WHERE workspace_id=? AND state IN ('STARTING','RUNNING') AND role='execute' ORDER BY started_at DESC LIMIT 1").get(args.workspaceId) as {id:string;provider:string;model:string|null;state:string;startedAt:string}|undefined;
    if(active&&active.id!==args.runId){
      throw new WorkspaceError(409,"workspace_busy",`A run is already in progress in this workspace (${active.provider}${active.model===null?"":` · ${active.model}`}).`,{runId:active.id,state:active.state,detail:"Recover or stop the existing owner before starting another agent in this working directory."});
    }
    const now=new Date().toISOString();
    db.prepare("INSERT INTO workspace_start_intent(id,workspace_id,effective_directory,prompt_id,provider,model,source,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'START_INTENT',?,?)")
      .run(args.runId,args.workspaceId,dir,args.promptId??null,args.provider,args.model,args.source,now,now);
  })()); },
  markStartIntent(runId:string,state:StartIntentState,detail:string|null=null):void {
    const now=new Date().toISOString();
    const terminal=state==="KNOWN_STOPPED"||state==="KNOWN_NO_SPAWN";
    db.prepare("UPDATE workspace_start_intent SET state=?,detail=?,updated_at=?,released_at=CASE WHEN ?=1 THEN ? ELSE released_at END WHERE id=?")
      .run(state,detail,now,terminal?1:0,terminal?now:null,runId);
  },
  activeStartIntentForWorkspace(workspaceId:number):StartIntentRow|null {
    return (db.prepare("SELECT * FROM workspace_start_intent WHERE workspace_id=? AND released_at IS NULL ORDER BY created_at DESC LIMIT 1").get(workspaceId) as StartIntentRow|undefined)??null;
  },
  reconcileStartIntentsForRestart():void {
    const now=new Date().toISOString();
    const rows=db.prepare("SELECT id,workspace_id FROM agent_run WHERE state IN ('STARTING','RUNNING')").all() as Array<{id:string;workspace_id:number}>;
    for(const row of rows){
      const existing=db.prepare("SELECT id FROM workspace_start_intent WHERE id=? AND released_at IS NULL").get(row.id) as {id:string}|undefined;
      if(existing){
        db.prepare("UPDATE workspace_start_intent SET state='START_UNKNOWN',detail=?,updated_at=? WHERE id=? AND released_at IS NULL")
          .run("Server restarted while this start was not known stopped; ownership remains held.",now,row.id);
        continue;
      }
      const workspace=db.prepare("SELECT work_directory FROM workspace WHERE id=?").get(row.workspace_id) as {work_directory:string}|undefined;
      if(workspace){
        db.prepare("INSERT OR IGNORE INTO workspace_start_intent(id,workspace_id,effective_directory,prompt_id,provider,model,source,state,detail,created_at,updated_at) SELECT id,workspace_id,?,prompt_id,provider,model,'restart-reconciliation','START_UNKNOWN',?,started_at,? FROM agent_run WHERE id=?")
          .run(effectiveDirectory(workspace.work_directory),"Server restarted with an active run row but no in-memory supervisor.",now,row.id);
      }
    }
    db.prepare("UPDATE workspace_start_intent SET state='START_UNKNOWN',detail=?,updated_at=? WHERE released_at IS NULL AND state='START_INTENT'")
      .run("Server restarted after reserving ownership but before spawn was observed.",now);
  },
  beginAgentRun(args:{runId:string;workspaceId:number;promptId:number;provider:string;model:string|null;tokenHash:string;expiresAt:string;role?:RunRole}):void { sqliteGuard(()=>beginRunTransaction(args)); },
  beginConsultRun(args:{runId:string;workspaceId:number;promptId:number|null;provider:string;model:string|null;tokenHash:string;expiresAt:string}):void { sqliteGuard(()=>beginConsultTransaction(args)); },
  beginHandoffAgentRun(args:{runId:string;workspaceId:number;promptId:number;provider:string;model:string|null;tokenHash:string;expiresAt:string}):void { sqliteGuard(()=>{
    const now=new Date().toISOString();
    db.prepare("INSERT INTO agent_run(id,workspace_id,prompt_id,provider,model,state,started_at,context_token_hash,token_expires_at,role) VALUES(?,?,?,?,?,'STARTING',?,?,?,'handoff')")
      .run(args.runId,args.workspaceId,args.promptId,args.provider,args.model,now,args.tokenHash,args.expiresAt);
  }); },
  markAgentRunRunning(runId:string):void { db.prepare("UPDATE agent_run SET state='RUNNING' WHERE id=? AND state='STARTING'").run(runId); },
  finishAgentRun(runId:string,state:string,answer="",terminalStatusFailure:string|null=null):void { sqliteGuard(()=>db.transaction(()=>{
    const run=db.prepare("SELECT prompt_id,role FROM agent_run WHERE id=?").get(runId) as {prompt_id:number|null;role:RunRole}|undefined;if(!run)return;
    const now=new Date().toISOString();db.prepare("UPDATE agent_run SET state=?,ended_at=? WHERE id=?").run(state.toUpperCase(),now,runId);
    db.prepare("UPDATE workspace_start_intent SET state='KNOWN_STOPPED',detail=?,updated_at=?,released_at=? WHERE id=? AND released_at IS NULL")
      .run(`Process ended ${state}.`,now,now,runId);
    if(run.role!=="execute"||run.prompt_id===null)return;
    if(answer.trim()!=="")db.prepare("INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,?,'AGENT_RESPONSE',?,'AGENT',?)").run(run.prompt_id,runId,answer.trim().slice(0,20000),now);
    const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(run.prompt_id) as {status:PromptRecord["status"]};
    if(prompt.status==="IN_PROGRESS"){
      const reason=terminalStatusFailure??`Agent process ended ${state} without posting the required DONE or BLOCKED status.`;
      db.prepare("UPDATE prompt SET status='BLOCKED',result=?,updated_at=? WHERE id=?").run(reason,now,run.prompt_id);
      db.prepare("INSERT INTO prompt_status_event(prompt_id,run_id,previous_status,new_status,reason,actor_type,created_at) VALUES(?,?,'IN_PROGRESS','BLOCKED',?,'SYSTEM',?)").run(run.prompt_id,runId,reason,now);
      db.prepare("INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,?,'BLOCKER',?,'SYSTEM',?)").run(run.prompt_id,runId,reason,now);
    }
  })()); },
  authorizeAgentRun(runId:string,tokenHash:string):{workspaceId:number;promptId:number|null;state:string;role:RunRole} { const row=db.prepare("SELECT workspace_id workspaceId,prompt_id promptId,state,role FROM agent_run WHERE id=? AND context_token_hash=? AND token_expires_at>?").get(runId,tokenHash,new Date().toISOString()) as {workspaceId:number;promptId:number|null;state:string;role:RunRole}|undefined;if(!row)throw new WorkspaceError(401,"invalid_run_token","Run credential is invalid or expired");return row; },
  addAgentRemark(runId:string,input:Record<string,unknown>):unknown { return sqliteGuard(()=>agentRemarkTransaction(runId,input)); },
  updateAgentStatus(runId:string,input:Record<string,unknown>):unknown { return sqliteGuard(()=>agentStatusTransaction(runId,input)); },
  promptHistory(promptId:number):{events:unknown[];remarks:unknown[];runs:unknown[]} { const exists=db.prepare("SELECT 1 FROM prompt WHERE id=?").get(promptId);if(!exists)throw new WorkspaceError(404,"not_found","Prompt not found");return{events:db.prepare("SELECT id,prompt_id promptId,run_id runId,previous_status previousStatus,new_status newStatus,reason,verification_summary verificationSummary,actor_type actorType,created_at createdAt FROM prompt_status_event WHERE prompt_id=? ORDER BY id DESC").all(promptId),remarks:db.prepare("SELECT id,prompt_id promptId,run_id runId,kind,content,actor_type actorType,created_at createdAt,CASE WHEN kind='HUMAN_RESPONSE' AND EXISTS(SELECT 1 FROM task_control_receipt t WHERE t.response_id=prompt_remark.id AND t.state='APPLIED') THEN 'telegram' ELSE 'local' END source FROM prompt_remark WHERE prompt_id=? ORDER BY id DESC").all(promptId),runs:db.prepare("SELECT id,provider,model,role,state,started_at startedAt,ended_at endedAt FROM agent_run WHERE prompt_id=? ORDER BY started_at DESC").all(promptId)}; },
  humanInputRequests():HumanInputRequest[] {
    const rows=db.prepare(`SELECT p.id promptId,g.workspace_id workspaceId FROM prompt p JOIN suite s ON s.id=p.suite_id JOIN program g ON g.id=s.program_id WHERE p.status='BLOCKED' OR EXISTS(SELECT 1 FROM prompt_remark r WHERE r.prompt_id=p.id AND r.kind='HUMAN_RESPONSE') ORDER BY p.updated_at DESC`).all() as Array<{promptId:number;workspaceId:number}>;
    return rows.map(({promptId,workspaceId})=>{const prompt=this.resolvePrompt(workspaceId,promptId);const workspace=this.get(workspaceId);const history=this.promptHistory(promptId);const remarks=history.remarks as PromptRemark[];return{prompt,workspace:{id:workspace.id,name:workspace.name,workDirectory:workspace.workDirectory,workDirectoryExists:workspace.workDirectoryExists},latestBlocker:remarks.find(item=>item.kind==="BLOCKER")??null,remarks,events:history.events as PromptStatusEvent[],clarifications:this.clarifications(promptId),currentRun:this.latestRunActivity(promptId)};});
  },
  latestRunActivity(promptId:number):AgentRunActivity|null { const run=db.prepare("SELECT id,provider,model,role,state,started_at startedAt,ended_at endedAt FROM agent_run WHERE prompt_id=? ORDER BY started_at DESC LIMIT 1").get(promptId) as Omit<AgentRunActivity,"events">|undefined;if(!run)return null;const rows=db.prepare("SELECT event_json FROM agent_run_event WHERE run_id=? ORDER BY id").all(run.id) as Array<{event_json:string}>;return{...run,events:rows.map(row=>JSON.parse(row.event_json) as NormalizedEvent)}; },
  sessions():AgentSession[] { const rows=db.prepare(`SELECT r.id,r.workspace_id workspaceId,w.name workspaceName,w.work_directory workDirectory,r.prompt_id promptId,p.external_key promptKey,COALESCE(p.title,'(research)') promptTitle,p.status promptStatus,COALESCE(g.name,'') programName,COALESCE(s.name,'') suiteName,r.provider,r.model,r.role,r.state,r.started_at startedAt,r.ended_at endedAt FROM agent_run r JOIN workspace w ON w.id=r.workspace_id LEFT JOIN prompt p ON p.id=r.prompt_id LEFT JOIN suite s ON s.id=p.suite_id LEFT JOIN program g ON g.id=s.program_id ORDER BY r.started_at DESC`).all() as Array<Omit<AgentSession,"events">>;const events=db.prepare("SELECT event_json FROM agent_run_event WHERE run_id=? ORDER BY id");return rows.map(run=>({...run,events:(events.all(run.id) as Array<{event_json:string}>).map(row=>JSON.parse(row.event_json) as NormalizedEvent)})); },
  /**
   * Token + estimated-cost rollup for the report page. Pulls usage from run
   * events without shipping full transcripts to the client.
   */
  usageReport(workspaceId?:number):UsageReport {
    if(workspaceId!==undefined)this.get(workspaceId);
    const rows=db.prepare(`SELECT r.id,r.workspace_id workspaceId,w.name workspaceName,r.prompt_id promptId,p.external_key promptKey,COALESCE(p.title,'(research)') promptTitle,s.id suiteId,COALESCE(s.name,'') suiteName,g.id programId,COALESCE(g.name,'') programName,r.provider,r.model,r.role,r.state,r.started_at startedAt,r.ended_at endedAt FROM agent_run r JOIN workspace w ON w.id=r.workspace_id LEFT JOIN prompt p ON p.id=r.prompt_id LEFT JOIN suite s ON s.id=p.suite_id LEFT JOIN program g ON g.id=s.program_id WHERE (? IS NULL OR r.workspace_id=?) ORDER BY r.started_at DESC`).all(workspaceId??null,workspaceId??null) as Array<{id:string;workspaceId:number;workspaceName:string;promptId:number|null;promptKey:string|null;promptTitle:string;suiteId:number|null;suiteName:string;programId:number|null;programName:string;provider:string;model:string|null;role:string;state:string;startedAt:string;endedAt:string|null}>;
    const eventsStmt=db.prepare("SELECT event_json FROM agent_run_event WHERE run_id=? ORDER BY id");
    const sessions:SessionUsageRow[]=rows.map(row=>{
      const events=(eventsStmt.all(row.id) as Array<{event_json:string}>).map(entry=>JSON.parse(entry.event_json) as NormalizedEvent);
      const usage=usageFromEvents(events);
      const cost=estimateCost(usage,row.provider,row.model);
      return{id:row.id,workspaceId:row.workspaceId,workspaceName:row.workspaceName,promptId:row.promptId,promptKey:row.promptKey,promptTitle:row.promptTitle,suiteId:row.suiteId,suiteName:row.suiteName,programId:row.programId,programName:row.programName,provider:row.provider,model:row.model,role:isRunRole(row.role)?row.role:"execute",state:row.state,startedAt:row.startedAt,endedAt:row.endedAt,usage,cost};
    });
    const totals=emptyUsageTotals();
    const byProviderMap=new Map<string,UsageTotals>();
    const suiteMap=new Map<number,SuiteUsageRow>();
    const unassignedIds:string[]=[];
    const unassignedTotals=emptyUsageTotals();
    for(const session of sessions){
      addUsageToTotals(totals,session.usage,session.cost.usd);
      let providerTotals=byProviderMap.get(session.provider);
      if(providerTotals===undefined){providerTotals=emptyUsageTotals();byProviderMap.set(session.provider,providerTotals);}
      addUsageToTotals(providerTotals,session.usage,session.cost.usd);
      if(session.promptId===null||session.suiteId===null||session.programId===null){
        unassignedIds.push(session.id);
        addUsageToTotals(unassignedTotals,session.usage,session.cost.usd);
        continue;
      }
      let suite=suiteMap.get(session.suiteId);
      if(suite===undefined){
        suite={suiteId:session.suiteId,suiteName:session.suiteName,programId:session.programId,programName:session.programName,workspaceId:session.workspaceId,workspaceName:session.workspaceName,totals:emptyUsageTotals(),tasks:[]};
        suiteMap.set(session.suiteId,suite);
      }
      addUsageToTotals(suite.totals,session.usage,session.cost.usd);
      let task=suite.tasks.find(entry=>entry.promptId===session.promptId);
      if(task===undefined){
        task={promptId:session.promptId,promptKey:session.promptKey,promptTitle:session.promptTitle,suiteId:session.suiteId,suiteName:session.suiteName,programId:session.programId,programName:session.programName,workspaceId:session.workspaceId,workspaceName:session.workspaceName,totals:emptyUsageTotals(),sessionIds:[]};
        suite.tasks.push(task);
      }
      addUsageToTotals(task.totals,session.usage,session.cost.usd);
      task.sessionIds.push(session.id);
    }
    for(const suite of suiteMap.values()){
      suite.tasks.sort((a,b)=>b.totals.estimatedUsd-a.totals.estimatedUsd||b.totals.totalTokens-a.totals.totalTokens);
    }
    const suites=[...suiteMap.values()].sort((a,b)=>b.totals.estimatedUsd-a.totals.estimatedUsd||b.totals.totalTokens-a.totals.totalTokens);
    const byProvider=[...byProviderMap.entries()].map(([provider,providerTotals])=>({provider,totals:providerTotals})).sort((a,b)=>b.totals.estimatedUsd-a.totals.estimatedUsd||b.totals.totalTokens-a.totals.totalTokens);
    return{generatedAt:new Date().toISOString(),pricingNote:USAGE_REPORT_PRICING_NOTE,totals,byProvider,suites,unassigned:{totals:unassignedTotals,sessionIds:unassignedIds},sessions};
  },
  operations(workspaceId?:number):OperationsSnapshot {
    const workspaceRows=workspaceId===undefined?this.list():[this.get(workspaceId)];
    const intervention=db.prepare("SELECT content FROM prompt_remark WHERE prompt_id=? AND kind IN ('BLOCKER','DECISION_NEEDED') ORDER BY id DESC LIMIT 1");
    const latestHandoff=db.prepare("SELECT * FROM handoff WHERE prompt_id=? ORDER BY created_at DESC LIMIT 1");
    const sessionCount=db.prepare("SELECT count(*) count FROM agent_run WHERE prompt_id=?");
    const sessionsBySuite=db.prepare("SELECT r.id,r.workspace_id workspaceId,r.prompt_id promptId,p.external_key promptKey,p.title promptTitle,r.provider,r.model,r.role,r.state,r.started_at startedAt,r.ended_at endedAt FROM agent_run r JOIN prompt p ON p.id=r.prompt_id WHERE p.suite_id=? ORDER BY r.started_at DESC");
    const latestVerification=db.prepare("SELECT id,kind,state,verdict,started_at startedAt,ended_at endedAt FROM suite_verification WHERE suite_id=? ORDER BY started_at DESC,id DESC LIMIT 1");
    const ruleRow=db.prepare("SELECT * FROM prompt_pipeline_rule WHERE prompt_id=?");
    const suiteDefaults=db.prepare("SELECT default_provider defaultProvider,default_model defaultModel FROM suite WHERE id=?");
    const activePipeline=db.prepare("SELECT * FROM suite_pipeline_run WHERE suite_id=? AND state IN ('PLAYING','WAITING_HUMAN','PAUSED') ORDER BY started_at DESC LIMIT 1");
    const latestPipeline=db.prepare("SELECT * FROM suite_pipeline_run WHERE suite_id=? ORDER BY started_at DESC LIMIT 1");
    const suites:OperationsSuite[]=[];
    for(const workspace of workspaceRows){const options=new Map(this.promptOptions(workspace.id).map(item=>[item.id,item]));for(const program of this.tree(workspace.id).programs)for(const suite of program.suites){const counts=Object.fromEntries(OPERATIONAL_STATES.map(state=>[state,0])) as Record<PromptOperationalState,number>;const prompts:OperationsPrompt[]=suite.prompts.map(record=>{const prompt=options.get(record.id)!;const question=this.pendingHumanQuestion(prompt.id);const state=operationalState(prompt,question!==null);counts[state]++;const latest=question??(intervention.get(prompt.id) as {content:string}|undefined)?.content??null;const handoffRow=latestHandoff.get(prompt.id) as Record<string,unknown>|undefined;const count=(sessionCount.get(prompt.id) as {count:number}).count;const lastActivityAt=prompt.currentRun?.endedAt??prompt.currentRun?.startedAt??record.updatedAt;return{prompt,workspace:{id:workspace.id,name:workspace.name,workDirectory:workspace.workDirectory,workDirectoryExists:workspace.workDirectoryExists},programKey:program.externalKey,suiteKey:suite.externalKey,operationalState:state,attention:state==="AWAITING_RESPONSE"||state==="RECOVERY_NEEDED"||state==="FAILED",latestIntervention:latest,lastActivityAt,sessionCount:count,latestHandoff:handoffRow?handoffDto(handoffRow):null,pipelineRule:pipelineRuleDto(prompt.id,ruleRow.get(prompt.id) as PipelineRuleRow|undefined)};});const sessions=sessionsBySuite.all(suite.id) as OperationsSession[];const defaultsRow=suiteDefaults.get(suite.id) as {defaultProvider:string|null;defaultModel:string|null};suites.push({id:suite.id,key:suite.externalKey,name:suite.name,programId:program.id,programKey:program.externalKey,programName:program.name,workspaceId:workspace.id,workspaceName:workspace.name,counts,attentionCount:prompts.filter(item=>item.attention).length,prompts,sessions,latestVerification:(latestVerification.get(suite.id) as SuiteVerificationBadge|undefined)??null,pipeline:{defaults:{suiteId:suite.id,defaultProvider:asProviderId(defaultsRow.defaultProvider),defaultModel:defaultsRow.defaultModel},active:(()=>{const row=activePipeline.get(suite.id) as PipelineRunRow|undefined;return row?pipelineRunDto(row):null;})(),latest:(()=>{const row=latestPipeline.get(suite.id) as PipelineRunRow|undefined;return row?pipelineRunDto(row):null;})()}});}}
    return{generatedAt:new Date().toISOString(),suites};
  },
  /* ---------------------------------------------------------------- */
  /* Suite verification                                                 */
  /* ---------------------------------------------------------------- */

  suiteHeader(suiteId:number){
    const suite=db.prepare(`SELECT s.id,s.external_key key,s.name,g.name programName,w.name workspaceName,w.id workspaceId FROM suite s JOIN program g ON g.id=s.program_id JOIN workspace w ON w.id=g.workspace_id WHERE s.id=?`).get(suiteId) as {id:number;key:string|null;name:string;programName:string;workspaceName:string;workspaceId:number}|undefined;
    if(!suite)throw new WorkspaceError(404,"not_found","Suite not found");
    return suite;
  },

  /**
   * Records an agent verification as it starts, so the run is a first-class
   * object from the beginning rather than something reconstructed afterwards.
   */
  beginSuiteVerification(args:{runId:string;suiteId:number;provider:string;model:string|null;stats:SuiteVerificationStats;scopePromptId?:number|null}):number {
    const suite=this.suiteHeader(args.suiteId);
    return sqliteGuard(()=>Number(db.prepare(
      "INSERT INTO suite_verification(suite_id,workspace_id,kind,run_id,provider,model,state,summary_json,stats_json,scope_prompt_id,started_at) VALUES(?,?,'AGENT',?,?,?,'RUNNING','{}',?,?,?)",
    ).run(args.suiteId,suite.workspaceId,args.runId,args.provider,args.model,JSON.stringify(args.stats),args.scopePromptId??null,new Date().toISOString()).lastInsertRowid));
  },

  recordVerificationEvent(verificationId:number,event:NormalizedEvent):void {
    db.prepare("INSERT INTO suite_verification_event(verification_id,event_json,created_at) VALUES(?,?,?)").run(verificationId,JSON.stringify(event),event.timestamp);
  },

  /**
   * Closes an agent verification: stores the report verbatim, parses what it
   * can into per-item outcomes, and links those back to real prompts.
   *
   * The markdown is saved whether or not parsing finds anything, so a parser
   * miss costs presentation and never evidence.
   */
  finishSuiteVerification(verificationId:number,state:string,reportMarkdown:string):void {
    sqliteGuard(()=>db.transaction(()=>{
      const row=db.prepare("SELECT suite_id suiteId FROM suite_verification WHERE id=?").get(verificationId) as {suiteId:number}|undefined;
      if(!row)return;
      const terminal=state==="done"?"DONE":state==="interrupted"?"INTERRUPTED":"ERROR";
      const report=reportMarkdown.trim();
      const items=terminal==="DONE"?parseReportItems(report):[];
      const prompts=db.prepare("SELECT id,external_key externalKey,title FROM prompt WHERE suite_id=?").all(row.suiteId) as Array<{id:number;externalKey:string|null;title:string}>;
      const insert=db.prepare("INSERT INTO suite_verification_item(verification_id,prompt_id,prompt_key,title,check_result,evidence,commands,sort_order) VALUES(?,?,?,?,?,?,?,?)");
      items.forEach((item,index)=>{
        // Match on the external key first; fall back to the title, since agents
        // often echo the human name rather than the key.
        const byKey=item.promptKey===null?undefined:prompts.find(p=>p.externalKey===item.promptKey);
        const lowered=item.title.toLowerCase();
        const byTitle=prompts.find(p=>lowered.includes(p.title.toLowerCase())||p.title.toLowerCase()===lowered);
        insert.run(verificationId,(byKey??byTitle)?.id??null,item.promptKey,item.title,item.check,item.evidence,item.commands,index);
      });
      const verdict=terminal==="DONE"?deriveVerdict(report,items):null;
      db.prepare("UPDATE suite_verification SET state=?,verdict=?,summary_json=?,report_markdown=?,ended_at=? WHERE id=?")
        .run(terminal,verdict,JSON.stringify(summarize(items)),report,new Date().toISOString(),verificationId);
    })());
  },

  /**
   * The fast audit: reads back what the orchestration records already claim,
   * without running anything. Now stored, so "when was this last checked" has
   * an answer instead of being recomputed and thrown away on every request.
   */
  recordSuiteAudit(suiteId:number):SuiteVerificationRecord {
    const suite=this.suiteHeader(suiteId);
    const rows=db.prepare(`SELECT p.id promptId,p.external_key promptKey,p.title,p.status,
      e.verification_summary verificationSummary,
      r.state runState
      FROM prompt p
      LEFT JOIN prompt_status_event e ON e.id=(SELECT e2.id FROM prompt_status_event e2 WHERE e2.prompt_id=p.id AND e2.new_status='DONE' ORDER BY e2.id DESC LIMIT 1)
      LEFT JOIN agent_run r ON r.id=e.run_id
      WHERE p.suite_id=? ORDER BY p.sort_order,p.id`).all(suiteId) as Array<{promptId:number;promptKey:string|null;title:string;status:PromptRecord["status"];verificationSummary:string|null;runState:string|null}>;
    const items:SuiteVerificationItem[]=rows.map(row=>{
      const base={promptId:row.promptId,promptKey:row.promptKey,title:row.title,commands:""};
      if(row.status==="SKIPPED")return{...base,check:"VERIFIED" as const,evidence:"Explicitly skipped by a human decision."};
      if(row.status!=="DONE")return{...base,check:"FAILED" as const,evidence:`Recorded status is ${row.status}; expected DONE or SKIPPED.`};
      const evidence=row.verificationSummary?.trim()??"";
      if(evidence==="")return{...base,check:"FAILED" as const,evidence:"Marked DONE with no recorded verification summary."};
      if(row.runState==="ERROR"||row.runState==="INTERRUPTED")return{...base,check:"WARNING" as const,evidence:`${evidence}\n\nProvider process ended ${row.runState.toLowerCase()} after posting DONE.`};
      return{...base,check:"VERIFIED" as const,evidence};
    });
    const summary=summarize(items);
    const verdict:SuiteVerificationVerdict=summary.failed>0?"FAIL":summary.warnings>0||summary.unverified>0?"WARNING":"PASS";
    const now=new Date().toISOString();
    const id=sqliteGuard(()=>db.transaction(()=>{
      const inserted=Number(db.prepare("INSERT INTO suite_verification(suite_id,workspace_id,kind,state,verdict,summary_json,report_markdown,started_at,ended_at) VALUES(?,?,'AUDIT','RECORDED',?,?,'',?,?)")
        .run(suiteId,suite.workspaceId,verdict,JSON.stringify(summary),now,now).lastInsertRowid);
      const insert=db.prepare("INSERT INTO suite_verification_item(verification_id,prompt_id,prompt_key,title,check_result,evidence,commands,sort_order) VALUES(?,?,?,?,?,?,?,?)");
      items.forEach((item,index)=>insert.run(inserted,item.promptId,item.promptKey,item.title,item.check,item.evidence,item.commands,index));
      return inserted;
    })());
    return this.suiteVerification(id);
  },

  suiteVerification(id:number):SuiteVerificationRecord {
    const row=db.prepare("SELECT * FROM suite_verification WHERE id=?").get(id) as Record<string,unknown>|undefined;
    if(!row)throw new WorkspaceError(404,"not_found","Verification not found");
    return hydrateVerification(row);
  },

  suiteVerificationDetail(id:number):SuiteVerificationDetail {
    const record=this.suiteVerification(id);
    const events=(db.prepare("SELECT event_json FROM suite_verification_event WHERE verification_id=? ORDER BY id").all(id) as Array<{event_json:string}>).map(r=>JSON.parse(r.event_json) as NormalizedEvent);
    return{...record,events};
  },

  /** Newest first. The transcript is excluded; fetch a detail for that. */
  suiteVerifications(suiteId:number,limit=25):SuiteVerificationRecord[] {
    this.suiteHeader(suiteId);
    const rows=db.prepare("SELECT * FROM suite_verification WHERE suite_id=? ORDER BY started_at DESC,id DESC LIMIT ?").all(suiteId,limit) as Array<Record<string,unknown>>;
    return rows.map(hydrateVerification);
  },

  suiteVerificationContext(suiteId:number,promptId?:number|null):SuiteVerificationContext {
    const suite=db.prepare(`SELECT s.id,s.external_key key,s.name,g.name programName,w.name workspaceName FROM suite s JOIN program g ON g.id=s.program_id JOIN workspace w ON w.id=g.workspace_id WHERE s.id=?`).get(suiteId) as {id:number;key:string|null;name:string;programName:string;workspaceName:string}|undefined;
    if(!suite)throw new WorkspaceError(404,"not_found","Suite not found");
    const allRows=db.prepare(`SELECT p.id,p.external_key promptKey,p.title,p.content,p.status,p.result,
      (SELECT group_concat(COALESCE(pr.external_key,pr.title),', ') FROM prompt_dependency d JOIN prompt pr ON pr.id=d.depends_on_prompt_id WHERE d.prompt_id=p.id) dependencies,
      (SELECT content FROM prompt_remark r WHERE r.prompt_id=p.id AND r.kind='VERIFICATION' ORDER BY r.id DESC LIMIT 1) latestVerification,
      (SELECT content FROM prompt_remark r WHERE r.prompt_id=p.id AND r.kind='COMPLETION' ORDER BY r.id DESC LIMIT 1) latestCompletion
      FROM prompt p WHERE p.suite_id=? ORDER BY p.sort_order,p.id`).all(suiteId) as Array<{id:number;promptKey:string|null;title:string;content:string;status:PromptRecord["status"];result:string;dependencies:string|null;latestVerification:string|null;latestCompletion:string|null}>;
    const scope=promptId===undefined||promptId===null?null:allRows.find(row=>row.id===promptId)??null;
    if(promptId!==undefined&&promptId!==null&&scope===null)throw new WorkspaceError(404,"not_found","Work item not found in this suite");
    const rows=scope===null?allRows:[scope];
    if(rows.length===0)throw new WorkspaceError(409,"empty_suite","Suite has no work items to verify");
    const compact=rows.map(row=>compactWorkItem(row.content));const commands=uniqueCommands(compact);
    const dossiers=rows.map((row,index)=>{const evidence=[row.result.trim(),row.latestVerification?.trim(),row.latestCompletion?.trim()].filter((value,i,all):value is string=>!!value&&all.indexOf(value)===i).slice(0,2);return `## ${row.promptKey??row.title} — ${row.title}\n\nStatus: ${row.status}\nDependencies: ${row.dependencies??"none"}\n\n${compact[index]}${evidence.length?`\n\n### Recorded evidence (lead only; independently confirm)\n\n${evidence.join("\n\n")}`:""}`;});
    const manifest=commands.length?commands.map((command,index)=>`${index+1}. \`${command}\``).join("\n"):"No explicit shell commands were found. Derive the smallest decisive checks from the acceptance criteria below.";
    const heading=dossierHeading(suite,scope===null?null:{promptKey:scope.promptKey,title:scope.title});
    const scopeNote=scope===null
      ?"Verify this suite against the current working tree and runtime."
      :"Verify this single work item against the current working tree and runtime.";
    const responseNote=scope===null
      ?"Return only: (1) a compact table with item, PASS/FAIL/UNVERIFIED, decisive commands, and evidence; (2) shared checks; (3) discrepancies from recorded evidence; and (4) one overall suite verdict. Do not narrate exploration."
      :"Return only: (1) a compact table with this item, PASS/FAIL/UNVERIFIED, decisive commands, and evidence; (2) shared checks; (3) discrepancies from recorded evidence; and (4) one overall verdict for this item. Do not narrate exploration.";
    const prompt=`${heading}\n\n${scopeNote} This dossier is authoritative context; do not read orchestration databases, prompt history, chat transcripts, or prior agent logs. Do not edit files, implement fixes, or change work-item statuses.\n\nWork efficiently: read repository instructions once, run shared setup once, reuse healthy services, and execute the smallest decisive check for each acceptance criterion. Recorded evidence is only a lead and must not be accepted without a fresh observable check. Inspect implementation details only when required by an acceptance criterion or when a command fails. Keep tool output focused; avoid dumping large files or logs.\n\n## Deduplicated command manifest\n\n${manifest}\n\nRun applicable shared commands once, then map their results to every relevant item. You may adjust a stale command to the repository's documented equivalent, but state the substitution.\n\n## Work-item dossiers\n\n${dossiers.join("\n\n---\n\n")}\n\n## Required response\n\n${responseNote}`;
    return{suiteId,stats:{workItems:rows.length,sourceCharacters:rows.reduce((sum,row)=>sum+row.content.length,0),dossierCharacters:prompt.length,uniqueCommands:commands.length},prompt,scopePromptId:scope?.id??null,scopePromptKey:scope?.promptKey??null};
  },
  promptActivity(promptId:number):PromptActivity {
    const row=db.prepare("SELECT g.workspace_id workspaceId,s.id suiteId FROM prompt p JOIN suite s ON s.id=p.suite_id JOIN program g ON g.id=s.program_id WHERE p.id=?").get(promptId) as {workspaceId:number;suiteId:number}|undefined;if(!row)throw new WorkspaceError(404,"not_found","Prompt not found");
    const item=this.operations(row.workspaceId).suites.find(suite=>suite.id===row.suiteId)?.prompts.find(prompt=>prompt.prompt.id===promptId);if(!item)throw new WorkspaceError(404,"not_found","Prompt not found");
    const history=this.promptHistory(promptId);return{item,humanInput:this.humanInputState(promptId),remarks:history.remarks as PromptRemark[],events:history.events as PromptStatusEvent[],clarifications:this.clarifications(promptId),sessions:this.sessions().filter(session=>session.promptId===promptId),handoffs:this.handoffsForPrompt(promptId)};
  },
  recordAgentEvent(runId:string,event:NormalizedEvent):void { db.prepare("INSERT INTO agent_run_event(run_id,event_json,created_at) VALUES(?,?,?)").run(runId,JSON.stringify(event),event.timestamp); },
  clarifications(promptId:number):ClarificationExchange[] { return db.prepare("SELECT id,prompt_id promptId,question,answer,provider,model,state,created_at createdAt,answered_at answeredAt FROM clarification_exchange WHERE prompt_id=? ORDER BY id").all(promptId) as ClarificationExchange[]; },
  beginClarification(promptId:number,questionValue:unknown,provider:string,model:string|null):number { const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as {status:string}|undefined;if(!prompt)throw new WorkspaceError(404,"not_found","Prompt not found");if(prompt.status!=="BLOCKED"&&this.pendingHumanQuestion(promptId)===null)throw new WorkspaceError(409,"prompt_not_blocked","Clarification is only available while a prompt needs input");const question=requireText(questionValue,"question",10000);return Number(db.prepare("INSERT INTO clarification_exchange(prompt_id,question,provider,model,state,created_at) VALUES(?,?,?,?, 'RUNNING',?)").run(promptId,question,provider,model,new Date().toISOString()).lastInsertRowid); },
  finishClarification(id:number,state:"DONE"|"INTERRUPTED"|"ERROR",answer:string|null):void { db.prepare("UPDATE clarification_exchange SET state=?,answer=?,answered_at=? WHERE id=?").run(state,answer?.trim()||null,new Date().toISOString(),id); },
  respondToBlockedPrompt(promptId:number,input:Record<string,unknown>,options:{source?:"local"|"telegram"}={}):PromptRemark { return sqliteGuard(()=>db.transaction(()=>{
    this.assertHumanInputRevision(promptId, input.expectedRevision);
    const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as {status:PromptRecord["status"]}|undefined;
    if(!prompt)throw new WorkspaceError(404,"not_found","Prompt not found");
    if(prompt.status!=="BLOCKED"&&this.pendingHumanQuestion(promptId)===null)throw new WorkspaceError(409,"prompt_not_blocked","Prompt no longer needs human input");
    const content=requireText(input.content,"content",20000);const now=new Date().toISOString();
    const remarkId=Number(db.prepare("INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,NULL,'HUMAN_RESPONSE',?,'USER',?)").run(promptId,content,now).lastInsertRowid);
    db.prepare("UPDATE prompt SET status='TODO',result='',updated_at=? WHERE id=?").run(now,promptId);
    db.prepare("INSERT INTO prompt_status_event(prompt_id,run_id,previous_status,new_status,reason,actor_type,created_at) VALUES(?,NULL,?,'TODO','Human supplied context; ready to resume','USER',?)").run(promptId,prompt.status,now);
    if (input.hold === true || db.prepare("SELECT 1 FROM human_response_hold WHERE prompt_id=?").get(promptId)) this.holdHumanResponse(promptId, remarkId);
    return{id:remarkId,promptId,runId:null,kind:"HUMAN_RESPONSE",content,actorType:"USER",createdAt:now,source:options.source??"local"} satisfies PromptRemark;
  })()); },
  recoveryRunId(promptId:number):string { const run=db.prepare("SELECT id FROM agent_run WHERE prompt_id=? ORDER BY started_at DESC LIMIT 1").get(promptId) as {id:string}|undefined;if(!run)throw new WorkspaceError(409,"nothing_to_recover","This prompt has no prior run to recover");return run.id; },
  latestExecuteRunId(promptId:number):string { const run=db.prepare("SELECT id FROM agent_run WHERE prompt_id=? AND role='execute' ORDER BY started_at DESC LIMIT 1").get(promptId) as {id:string}|undefined;if(!run)throw new WorkspaceError(409,"nothing_to_handoff","This work item has no prior developer run");return run.id; },
  runSummary(runId:string):{id:string;workspaceId:number;promptId:number|null;provider:ProviderId;model:string|null;state:string} { const run=db.prepare("SELECT id,workspace_id workspaceId,prompt_id promptId,provider,model,state FROM agent_run WHERE id=?").get(runId) as {id:string;workspaceId:number;promptId:number|null;provider:ProviderId;model:string|null;state:string}|undefined;if(!run)throw new WorkspaceError(404,"not_found","Run not found");return run; },
  classifyStartUnknown(promptId:number,input:Record<string,unknown>):{classified:true;classification:StartUnknownClassification;startIntentId:string} { return sqliteGuard(()=>db.transaction(()=>{
    const requested=input.classification;
    if(requested!=="known_stopped"&&requested!=="known_no_spawn")throw new WorkspaceError(422,"validation_error","Choose a valid START_UNKNOWN classification.");
    const classification:StartUnknownClassification=requested;
    if(input.confirmed!==true)throw new WorkspaceError(422,"confirmation_required","Confirm that you checked the local provider process state before classifying this start.");
    const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as {status:PromptRecord["status"]}|undefined;
    if(!prompt)throw new WorkspaceError(404,"not_found","Prompt not found");
    const latestRun=db.prepare("SELECT id,state FROM agent_run WHERE prompt_id=? AND role='execute' ORDER BY started_at DESC LIMIT 1").get(promptId) as {id:string;state:string}|undefined;
    if(latestRun&&activeRuns.has(latestRun.id))throw new WorkspaceError(409,"run_active","The agent process is still active; stop it before classifying the previous start.");
    const intent=db.prepare("SELECT id,state FROM workspace_start_intent WHERE prompt_id=? AND released_at IS NULL ORDER BY created_at DESC LIMIT 1").get(promptId) as {id:string;state:StartIntentState}|undefined;
    if(!intent||intent.state!=="START_UNKNOWN")throw new WorkspaceError(409,"start_intent_changed","The latest start is no longer START_UNKNOWN; refresh before classifying.");
    const expected=input.expectedStartIntentId;
    if(typeof expected!=="string"||expected!==intent.id)throw new WorkspaceError(409,"start_intent_changed","A newer start intent exists; refresh before classifying.");
    if(latestRun&&latestRun.id!==intent.id)throw new WorkspaceError(409,"run_changed","A newer run exists; refresh before classifying.");
    if(activeRuns.has(intent.id))throw new WorkspaceError(409,"run_active","The agent process is still active; stop it before classifying the previous start.");
    const state=classification==="known_no_spawn"?"KNOWN_NO_SPAWN":"KNOWN_STOPPED";
    const label=classification==="known_no_spawn"?"known no spawn":"known stopped";
    const now=new Date().toISOString();
    db.prepare("UPDATE workspace_start_intent SET state=?,detail=?,updated_at=?,released_at=? WHERE id=? AND released_at IS NULL AND state='START_UNKNOWN'")
      .run(state,`Operator confirmed START_UNKNOWN classification: ${label}.`,now,now,intent.id);
    db.prepare("INSERT INTO prompt_status_event(prompt_id,run_id,previous_status,new_status,reason,actor_type,created_at) VALUES(?,?,?,?,?,'USER',?)")
      .run(promptId,latestRun?.id??null,prompt.status,prompt.status,`Operator confirmed previous start is ${label}; recovery gate released.`,now);
    return{classified:true as const,classification,startIntentId:intent.id};
  })()); },
  recoverPrompt(promptId:number,expectedRunId:string):void { sqliteGuard(()=>db.transaction(()=>{
    const prompt=db.prepare("SELECT status,result FROM prompt WHERE id=?").get(promptId) as {status:PromptRecord["status"];result:string}|undefined;
    if(!prompt)throw new WorkspaceError(404,"not_found","Prompt not found");
    const run=db.prepare("SELECT id,state FROM agent_run WHERE prompt_id=? ORDER BY started_at DESC LIMIT 1").get(promptId) as {id:string;state:string}|undefined;
    if(!run||run.id!==expectedRunId)throw new WorkspaceError(409,"run_changed","A newer run exists; refresh before recovering");
    if(activeRuns.has(run.id))throw new WorkspaceError(409,"run_active","The agent process is still active; stop it before recovering");
    const intent=db.prepare("SELECT state FROM workspace_start_intent WHERE id=? AND released_at IS NULL").get(run.id) as {state:StartIntentState}|undefined;
    if(intent?.state==="START_UNKNOWN")throw new WorkspaceError(409,"start_unknown","The previous start is unknown after restart. Confirm the provider process is not still running before recovering.");
    const abandoned=prompt.status==="IN_PROGRESS"&&(run.state==="STARTING"||run.state==="RUNNING");
    const systemInterrupted=prompt.status==="BLOCKED"&&(run.state==="INTERRUPTED"||run.state==="ERROR")&&(prompt.result.startsWith("Agent process ended")||prompt.result.startsWith("No active agent run"));
    if(!abandoned&&!systemInterrupted)throw new WorkspaceError(409,"not_recoverable","This prompt is not an abandoned or system-interrupted run");
    const now=new Date().toISOString();
    if(run.state==="STARTING"||run.state==="RUNNING")db.prepare("UPDATE agent_run SET state='INTERRUPTED',ended_at=? WHERE id=?").run(now,run.id);
    db.prepare("UPDATE workspace_start_intent SET state='KNOWN_STOPPED',detail='Operator recovered the abandoned run.',updated_at=?,released_at=? WHERE id=? AND released_at IS NULL").run(now,now,run.id);
    db.prepare("UPDATE prompt SET status='TODO',result='',completed_at=NULL,updated_at=? WHERE id=?").run(now,promptId);
    db.prepare("INSERT INTO prompt_status_event(prompt_id,run_id,previous_status,new_status,reason,actor_type,created_at) VALUES(?,?,?,'TODO','Operator recovered an abandoned agent run','USER',?)").run(promptId,run.id,prompt.status,now);
    db.prepare("INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,?, 'HUMAN_RESPONSE','The previous agent run was interrupted or lost. Continue from the existing working tree and prior run evidence; inspect current changes before repeating work.','USER',?)").run(promptId,run.id,now);
  })()); },

  /* ---------------------------------------------------------------- */
  /* Suite pipelines                                                    */
  /* ---------------------------------------------------------------- */

  promptHome(promptId:number):{promptId:number;suiteId:number;workspaceId:number} {
    const row=db.prepare("SELECT p.id promptId,p.suite_id suiteId,g.workspace_id workspaceId FROM prompt p JOIN suite s ON s.id=p.suite_id JOIN program g ON g.id=s.program_id WHERE p.id=?").get(promptId) as {promptId:number;suiteId:number;workspaceId:number}|undefined;
    if(!row)throw new WorkspaceError(404,"not_found","Prompt not found");
    return row;
  },

  promptOutcome(promptId:number):{status:PromptRecord["status"];result:string;suiteId:number} {
    const row=db.prepare("SELECT status,result,suite_id suiteId FROM prompt WHERE id=?").get(promptId) as {status:PromptRecord["status"];result:string;suiteId:number}|undefined;
    if(!row)throw new WorkspaceError(404,"not_found","Prompt not found");
    return row;
  },

  suitePromptCount(suiteId:number):number {
    this.suiteHeader(suiteId);
    return (db.prepare("SELECT count(*) count FROM prompt WHERE suite_id=?").get(suiteId) as {count:number}).count;
  },

  suitePipelineDefaults(suiteId:number):SuitePipelineDefaults {
    this.suiteHeader(suiteId);
    const row=db.prepare("SELECT default_provider defaultProvider,default_model defaultModel FROM suite WHERE id=?").get(suiteId) as {defaultProvider:string|null;defaultModel:string|null};
    return {suiteId,defaultProvider:asProviderId(row.defaultProvider),defaultModel:row.defaultModel};
  },

  updateSuitePipelineDefaults(suiteId:number,input:Record<string,unknown>):SuitePipelineDefaults {
    this.suiteHeader(suiteId);
    const current=this.suitePipelineDefaults(suiteId);
    const defaultProvider="defaultProvider" in input ? optionalProviderField(input.defaultProvider,"defaultProvider") : current.defaultProvider;
    const defaultModel="defaultModel" in input ? optionalModelField(input.defaultModel,"defaultModel") : current.defaultModel;
    db.prepare("UPDATE suite SET default_provider=?,default_model=?,updated_at=? WHERE id=?").run(defaultProvider,defaultModel,new Date().toISOString(),suiteId);
    return this.suitePipelineDefaults(suiteId);
  },

  pipelineRule(promptId:number):PromptPipelineRule {
    this.promptHome(promptId);
    return pipelineRuleDto(promptId,db.prepare("SELECT * FROM prompt_pipeline_rule WHERE prompt_id=?").get(promptId) as PipelineRuleRow|undefined);
  },

  upsertPipelineRule(promptId:number,input:Record<string,unknown>):PromptPipelineRule {
    this.promptHome(promptId);
    const current=this.pipelineRule(promptId);
    const next:PromptPipelineRule={
      promptId,
      provider:"provider" in input ? optionalProviderField(input.provider,"provider") : current.provider,
      model:"model" in input ? optionalModelField(input.model,"model") : current.model,
      onDone:current.onDone,
      onBlocked:current.onBlocked,
      retryLimit:current.retryLimit,
      recoverProvider:"recoverProvider" in input ? optionalProviderField(input.recoverProvider,"recoverProvider") : current.recoverProvider,
      recoverModel:"recoverModel" in input ? optionalModelField(input.recoverModel,"recoverModel") : current.recoverModel,
      enabled:current.enabled,
      stepOrder:current.stepOrder,
    };
    if("onDone" in input){
      if(!isOnDoneAction(input.onDone)) throw new WorkspaceError(422,"validation_error","onDone must be continue, stop, or skip_rest",{onDone:"Unknown action"});
      next.onDone=input.onDone;
    }
    if("onBlocked" in input){
      if(!isOnBlockedAction(input.onBlocked)) throw new WorkspaceError(422,"validation_error","onBlocked must be wait, retry, recover, or skip",{onBlocked:"Unknown action"});
      next.onBlocked=input.onBlocked;
    }
    if("retryLimit" in input){
      const value=input.retryLimit;
      if(typeof value!=="number"||!Number.isInteger(value)||value<1||value>5) throw new WorkspaceError(422,"validation_error","retryLimit must be an integer between 1 and 5",{retryLimit:"Must be 1-5"});
      next.retryLimit=value;
    }
    if("enabled" in input) next.enabled=input.enabled===true||input.enabled===1;
    if("stepOrder" in input){
      const value=input.stepOrder;
      if(typeof value!=="number"||!Number.isInteger(value)||value<0) throw new WorkspaceError(422,"validation_error","stepOrder must be a non-negative integer",{stepOrder:"Must be >= 0"});
      next.stepOrder=value;
    }
    if(next.onBlocked==="recover" && next.recoverProvider===null){
      throw new WorkspaceError(422,"validation_error","recoverProvider is required when onBlocked is recover",{recoverProvider:"Required"});
    }
    const now=new Date().toISOString();
    db.prepare(`INSERT INTO prompt_pipeline_rule(prompt_id,provider,model,on_done,on_blocked,retry_limit,recover_provider,recover_model,updated_at,enabled,step_order)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(prompt_id) DO UPDATE SET
        provider=excluded.provider, model=excluded.model, on_done=excluded.on_done, on_blocked=excluded.on_blocked,
        retry_limit=excluded.retry_limit, recover_provider=excluded.recover_provider, recover_model=excluded.recover_model, updated_at=excluded.updated_at,
        enabled=excluded.enabled, step_order=excluded.step_order`)
      .run(promptId,next.provider,next.model,next.onDone,next.onBlocked,next.retryLimit,next.recoverProvider,next.recoverModel,now,next.enabled?1:0,next.stepOrder);
    return this.pipelineRule(promptId);
  },

  enabledPipelineSteps(suiteId:number):PromptPipelineRule[] {
    this.suiteHeader(suiteId);
    const rows=db.prepare(`SELECT r.* FROM prompt_pipeline_rule r JOIN prompt p ON p.id=r.prompt_id WHERE p.suite_id=? AND r.enabled=1 ORDER BY r.step_order,p.sort_order,p.id`).all(suiteId) as PipelineRuleRow[];
    return rows.map(row=>pipelineRuleDto(row.prompt_id,row));
  },

  addPipelineStep(promptId:number,input:Record<string,unknown>={}):PromptPipelineRule {
    const home=this.promptHome(promptId);
    const current=this.pipelineRule(promptId);
    if(current.enabled) return this.upsertPipelineRule(promptId,input);
    const max=(db.prepare(`SELECT COALESCE(MAX(r.step_order), -1) AS value FROM prompt_pipeline_rule r JOIN prompt p ON p.id=r.prompt_id WHERE p.suite_id=? AND r.enabled=1`).get(home.suiteId) as {value:number}).value;
    const provider="provider" in input ? optionalProviderField(input.provider,"provider") : current.provider;
    const model="model" in input ? optionalModelField(input.model,"model") : current.model;
    return this.upsertPipelineRule(promptId,{...input,provider,model,enabled:true,stepOrder:max+1});
  },

  removePipelineStep(promptId:number):PromptPipelineRule {
    this.promptHome(promptId);
    return this.upsertPipelineRule(promptId,{enabled:false,stepOrder:0});
  },

  reorderPipelineSteps(suiteId:number,promptIds:number[]):PromptPipelineRule[] {
    this.suiteHeader(suiteId);
    const current=this.enabledPipelineSteps(suiteId);
    if(promptIds.length!==current.length || new Set(promptIds).size!==promptIds.length){
      throw new WorkspaceError(422,"validation_error","promptIds must list every enabled step once");
    }
    const allowed=new Set(current.map(step=>step.promptId));
    for(const promptId of promptIds){
      if(!allowed.has(promptId)) throw new WorkspaceError(422,"validation_error","promptIds must be the enabled steps of this suite");
    }
    sqliteGuard(()=>db.transaction(()=>{
      promptIds.forEach((promptId,index)=>{
        db.prepare("UPDATE prompt_pipeline_rule SET step_order=?,updated_at=? WHERE prompt_id=?").run(index,new Date().toISOString(),promptId);
      });
    })());
    return this.enabledPipelineSteps(suiteId);
  },

  pipeline(suiteId:number):SuitePipelineView {
    const defaults=this.suitePipelineDefaults(suiteId);
    const prompts=(db.prepare("SELECT id,title,external_key externalKey FROM prompt WHERE suite_id=? ORDER BY sort_order,id").all(suiteId) as Array<{id:number;title:string;externalKey:string|null}>);
    const rules=prompts.map(row=>this.pipelineRule(row.id));
    const steps=this.enabledPipelineSteps(suiteId);
    const enabled=new Set(steps.map(step=>step.promptId));
    const available:PipelineAvailablePrompt[]=prompts.filter(row=>!enabled.has(row.id)).map(row=>({id:row.id,title:row.title,externalKey:row.externalKey}));
    return {defaults,steps,available,rules,active:this.activePipeline(suiteId),latest:this.latestPipeline(suiteId)};
  },

  pipelineById(id:string):SuitePipelineRun|null {
    const row=db.prepare("SELECT * FROM suite_pipeline_run WHERE id=?").get(id) as PipelineRunRow|undefined;
    return row?pipelineRunDto(row):null;
  },

  activePipeline(suiteId:number):SuitePipelineRun|null {
    const row=db.prepare("SELECT * FROM suite_pipeline_run WHERE suite_id=? AND state IN ('PLAYING','WAITING_HUMAN','PAUSED') ORDER BY started_at DESC LIMIT 1").get(suiteId) as PipelineRunRow|undefined;
    return row?pipelineRunDto(row):null;
  },

  latestPipeline(suiteId:number):SuitePipelineRun|null {
    const row=db.prepare("SELECT * FROM suite_pipeline_run WHERE suite_id=? ORDER BY started_at DESC LIMIT 1").get(suiteId) as PipelineRunRow|undefined;
    return row?pipelineRunDto(row):null;
  },

  activePipelineForWorkspace(workspaceId:number):SuitePipelineRun|null {
    const row=db.prepare("SELECT * FROM suite_pipeline_run WHERE workspace_id=? AND state IN ('PLAYING','WAITING_HUMAN','PAUSED') ORDER BY started_at DESC LIMIT 1").get(workspaceId) as PipelineRunRow|undefined;
    return row?pipelineRunDto(row):null;
  },

  pipelineByCurrentRun(runId:string):SuitePipelineRun|null {
    const row=db.prepare("SELECT * FROM suite_pipeline_run WHERE current_run_id=? AND state IN ('PLAYING','PAUSED') ORDER BY started_at DESC LIMIT 1").get(runId) as PipelineRunRow|undefined;
    return row?pipelineRunDto(row):null;
  },

  createPipelineRun(args:{id:string;suiteId:number;workspaceId:number;playProvider:ProviderId|null;playModel:string|null;pipelineRunId?:string|null}):SuitePipelineRun {
    return sqliteGuard(()=>{
      const now=new Date().toISOString();
      db.prepare("INSERT INTO suite_pipeline_run(id,suite_id,workspace_id,state,current_prompt_id,current_run_id,attempt,recovering,play_provider,play_model,started_at,pipeline_run_id) VALUES(?,?,?,'PLAYING',NULL,NULL,0,0,?,?,?,?)")
        .run(args.id,args.suiteId,args.workspaceId,args.playProvider,args.playModel,now,args.pipelineRunId??null);
      return this.pipelineById(args.id)!;
    });
  },

  updatePipelineRun(id:string,patch:{
    state?:PipelineState;
    currentPromptId?:number|null;
    currentRunId?:string|null;
    attempt?:number;
    recovering?:boolean;
    playProvider?:ProviderId|null;
    playModel?:string|null;
    endedAt?:string|null;
    stopReason?:string|null;
  }):SuitePipelineRun {
    const current=this.pipelineById(id);
    if(!current)throw new WorkspaceError(404,"not_found","Pipeline run not found");
    const next={
      state:patch.state??current.state,
      currentPromptId:patch.currentPromptId===undefined?current.currentPromptId:patch.currentPromptId,
      currentRunId:patch.currentRunId===undefined?current.currentRunId:patch.currentRunId,
      attempt:patch.attempt??current.attempt,
      recovering:patch.recovering===undefined?current.recovering:patch.recovering,
      playProvider:patch.playProvider===undefined?current.playProvider:patch.playProvider,
      playModel:patch.playModel===undefined?current.playModel:patch.playModel,
      endedAt:patch.endedAt===undefined?current.endedAt:patch.endedAt,
      stopReason:patch.stopReason===undefined?current.stopReason:patch.stopReason,
    };
    db.prepare("UPDATE suite_pipeline_run SET state=?,current_prompt_id=?,current_run_id=?,attempt=?,recovering=?,play_provider=?,play_model=?,ended_at=?,stop_reason=? WHERE id=?")
      .run(next.state,next.currentPromptId,next.currentRunId,next.attempt,next.recovering?1:0,next.playProvider,next.playModel,next.endedAt,next.stopReason,id);
    return this.pipelineById(id)!;
  },

  readyPromptsInSuite(workspaceId:number,suiteId:number):PromptOption[] {
    const options=new Map(this.promptOptions(workspaceId).map(prompt=>[prompt.id,prompt]));
    const next:PromptOption[]=[];
    for(const step of this.enabledPipelineSteps(suiteId)){
      const prompt=options.get(step.promptId);
      if(prompt===undefined) continue;
      if(prompt.status==="DONE"||prompt.status==="SKIPPED") continue;
      if(prompt.ready){ next.push(prompt); continue; }
      break;
    }
    return next;
  },

  remainingPipelinePromptIds(suiteId:number):number[] {
    return this.enabledPipelineSteps(suiteId).map(step=>step.promptId);
  },

  suitePromptRows(suiteId:number):Array<{id:number;status:PromptRecord["status"]}> {
    return db.prepare("SELECT id,status FROM prompt WHERE suite_id=? ORDER BY sort_order,id").all(suiteId) as Array<{id:number;status:PromptRecord["status"]}>;
  },

  skipPrompt(promptId:number,actor:"SYSTEM"|"USER",reason:string):void {
    sqliteGuard(()=>db.transaction(()=>{
      const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as {status:PromptRecord["status"]}|undefined;
      if(!prompt)throw new WorkspaceError(404,"not_found","Prompt not found");
      if(prompt.status==="DONE")throw new WorkspaceError(409,"invalid_transition","Completed work items cannot be skipped");
      if(prompt.status==="SKIPPED")throw new WorkspaceError(409,"already_skipped","Work item is already skipped");
      if(prompt.status==="IN_PROGRESS"){
        const run=db.prepare("SELECT id FROM agent_run WHERE prompt_id=? AND role='execute' AND state IN ('STARTING','RUNNING') ORDER BY started_at DESC LIMIT 1").get(promptId) as {id:string}|undefined;
        if(run&&activeRuns.has(run.id))throw new WorkspaceError(409,"prompt_run_active","Stop the running agent before skipping this work item");
        throw new WorkspaceError(409,"invalid_transition","In-progress work items cannot be skipped");
      }
      if(prompt.status!=="TODO"&&prompt.status!=="BLOCKED")throw new WorkspaceError(409,"invalid_transition","Only TODO or BLOCKED work items can be skipped");
      const now=new Date().toISOString();
      db.prepare("UPDATE prompt SET status='SKIPPED',updated_at=? WHERE id=?").run(now,promptId);
      db.prepare("INSERT INTO prompt_status_event(prompt_id,run_id,previous_status,new_status,reason,actor_type,created_at) VALUES(?,NULL,?, 'SKIPPED',?,?,?)").run(promptId,prompt.status,reason,actor,now);
      db.prepare("INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,NULL,?,?,?,?)").run(promptId,actor==="USER"?"HUMAN_RESPONSE":"PROGRESS",reason,actor,now);
    })());
  },

  resetPromptToTodo(promptId:number,reason:string):void {
    sqliteGuard(()=>db.transaction(()=>{
      const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as {status:PromptRecord["status"]}|undefined;
      if(!prompt)throw new WorkspaceError(404,"not_found","Prompt not found");
      if(prompt.status==="IN_PROGRESS"){
        const run=db.prepare("SELECT id FROM agent_run WHERE prompt_id=? AND role='execute' AND state IN ('STARTING','RUNNING') ORDER BY started_at DESC LIMIT 1").get(promptId) as {id:string}|undefined;
        if(run&&activeRuns.has(run.id))throw new WorkspaceError(409,"run_active","The agent process is still active");
      }else if(prompt.status!=="BLOCKED"){
        throw new WorkspaceError(409,"invalid_transition","Pipeline can only reset BLOCKED stations to TODO");
      }
      const now=new Date().toISOString();
      db.prepare("UPDATE prompt SET status='TODO',result='',completed_at=NULL,updated_at=? WHERE id=?").run(now,promptId);
      db.prepare("INSERT INTO prompt_status_event(prompt_id,run_id,previous_status,new_status,reason,actor_type,created_at) VALUES(?,NULL,?,'TODO',?,'SYSTEM',?)").run(promptId,prompt.status,reason,now);
      db.prepare("INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,NULL,'HUMAN_RESPONSE',?,'SYSTEM',?)")
        .run(promptId,"Pipeline is retrying / recovering this station. Inspect the working tree and prior evidence; do not repeat resolved work.",now);
    })());
  },

  reopenPrompt(promptId:number,reason:string):void {
    sqliteGuard(()=>db.transaction(()=>{
      const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as {status:PromptRecord["status"]}|undefined;
      if(!prompt)throw new WorkspaceError(404,"not_found","Prompt not found");
      if(prompt.status!=="DONE"&&prompt.status!=="SKIPPED")throw new WorkspaceError(409,"invalid_transition","Only completed work items can be reopened");
      const now=new Date().toISOString();
      db.prepare("UPDATE prompt SET status='TODO',result='',completed_at=NULL,updated_at=? WHERE id=?").run(now,promptId);
      db.prepare("DELETE FROM human_response_hold WHERE prompt_id=?").run(promptId);
      db.prepare("INSERT INTO prompt_status_event(prompt_id,run_id,previous_status,new_status,reason,actor_type,created_at) VALUES(?,NULL,?,'TODO',?,'USER',?)").run(promptId,prompt.status,requireText(reason,"reason",1000),now);
    })());
  },

  interruptPipelinesOnRestart():void {
    const now=new Date().toISOString();
    db.prepare("UPDATE suite_pipeline_run SET state='INTERRUPTED',ended_at=?,stop_reason='server_restart' WHERE state IN ('PLAYING','PAUSED','WAITING_HUMAN')").run(now);
    db.prepare("UPDATE pipeline_run SET state='INTERRUPTED',ended_at=?,stop_reason='server_restart' WHERE state IN ('PLAYING','PAUSED','WAITING_HUMAN')").run(now);
  },

  /* ---------------------------------------------------------------- */
  /* Named pipelines                                                    */
  /* ---------------------------------------------------------------- */

  pipelineStages(pipelineId:number):PipelineStage[] {
    return db.prepare(`
      SELECT st.suite_id suiteId, st.sort_order sortOrder,
             g.id programId, g.name programName, g.external_key programKey,
             s.name suiteName, s.external_key suiteKey,
             (SELECT count(*) FROM prompt p WHERE p.suite_id=s.id) promptCount,
             (SELECT count(*) FROM prompt_pipeline_rule r JOIN prompt p ON p.id=r.prompt_id WHERE p.suite_id=s.id AND r.enabled=1) stepCount
      FROM pipeline_stage st
      JOIN suite s ON s.id=st.suite_id
      JOIN program g ON g.id=s.program_id
      WHERE st.pipeline_id=?
      ORDER BY st.sort_order, s.id
    `).all(pipelineId) as PipelineStage[];
  },

  namedPipelineRunById(id:string):PipelineRun|null {
    const row=db.prepare("SELECT * FROM pipeline_run WHERE id=?").get(id) as NamedPipelineRunRow|undefined;
    return row?namedPipelineRunDto(row):null;
  },

  activeNamedPipelineRun(pipelineId:number):PipelineRun|null {
    const row=db.prepare("SELECT * FROM pipeline_run WHERE pipeline_id=? AND state IN ('PLAYING','WAITING_HUMAN','PAUSED') ORDER BY started_at DESC LIMIT 1").get(pipelineId) as NamedPipelineRunRow|undefined;
    return row?namedPipelineRunDto(row):null;
  },

  latestNamedPipelineRun(pipelineId:number):PipelineRun|null {
    const row=db.prepare("SELECT * FROM pipeline_run WHERE pipeline_id=? ORDER BY started_at DESC LIMIT 1").get(pipelineId) as NamedPipelineRunRow|undefined;
    return row?namedPipelineRunDto(row):null;
  },

  activeNamedPipelineForWorkspace(workspaceId:number):PipelineRun|null {
    const row=db.prepare("SELECT * FROM pipeline_run WHERE workspace_id=? AND state IN ('PLAYING','WAITING_HUMAN','PAUSED') ORDER BY started_at DESC LIMIT 1").get(workspaceId) as NamedPipelineRunRow|undefined;
    return row?namedPipelineRunDto(row):null;
  },

  hydratePipeline(row:NamedPipelineRow):PipelineRecord {
    const workspace=this.get(row.workspace_id);
    return {
      id:row.id,
      workspaceId:row.workspace_id,
      workspaceName:workspace.name,
      name:row.name,
      description:row.description,
      executionProvider:asProviderId(row.execution_provider),
      executionModel:row.execution_model,
      createdAt:row.created_at,
      updatedAt:row.updated_at,
      stages:this.pipelineStages(row.id),
      active:this.activeNamedPipelineRun(row.id),
      latest:this.latestNamedPipelineRun(row.id),
    };
  },

  listPipelines(workspaceId?:number):PipelineRecord[] {
    if(workspaceId!==undefined) this.get(workspaceId);
    const rows=workspaceId===undefined
      ? db.prepare("SELECT * FROM pipeline ORDER BY updated_at DESC, id DESC").all() as NamedPipelineRow[]
      : db.prepare("SELECT * FROM pipeline WHERE workspace_id=? ORDER BY updated_at DESC, id DESC").all(workspaceId) as NamedPipelineRow[];
    return rows.map(row=>this.hydratePipeline(row));
  },

  getPipeline(id:number):PipelineRecord {
    const row=db.prepare("SELECT * FROM pipeline WHERE id=?").get(id) as NamedPipelineRow|undefined;
    if(!row) throw new WorkspaceError(404,"not_found","Pipeline not found");
    return this.hydratePipeline(row);
  },

  replacePipelineStages(pipelineId:number,workspaceId:number,suiteIds:number[]):void {
    const seen=new Set<number>();
    suiteIds.forEach((suiteId,index)=>{
      if(typeof suiteId!=="number"||!Number.isSafeInteger(suiteId)||suiteId<=0){
        throw new WorkspaceError(422,"validation_error","suiteIds must be positive integers",{suiteIds:"Invalid suite id"});
      }
      if(seen.has(suiteId)) throw new WorkspaceError(422,"validation_error","suiteIds must be unique",{suiteIds:"Duplicate suite"});
      seen.add(suiteId);
      const home=this.suiteHeader(suiteId);
      if(home.workspaceId!==workspaceId){
        throw new WorkspaceError(422,"validation_error","Every suite must belong to this pipeline's workspace",{suiteIds:`Suite ${suiteId} is in another workspace`});
      }
      db.prepare("INSERT INTO pipeline_stage(pipeline_id,suite_id,sort_order) VALUES(?,?,?)").run(pipelineId,suiteId,index);
    });
  },

  createPipeline(input:Record<string,unknown>):PipelineRecord {
    return sqliteGuard(()=>db.transaction(()=>{
      const workspaceId=typeof input.workspaceId==="number"?input.workspaceId:0;
      this.get(workspaceId);
      const name=requireText(input.name,"name",120);
      const description=requireText(input.description??"","description",4000,true);
      const suiteIds=Array.isArray(input.suiteIds)?input.suiteIds.filter((value):value is number=>typeof value==="number"):[];
      const now=new Date().toISOString();
      const result=db.prepare("INSERT INTO pipeline(workspace_id,name,description,created_at,updated_at) VALUES(?,?,?,?,?)")
        .run(workspaceId,name,description,now,now);
      const id=Number(result.lastInsertRowid);
      this.replacePipelineStages(id,workspaceId,suiteIds);
      return this.getPipeline(id);
    })());
  },

  updatePipeline(id:number,input:Record<string,unknown>):PipelineRecord {
    return sqliteGuard(()=>db.transaction(()=>{
      const current=this.getPipeline(id);
      const name=input.name===undefined?current.name:requireText(input.name,"name",120);
      const description=input.description===undefined?current.description:requireText(input.description,"description",4000,true);
      const executionProvider = "executionProvider" in input ? optionalProviderField(input.executionProvider, "executionProvider") : current.executionProvider;
      // Clear a previous provider's model when switching or removing the override.
      const executionModel = executionProvider === null ? null : "executionModel" in input
        ? optionalModelField(input.executionModel, "executionModel")
        : executionProvider === current.executionProvider ? current.executionModel : null;
      if("suiteIds" in input && current.active!==null){
        throw new WorkspaceError(409,"pipeline_active","Stop the running pipeline before changing its stages");
      }
      db.prepare("UPDATE pipeline SET name=?,description=?,execution_provider=?,execution_model=?,updated_at=? WHERE id=?")
        .run(name,description,executionProvider,executionModel,new Date().toISOString(),id);
      if("suiteIds" in input){
        const suiteIds=Array.isArray(input.suiteIds)?input.suiteIds.filter((value):value is number=>typeof value==="number"):[];
        db.prepare("DELETE FROM pipeline_stage WHERE pipeline_id=?").run(id);
        this.replacePipelineStages(id,current.workspaceId,suiteIds);
      }
      return this.getPipeline(id);
    })());
  },

  deletePipeline(id:number):void {
    const current=this.getPipeline(id);
    if(current.active!==null) throw new WorkspaceError(409,"pipeline_active","Stop the running pipeline before deleting it");
    if(db.prepare("DELETE FROM pipeline WHERE id=?").run(id).changes===0) throw new WorkspaceError(404,"not_found","Pipeline not found");
  },

  createNamedPipelineRun(args:{id:string;pipelineId:number;workspaceId:number;playProvider:ProviderId|null;playModel:string|null}):PipelineRun {
    return sqliteGuard(()=>{
      const now=new Date().toISOString();
      db.prepare("INSERT INTO pipeline_run(id,pipeline_id,workspace_id,state,current_suite_id,current_suite_run_id,play_provider,play_model,started_at) VALUES(?,?,?,'PLAYING',NULL,NULL,?,?,?)")
        .run(args.id,args.pipelineId,args.workspaceId,args.playProvider,args.playModel,now);
      return this.namedPipelineRunById(args.id)!;
    });
  },

  updateNamedPipelineRun(id:string,patch:{
    state?:PipelineState;
    currentSuiteId?:number|null;
    currentSuiteRunId?:string|null;
    playProvider?:ProviderId|null;
    playModel?:string|null;
    endedAt?:string|null;
    stopReason?:string|null;
  }):PipelineRun {
    const current=this.namedPipelineRunById(id);
    if(!current) throw new WorkspaceError(404,"not_found","Pipeline run not found");
    const next={
      state:patch.state??current.state,
      currentSuiteId:patch.currentSuiteId===undefined?current.currentSuiteId:patch.currentSuiteId,
      currentSuiteRunId:patch.currentSuiteRunId===undefined?current.currentSuiteRunId:patch.currentSuiteRunId,
      playProvider:patch.playProvider===undefined?current.playProvider:patch.playProvider,
      playModel:patch.playModel===undefined?current.playModel:patch.playModel,
      endedAt:patch.endedAt===undefined?current.endedAt:patch.endedAt,
      stopReason:patch.stopReason===undefined?current.stopReason:patch.stopReason,
    };
    db.prepare("UPDATE pipeline_run SET state=?,current_suite_id=?,current_suite_run_id=?,play_provider=?,play_model=?,ended_at=?,stop_reason=? WHERE id=?")
      .run(next.state,next.currentSuiteId,next.currentSuiteRunId,next.playProvider,next.playModel,next.endedAt,next.stopReason,id);
    return this.namedPipelineRunById(id)!;
  },

  listPipelineRuns(pipelineId:number):PipelineRunDetail[] {
    this.getPipeline(pipelineId);
    const rows=db.prepare("SELECT * FROM pipeline_run WHERE pipeline_id=? ORDER BY started_at DESC").all(pipelineId) as NamedPipelineRunRow[];
    return rows.map(row=>this.pipelineRunDetail(row.id));
  },

  pipelineRunDetail(id:string):PipelineRunDetail {
    const run=this.namedPipelineRunById(id);
    if(!run) throw new WorkspaceError(404,"not_found","Pipeline run not found");
    const pipeline=this.getPipeline(run.pipelineId);
    const suiteRuns=new Map(
      (db.prepare("SELECT * FROM suite_pipeline_run WHERE pipeline_run_id=?").all(id) as PipelineRunRow[])
        .map(row=>[row.suite_id,pipelineRunDto(row)]),
    );
    return {
      ...run,
      pipelineName:pipeline.name,
      stages:pipeline.stages.map(stage=>({
        suiteId:stage.suiteId,
        suiteName:stage.suiteName,
        programName:stage.programName,
        sortOrder:stage.sortOrder,
        suiteRun:suiteRuns.get(stage.suiteId)??null,
      })),
    };
  },

  createHandoff(args:{id:string;workspaceId:number;promptId:number;sourceRunId:string;provider:ProviderId;model:string|null}):HandoffRecord {
    const now=new Date().toISOString();
    db.prepare("INSERT INTO handoff(id,workspace_id,prompt_id,source_run_id,provider,model,state,created_at) VALUES(?,?,?,?,?,?,'QUEUED',?)")
      .run(args.id,args.workspaceId,args.promptId,args.sourceRunId,args.provider,args.model,now);
    return this.handoffById(args.id)!;
  },
  handoffById(id:string):HandoffRecord|null { const row=db.prepare("SELECT * FROM handoff WHERE id=?").get(id) as Record<string,unknown>|undefined;return row?handoffDto(row):null; },
  handoffsForPrompt(promptId:number):HandoffRecord[] { return (db.prepare("SELECT * FROM handoff WHERE prompt_id=? ORDER BY created_at DESC").all(promptId) as Record<string,unknown>[]).map(handoffDto); },
  /**
   * The status event that blocked this task, with the options the agent offered
   * with it (L3 A2). Null unless the task is BLOCKED right now, so options and the
   * "blocked N ago" age can never survive into a later question.
   */
  blockingStatus(promptId:number):{createdAt:string;options:AgentStatusOption[]}|null {
    const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as {status:PromptRecord["status"]}|undefined;
    if(prompt?.status!=="BLOCKED")return null;
    const row=db.prepare("SELECT created_at createdAt,options_json optionsJson FROM prompt_status_event WHERE prompt_id=? AND new_status='BLOCKED' ORDER BY id DESC LIMIT 1").get(promptId) as {createdAt:string;optionsJson:string|null}|undefined;
    if(!row)return null;
    let options:AgentStatusOption[]=[];
    try{const parsed=row.optionsJson===null?[]:JSON.parse(row.optionsJson) as unknown;if(Array.isArray(parsed))options=parsed as AgentStatusOption[];}catch{options=[];}
    return {createdAt:row.createdAt,options};
  },
  latestReadyHandoffMarkdown(promptId:number):string { return (db.prepare("SELECT brief_markdown text FROM handoff WHERE prompt_id=? AND state='READY' ORDER BY created_at DESC LIMIT 1").get(promptId) as {text:string}|undefined)?.text??""; },
  updateHandoff(id:string,patch:{handoffRunId?:string|null;successorRunId?:string|null;state?:HandoffRecord["state"];recommendation?:HandoffRecommendation|null;brief?:HandoffBrief|null;briefMarkdown?:string;error?:string|null;completedAt?:string|null}):HandoffRecord {
    const current=this.handoffById(id);if(!current)throw new WorkspaceError(404,"not_found","Handoff not found");
    const next={handoffRunId:patch.handoffRunId===undefined?current.handoffRunId:patch.handoffRunId,successorRunId:patch.successorRunId===undefined?current.successorRunId:patch.successorRunId,state:patch.state??current.state,recommendation:patch.recommendation===undefined?current.recommendation:patch.recommendation,brief:patch.brief===undefined?current.brief:patch.brief,briefMarkdown:patch.briefMarkdown===undefined?current.briefMarkdown:patch.briefMarkdown,error:patch.error===undefined?current.error:patch.error,completedAt:patch.completedAt===undefined?current.completedAt:patch.completedAt};
    db.prepare("UPDATE handoff SET handoff_run_id=?,successor_run_id=?,state=?,recommendation=?,brief_json=?,brief_markdown=?,error=?,completed_at=? WHERE id=?")
      .run(next.handoffRunId,next.successorRunId,next.state,next.recommendation,next.brief===null?null:JSON.stringify(next.brief),next.briefMarkdown,next.error,next.completedAt,id);
    return this.handoffById(id)!;
  },
  handoffDossier(workspaceId:number,promptId:number,sourceRunId:string):string {
    const context=this.agentContext(workspaceId,promptId);const history=this.promptHistory(promptId);
    const source=(history.runs as Array<Record<string,unknown>>).find(run=>run.id===sourceRunId);
    if(!source)throw new WorkspaceError(404,"not_found","Source run not found");
    const events=(db.prepare("SELECT event_json FROM agent_run_event WHERE run_id=? ORDER BY id").all(sourceRunId) as Array<{event_json:string}>).map(row=>JSON.parse(row.event_json) as NormalizedEvent);
    const compact=events.filter(event=>event.type!=="status"&&event.type!=="assistant_text"||event.type==="assistant_text"&&event.payload.kind==="message").slice(-120);
    return JSON.stringify({context,sourceRun:source,sourceEvents:compact,history},null,2);
  },
  preparePromptForSuccessor(promptId:number,handoffId:string,briefMarkdown:string):void { sqliteGuard(()=>db.transaction(()=>{
    const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as {status:PromptRecord["status"]}|undefined;if(!prompt)throw new WorkspaceError(404,"not_found","Prompt not found");
    if(prompt.status==="DONE"||prompt.status==="SKIPPED")throw new WorkspaceError(409,"already_terminal","Work item is already complete");
    const now=new Date().toISOString();db.prepare("UPDATE prompt SET status='TODO',result='',completed_at=NULL,updated_at=? WHERE id=?").run(now,promptId);
    db.prepare("INSERT INTO prompt_status_event(prompt_id,previous_status,new_status,reason,actor_type,created_at) VALUES(?,?,'TODO',?,'SYSTEM',?)").run(promptId,prompt.status,`Automatic continuation prepared by handoff ${handoffId}`,now);
    db.prepare("INSERT INTO prompt_remark(prompt_id,kind,content,actor_type,created_at) VALUES(?,'PROGRESS',?,'SYSTEM',?)").run(promptId,`${briefMarkdown}\n\nHandoff: ${handoffId}`,now);
  })()); },
  suitePipelineForRun(runId:string):SuitePipelineRun|null { const row=db.prepare("SELECT * FROM suite_pipeline_run WHERE current_run_id=? ORDER BY started_at DESC LIMIT 1").get(runId) as PipelineRunRow|undefined;return row?pipelineRunDto(row):null; },
  close(): void { db.close(); },
};
