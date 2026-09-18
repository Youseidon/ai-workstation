import Database from "better-sqlite3";
import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { INSTRUCTION_CONTENT_MAX, INSTRUCTION_FILE_NAMES, isInstructionField, type InstructionProposalOrigin, type InstructionProposalRecord, type InstructionProposalState, type WorkspaceInstructionField } from "@agent-console/shared";
import { DRAFT_GOAL_MAX, DRAFT_KEY_PATTERN, applyRevisionChanges, diffProgramRevision, promptKeyAt, suiteKeyAt, type ProgramDraftPrompt, type ProgramDraftSuite, bodyFromProgramProposal, canApplyProgramDraft, emptyProgramDraftBody, normalizeProgramDraftBody, normalizeProgramProposal, normalizeSuiteProposal, programDraftIssues, programDraftPreview, programKeyFrom, resolvedDependencies, withSuiteProposal, type ProgramDraftBody, type ProgramDraftRecord, type ProgramDraftState, DEFAULT_STATUS_CATALOG, DEFAULT_TRIGGER_SENTENCES, DOD_COMMAND_MAX_LENGTH, DOD_COMMAND_OUTPUT_MAX_BYTES, DOD_COMMAND_TIMEOUT_DEFAULT_MS, clampDodTimeout, dodUnmetEvidence, dodUnmetReason, isDodCriterionKind, isDodEnforcement, isDodResult, isDodResultSource, isDodScope, matchStepTransition, parseVerifyBlock, unmetCriteria, type DefinitionOfDone, type DodCriterion, type DodCriterionResult, type DodEnforcement, type DodEvaluation, type DodResult, type DodResultSource, type DodScope, defaultStatusDefinition, isStatusIcon, isStatusTrigger, isStepDisplayStatus, isStepStatus, isStatusOnEnter, isStatusTone, isTerminalDisplayStatus, rollupStatus, statusDefinition, statusFieldEditable, type ActorType, type RemarkKind, type StatusDefinition, type StatusEditableKey, type StatusTrigger, type StepStatus, USAGE_REPORT_PRICING_NOTE, addUsageToTotals, defaultPromptPipelineRule, emptyUsageTotals, estimateCost, isOnUnfinishedAction, isOnDoneAction, isProviderId, isRunRole, usageFromEvents, type AgentRunActivity, type AgentSession, type ClarificationExchange, type CompletionAuditRecord, type CompletionAuditReport, type CompletionVerdict, type HumanInputRequest, type NormalizedEvent, type OperationsPrompt, type OperationsSession, type OperationsSnapshot, type OperationsSuite, type PipelineAvailablePrompt, type PipelineBlockedStation, type PipelineDashboard, type PipelineDashboardItem, type PipelineFlowchartView, type PipelineRecord, type PipelineRun, type PipelineRunDetail, type PipelineSubStepRule, type PipelineStage, type PipelineState, type PipelineThroughputDay, type ProgramRecord, type PromptActivity, type PromptOperationalState, type PromptOption, type PromptPipelineRule, type PromptRecord, type PromptRemark, type PromptStatusEvent, type ProviderId, type RunRole, type SessionUsageRow, type SuitePipelineDefaults, type SuitePipelineRun, type SuiteRecord, type SuiteUsageRow, type SuiteVerificationBadge, type SuiteVerificationContext, type SuiteVerificationDetail, type SuiteVerificationItem, type SuiteVerificationRecord, type SuiteVerificationStats, type SuiteVerificationVerdict, type TaskUsageRow, type TokenUsage, type WorkspaceRevision, type UsageReport, type UsageTotals, type WorkspaceRecord, type WorkspaceTree } from "@agent-console/shared";
import { config } from "./config.ts";
import { currentLockMode } from "./lib/instanceLock.ts";
import { createLogger } from "./lib/logger.ts";
import type { ImportedProgram } from "./promptImport.ts";
import { activeRuns } from "./activeRuns.ts";
import type { ProgramBrief, ProgramBriefItem } from "./programBrief.ts";
import { settings } from "./settings.ts";
import { OPERATIONAL_STATES, operationalState } from "./operationalState.ts";
import { decide, endOfRunReason, endOfRunSignal } from "./statusTransition.ts";
import type { RunOutcome } from "./statusTransition.ts";
import { compactWorkItem, deriveVerdict, dossierHeading, parseReportItems, summarize, uniqueCommands } from "./suiteVerification.ts";

/*
 * Where the orchestration database lives, and why it is not in the repo.
 *
 * It used to default to `<repoRoot>/.agent-console/console.sqlite`. That is the
 * one place it must not be: `repoRoot` is very often the directory a workspace
 * points at, which is the directory an agent is given as its cwd with edit
 * permissions. The app told agents "never open or modify SQLite directly" in a
 * Markdown block and then left the file inside their sandbox — a rule enforced
 * by asking nicely.
 *
 * XDG state is the right home for it: per-user, outside every repository, and
 * conventional. `AGENT_CONSOLE_DB` still wins, which is how the tests point
 * somewhere disposable — they must never open the console's own database, since
 * they create and delete workspaces and a cancelled run leaves that debris in
 * real data.
 */
function defaultDatabasePath(): string {
  const state = process.env.XDG_STATE_HOME;
  const base = state !== undefined && state.trim() !== ""
    ? resolve(state.trim())
    : resolve(homedir(), ".local/state");
  return resolve(base, "agent-console/console.sqlite");
}

const databasePath = process.env.AGENT_CONSOLE_DB !== undefined && process.env.AGENT_CONSOLE_DB !== ""
  ? resolve(process.env.AGENT_CONSOLE_DB)
  : defaultDatabasePath();

/*
 * The watch server is a deployment, and that is the bug.
 *
 * `npm run dev` runs under `tsx watch`: saving a file restarts the process,
 * which kills every agent in flight and runs any new migration against whatever
 * database it is pointed at. 22 of the owner's first 34 pipeline runs died that
 * way. `npm run serve` is the way to run a live pipeline; `npm run dev:sandbox`
 * is the way to develop.
 *
 * This sits here, above `new Database`, rather than beside the instance lock in
 * `index.ts`, because opening the file is already the damage: migrations run on
 * import, so a guard in the listen callback would fire after the live schema had
 * been rewritten. Narrow on purpose — only an unlabelled (watch) process, only
 * the default state-dir path, and only when nothing said otherwise.
 */
if (
  currentLockMode() !== "serve"
  && process.env.AGENT_CONSOLE_ALLOW_DEV_ON_LIVE !== "1"
  && (process.env.AGENT_CONSOLE_DB === undefined || process.env.AGENT_CONSOLE_DB.trim() === "")
) {
  createLogger("server").error(
    `Refusing to run the watch server against the live database (${databasePath}). `
    + "Use `npm run serve` for a live pipeline, or `npm run dev:sandbox` to develop against a copy. "
    + "Set AGENT_CONSOLE_ALLOW_DEV_ON_LIVE=1 if you really mean this one.",
  );
  process.exit(1);
}

mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });

/*
 * One-time move of an existing database out of the repository.
 *
 * Copied and left behind rather than deleted: if this is wrong for someone's
 * setup, their data is still where it was. The WAL and SHM are deliberately not
 * copied — SQLite rebuilds them, and a WAL paired with the wrong database is
 * worse than none. A checkpoint first makes sure nothing is only in the WAL.
 */
const legacyDatabasePath = resolve(config.repoRoot, ".agent-console/console.sqlite");
if (process.env.AGENT_CONSOLE_DB === undefined && !existsSync(databasePath) && existsSync(legacyDatabasePath)) {
  const legacy = new Database(legacyDatabasePath);
  try {
    legacy.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    legacy.close();
  }
  copyFileSync(legacyDatabasePath, databasePath);
  chmodSync(databasePath, 0o600);
}

const db = new Database(databasePath);
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
for(const file of [databasePath,`${databasePath}-wal`,`${databasePath}-shm`])if(existsSync(file))chmodSync(file,0o600);

function findOperationsPrompt(prompts: OperationsPrompt[], promptId: number): OperationsPrompt | undefined {
  for (const prompt of prompts) {
    if (prompt.prompt.id === promptId) return prompt;
    const child = findOperationsPrompt(prompt.children, promptId);
    if (child !== undefined) return child;
  }
  return undefined;
}

function handoffEvent(event: NormalizedEvent): Record<string, unknown> {
  const base = { type: event.type, timestamp: event.timestamp };
  if (event.type === "assistant_text") return { ...base, kind: event.payload.kind, text: event.payload.text.slice(0, 4000) };
  if (event.type === "tool_use") return { ...base, name: event.payload.name, summary: event.payload.summary.slice(0, 1000), input: JSON.stringify(event.payload.input).slice(0, 2000) };
  if (event.type === "tool_result") return { ...base, summary: event.payload.summary.slice(0, 1000), output: event.payload.output.slice(0, 4000) };
  if (event.type === "result") return { ...base, state: event.payload.state, text: event.payload.text?.slice(0, 4000) ?? null };
  if (event.type === "error") return { ...base, message: event.payload.message.slice(0, 2000), detail: event.payload.detail?.slice(0, 2000) ?? null };
  return base;
}

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
  const afterThirteen = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
  if (afterThirteen < 14) {
    db.exec(`
      CREATE TABLE pipeline_step (
        pipeline_id INTEGER NOT NULL REFERENCES pipeline(id) ON DELETE CASCADE,
        prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
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
        step_order INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (pipeline_id, prompt_id)
      );
      CREATE INDEX pipeline_step_pipeline_idx ON pipeline_step(pipeline_id, step_order);
      INSERT INTO pipeline_step (
        pipeline_id, prompt_id, provider, model, on_done, on_blocked,
        retry_limit, recover_provider, recover_model, step_order, updated_at
      )
      SELECT ps.pipeline_id, r.prompt_id, r.provider, r.model, r.on_done, r.on_blocked,
             r.retry_limit, r.recover_provider, r.recover_model, r.step_order, r.updated_at
      FROM prompt_pipeline_rule r
      JOIN prompt p ON p.id = r.prompt_id
      JOIN pipeline_stage ps ON ps.suite_id = p.suite_id
      WHERE r.enabled = 1;
    `);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(14,?)").run(new Date().toISOString());
  }
  const afterFourteen = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
  if (afterFourteen < 15) {
    // A prompt an agent decomposes gets sub-steps: real prompts, tracked like
    // any other, but never a pipeline_step in their own right — the parent
    // stays the one flowchart entry and its prompt_dependency rows (below)
    // gate it on every child reaching DONE.
    db.exec(`
      ALTER TABLE prompt ADD COLUMN parent_prompt_id INTEGER REFERENCES prompt(id) ON DELETE CASCADE;
      ALTER TABLE prompt ADD COLUMN child_order INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX prompt_parent_idx ON prompt(parent_prompt_id, child_order);
    `);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(15,?)").run(new Date().toISOString());
  }
  const afterFifteen = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
  if (afterFifteen < 16) {
    // Prompt content had no history: updateChild overwrote it in place, so a
    // bad edit — by hand or by a bulk rewrite — was unrecoverable. Status and
    // run output were already versioned (prompt_status_event, prompt_remark);
    // this closes the gap for the text itself. Every existing prompt is seeded
    // as its own revision 0 so the pre-versioning state is captured too.
    db.exec(`
      CREATE TABLE prompt_revision (
        id INTEGER PRIMARY KEY,
        prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX prompt_revision_prompt_idx ON prompt_revision(prompt_id, id);
    `);
    const seedNow = new Date().toISOString();
    db.prepare(
      "INSERT INTO prompt_revision(prompt_id,title,content,actor_type,reason,created_at) SELECT id,title,content,'SYSTEM','Seeded when prompt versioning was introduced',? FROM prompt",
    ).run(seedNow);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(16,?)").run(seedNow);
  }
  const afterSixteen = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
  if (afterSixteen < 17) {
    // Per-run cost was only recoverable by parsing every agent_run_event row.
    // These columns make "what did this run cost" a single query, which is the
    // precondition for enforcing — and proving — the run budgets.
    db.exec(`
      ALTER TABLE agent_run ADD COLUMN input_tokens INTEGER;
      ALTER TABLE agent_run ADD COLUMN output_tokens INTEGER;
      ALTER TABLE agent_run ADD COLUMN cached_input_tokens INTEGER;
      ALTER TABLE agent_run ADD COLUMN tool_calls INTEGER;
      ALTER TABLE agent_run ADD COLUMN tool_output_bytes INTEGER;
      ALTER TABLE agent_run ADD COLUMN stop_reason TEXT;
    `);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(17,?)").run(new Date().toISOString());
  }
  const afterSeventeen = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
  if (afterSeventeen < 18) {
    // The repo-level agent instruction files, owned here rather than in the
    // working tree. They are still written to disk for each run — a provider
    // CLI loads CLAUDE.md/AGENTS.md itself, and only a real file reaches
    // subagents, survives compaction, and participates in nested loading. The
    // database is the source of truth; the files are its projection.
    db.exec(`
      ALTER TABLE workspace ADD COLUMN claude_md TEXT NOT NULL DEFAULT '';
      ALTER TABLE workspace ADD COLUMN agents_md TEXT NOT NULL DEFAULT '';
      CREATE TABLE workspace_revision (
        id INTEGER PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        field TEXT NOT NULL CHECK(field IN ('claudeMd','agentsMd','description')),
        content TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX workspace_revision_idx ON workspace_revision(workspace_id, field, id);
    `);
    db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(18,?)").run(new Date().toISOString());
  }
}

const afterEighteen = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
if (afterEighteen < 19) {
  // A run parked on WAITING_HUMAN is not stopped, so the reason it is waiting
  // does not belong in `stop_reason` — that field means "why this run ended",
  // and overloading it hid the explanation exactly where it mattered most.
  db.exec(`
    ALTER TABLE suite_pipeline_run ADD COLUMN wait_reason TEXT;
    ALTER TABLE pipeline_run ADD COLUMN wait_reason TEXT;
  `);
  db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(19,?)").run(new Date().toISOString());
}

const afterNineteen = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
if (afterNineteen < 20) {
  // A station that blocks because its run never posted a status is a different
  // thing from a station that blocked with a question, and until now the two
  // were handled identically: both parked until a human looked. This table
  // records what an independent read-only auditor concluded about the first
  // kind, so an unattended pipeline can tell "already done, status dropped"
  // from "genuinely unfinished" without a person in the loop.
  //
  // Deliberately not UNIQUE on source_run_id: unlike a handoff, an audit may be
  // re-run by hand after the operator changes something, and the history of
  // what each attempt concluded is the audit trail.
  db.exec(`
    CREATE TABLE completion_audit (
      id TEXT PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
      prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
      source_run_id TEXT NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
      audit_run_id TEXT REFERENCES agent_run(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      model TEXT,
      state TEXT NOT NULL CHECK(state IN ('QUEUED','RUNNING','READY','FAILED')),
      verdict TEXT CHECK(verdict IN ('COMPLETE','INCOMPLETE','UNVERIFIABLE')),
      report_json TEXT,
      report_markdown TEXT NOT NULL DEFAULT '',
      applied INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX completion_audit_prompt_idx ON completion_audit(prompt_id,created_at);
    CREATE INDEX completion_audit_source_idx ON completion_audit(source_run_id);
    CREATE UNIQUE INDEX completion_audit_active_prompt_uq
      ON completion_audit(prompt_id) WHERE state IN ('QUEUED','RUNNING');
  `);
  db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(20,?)").run(new Date().toISOString());
}

const afterTwenty = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
if (afterTwenty < 21) {
  // The status vocabulary becomes data.
  //
  // Two problems are being fixed at once. The labels were hardcoded in the web
  // in two maps that disagreed with the shared rule table about what to call
  // the same state, and the operator could not change any of it. And a status
  // carried no record of what caused it: `prompt_status_event` stored a free-
  // text `reason`, which is fine for a human to read and useless for the app to
  // reason about, so nothing could tell an operator *which rule* had decided.
  //
  // `status_definition` is sparse on purpose. A row exists only for a field the
  // operator has actually changed; everything else falls through to
  // DEFAULT_STATUS_CATALOG in shared/src/statusModel.ts. That way a new status
  // shipped in a later release appears immediately rather than being invisible
  // until someone re-seeds a table, and an operator's edits survive an upgrade
  // that rewords the default.
  const migrate21 = db.transaction(() => {
    db.exec(`
      CREATE TABLE status_definition (
        id TEXT PRIMARY KEY,
        label TEXT,
        short_label TEXT,
        description TEXT,
        tone TEXT,
        icon TEXT,
        is_terminal INTEGER,
        satisfies_dependency INTEGER,
        blocks_parent INTEGER,
        needs_attention INTEGER,
        precedence INTEGER,
        on_enter TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE trigger_definition (
        id TEXT PRIMARY KEY,
        sentence TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      ALTER TABLE prompt_status_event ADD COLUMN trigger_id TEXT;
      ALTER TABLE prompt_status_event ADD COLUMN rule_id TEXT;
      ALTER TABLE prompt_status_event ADD COLUMN evidence_json TEXT;
    `);

    // Backfill the ledger. Existing rows have an actor and a reason but no
    // trigger, and leaving them null would make "every status change names its
    // cause" false for all the history the operator can still see. The mapping
    // below is the same one the code used to make implicitly.
    db.prepare(`UPDATE prompt_status_event SET trigger_id='import' WHERE actor_type='IMPORT' AND trigger_id IS NULL`).run();
    db.prepare(`UPDATE prompt_status_event SET trigger_id='agent_post' WHERE actor_type='AGENT' AND trigger_id IS NULL`).run();
    db.prepare(`UPDATE prompt_status_event SET trigger_id='operator_override' WHERE actor_type='USER' AND trigger_id IS NULL`).run();
    db.prepare(`UPDATE prompt_status_event SET trigger_id='run_started' WHERE actor_type='SYSTEM' AND new_status='IN_PROGRESS' AND trigger_id IS NULL`).run();
    db.prepare(`UPDATE prompt_status_event SET trigger_id='operator_skip' WHERE actor_type='SYSTEM' AND new_status='SKIPPED' AND trigger_id IS NULL`).run();
    // The system only ever wrote BLOCKED for one reason: a run that ended
    // without posting. That is exactly what UNREPORTED now means.
    db.prepare(`UPDATE prompt_status_event SET trigger_id='run_ended_without_post' WHERE actor_type='SYSTEM' AND new_status='BLOCKED' AND trigger_id IS NULL`).run();
    db.prepare(`UPDATE prompt_status_event SET trigger_id='operator_retry' WHERE trigger_id IS NULL AND new_status='TODO'`).run();
    db.prepare(`UPDATE prompt_status_event SET trigger_id='operator_override' WHERE trigger_id IS NULL`).run();

    // Migrate the statuses themselves. A prompt sitting at BLOCKED whose most
    // recent block was posted by the system is not blocked on a human at all —
    // it is a run that ended without reporting. That distinction used to be
    // recomputed on every read by looking up the last status event's actor;
    // storing it is the point of this release, so it is stored once, here.
    const systemBlocked = db.prepare(`
      SELECT p.id FROM prompt p
      WHERE p.status = 'BLOCKED'
        AND (
          SELECT e.actor_type FROM prompt_status_event e
          WHERE e.prompt_id = p.id AND e.new_status = 'BLOCKED'
          ORDER BY e.created_at DESC, e.id DESC LIMIT 1
        ) = 'SYSTEM'
    `).all() as Array<{ id: number }>;
    const reclassify = db.prepare("UPDATE prompt SET status='UNREPORTED' WHERE id=?");
    for (const row of systemBlocked) reclassify.run(row.id);
  });
  migrate21();
  db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(21,?)").run(new Date().toISOString());
}

const afterTwentyOne = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
if (afterTwentyOne < 22) {
  // The reviewer becomes configurable, and addressable.
  //
  // There was one global switch — auditOnBlocked: off | report | autocomplete —
  // so every situation the app has no first-hand account of had to be handled
  // identically. An operator could not say "check a run that went quiet, but
  // leave a crash for me", and could not choose which agent does the checking:
  // providerFor() simply took the first available one that was not the agent on
  // trial. That is a reasonable default and a poor rule.
  //
  // Sparse and scoped, like status_definition: a row exists only where someone
  // has actually said something, and resolution runs prompt → suite → pipeline
  // → global → the shipped defaults.
  const migrate22 = db.transaction(() => {
    db.exec(`
      CREATE TABLE reviewer_config (
        scope TEXT NOT NULL CHECK(scope IN ('global','pipeline','suite','prompt')),
        scope_id INTEGER,
        trigger_id TEXT NOT NULL,
        enabled INTEGER,
        provider TEXT,
        model TEXT,
        max_attempts INTEGER,
        must_differ_from_source INTEGER,
        on_complete TEXT,
        on_incomplete TEXT,
        on_unverifiable TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope, scope_id, trigger_id)
      );
    `);

    // A reviewer run is now its own role, so its sessions are distinguishable
    // in the activity view instead of being filed under the role it borrowed.
    // The TS union and this CHECK are two copies of one list and have to move
    // together, which is why the table is rebuilt rather than left alone.
    //
    // Foreign keys are disabled by the caller, OUTSIDE this transaction.
    // `PRAGMA foreign_keys` is a silent no-op inside one, and getting that
    // wrong here is catastrophic rather than merely buggy: four tables cascade
    // off agent_run, so DROP TABLE takes the entire transcript history,
    // the idempotency ledger, every handoff and every audit with it. Migration
    // 13 rebuilds the same table and does it correctly; this is why.
    db.exec(`
      CREATE TABLE agent_run_role (
        id TEXT PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        prompt_id INTEGER REFERENCES prompt(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'execute' CHECK(role IN ('execute','consult','handoff','review')),
        provider TEXT NOT NULL,
        model TEXT,
        state TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        context_token_hash TEXT NOT NULL,
        token_expires_at TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_input_tokens INTEGER,
        tool_calls INTEGER,
        tool_output_bytes INTEGER,
        stop_reason TEXT
      );
      INSERT INTO agent_run_role SELECT
        id, workspace_id, prompt_id, role, provider, model, state, started_at, ended_at,
        context_token_hash, token_expires_at, input_tokens, output_tokens,
        cached_input_tokens, tool_calls, tool_output_bytes, stop_reason
      FROM agent_run;
      DROP TABLE agent_run;
      ALTER TABLE agent_run_role RENAME TO agent_run;
      CREATE UNIQUE INDEX active_prompt_run_uq ON agent_run(prompt_id)
        WHERE state IN ('STARTING','RUNNING') AND role = 'execute';
      CREATE INDEX agent_run_prompt_idx ON agent_run(prompt_id,started_at);
      CREATE INDEX agent_run_workspace_role_idx ON agent_run(workspace_id,role,started_at);
    `);
  });
  // Outside the transaction, where the pragma actually takes effect.
  db.pragma("foreign_keys = OFF");
  try {
    migrate22();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(22,?)").run(new Date().toISOString());
}

const afterTwentyTwo = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
if (afterTwentyTwo < 23) {
  // "Done" becomes something the app can check rather than something it is told.
  //
  // The only acceptance criteria this app had were whatever `compactWorkItem`
  // could scrape out of a work item's markdown with a regex that had one
  // installation's domain headings written into it — "gst verification", "money
  // rules". On any other repository it matched almost nothing, so the reviewer
  // was handed an empty checklist and asked to judge against it.
  //
  // Three kinds of criterion, because they are checked by three different
  // things and only one of them cannot be argued with: PROSE is judged by the
  // reviewer agent, CHILDREN_CLOSED is read off the child rollup, and COMMAND is
  // run by this server with its exit code taken as the verdict.
  //
  // Purely additive: three CREATE TABLEs, no rebuild and no DROP, so there is no
  // cascade to get wrong and no `PRAGMA foreign_keys` to misplace. Proven
  // against a copy of the live database before it was written — 138,103 rows
  // across 29 pre-existing tables unchanged, integrity_check ok, foreign_key_check
  // clean. Migration 22's incident is why that is now the routine and not an
  // extra step.
  const migrate23 = db.transaction(() => {
    db.exec(`
      CREATE TABLE definition_of_done (
        id INTEGER PRIMARY KEY,
        scope TEXT NOT NULL CHECK(scope IN ('workspace','program','suite','prompt')),
        scope_id INTEGER NOT NULL,
        enforcement TEXT CHECK(enforcement IN ('block','warn','off')),
        updated_at TEXT NOT NULL,
        UNIQUE(scope, scope_id)
      );
      CREATE TABLE dod_criterion (
        id INTEGER PRIMARY KEY,
        dod_id INTEGER NOT NULL REFERENCES definition_of_done(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('PROSE','COMMAND','CHILDREN_CLOSED')),
        text TEXT NOT NULL DEFAULT '',
        command TEXT,
        cwd TEXT,
        expect_exit_code INTEGER NOT NULL DEFAULT 0,
        timeout_ms INTEGER NOT NULL DEFAULT 120000,
        required INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX dod_criterion_idx ON dod_criterion(dod_id, sort_order, id);
      CREATE TABLE dod_result (
        id INTEGER PRIMARY KEY,
        prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
        criterion_id INTEGER NOT NULL REFERENCES dod_criterion(id) ON DELETE CASCADE,
        -- Provenance, not a relationship this app navigates, and deliberately
        -- without a foreign key. Every FK edge into agent_run is one more
        -- cascade a later migration can get wrong, and migration 22 is what
        -- that costs. A run id that outlives its run is a stale label here;
        -- a cascade would be lost evidence.
        run_id TEXT,
        source TEXT NOT NULL CHECK(source IN ('AGENT','REVIEWER','RUNNER','HUMAN')),
        result TEXT NOT NULL CHECK(result IN ('PASSED','FAILED','UNVERIFIED')),
        evidence TEXT NOT NULL DEFAULT '',
        output TEXT NOT NULL DEFAULT '',
        exit_code INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX dod_result_idx ON dod_result(prompt_id, criterion_id, id);
    `);
  });
  migrate23();
  db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(23,?)").run(new Date().toISOString());
}

const afterTwentyThree = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
if (afterTwentyThree < 24) {
  // A reviewer may now change the pipeline, not only report on it.
  //
  // The ledger *is* the state. There is deliberately no `budget_multiplier`
  // column on `prompt`: the effective multiplier is derived from the applied
  // rows here, so "what did the reviewer change, when, and why" and "what is in
  // force right now" cannot drift apart, and reverting a change is deleting its
  // row rather than remembering to reset a field somewhere else.
  //
  // Refused directives are stored too, with the reason. A reviewer that keeps
  // asking for something the operator has capped is telling them something, and
  // that is only visible if the refusals are kept.
  //
  // Additive: one CREATE TABLE and one index, no rebuild, no DROP, no foreign
  // key into agent_run (migration 22's lesson: provenance is a label, and a
  // cascade there is lost evidence).
  const migrate24 = db.transaction(() => {
    db.exec(`
      CREATE TABLE reviewer_reconfigure (
        id INTEGER PRIMARY KEY,
        prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
        audit_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('raiseBudget','decompose','switchProvider')),
        multiplier REAL,
        provider TEXT,
        why TEXT NOT NULL DEFAULT '',
        applied INTEGER NOT NULL DEFAULT 0,
        refused_reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX reviewer_reconfigure_idx ON reviewer_reconfigure(prompt_id, id);
    `);
  });
  migrate24();
  db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(24,?)").run(new Date().toISOString());
}

const afterTwentyFour = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
if (afterTwentyFour < 25) {
  // `reviewer_config` has been silently accumulating duplicate rows.
  //
  // Its PRIMARY KEY is (scope, scope_id, trigger_id), and `scope_id` is NULL for
  // the global scope — which is every row the settings screen writes. SQLite
  // permits any number of NULLs in a primary key on a rowid table, so the
  // `ON CONFLICT DO NOTHING` in `setReviewerConfig` never had a conflict to
  // detect: each save inserted another row instead of updating the one there.
  // One installation reached 85 rows for 2 distinct keys.
  //
  // It read correctly by luck. `resolveReviewerConfig` takes the first row, and
  // the companion UPDATE has no LIMIT so it writes every duplicate — so the
  // first row is a superset of the others and dropping the rest changes no
  // resolved value. That is what makes this safe to collapse rather than merge.
  //
  // The index uses IFNULL because a plain UNIQUE would reproduce the bug
  // exactly: NULLs are distinct to a unique index too.
  const migrate25 = db.transaction(() => {
    db.exec(`
      DELETE FROM reviewer_config
      WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM reviewer_config GROUP BY scope, IFNULL(scope_id, -1), trigger_id
      );
      CREATE UNIQUE INDEX reviewer_config_scope_idx
        ON reviewer_config(scope, IFNULL(scope_id, -1), trigger_id);
    `);
  });
  migrate25();
  db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(25,?)").run(new Date().toISOString());
}

const afterTwentyFive = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
if (afterTwentyFive < 26) {
  // Two facts a run has always had and never recorded: which provider session
  // it was having, and whether it exists only to write down what an earlier run
  // learned.
  //
  // `session_id` is what a wrap-up turn resumes. Without it a run stopped by a
  // budget was simply interrupted — the agent that had just read forty files
  // was killed with nothing written down, and the station landed UNREPORTED
  // with the stop reason as its only record.
  //
  // `wrapup_of` points a wrap-up run at the run it is speaking for. It is the
  // only way to tell the two apart afterwards: same role, same work item, same
  // provider — and the ledger has to attribute the *source* run's stop reason,
  // not the wrap-up's.
  //
  // Two ALTER TABLE ADD COLUMNs. No rebuild, so no `PRAGMA foreign_keys`
  // question to get wrong (migration 22 deleted 135 025 transcript events that
  // way) and no risk to the 160 k rows in `agent_run_event` that reference
  // these runs. Nullable with no default: every existing row keeps meaning
  // exactly what it meant.
  const migrate26 = db.transaction(() => {
    db.exec(`
      ALTER TABLE agent_run ADD COLUMN session_id TEXT;
      ALTER TABLE agent_run ADD COLUMN wrapup_of TEXT;
    `);
  });
  migrate26();
  db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(26,?)").run(new Date().toISOString());
}

const afterTwentySix = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
if (afterTwentySix < 27) {
  // Continuation loop (prompt 03): station rules gain `on_unfinished` —
  // continue / skip / wait — replacing the behavioural role of `on_blocked`
  // without dropping the old columns (prompt 08).
  //
  // Backfill: wait→wait, skip→skip, everything else (retry/recover)→continue.
  // Two ALTER TABLE ADD COLUMNs. No rebuild.
  const migrate27 = db.transaction(() => {
    db.exec(`
      ALTER TABLE pipeline_step ADD COLUMN on_unfinished TEXT NOT NULL DEFAULT 'continue'
        CHECK(on_unfinished IN ('continue','skip','wait'));
      ALTER TABLE prompt_pipeline_rule ADD COLUMN on_unfinished TEXT NOT NULL DEFAULT 'continue'
        CHECK(on_unfinished IN ('continue','skip','wait'));
      UPDATE pipeline_step SET on_unfinished = CASE on_blocked
        WHEN 'wait' THEN 'wait'
        WHEN 'skip' THEN 'skip'
        ELSE 'continue'
      END;
      UPDATE prompt_pipeline_rule SET on_unfinished = CASE on_blocked
        WHEN 'wait' THEN 'wait'
        WHEN 'skip' THEN 'skip'
        ELSE 'continue'
      END;
    `);
  });
  migrate27();
  db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(27,?)").run(new Date().toISOString());
}

const afterTwentySeven = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
if (afterTwentySeven < 28) {
  // Provider fallback (prompt 05): ordered fallback lists on the station and
  // the suite. JSON arrays, default empty — house default lives in settings.
  // Three ALTER TABLE ADD COLUMNs. No rebuild.
  const migrate28 = db.transaction(() => {
    db.exec(`
      ALTER TABLE pipeline_step ADD COLUMN fallback_providers TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE prompt_pipeline_rule ADD COLUMN fallback_providers TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE suite ADD COLUMN default_fallback_providers TEXT NOT NULL DEFAULT '[]';
    `);
  });
  migrate28();
  db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(28,?)").run(new Date().toISOString());
}

const afterTwentyEight = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
if (afterTwentyEight < 29) {
  // Prompt 08 §2: archive then drop tables nothing reads. Leaf drops — no
  // rebuild, no foreign_keys pragma.
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const archiveDir = join(dirname(databasePath), "archive");
  mkdirSync(archiveDir, { recursive: true });
  for (const table of ["handoff", "reviewer_config", "reviewer_reconfigure"] as const) {
    writeFileSync(join(archiveDir, `${table}-${stamp}.json`), JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all(), null, 2));
  }
  db.exec(`
    DROP TABLE reviewer_config;
    DROP TABLE reviewer_reconfigure;
    DROP TABLE handoff;
  `);
  db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(29,?)").run(new Date().toISOString());
}

const afterTwentyNine = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
if (afterTwentyNine < 30) {
  // Prompt 08 §3: drop columns nothing reads. SQLite ≥ 3.35 DROP COLUMN.
  db.exec(`
    ALTER TABLE pipeline_step DROP COLUMN on_blocked;
    ALTER TABLE pipeline_step DROP COLUMN retry_limit;
    ALTER TABLE pipeline_step DROP COLUMN recover_provider;
    ALTER TABLE pipeline_step DROP COLUMN recover_model;
    ALTER TABLE suite_pipeline_run DROP COLUMN attempt;
    ALTER TABLE suite_pipeline_run DROP COLUMN recovering;
  `);
  db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(30,?)").run(new Date().toISOString());
}

const afterThirty = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
if (afterThirty < 31) {
  // Prompt 08 §4: one pipeline system. Enabled legacy rules without a named
  // twin get a one-stage pipeline for their suite (create-or-open), then we
  // re-check and refuse only if something is still missing. Archive + drop.
  const orphaned = db.prepare(`
    SELECT r.prompt_id AS promptId, r.provider, r.model, r.on_done AS onDone,
           r.on_unfinished AS onUnfinished, r.fallback_providers AS fallbackProviders,
           r.step_order AS stepOrder, r.updated_at AS updatedAt,
           p.suite_id AS suiteId, s.name AS suiteName, s.external_key AS suiteKey,
           g.workspace_id AS workspaceId
    FROM prompt_pipeline_rule r
    JOIN prompt p ON p.id = r.prompt_id
    JOIN suite s ON s.id = p.suite_id
    JOIN program g ON g.id = s.program_id
    WHERE r.enabled = 1 AND NOT EXISTS (
      SELECT 1 FROM pipeline_step ps
      JOIN pipeline_stage st ON st.pipeline_id = ps.pipeline_id AND st.suite_id = p.suite_id
      WHERE ps.prompt_id = r.prompt_id
    )
  `).all() as Array<{
    promptId: number; provider: string | null; model: string | null; onDone: string;
    onUnfinished: string; fallbackProviders: string; stepOrder: number; updatedAt: string;
    suiteId: number; suiteName: string; suiteKey: string | null; workspaceId: number;
  }>;
  const pipelineForSuite = new Map<number, number>();
  const now = new Date().toISOString();
  for (const row of orphaned) {
    let pipelineId = pipelineForSuite.get(row.suiteId);
    if (pipelineId === undefined) {
      const existing = db.prepare(`
        SELECT p.id FROM pipeline p
        JOIN pipeline_stage st ON st.pipeline_id = p.id
        WHERE p.workspace_id = ? AND st.suite_id = ?
        ORDER BY p.id LIMIT 1
      `).get(row.workspaceId, row.suiteId) as { id: number } | undefined;
      if (existing !== undefined) {
        pipelineId = existing.id;
      } else {
        const name = `${row.suiteName} (migrated)`.slice(0, 120);
        const description = `Created by migration 31 from enabled prompt_pipeline_rule rows for suite ${row.suiteKey ?? row.suiteId}.`;
        const inserted = db.prepare("INSERT INTO pipeline(workspace_id,name,description,created_at,updated_at) VALUES(?,?,?,?,?)")
          .run(row.workspaceId, name, description, now, now);
        pipelineId = Number(inserted.lastInsertRowid);
        db.prepare("INSERT INTO pipeline_stage(pipeline_id,suite_id,sort_order) VALUES(?,?,0)").run(pipelineId, row.suiteId);
      }
      pipelineForSuite.set(row.suiteId, pipelineId);
    }
    db.prepare(`
      INSERT INTO pipeline_step(pipeline_id,prompt_id,provider,model,on_done,on_unfinished,fallback_providers,step_order,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(pipeline_id,prompt_id) DO UPDATE SET
        provider=excluded.provider, model=excluded.model, on_done=excluded.on_done,
        on_unfinished=excluded.on_unfinished, fallback_providers=excluded.fallback_providers,
        step_order=excluded.step_order, updated_at=excluded.updated_at
    `).run(
      pipelineId, row.promptId, row.provider, row.model, row.onDone,
      row.onUnfinished ?? "continue", row.fallbackProviders ?? "[]", row.stepOrder, row.updatedAt,
    );
  }
  const missing = db.prepare(`
    SELECT r.prompt_id AS promptId, p.external_key AS promptKey FROM prompt_pipeline_rule r
    JOIN prompt p ON p.id = r.prompt_id
    WHERE r.enabled = 1 AND NOT EXISTS (
      SELECT 1 FROM pipeline_step ps
      JOIN pipeline_stage st ON st.pipeline_id = ps.pipeline_id AND st.suite_id = p.suite_id
      WHERE ps.prompt_id = r.prompt_id
    )
  `).all() as Array<{ promptId: number; promptKey: string | null }>;
  if (missing.length > 0) {
    throw new Error(
      `migration 31 refused: enabled prompt_pipeline_rule rows lack pipeline_step twins: ${
        missing.map((row) => row.promptKey ?? String(row.promptId)).join(", ")
      }`,
    );
  }
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const archiveDir = join(dirname(databasePath), "archive");
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(join(archiveDir, `prompt_pipeline_rule-${stamp}.json`), JSON.stringify(db.prepare("SELECT * FROM prompt_pipeline_rule").all(), null, 2));
  db.exec("DROP TABLE prompt_pipeline_rule;");
  db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(31,?)").run(new Date().toISOString());
}

const afterThirtyOne = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
if (afterThirtyOne < 32) {
  // Chat-box runs (custom execute, and consults without a work item) had no
  // place to keep the instruction the operator typed. Activity then titled
  // them "(research)" or omitted them entirely, because execute never even
  // wrote an agent_run row.
  //
  // One ALTER TABLE ADD COLUMN. No rebuild, so no `PRAGMA foreign_keys`
  // question (migration 22). Proven against a copy of the live database:
  // 29 tables, row counts unchanged including 183,113 agent_run_event rows,
  // integrity_check ok, foreign_key_check clean. Existing runs stay NULL.
  const migrate32 = db.transaction(() => {
    db.exec("ALTER TABLE agent_run ADD COLUMN display_text TEXT;");
  });
  migrate32();
  db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(32,?)").run(new Date().toISOString());
}

const afterThirtyTwo = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
if (afterThirtyTwo < 33) {
  // Agent-authored programs: a proposal, and nowhere near the library.
  //
  // An author run may write here and nowhere else. Until an operator applies
  // one of these rows, nothing in `program`, `suite` or `prompt` has changed —
  // which is the whole reason a draft exists rather than the agent calling the
  // tree's CRUD directly. Applying is a human action that runs the same
  // transaction the disk importer runs.
  //
  // No foreign key to `agent_run`: the run id is provenance, and migration 22's
  // lesson is that a cascade there is lost evidence. Nor to `program` — a draft
  // that has been applied keeps saying so even if the program is later deleted,
  // because "this was applied once" is the fact the operator needs when they
  // find the same proposal in the list again.
  //
  // Additive: one CREATE TABLE and two indexes. No rebuild, no DROP, so there
  // is no `PRAGMA foreign_keys` question to get wrong.
  const migrate33 = db.transaction(() => {
    db.exec(`
      CREATE TABLE program_draft (
        id INTEGER PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        run_id TEXT,
        state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','APPLIED','DISCARDED')),
        goal TEXT NOT NULL DEFAULT '',
        body_json TEXT NOT NULL,
        applied_program_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX program_draft_workspace_idx ON program_draft(workspace_id, id);
      CREATE UNIQUE INDEX program_draft_run_idx ON program_draft(run_id) WHERE run_id IS NOT NULL;
    `);
  });
  migrate33();
  db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(33,?)").run(new Date().toISOString());
}

const afterThirtyThree = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
if (afterThirtyThree < 34) {
  // `author` becomes a role a run can have, and `review` — a role nothing has
  // written since the reviewer subsystem was removed in migration 29/31 — stops
  // being one.
  //
  // This is a rebuild of `agent_run`, which is the most dangerous thing this
  // file does. Five tables reference it: `agent_run_event`, `agent_command` and
  // `completion_audit` cascade on delete, `prompt_status_event` and
  // `prompt_remark` null their run_id. With foreign keys on, the DROP below
  // takes the entire transcript history with it — that is migration 22's
  // incident, 135,025 events, and it reported success while doing it.
  //
  // So: `PRAGMA foreign_keys = OFF` is issued by the caller, OUTSIDE the
  // transaction, in a try/finally. Inside one SQLite ignores it silently.
  // `server/test/migrationSafety.test.ts` enforces this at the source level.
  //
  // The CHECK is rewritten rather than dropped, and `server/test/runRole.test.ts`
  // now asserts it lists exactly `RUN_ROLES` — the drift between that union and
  // this constraint is what made a rebuild necessary twice.
  const migrate34 = db.transaction(() => {
    db.exec(`
      CREATE TABLE agent_run_author (
        id TEXT PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        prompt_id INTEGER REFERENCES prompt(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'execute' CHECK(role IN ('execute','consult','handoff','author')),
        provider TEXT NOT NULL,
        model TEXT,
        state TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        context_token_hash TEXT NOT NULL,
        token_expires_at TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cached_input_tokens INTEGER,
        tool_calls INTEGER,
        tool_output_bytes INTEGER,
        stop_reason TEXT,
        session_id TEXT,
        wrapup_of TEXT,
        display_text TEXT
      );
      INSERT INTO agent_run_author SELECT
        id, workspace_id, prompt_id,
        -- Nothing should hold the dead role, but a row that somehow does is
        -- kept as a run rather than refused: it is history, and 'execute' is
        -- what a reviewer run borrowed before it had a role of its own.
        CASE role WHEN 'review' THEN 'execute' ELSE role END,
        provider, model, state, started_at, ended_at,
        context_token_hash, token_expires_at, input_tokens, output_tokens,
        cached_input_tokens, tool_calls, tool_output_bytes, stop_reason,
        session_id, wrapup_of, display_text
      FROM agent_run;
      DROP TABLE agent_run;
      ALTER TABLE agent_run_author RENAME TO agent_run;
      CREATE UNIQUE INDEX active_prompt_run_uq ON agent_run(prompt_id)
        WHERE state IN ('STARTING','RUNNING') AND role = 'execute';
      CREATE INDEX agent_run_prompt_idx ON agent_run(prompt_id,started_at);
      CREATE INDEX agent_run_workspace_role_idx ON agent_run(workspace_id,role,started_at);
    `);
  });
  // Outside the transaction, where the pragma actually takes effect.
  db.pragma("foreign_keys = OFF");
  try {
    migrate34();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(34,?)").run(new Date().toISOString());
}

const afterThirtyFour = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
if (afterThirtyFour < 35) {
  // A draft can revise a program that already exists, rather than propose a
  // new one. `target_program_id` names that program; `baseline_json` is the
  // program as it was when the draft was opened, which apply compares against
  // so it writes only what the draft changed and refuses to overwrite an edit
  // made to the program since.
  //
  // No foreign key, for the same reason `applied_program_id` has none: a
  // cascade or a SET NULL would erase "this draft was about that program",
  // which is the fact apply needs to refuse cleanly once the program is gone.
  //
  // Additive: two nullable columns. No rebuild, no DROP.
  const migrate35 = db.transaction(() => {
    db.exec(`
      ALTER TABLE program_draft ADD COLUMN target_program_id INTEGER;
      ALTER TABLE program_draft ADD COLUMN baseline_json TEXT;
    `);
  });
  migrate35();
  db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(35,?)").run(new Date().toISOString());
}
const afterThirtyFive = (db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration").get() as { version: number }).version;
if (afterThirtyFive < 36) {
  // A proposed rewrite of CLAUDE.md or AGENTS.md, held for the operator to
  // apply. Either asked for from the request bar, or found in the working tree
  // after a run edited the file on its own — which used to be written into the
  // workspace without anyone reading it.
  //
  // `baseline` is the stored text when the proposal opened; apply refuses once
  // the field has moved on, rather than silently reverting an edit made since.
  //
  // No foreign key to `agent_run`, for the reason `program_draft` has none.
  //
  // Additive: one CREATE TABLE and one index. No rebuild, no DROP.
  const migrate36 = db.transaction(() => {
    db.exec(`
      CREATE TABLE instruction_proposal (
        id INTEGER PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        field TEXT NOT NULL CHECK(field IN ('claudeMd','agentsMd')),
        state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','APPLIED','DISCARDED')),
        origin TEXT NOT NULL CHECK(origin IN ('request','run')),
        goal TEXT NOT NULL DEFAULT '',
        run_id TEXT,
        baseline TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX instruction_proposal_workspace_idx ON instruction_proposal(workspace_id, id);
    `);
  });
  migrate36();
  db.prepare("INSERT INTO schema_migration(version,applied_at) VALUES(36,?)").run(new Date().toISOString());
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

/*
 * Destructive, and correct only for the process that owns this database:
 * everything it finds in flight is declared dead on the assumption that the
 * server which owned those runs is gone.
 *
 * That assumption is the caller's to establish, which is why this is not run on
 * import. A second server booting against a live one's database used to reach
 * this at import time and interrupt runs that were still going — the agent kept
 * working, its Progress API calls started failing `run_not_active`, and the
 * pipeline reported itself interrupted while an agent was still writing to the
 * tree. `index.ts` calls it only once the port is bound and the instance lock
 * is held.
 */
const recoverAbandonedRuns=db.transaction(()=>{
  const rows=db.prepare("SELECT id,prompt_id FROM agent_run WHERE state IN ('STARTING','RUNNING')").all() as Array<{id:string;prompt_id:number|null}>;
  const now=new Date().toISOString();
  // A verification still marked RUNNING after a restart died with the process;
  // leaving it live would strand the suite badge on "verifying" forever.
  db.prepare("UPDATE suite_verification SET state='INTERRUPTED',ended_at=? WHERE state='RUNNING'").run(now);
  // Same reasoning for an audit: its agent died with the process, and a row
  // left QUEUED/RUNNING would hold the per-prompt uniqueness index forever and
  // block the audit that the restart itself makes necessary.
  db.prepare("UPDATE completion_audit SET state='FAILED',error='The server restarted while this audit was running.',completed_at=? WHERE state IN ('QUEUED','RUNNING')").run(now);
  for(const row of rows)db.prepare("UPDATE agent_run SET state='INTERRUPTED',ended_at=? WHERE id=?").run(now,row.id);
  const orphaned=db.prepare(`SELECT p.id,(SELECT r.id FROM agent_run r WHERE r.prompt_id=p.id AND r.role='execute' ORDER BY r.started_at DESC LIMIT 1) runId FROM prompt p WHERE p.status='IN_PROGRESS' AND NOT EXISTS(SELECT 1 FROM agent_run active WHERE active.prompt_id=p.id AND active.state IN ('STARTING','RUNNING') AND active.role='execute')`).all() as Array<{id:number;runId:string|null}>;
  // The server died while these were in flight, so nobody ever recorded how
  // they ended. That is the definition of UNREPORTED — not BLOCKED, which would
  // claim an agent had asked the operator something, and not FAILED, which
  // would claim the work was observed to fail. Neither is known here.
  for(const prompt of orphaned){
    const reason="The server restarted while this run was in flight, so the run never reported how it ended. Whether the work was finished is unknown.";
    writeStatus({promptId:prompt.id,to:"UNREPORTED",trigger:"run_ended_without_post",actor:"SYSTEM",runId:prompt.runId,reason,result:reason,evidence:{cause:"server_restart"},remark:{kind:"BLOCKER",content:reason}});
  }
  db.prepare("UPDATE suite_pipeline_run SET state='INTERRUPTED',ended_at=?,stop_reason='server_restart' WHERE state IN ('PLAYING','PAUSED','WAITING_HUMAN')").run(now);
  db.prepare("UPDATE pipeline_run SET state='INTERRUPTED',ended_at=?,stop_reason='server_restart' WHERE state IN ('PLAYING','PAUSED','WAITING_HUMAN')").run(now);
});

/** What a finished run spent, as recorded by the runner. */
export interface RunCostMetrics { usage: TokenUsage | null; toolCalls: number; toolOutputBytes: number; stopReason: string | null; sessionId?: string | null }

type WorkspaceRow = { id: number; name: string; description: string; work_directory: string; created_at: string; updated_at: string; claude_md: string; agents_md: string };
type ProgramRow = { id: number; workspace_id: number; name: string; overview: string; sort_order: number; created_at: string; updated_at: string; external_key: string | null };
type SuiteRow = { id: number; program_id: number; name: string; overview: string; sort_order: number; created_at: string; updated_at: string; external_key: string | null; default_provider?: string | null; default_model?: string | null };
type PromptRow = { id: number; suite_id: number; title: string; content: string; sort_order: number; created_at: string; updated_at: string; external_key: string | null; status: PromptRecord["status"]; completed_at: string | null; result: string; is_gate: number; parent_prompt_id: number | null; child_order: number };
type PipelineStepRow = { pipeline_id: number; prompt_id: number; provider: string | null; model: string | null; on_done: string; on_unfinished?: string; fallback_providers?: string; step_order: number; updated_at: string };
type PipelineRunRow = { id: string; suite_id: number; workspace_id: number; state: string; current_prompt_id: number | null; current_run_id: string | null; play_provider: string | null; play_model: string | null; started_at: string; ended_at: string | null; stop_reason: string | null; wait_reason?: string | null; pipeline_run_id: string | null };
type NamedPipelineRow = { id: number; workspace_id: number; name: string; description: string; created_at: string; updated_at: string };
type NamedPipelineRunRow = { id: string; pipeline_id: number; workspace_id: number; state: string; current_suite_id: number | null; current_suite_run_id: string | null; play_provider: string | null; play_model: string | null; started_at: string; ended_at: string | null; stop_reason: string | null; wait_reason?: string | null };

function asProviderId(value: string | null | undefined): ProviderId | null {
  return value !== null && value !== undefined && isProviderId(value) ? value : null;
}

function parseFallbackProvidersJson(raw: string | null | undefined): ProviderId[] {
  if (raw === null || raw === undefined || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: ProviderId[] = [];
    for (const item of parsed) {
      if (typeof item === "string" && isProviderId(item) && !out.includes(item)) out.push(item);
    }
    return out;
  } catch {
    return [];
  }
}

function pipelineStepDto(promptId: number, row: PipelineStepRow): PromptPipelineRule {
  const onDone = isOnDoneAction(row.on_done) ? row.on_done : "continue";
  const onUnfinished = isOnUnfinishedAction(row.on_unfinished) ? row.on_unfinished : "continue";
  return {
    promptId,
    provider: asProviderId(row.provider),
    model: row.model,
    fallbackProviders: parseFallbackProvidersJson(row.fallback_providers),
    onDone,
    onUnfinished,
    enabled: true,
    stepOrder: row.step_order,
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
    playProvider: asProviderId(row.play_provider),
    playModel: row.play_model,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    stopReason: row.stop_reason,
    waitReason: row.wait_reason ?? null,
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
    waitReason: row.wait_reason ?? null,
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

/**
 * Known provider ids, no duplicates, and not equal to the station's own
 * provider. An empty list is valid — it means "use the suite / house default".
 */
function validateFallbackProviders(value: unknown, stationProvider: ProviderId | null, field = "fallbackProviders"): ProviderId[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new WorkspaceError(422, "validation_error", `${field} must be an array of provider ids`, { [field]: "Must be an array" });
  }
  const out: ProviderId[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isProviderId(item)) {
      throw new WorkspaceError(422, "validation_error", `${field} must list known providers`, { [field]: "Unknown provider" });
    }
    if (stationProvider !== null && item === stationProvider) {
      throw new WorkspaceError(422, "validation_error", `${field} must not include the station's own provider`, { [field]: "Cannot equal the station provider" });
    }
    if (out.includes(item)) {
      throw new WorkspaceError(422, "validation_error", `${field} must not contain duplicates`, { [field]: "Duplicate provider" });
    }
    out.push(item);
  }
  return out;
}

const workspaceDto = (row: WorkspaceRow): WorkspaceRecord => ({ id: row.id, name: row.name, description: row.description, workDirectory: row.work_directory, workDirectoryExists: existsSync(row.work_directory), createdAt: row.created_at, updatedAt: row.updated_at, claudeMd: row.claude_md ?? "", agentsMd: row.agents_md ?? "" });
const promptDto = (row: PromptRow): PromptRecord => ({ id: row.id, suiteId: row.suite_id, title: row.title, content: row.content, sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at, externalKey: row.external_key, status: row.status, completedAt: row.completed_at, result: row.result, isGate: row.is_gate === 1, parentPromptId: row.parent_prompt_id, childOrder: row.child_order });

function completionAuditDto(row:Record<string,unknown>):CompletionAuditRecord {
  let report:CompletionAuditReport|null=null;
  try { report=row.report_json?JSON.parse(row.report_json as string) as CompletionAuditReport:null; } catch { report=null; }
  return {
    id:row.id as string, workspaceId:row.workspace_id as number, promptId:row.prompt_id as number,
    sourceRunId:row.source_run_id as string, auditRunId:row.audit_run_id as string|null,
    provider:row.provider as ProviderId, model:row.model as string|null,
    state:row.state as CompletionAuditRecord["state"], verdict:row.verdict as CompletionVerdict|null,
    report, reportMarkdown:row.report_markdown as string, applied:row.applied===1,
    error:row.error as string|null, createdAt:row.created_at as string,
    completedAt:row.completed_at as string|null,
  };
}

function requireText(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string") throw new WorkspaceError(422, "validation_error", `${field} must be a string`, { [field]: "Required" });
  const text = value.trim();
  if (!allowEmpty && text === "") throw new WorkspaceError(422, "validation_error", `${field} is required`, { [field]: "Required" });
  if (text.length > max) throw new WorkspaceError(422, "validation_error", `${field} is too long`, { [field]: `Maximum ${max} characters` });
  return text;
}

const VERIFY_TIMEOUT_SUFFIX=/\s+#\s*timeout\s*=\s*\d+(?:\.\d+)?(?:s|ms|m)?\s*$/i;
const VERIFY_EXECUTABLES=["cargo","curl","docker","dotnet","git","go","grep","node","npm","pnpm","pytest","python","rg","test","yarn"] as const;

function commandText(line:string):string{return line.trim().replace(VERIFY_TIMEOUT_SUFFIX,"").trim();}

/**
 * Replace one command in the last Verify fence, which is the same section
 * `parseVerifyBlock` treats as authoritative. A textual replacement over the
 * whole prompt could silently alter an example or an earlier, superseded
 * Verify section; locating the fence first keeps this capability as narrow as
 * its name.
 */
function replaceVerifyCommand(content:string,oldCommand:string,newCommand:string):string {
  const lines=content.replace(/\r\n/g,"\n").split("\n");
  let heading=-1;
  for(let i=0;i<lines.length;i++)if(/^##\s+Verify\b/i.test(lines[i]!))heading=i;
  if(heading<0)throw new WorkspaceError(409,"verify_command_changed","This work item no longer has a Verify section. Re-read its context.");
  let open=-1;let close=-1;
  for(let i=heading+1;i<lines.length&&!/^##\s+/.test(lines[i]!);i++){
    if(open<0&&/^```(?:sh|bash)[ \t]*$/i.test(lines[i]!)){open=i;continue;}
    if(open>=0&&/^```[ \t]*$/.test(lines[i]!)){close=i;break;}
  }
  if(open<0||close<0)throw new WorkspaceError(409,"verify_command_changed","This work item's Verify shell block changed. Re-read its context.");
  const matches:number[]=[];
  for(let i=open+1;i<close;i++)if(commandText(lines[i]!)===oldCommand)matches.push(i);
  if(matches.length!==1)throw new WorkspaceError(409,"verify_command_changed","The failing command is no longer present exactly once. Re-read context and use the current command.");
  lines[matches[0]!] = newCommand;
  return lines.join("\n");
}

/** Stable subjects a repaired recipe must continue to exercise. */
function verificationAnchors(command:string):string[] {
  const matches=command.match(/https?:\/\/[^\s'";]+|(?:[\w.@$(){}+-]+\/)+[\w.@$(){}:+-]+|[\w.-]+\.(?:csproj|slnx|json|ya?ml|toml|sh|mjs|cjs|js|ts|tsx|cs|py)/gi) ?? [];
  return [...new Set(matches.map(value=>value.replace(/[),;&]+$/,"")))];
}

function validateVerifyRepair(oldCommand:string,newCommand:string):void {
  if(newCommand.includes("\n")||newCommand.includes("\r"))throw new WorkspaceError(422,"validation_error","newCommand must be one shell line",{newCommand:"Use semicolons or && inside one line"});
  if(newCommand===oldCommand)throw new WorkspaceError(422,"validation_error","newCommand is identical to the failing command",{newCommand:"Nothing changed"});
  if(/(?:^|[;&|]\s*)(?:true|:|exit\s+0)(?:\s*(?:[;&|]|$))/i.test(newCommand)||/^echo\b.*$/i.test(newCommand))throw new WorkspaceError(422,"unsafe_verify_repair","A Verify repair must still test the work; it cannot contain an unconditional-success branch.");
  if(newCommand.length<Math.min(40,Math.ceil(oldCommand.length/4)))throw new WorkspaceError(422,"unsafe_verify_repair","The replacement removes too much of the original verification recipe.");
  const missingAnchors=verificationAnchors(oldCommand).filter(anchor=>!newCommand.includes(anchor));
  const missingExecutables=VERIFY_EXECUTABLES.filter(name=>new RegExp(`(?:^|[;&|()\\s])${name}(?:[;&|()\\s]|$)`).test(oldCommand)&&!new RegExp(`(?:^|[;&|()\\s])${name}(?:[;&|()\\s]|$)`).test(newCommand));
  if(missingAnchors.length>0||missingExecutables.length>0){
    throw new WorkspaceError(422,"unsafe_verify_repair","The replacement must preserve what the original command verifies.",{
      newCommand:`Keep these targets and tools: ${[...missingAnchors,...missingExecutables].join(", ")}`,
    });
  }
}

function recoverableBlocker(reason:string,action:string):boolean {
  const text=`${reason}\n${action}`.toLowerCase();
  const external=/credential|secret|password|api key|approval|legal|billing|account owner|physical access|choose|decision|confirm requirement/.test(text);
  if(external)return false;
  const verifyRecipe=/(verify|verification|acceptance).{0,80}(command|script|recipe)|(?:command|script|recipe).{0,80}(verify|verification|acceptance)|tracker database|work-item database/.test(text);
  const workspaceWork=/(edit|change|modify|fix|update|add|remove|rewrite).{0,80}(source|code|file|test|config|script)/.test(text);
  return verifyRecipe||workspaceWork;
}

function directory(value: unknown): string {
  const input = requireText(value, "workDirectory", 4096);
  const absolute = isAbsolute(input) ? resolve(input) : resolve(config.repoRoot, input);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new WorkspaceError(422, "invalid_directory", "Work directory must be an existing directory", { workDirectory: "Directory does not exist" });
  return realpathSync(absolute);
}

function nextOrder(table: "program" | "suite" | "prompt", parentColumn: "workspace_id" | "program_id" | "suite_id", parentId: number): number {
  return (db.prepare(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM ${table} WHERE ${parentColumn} = ?`).get(parentId) as { value: number }).value;
}

export class WorkspaceError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
    /** Extra JSON fields merged into the error body (e.g. decompose conflicts). */
    public details?: Record<string, unknown>,
  ) { super(message); }
}

export interface AgentPromptParentContext {
  externalKey:string|null;
  title:string;
  content:string;
  /** Latest CONTINUATION remark, or the resumeBrief filed with the parent's decompose. */
  resumeBrief:string;
  siblings:Array<{externalKey:string|null;title:string;status:PromptRecord["status"]}>;
}

/** One direct child of a decompose parent, for the integration checklist. */
export interface AgentPromptChildSummary {
  externalKey:string|null;
  title:string;
  status:PromptRecord["status"];
  /** DONE verification summary, or the skip reason from the ledger for SKIPPED. */
  result:string;
}

export interface AgentPromptContext {
  workspace:{id:number;name:string;workDirectory:string;description:string;agentsMd:string;claudeMd:string};
  program:{id:number;externalKey:string|null;name:string;overview:string};
  suite:{id:number;externalKey:string|null;name:string;overview:string};
  prompt:PromptRecord;
  /** Non-null only for a decompose sub-step. */
  parent:AgentPromptParentContext|null;
  /** Direct sub-steps; empty when this item was never decomposed. */
  children:AgentPromptChildSummary[];
  /** Resolved DoD COMMAND lines the server will run when the agent posts `done`. */
  verificationCommands:string[];
  /**
   * Curated remarks for the execute "Where the last run stopped" section —
   * CONTINUATION, latest BLOCKER (+ HUMAN_RESPONSE when still pending), and the
   * last few PROGRESS/VERIFICATION notes. Never includes AGENT_RESPONSE.
   */
  stoppedRemarks:PromptRemark[];
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

/**
 * Did the harness block this prompt, rather than the agent asking something?
 *
 * An agent posting BLOCKED is asking a question a human must answer. The
 * harness blocking a prompt — a crashed process, the orphan sweep, a spent run
 * budget — is reporting that a run stopped with its work banked, which an
 * operator resumes rather than answers. The two need different buttons, so the
 * distinction reads the actor off the status event that did it. It used to
 * match prefixes of the reason text instead, and a budget stop was worded
 * differently on purpose: it fell straight into "answer the question", where
 * there was no question and no way forward.
 */
/** The statuses that mean "the run is over and the item is not closed". */
const UNFINISHED_STATUSES=new Set<StepStatus>(["BLOCKED","UNREPORTED","FAILED","NEEDS_REVIEW"]);

/** Status events on the wire, with the ledger columns the "why" panel renders. */
function statusEvents(promptId:number):PromptStatusEvent[] {
  return (db.prepare(`SELECT id,prompt_id promptId,run_id runId,previous_status previousStatus,new_status newStatus,
      reason,verification_summary verificationSummary,actor_type actorType,created_at createdAt,
      trigger_id trigger,rule_id ruleId,evidence_json evidenceJson
    FROM prompt_status_event WHERE prompt_id=? ORDER BY id DESC`).all(promptId) as Array<Record<string,unknown>>)
    .map(row=>{
      const {evidenceJson,...rest}=row;
      let evidence:Record<string,unknown>|null=null;
      // Malformed evidence must never cost the operator the event itself: the
      // sentence and the trigger are the part they actually read.
      try{ evidence=typeof evidenceJson==="string"?JSON.parse(evidenceJson) as Record<string,unknown>:null; }catch{ evidence=null; }
      return {...rest,evidence} as unknown as PromptStatusEvent;
    });
}

function endedWithoutAgentStatus(status:string):boolean {
  // Reads the stored status. This used to re-derive the same fact on every call
  // by looking up the newest BLOCKED event and checking whether its actor was
  // SYSTEM — the distinction was real and load-bearing, but it lived only in
  // the ledger and had to be reconstructed, so it could not be shown, filtered,
  // or trusted. Both of these statuses mean the same thing: a run ended and the
  // agent never said what it achieved.
  return status==="UNREPORTED"||status==="FAILED";
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
  const active=db.prepare("SELECT id,provider,model,state,started_at startedAt FROM agent_run WHERE prompt_id=? AND state IN ('STARTING','RUNNING') AND role='execute' ORDER BY started_at DESC LIMIT 1").get(args.promptId) as {id:string;provider:string;model:string|null;state:string;startedAt:string}|undefined;
  if(active)throw new WorkspaceError(409,"prompt_run_active",`This prompt already has an active session: ${active.id} (${active.provider}${active.model?` / ${active.model}`:""}, ${active.state.toLowerCase()}, started ${active.startedAt}). Open Sessions to inspect it before starting another run.`,{runId:active.id,state:active.state,provider:active.provider,startedAt:active.startedAt});
  const now=new Date().toISOString(); db.prepare("INSERT INTO agent_run(id,workspace_id,prompt_id,provider,model,state,started_at,context_token_hash,token_expires_at,role) VALUES(?,?,?,?,?,'STARTING',?,?,?,?)").run(args.runId,args.workspaceId,args.promptId,args.provider,args.model,now,args.tokenHash,args.expiresAt,args.role??"execute");
  if(prompt.status==="TODO"){
    writeStatus({promptId:args.promptId,to:"IN_PROGRESS",expect:"TODO",trigger:"run_started",actor:"SYSTEM",runId:args.runId,reason:"An agent run started."});
  }
});

/**
 * What the end of an execute run means for its work item.
 *
 * The decision itself is in statusTransition.ts so it can be tested without a
 * database, and so the one rule that matters is stated once: a run that ends
 * without posting is UNREPORTED, never BLOCKED and never FAILED.
 *
 * This used to write BLOCKED unconditionally, which is what made an agent that
 * finished the work but dropped its final HTTP call look identical to one that
 * stopped to ask a question — and BLOCKED is what the pipeline parks on, so
 * finished work waited on a human with nothing to answer.
 *
 * `wrapupOf` is set when the run that just ended was a wrap-up turn speaking
 * for an earlier one. The item is then concluded on the *source* run's stop
 * reason, because that is what actually stopped the work; the wrap-up merely
 * had a chance to write it down and did not take it. The ledger records both
 * ids so "why is this UNREPORTED" leads back to the run that ran out of budget
 * rather than to the four-minute turn that followed it.
 */
function applyEndOfRunStatus(runId:string,promptId:number,wrapupOf:string|null,state:string,stopReason:string|null,toolCalls:number|null):void {
  const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as {status:PromptRecord["status"]};
  const source=wrapupOf===null?null:db.prepare("SELECT stop_reason stopReason FROM agent_run WHERE id=?").get(wrapupOf) as {stopReason:string|null}|undefined??null;
  // `state` arrives as a loose string from the runner. Anything that is not a
  // recognised ending is treated as an error rather than silently as a clean
  // exit: guessing "fine" about an unrecognised ending is the same mistake in
  // a smaller place.
  const outcome:RunOutcome=state==="done"?"done":state==="interrupted"?"interrupted":"error";
  const facts={status:prompt.status,outcome,stopReason:source===null?stopReason:source.stopReason};
  const signal=endOfRunSignal(facts);
  if(signal===null)return;
  const decision=decide(signal);
  const reason=endOfRunReason(facts);
  writeStatus({
    promptId,
    to:decision.to??"UNREPORTED",
    trigger:decision.row.trigger,
    ruleId:decision.row.id,
    actor:"SYSTEM",
    runId,
    reason,
    result:reason,
    evidence:{processState:state,stopReason,toolCalls,...(wrapupOf===null?{}:{wrapupOf,wrapupStopReason:source?.stopReason??null})},
    remark:{kind:"BLOCKER",content:reason},
  });
}

function requireActiveExecuteRun(runId:string):{prompt_id:number;role:RunRole} {
  const run=db.prepare("SELECT prompt_id,role FROM agent_run WHERE id=? AND state IN ('STARTING','RUNNING')").get(runId) as {prompt_id:number|null;role:RunRole}|undefined;
  if(!run)throw new WorkspaceError(409,"run_not_active","Run is not active");
  // An author run is not read-only — it is working on a draft and has no work
  // item to report on. Saying "read-only" to one would send it looking for a
  // permission it was never refused.
  if(run.role==="author")throw new WorkspaceError(403,"author_only","An author run drafts a program; it has no work item to report on.");
  if(run.role!=="execute")throw new WorkspaceError(403,"consult_read_only","Read-only runs cannot post remarks or status.");
  if(run.prompt_id===null)throw new WorkspaceError(409,"run_not_active","Run is not attached to a work item");
  return {prompt_id:run.prompt_id,role:run.role};
}

const DISPLAY_TEXT_LIMIT=20000;
function clipDisplayText(value:string|null|undefined):string|null {
  if(typeof value!=="string")return null;
  const trimmed=value.trim();
  if(trimmed==="")return null;
  return trimmed.length>DISPLAY_TEXT_LIMIT?trimmed.slice(0,DISPLAY_TEXT_LIMIT):trimmed;
}

const beginConsultTransaction=db.transaction((args:{runId:string;workspaceId:number;promptId:number|null;provider:string;model:string|null;tokenHash:string;expiresAt:string;displayText?:string|null})=>{
  if(!db.prepare("SELECT 1 FROM workspace WHERE id=?").get(args.workspaceId))throw new WorkspaceError(404,"not_found","Workspace not found");
  if(args.promptId!==null){
    const prompt=db.prepare(`SELECT p.id FROM prompt p JOIN suite s ON s.id=p.suite_id JOIN program g ON g.id=s.program_id WHERE p.id=? AND g.workspace_id=?`).get(args.promptId,args.workspaceId);
    if(!prompt)throw new WorkspaceError(404,"not_found","Prompt was not found in this workspace");
  }
  const now=new Date().toISOString();
  db.prepare("INSERT INTO agent_run(id,workspace_id,prompt_id,provider,model,state,started_at,context_token_hash,token_expires_at,role,display_text) VALUES(?,?,?,?,?,'STARTING',?,?,?,'consult',?)").run(args.runId,args.workspaceId,args.promptId,args.provider,args.model,now,args.tokenHash,args.expiresAt,clipDisplayText(args.displayText));
});

/** Chat-box execute: no work item, so no status transition and no per-prompt lock. */
const beginCustomExecuteTransaction=db.transaction((args:{runId:string;workspaceId:number;provider:string;model:string|null;tokenHash:string;expiresAt:string;displayText:string})=>{
  if(!db.prepare("SELECT 1 FROM workspace WHERE id=?").get(args.workspaceId))throw new WorkspaceError(404,"not_found","Workspace not found");
  const displayText=clipDisplayText(args.displayText);
  if(displayText===null)throw new WorkspaceError(422,"validation_error","Prompt is empty");
  const now=new Date().toISOString();
  db.prepare("INSERT INTO agent_run(id,workspace_id,prompt_id,provider,model,state,started_at,context_token_hash,token_expires_at,role,display_text) VALUES(?,?,NULL,?,?,'STARTING',?,?,?,'execute',?)").run(args.runId,args.workspaceId,args.provider,args.model,now,args.tokenHash,args.expiresAt,displayText);
});

const agentRemarkTransaction=db.transaction((runId:string,input:Record<string,unknown>)=>commandResult(runId,input.requestId,"remark",()=>{
  const run=requireActiveExecuteRun(runId);
  const kind=typeof input.kind==="string"?input.kind:"";if(!REMARK_KINDS.has(kind))throw new WorkspaceError(422,"validation_error","Unknown remark kind");const content=requireText(input.content,"content",20000);
  const now=new Date().toISOString();const id=Number(db.prepare("INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,?,?,?, 'AGENT',?)").run(run.prompt_id,runId,kind,content,now).lastInsertRowid);return{id,promptId:run.prompt_id,runId,kind,content,actorType:"AGENT",createdAt:now};
}));

const agentStatusTransaction=db.transaction((runId:string,input:Record<string,unknown>)=>commandResult(runId,input.requestId,"status",()=>{
  const run=requireActiveExecuteRun(runId);
  const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(run.prompt_id) as {status:PromptRecord["status"]};const expected=input.expectedStatus;const target=input.status;
  if(expected!==prompt.status)throw new WorkspaceError(409,"stale_status",`Prompt status is ${prompt.status}, not ${String(expected)}`);
  if(prompt.status!=="IN_PROGRESS")throw new WorkspaceError(422,"invalid_transition","Agents may only change IN_PROGRESS to DONE, BLOCKED or CONTINUE");
  // CONTINUE is not a stored status and never will be: it is the agent saying
  // "here is what remains, resume me on this same tree". The item goes back to
  // TODO the way a decompose sends it back, and the brief it leaves behind is
  // the whole point — it is written while the agent still has the context, and
  // it replaces a reviewer run that would have to rediscover it from the
  // transcript at ~30 M input tokens across this install's history.
  if(target==="CONTINUE"){
    const remaining=requireText(input.reason,"remaining",20000);
    if(remaining==="")throw new WorkspaceError(422,"validation_error","CONTINUE requires the remaining work as concrete instructions for the run that resumes this item");
    // Optional: an agent that was stopped before it verified anything still has
    // a brief worth writing, and refusing the post for a missing evidence field
    // would lose the one thing this turn exists to capture.
    const verified=requireText(input.verificationSummary??"","verified",20000,true);
    const now=new Date().toISOString();
    const decision=decide("agent_posted_continue");
    const written=writeStatus({promptId:run.prompt_id,to:decision.to??"TODO",expect:"IN_PROGRESS",trigger:decision.row.trigger,ruleId:decision.row.id,actor:"AGENT",runId,reason:remaining,verificationSummary:verified,result:"",evidence:{remaining,verified}});
    const eventId=Number((db.prepare("SELECT id FROM prompt_status_event WHERE prompt_id=? ORDER BY id DESC LIMIT 1").get(run.prompt_id) as {id:number}).id);
    // The brief the next run receives, as its own remark kind so it can be
    // found without parsing a ledger row's evidence.
    db.prepare("INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,?,'CONTINUATION',?,'AGENT',?)").run(run.prompt_id,runId,remaining,now);
    return{eventId,promptId:run.prompt_id,previousStatus:prompt.status,status:written.to,requestedStatus:target,result:remaining,createdAt:now};
  }
  if(target!=="DONE"&&target!=="BLOCKED")throw new WorkspaceError(422,"invalid_transition","Agents may only change IN_PROGRESS to DONE, BLOCKED or CONTINUE");
  const reason=requireText(input.reason,"reason",10000,target==="DONE");const verification=requireText(input.verificationSummary??"","verificationSummary",20000,false);
  if(target==="DONE"&&verification==="")throw new WorkspaceError(422,"validation_error","DONE requires a verification summary");
  if(target==="BLOCKED"&&reason==="")throw new WorkspaceError(422,"validation_error","BLOCKED requires an evidence-based reason");
  if(target==="BLOCKED"&&verification==="")throw new WorkspaceError(422,"validation_error","BLOCKED requires verificationSummary to state the exact action only the human can take");
  if(target==="BLOCKED"&&recoverableBlocker(reason,verification))throw new WorkspaceError(
    409,
    "recoverable_blocker",
    "The requested action is a workspace or Verify-recipe change, not an external dependency only a human can clear. Repair the failing Verify command, fix the workspace, or post CONTINUE with what remains.",
  );
  const now=new Date().toISOString();const result=target==="DONE"?verification:`${reason}\n\nRequired human action: ${verification}`;
  // The agent posting for itself is the most direct evidence there is, so the
  // row that records it is the one the transition table locks against override.
  const decision=decide(target==="DONE"?"agent_posted_done":"agent_posted_blocked");
  const written=writeStatus({promptId:run.prompt_id,to:target,expect:"IN_PROGRESS",trigger:decision.row.trigger,ruleId:decision.row.id,actor:"AGENT",runId,reason,verificationSummary:verification,result});
  const eventId=Number((db.prepare("SELECT id FROM prompt_status_event WHERE prompt_id=? ORDER BY id DESC LIMIT 1").get(run.prompt_id) as {id:number}).id);
  // The agent's own claim is kept whatever the gate decided — it said it was
  // finished and gave its evidence, and that is worth reading next to the
  // criteria that disagreed.
  db.prepare("INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,?,?,?, 'AGENT',?)").run(run.prompt_id,runId,target==="DONE"?"COMPLETION":"BLOCKER",result,now);
  // `status` is what was actually stored, not what was asked for. Replying
  // "DONE" to an agent whose close the definition of done refused would be the
  // app telling the same lie it was built to stop telling — and the agent has
  // a use for the truth: `definitionOfDone` lists what is still failing, so a
  // run with budget left can fix it instead of ending on a false success.
  const gate=written.to===target?null:workspaces.definitionOfDoneEvaluation(run.prompt_id);
  return{eventId,promptId:run.prompt_id,previousStatus:prompt.status,status:written.to,requestedStatus:target,result,createdAt:now,
    ...(gate===null?{}:{definitionOfDone:{satisfied:false,unmet:unmetCriteria(gate).map(entry=>({criterion:entry.text,result:entry.result,evidence:entry.evidence}))}})};
}));

/**
 * Let an active agent repair one command only after the server itself observed
 * that exact command fail. The outgoing prompt is revisioned, the replacement
 * keeps the original command's concrete targets/tools, and the HTTP layer runs
 * the new definition immediately. This is deliberately not a general prompt
 * editor: task scope and prose still belong to the operator.
 */
const agentVerifyRepairTransaction=db.transaction((runId:string,input:Record<string,unknown>)=>commandResult(runId,input.requestId,"repair-verify",()=>{
  const run=requireActiveExecuteRun(runId);
  const oldCommand=requireText(input.oldCommand,"oldCommand",DOD_COMMAND_MAX_LENGTH);
  const newCommand=requireText(input.newCommand,"newCommand",DOD_COMMAND_MAX_LENGTH);
  const reason=requireText(input.reason,"reason",2000);
  const failures=workspaces.agentDoneVerificationFailures(run.prompt_id)??[];
  if(!failures.some(entry=>entry.result==="FAILED"&&entry.command===oldCommand)){
    throw new WorkspaceError(409,"verify_not_failed","The server has not observed that exact current Verify command fail. Post done first, then repair only the command named in the refusal.");
  }
  validateVerifyRepair(oldCommand,newCommand);
  const row=db.prepare("SELECT title,content FROM prompt WHERE id=?").get(run.prompt_id) as {title:string;content:string}|undefined;
  if(row===undefined)throw new WorkspaceError(404,"not_found","Work item not found");
  const content=replaceVerifyCommand(row.content,oldCommand,newCommand);
  const now=new Date().toISOString();
  db.prepare("INSERT INTO prompt_revision(prompt_id,title,content,actor_type,reason,created_at) VALUES(?,?,?,'AGENT',?,?)")
    .run(run.prompt_id,row.title,row.content,`Verify repair: ${reason}`.slice(0,500),now);
  db.prepare("UPDATE prompt SET content=?,updated_at=? WHERE id=?").run(content,now,run.prompt_id);
  syncPromptVerifyCriteria(run.prompt_id,content);
  db.prepare("INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,?,'VERIFICATION',?,'AGENT',?)")
    .run(run.prompt_id,runId,`Repaired a failing Verify command.\n\nReason: ${reason}\n\nBefore:\n$ ${oldCommand}\n\nAfter:\n$ ${newCommand}`.slice(0,20000),now);
  return {promptId:run.prompt_id,oldCommand,newCommand,reason};
}));

/**
 * Remarks rendered into an agent's context. Newest first, so a resumed run sees
 * the resume brief and the last blocker rather than an unbounded transcript of
 * every prior attempt.
 */
const CONTEXT_REMARK_LIMIT=8;
/** Cap for transcript payloads returned to the UI. Matches live WebSocket replay. */
const MAX_SESSION_EVENTS=2000;

/** Parent brief + siblings for a decompose sub-step; null for a station. */
function buildParentContext(parentPromptId:number|null):AgentPromptParentContext|null {
  if(parentPromptId===null)return null;
  const parent=db.prepare("SELECT external_key externalKey,title,content FROM prompt WHERE id=?").get(parentPromptId) as {externalKey:string|null;title:string;content:string}|undefined;
  if(parent===undefined)return null;
  const siblings=db.prepare(
    "SELECT external_key externalKey,title,status FROM prompt WHERE parent_prompt_id=? ORDER BY child_order,id",
  ).all(parentPromptId) as AgentPromptParentContext["siblings"];
  // Prefer the newest CONTINUATION (agent or system brief). Fall back to the
  // resumeBrief filed alongside the parent's decompose — stored as the
  // verification_summary of the "Decomposed into N sub-steps" ledger row (the
  // writeStatus row for trigger agent_decompose has an empty summary).
  const continuation=db.prepare(
    "SELECT content FROM prompt_remark WHERE prompt_id=? AND kind='CONTINUATION' ORDER BY id DESC LIMIT 1",
  ).get(parentPromptId) as {content:string}|undefined;
  const decomposeBrief=db.prepare(
    `SELECT verification_summary resumeBrief FROM prompt_status_event
     WHERE prompt_id=? AND verification_summary<>'' AND reason LIKE 'Decomposed into %'
     ORDER BY id DESC LIMIT 1`,
  ).get(parentPromptId) as {resumeBrief:string}|undefined;
  return {
    externalKey:parent.externalKey,
    title:parent.title,
    content:parent.content,
    resumeBrief:(continuation?.content??decomposeBrief?.resumeBrief??"").trim(),
    siblings,
  };
}

/**
 * Direct children for a resumed parent's integration checklist. SKIPPED rows
 * carry the ledger reason so the parent does not assume their work exists.
 */
function buildChildrenContext(promptId:number):AgentPromptChildSummary[] {
  const rows=db.prepare(
    "SELECT id,external_key externalKey,title,status,result FROM prompt WHERE parent_prompt_id=? ORDER BY child_order,id",
  ).all(promptId) as Array<{id:number;externalKey:string|null;title:string;status:PromptRecord["status"];result:string}>;
  if(rows.length===0)return[];
  const skipReason=db.prepare(
    "SELECT reason FROM prompt_status_event WHERE prompt_id=? AND new_status='SKIPPED' ORDER BY id DESC LIMIT 1",
  );
  return rows.map((row)=>{
    if(row.status==="SKIPPED"){
      const skip=skipReason.get(row.id) as {reason:string}|undefined;
      return{externalKey:row.externalKey,title:row.title,status:row.status,result:(skip?.reason??row.result).trim()};
    }
    return{externalKey:row.externalKey,title:row.title,status:row.status,result:row.result};
  });
}

/**
 * The execute context's "Where the last run stopped" selection: one query per
 * kind, never AGENT_RESPONSE. Oldest-first so the agent reads chronologically.
 */
function buildStoppedRemarks(promptId:number):PromptRemark[] {
  const select=(kinds:string[],limit:number)=>db.prepare(
    `SELECT id,prompt_id promptId,run_id runId,kind,content,actor_type actorType,created_at createdAt
     FROM prompt_remark WHERE prompt_id=? AND kind IN (${kinds.map(()=>"?").join(",")})
     ORDER BY id DESC LIMIT ?`,
  ).all(promptId,...kinds,limit) as PromptRemark[];
  const byId=new Map<number,PromptRemark>();
  for(const remark of select(["CONTINUATION"],1))byId.set(remark.id,remark);
  const blocker=select(["BLOCKER"],1)[0];
  if(blocker!==undefined)byId.set(blocker.id,blocker);
  const human=select(["HUMAN_RESPONSE"],1)[0];
  // Pair an answer with the blocker it resolves, not with the latest status.
  // Starting the resumed run writes a newer IN_PROGRESS status before this
  // context is assembled; comparing against that status hid every answer at
  // exactly the moment the next agent needed to read it. Both records are
  // remarks, so their ids give us an unambiguous ordering even when SQLite
  // timestamps land in the same millisecond.
  if(human!==undefined&&(blocker===undefined||human.id>blocker.id)){
    byId.set(human.id,human);
  }
  for(const remark of select(["PROGRESS","VERIFICATION"],3))byId.set(remark.id,remark);
  return [...byId.values()].sort((a,b)=>a.id-b.id);
}

/**
 * Clarifications answered after the item last moved to DONE or TODO. Older
 * exchanges belong to a previous attempt and just bloat the prompt.
 */
function clarificationsSinceLastSettled(promptId:number):ClarificationExchange[] {
  const floor=db.prepare(
    "SELECT created_at createdAt FROM prompt_status_event WHERE prompt_id=? AND new_status IN ('DONE','TODO') ORDER BY id DESC LIMIT 1",
  ).get(promptId) as {createdAt:string}|undefined;
  const rows=db.prepare(
    "SELECT id,prompt_id promptId,question,answer,provider,model,state,created_at createdAt,answered_at answeredAt FROM clarification_exchange WHERE prompt_id=? AND state='DONE' AND answer IS NOT NULL ORDER BY id",
  ).all(promptId) as ClarificationExchange[];
  if(floor===undefined)return rows;
  return rows.filter((row)=>row.answeredAt!==null&&row.answeredAt>=floor.createdAt);
}
/** Evidence budget for a handoff dossier, in bytes. */
const HANDOFF_EVENT_BUDGET_BYTES=16000;

export const DECOMPOSE_MAX_DEPTH=2;
const DECOMPOSE_MIN_CHILDREN=2;
const DECOMPOSE_MAX_CHILDREN=12;

const agentDecomposeTransaction=db.transaction((runId:string,input:Record<string,unknown>)=>commandResult(runId,input.requestId,"decompose",()=>{
  const run=requireActiveExecuteRun(runId);
  const prompt=db.prepare("SELECT status,suite_id suiteId,external_key externalKey,parent_prompt_id parentPromptId FROM prompt WHERE id=?").get(run.prompt_id) as {status:PromptRecord["status"];suiteId:number;externalKey:string|null;parentPromptId:number|null};
  if(prompt.status!=="IN_PROGRESS")throw new WorkspaceError(422,"invalid_transition","Agents may only decompose an IN_PROGRESS work item");
  let depth=0;let ancestor=prompt.parentPromptId;
  while(ancestor!==null){depth++;ancestor=(db.prepare("SELECT parent_prompt_id parentPromptId FROM prompt WHERE id=?").get(ancestor) as {parentPromptId:number|null}).parentPromptId;}
  if(depth>=DECOMPOSE_MAX_DEPTH)throw new WorkspaceError(422,"decompose_depth_exceeded",`This work item is already a sub-step ${depth} level(s) deep; sub-steps cannot be split further. Finish it, or post \`continue\` with what remains; it will be resumed on this working tree.`);
  const resumeBrief=requireText(input.resumeBrief,"resumeBrief",20000);
  const rawChildren=Array.isArray(input.children)?input.children:[];
  if(rawChildren.length<DECOMPOSE_MIN_CHILDREN||rawChildren.length>DECOMPOSE_MAX_CHILDREN)throw new WorkspaceError(422,"validation_error",`children must list between ${DECOMPOSE_MIN_CHILDREN} and ${DECOMPOSE_MAX_CHILDREN} sub-steps`);
  // Parse first, then refuse title collisions before any insert — a resumed
  // parent appending more slices must not half-write a conflicting batch.
  const parsed=rawChildren.map((raw,index)=>{
    if(raw===null||typeof raw!=="object")throw new WorkspaceError(422,"validation_error",`children[${index}] must be an object`);
    const item=raw as Record<string,unknown>;
    return{
      index,
      title:requireText(item.title,`children[${index}].title`,200),
      content:requireText(item.content,`children[${index}].content`,20000),
    };
  });
  const conflicts:Array<{index:number;title:string;existing:string}>=[];
  const seenInRequest=new Map<string,number>();
  for(const child of parsed){
    const prior=seenInRequest.get(child.title);
    if(prior!==undefined){
      conflicts.push({index:child.index,title:child.title,existing:`(this request's children[${prior}]) — ${child.title}`});
      continue;
    }
    seenInRequest.set(child.title,child.index);
    const existing=db.prepare("SELECT external_key externalKey,title,status FROM prompt WHERE suite_id=? AND title=?").get(prompt.suiteId,child.title) as {externalKey:string|null;title:string;status:PromptRecord["status"]}|undefined;
    if(existing!==undefined){
      conflicts.push({
        index:child.index,
        title:child.title,
        existing:`${existing.externalKey??"(no key)"} — ${existing.title} (${existing.status})`,
      });
    }
  }
  if(conflicts.length>0){
    throw new WorkspaceError(422,"decompose_title_conflict","Rename these sub-steps and post again; existing sub-steps are kept.",undefined,{conflicts});
  }
  // Re-decompose appends: keep every existing child and continue numbering.
  const existingChildren=(db.prepare("SELECT COUNT(*) count FROM prompt WHERE parent_prompt_id=?").get(run.prompt_id) as {count:number}).count;
  const now=new Date().toISOString();
  const children=parsed.map((child,index)=>{
    const externalKey=prompt.externalKey===null?null:`${prompt.externalKey}.${existingChildren+index+1}`;
    const childOrder=existingChildren+index;
    const sortOrder=nextOrder("prompt","suite_id",prompt.suiteId);
    // No prompt_dependency row: a decompose parent's readiness is gated
    // directly on its open children (see promptOptions' openChildren), not
    // through the dependency table, so a skipped child still lets it resume -
    // unlike a real dependency, which a skip must never silently satisfy.
    const id=Number(db.prepare("INSERT INTO prompt(suite_id,title,content,sort_order,created_at,updated_at,external_key,status,completed_at,result,is_gate,parent_prompt_id,child_order) VALUES(?,?,?,?,?,?,?, 'TODO', NULL, '',0,?,?)")
      .run(prompt.suiteId,child.title,child.content,sortOrder,now,now,externalKey,run.prompt_id,childOrder).lastInsertRowid);
    syncPromptVerifyCriteria(id, child.content);
    return{id,externalKey,title:child.title};
  });
  writeStatus({promptId:run.prompt_id,to:"TODO",trigger:"agent_decompose",ruleId:"agent-decomposed",actor:"AGENT",runId,reason:"The agent split this work item into sub-steps; they carry the work now."});
  db.prepare("INSERT INTO prompt_status_event(prompt_id,run_id,previous_status,new_status,reason,verification_summary,actor_type,created_at) VALUES(?,?,'IN_PROGRESS','TODO',?,?, 'AGENT',?)")
    .run(run.prompt_id,runId,`Decomposed into ${children.length} sub-steps`,resumeBrief,now);
  db.prepare("INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,?, 'PROGRESS',?, 'AGENT',?)").run(run.prompt_id,runId,resumeBrief,now);
  return{promptId:run.prompt_id,children};
}));

/**
 * A whole program, written in one go.
 *
 * Shared by the two things that can produce one: the disk importer, and an
 * applied agent draft. It exists as a function so the second does not get a
 * second, subtly different insert — the dependency edges, the gate rows and
 * `syncPromptVerifyCriteria` (which is what turns a `## Verify` block into
 * command criteria) all have to happen for both, and the way that stays true is
 * for there to be one copy of it.
 *
 * The caller owns the transaction: both callers have their own preconditions to
 * check in the same atomic unit.
 */
interface ProgramTreeInsert {
  key: string | null;
  name: string;
  overview: string;
  suites: Array<{
    key: string | null;
    name: string;
    overview: string;
    prompts: Array<{
      key: string | null; title: string; content: string;
      status: PromptRecord["status"]; completedAt: string | null; result: string; isGate: boolean;
    }>;
  }>;
  dependencies: Array<{ promptKey: string; dependsOnKey: string }>;
  gates: Array<{ promptKey: string; code: string; name: string; description: string }>;
}

function insertProgramTree(workspaceId: number, tree: ProgramTreeInsert): { programId: number; promptIds: Map<string, number> } {
  const now=new Date().toISOString();
  const programOrder=nextOrder("program","workspace_id",workspaceId);
  const programId=Number(db.prepare("INSERT INTO program(workspace_id,name,overview,sort_order,created_at,updated_at,external_key) VALUES(?,?,?,?,?,?,?)").run(workspaceId,tree.name,tree.overview,programOrder,now,now,tree.key).lastInsertRowid);
  const promptIds=new Map<string,number>();
  tree.suites.forEach((suite,suiteOrder)=>{
    const suiteId=Number(db.prepare("INSERT INTO suite(program_id,name,overview,sort_order,created_at,updated_at,external_key) VALUES(?,?,?,?,?,?,?)").run(programId,suite.name,suite.overview,suiteOrder,now,now,suite.key).lastInsertRowid);
    suite.prompts.forEach((prompt,promptOrder)=>{
      const promptId=Number(db.prepare("INSERT INTO prompt(suite_id,title,content,sort_order,created_at,updated_at,external_key,status,completed_at,result,is_gate) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(suiteId,prompt.title,prompt.content,promptOrder,now,now,prompt.key,prompt.status,prompt.completedAt,prompt.result,prompt.isGate?1:0).lastInsertRowid);
      syncPromptVerifyCriteria(promptId, prompt.content);
      if(prompt.key!==null) promptIds.set(prompt.key,promptId);
    });
  });
  for(const dependency of tree.dependencies){
    const promptId=promptIds.get(dependency.promptKey);const dependsOnId=promptIds.get(dependency.dependsOnKey);
    if(promptId===undefined||dependsOnId===undefined)continue;
    db.prepare("INSERT INTO prompt_dependency(prompt_id,depends_on_prompt_id) VALUES(?,?)").run(promptId,dependsOnId);
  }
  tree.gates.forEach((gate,index)=>{
    const promptId=promptIds.get(gate.promptKey);
    if(promptId===undefined)return;
    db.prepare("INSERT INTO program_gate(program_id,prompt_id,code,name,description,sort_order) VALUES(?,?,?,?,?,?)").run(programId,promptId,gate.code,gate.name,gate.description,index);
  });
  return {programId,promptIds};
}

const importProgramTransaction = db.transaction((workspaceId: number, pack: ImportedProgram): number => {
  if (!db.prepare("SELECT 1 FROM workspace WHERE id=?").get(workspaceId)) throw new WorkspaceError(404,"not_found","Workspace not found");
  if (db.prepare("SELECT 1 FROM program WHERE workspace_id=? AND external_key=?").get(workspaceId,pack.key)) throw new WorkspaceError(409,"conflict",`Program ${pack.key} already exists in this workspace`);
  // A disk pack carries the workspace's standing instructions with it; an
  // agent-authored draft deliberately does not, and must never overwrite them.
  db.prepare("UPDATE workspace SET description=?,updated_at=? WHERE id=?").run(pack.workspaceDescription,new Date().toISOString(),workspaceId);
  return insertProgramTree(workspaceId,{
    key:pack.key,name:pack.name,overview:pack.overview,
    suites:pack.suites.map(suite=>({key:suite.key,name:suite.name,overview:"",prompts:suite.prompts.map(prompt=>({key:prompt.key,title:prompt.title,content:prompt.content,status:prompt.status,completedAt:prompt.completedAt,result:prompt.result,isGate:prompt.isGate}))})),
    dependencies:pack.dependencies,
    gates:pack.gates,
  }).programId;
});

/* ------------------------------------------------------------------------- */
/* Agent-authored programs                                                    */
/* ------------------------------------------------------------------------- */

type InstructionProposalRow = {
  id:number; workspace_id:number; field:WorkspaceInstructionField; state:InstructionProposalState; origin:InstructionProposalOrigin;
  goal:string; run_id:string|null; baseline:string; content:string; created_at:string; updated_at:string;
};

function instructionProposalRecord(row:InstructionProposalRow):InstructionProposalRecord {
  return {
    id:row.id, workspaceId:row.workspace_id, field:row.field, state:row.state, origin:row.origin, goal:row.goal,
    runId:row.run_id, baseline:row.baseline, content:row.content, createdAt:row.created_at, updatedAt:row.updated_at,
  };
}

function instructionProposalRow(id:number):InstructionProposalRow {
  const row=db.prepare("SELECT * FROM instruction_proposal WHERE id=?").get(id) as InstructionProposalRow|undefined;
  if(row===undefined)throw new WorkspaceError(404,"not_found","Proposal not found");
  return row;
}

/** A proposal whose own run is still writing it cannot be edited or applied underneath that run. */
function requireIdleProposal(row:InstructionProposalRow):void {
  if(row.state!=="PENDING")throw new WorkspaceError(409,"proposal_settled",`This proposal was already ${row.state.toLowerCase()}.`);
  if(row.origin!=="request"||row.run_id===null)return;
  const live=db.prepare("SELECT id FROM agent_run WHERE id=? AND state IN ('STARTING','RUNNING')").get(row.run_id) as {id:string}|undefined;
  if(live!==undefined)throw new WorkspaceError(409,"proposal_busy",`An agent is still writing this proposal (${live.id}). Wait for it to finish or stop it.`);
}

type ProgramDraftRow = {
  id:number; workspace_id:number; run_id:string|null; state:ProgramDraftState; goal:string;
  body_json:string; applied_program_id:number|null; created_at:string; updated_at:string;
  target_program_id:number|null; baseline_json:string|null;
};

function draftRecord(row:ProgramDraftRow):ProgramDraftRecord {
  let body:ProgramDraftBody;
  // A draft whose JSON cannot be parsed is still a row the operator has to be
  // able to see and discard. Returning an empty body rather than throwing keeps
  // one corrupt draft from taking the whole list down with it.
  try{ body=JSON.parse(row.body_json) as ProgramDraftBody; }catch{ body=emptyProgramDraftBody(); }
  let baseline:ProgramDraftBody|null=null;
  if(row.baseline_json!==null){ try{ baseline=JSON.parse(row.baseline_json) as ProgramDraftBody; }catch{ baseline=null; } }
  return {
    id:row.id,
    workspaceId:row.workspace_id,
    runId:row.run_id,
    state:row.state,
    goal:row.goal,
    body,
    appliedProgramId:row.applied_program_id,
    targetProgramId:row.target_program_id,
    baseline,
    createdAt:row.created_at,
    updatedAt:row.updated_at,
  };
}

function draftRow(id:number):ProgramDraftRow {
  const row=db.prepare("SELECT * FROM program_draft WHERE id=?").get(id) as ProgramDraftRow|undefined;
  if(row===undefined)throw new WorkspaceError(404,"not_found","Program draft not found");
  return row;
}

function writeDraftBody(id:number,body:ProgramDraftBody):void {
  db.prepare("UPDATE program_draft SET body_json=?,updated_at=? WHERE id=?").run(JSON.stringify(body),new Date().toISOString(),id);
}

/** The errors object shape the REST layer already renders, from a shared validator. */
function refuseInvalid(errors:Record<string,string>):never {
  throw new WorkspaceError(422,"validation_error","Some of that proposal was refused",errors);
}

/**
 * The author run's door.
 *
 * Deliberately not `requireActiveExecuteRun`: an author run has no work item,
 * so every check that one makes is meaningless here, and an execute run must
 * not be able to reach the draft table either. The two doors are separate so
 * neither can be widened by accident.
 */
function requireActiveAuthorRun(runId:string):{draft:ProgramDraftRow} {
  const run=db.prepare("SELECT role,workspace_id workspaceId FROM agent_run WHERE id=? AND state IN ('STARTING','RUNNING')").get(runId) as {role:RunRole;workspaceId:number}|undefined;
  if(!run)throw new WorkspaceError(409,"run_not_active","Run is not active");
  if(run.role!=="author")throw new WorkspaceError(403,"author_only","Only an author run can propose a program.");
  const row=db.prepare("SELECT * FROM program_draft WHERE run_id=?").get(runId) as ProgramDraftRow|undefined;
  if(row===undefined)throw new WorkspaceError(409,"draft_not_found","This run has no program draft to write to.");
  if(row.state!=="PENDING")throw new WorkspaceError(409,"draft_settled",`This draft was already ${row.state.toLowerCase()}; it can no longer be changed.`);
  return {draft:row};
}

const proposeProgramTransaction=db.transaction((runId:string,input:Record<string,unknown>)=>commandResult(runId,input.requestId,"propose-program",()=>{
  const {draft}=requireActiveAuthorRun(runId);
  if(draft.target_program_id!==null)throw new WorkspaceError(409,"revision_draft","This draft revises an existing program. Post changes with revise-program; proposing a whole program would throw its history away.");
  const parsed=normalizeProgramProposal(input);
  if(!parsed.ok)refuseInvalid(parsed.errors);
  // A second program post replaces the first outright, work items included. An
  // author that has changed its mind about the suites has changed its mind
  // about what the work items belong to, and silently keeping the old ones
  // would leave items filed under a suite that no longer means what it did.
  const body=bodyFromProgramProposal(parsed.value);
  writeDraftBody(draft.id,body);
  return {
    draftId:draft.id,
    program:body.name,
    suites:body.suites.map(suite=>({key:suite.key,name:suite.name})),
    next:"Post one `propose-suite` per suite, using the keys above.",
  };
}));

const proposeSuiteTransaction=db.transaction((runId:string,input:Record<string,unknown>)=>commandResult(runId,input.requestId,"propose-suite",()=>{
  const {draft}=requireActiveAuthorRun(runId);
  if(draft.target_program_id!==null)throw new WorkspaceError(409,"revision_draft","This draft revises an existing program. Post changes with revise-program; re-posting a suite would throw its items' history away.");
  const current=draftRecord(draft).body;
  if(current.suites.length===0){
    throw new WorkspaceError(409,"no_program_yet","Post `propose-program` first: this draft has no suites to file work items under.");
  }
  const parsed=normalizeSuiteProposal(input,current);
  if(!parsed.ok)refuseInvalid(parsed.errors);
  const body=withSuiteProposal(current,parsed.value);
  writeDraftBody(draft.id,body);
  const filled=body.suites.filter(suite=>suite.prompts.length>0).map(suite=>suite.key);
  const remaining=body.suites.filter(suite=>suite.prompts.length===0).map(suite=>suite.key);
  return {
    draftId:draft.id,
    suite:parsed.value.suiteKey,
    prompts:body.suites.find(suite=>suite.key===parsed.value.suiteKey)?.prompts.map(prompt=>({key:prompt.key,title:prompt.title}))??[],
    filled,
    remaining,
    next:remaining.length===0
      ?"Every suite has work items. Say what you proposed and stop; the operator applies it."
      :`Still to post: ${remaining.join(", ")}.`,
  };
}));

/**
 * Turns an approved draft into a real program.
 *
 * The keys are assigned here, not taken from the draft: `program.external_key`
 * is unique per workspace and `prompt.external_key` per suite, and a model
 * choosing its own would fail the insert at the end of the operator's approval
 * rather than at the start of the agent's run.
 */
const applyProgramDraftTransaction=db.transaction((id:number):{programId:number;prompts:number} => {
  const row=draftRow(id);
  if(row.target_program_id!==null)throw new WorkspaceError(409,"revision_draft","This draft revises an existing program; apply it as a revision.");
  if(row.state!=="PENDING")throw new WorkspaceError(409,"draft_settled",`This draft was already ${row.state.toLowerCase()}.`);
  const draft=draftRecord(row);
  if(!canApplyProgramDraft(draft.body)){
    throw new WorkspaceError(422,"draft_incomplete","This draft cannot be applied yet.",undefined,{issues:programDraftIssues(draft.body)});
  }
  const taken=(db.prepare("SELECT external_key key FROM program WHERE workspace_id=? AND external_key IS NOT NULL").all(row.workspace_id) as Array<{key:string}>).map(entry=>entry.key);
  const key=programKeyFrom(draft.body.name,taken);
  const gates=draft.body.suites.flatMap(suite=>suite.prompts.filter(prompt=>prompt.gate!==null).map(prompt=>({promptKey:prompt.key,name:prompt.gate!.name,description:prompt.gate!.description})));
  const inserted=insertProgramTree(row.workspace_id,{
    key,
    name:draft.body.name,
    overview:draft.body.overview,
    suites:draft.body.suites.map(suite=>({
      key:suite.key,
      name:suite.name,
      overview:suite.overview,
      prompts:suite.prompts.map(prompt=>({
        key:prompt.key,title:prompt.title,content:prompt.content,
        status:"TODO" as const,completedAt:null,result:"",isGate:prompt.gate!==null,
      })),
    })),
    dependencies:resolvedDependencies(draft.body),
    gates:gates.map((gate,index)=>({promptKey:gate.promptKey,code:`G${index+1}`,name:gate.name,description:gate.description})),
  });
  db.prepare("UPDATE program_draft SET state='APPLIED',applied_program_id=?,updated_at=? WHERE id=?").run(inserted.programId,new Date().toISOString(),id);
  return {programId:inserted.programId,prompts:inserted.promptIds.size};
});

/* ------------------------------------------------------------------------- */
/* Revisions: an agent-proposed change to a program that already exists      */
/* ------------------------------------------------------------------------- */

/**
 * The program as a revision draft body: every suite and work item carrying the
 * id of the row it copies.
 *
 * Keys are the library's own where they can be (so the agent and the operator
 * talk about `BT-S2-04`, not a number this draft invented), and assigned only
 * where a row has none or one that is not usable as a key. Dependencies inside
 * the program are carried; ones that point outside it are not, because a draft
 * cannot name them and apply must never delete what it could not see.
 */
function programRevisionBody(programId:number):ProgramDraftBody {
  const program=db.prepare("SELECT id,name,overview FROM program WHERE id=?").get(programId) as {id:number;name:string;overview:string}|undefined;
  if(!program)throw new WorkspaceError(404,"not_found","Program not found");
  const suites=db.prepare("SELECT id,name,overview,external_key FROM suite WHERE program_id=? ORDER BY sort_order,id").all(programId) as Array<{id:number;name:string;overview:string;external_key:string|null}>;
  const prompts=db.prepare("SELECT p.id,p.suite_id,p.title,p.content,p.external_key FROM prompt p JOIN suite s ON s.id=p.suite_id WHERE s.program_id=? ORDER BY s.sort_order,p.sort_order,p.id").all(programId) as Array<{id:number;suite_id:number;title:string;content:string;external_key:string|null}>;
  const edges=db.prepare("SELECT d.prompt_id promptId,d.depends_on_prompt_id dependsOnId FROM prompt_dependency d JOIN prompt p ON p.id=d.prompt_id JOIN suite s ON s.id=p.suite_id WHERE s.program_id=? ORDER BY d.prompt_id,d.depends_on_prompt_id").all(programId) as Array<{promptId:number;dependsOnId:number}>;
  const gates=new Map((db.prepare("SELECT prompt_id,name,description FROM program_gate WHERE program_id=?").all(programId) as Array<{prompt_id:number;name:string;description:string}>).map(gate=>[gate.prompt_id,{name:gate.name,description:gate.description}]));
  const usable=(key:string|null,used:Set<string>)=>{
    const upper=key?.trim().toUpperCase()??"";
    return DRAFT_KEY_PATTERN.test(upper)&&!used.has(upper)?upper:null;
  };
  const suiteKeys=new Set<string>();const promptKeys=new Set<string>();const keyById=new Map<number,string>();
  const suiteEntries=suites.map((suite,index)=>{
    let key=usable(suite.external_key,suiteKeys);
    for(let n=index;key===null;n+=1)key=usable(suiteKeyAt(n),suiteKeys);
    suiteKeys.add(key);
    const own=prompts.filter(prompt=>prompt.suite_id===suite.id);
    for(const [at,prompt] of own.entries()){
      let promptKey=usable(prompt.external_key,promptKeys);
      for(let n=at;promptKey===null;n+=1)promptKey=usable(promptKeyAt(key,n),promptKeys);
      promptKeys.add(promptKey);keyById.set(prompt.id,promptKey);
    }
    return {suite,key,own};
  });
  const body={
    name:program.name,
    overview:program.overview,
    notes:"",
    suites:suiteEntries.map(({suite,key,own})=>({
      key,name:suite.name,overview:suite.overview,filled:own.length>0,sourceId:suite.id,
      prompts:own.map(prompt=>({
        key:keyById.get(prompt.id)!,
        title:prompt.title,
        content:prompt.content,
        dependsOn:edges.filter(edge=>edge.promptId===prompt.id&&keyById.has(edge.dependsOnId)).map(edge=>keyById.get(edge.dependsOnId)!),
        gate:gates.get(prompt.id)??null,
        sourceId:prompt.id,
      })),
    })),
  };
  const normalized=normalizeProgramDraftBody(body,{revision:true});
  if(!normalized.ok)throw new WorkspaceError(422,"revision_unsupported","This program cannot be opened as a revision draft.",normalized.errors);
  return normalized.value;
}

const reviseProgramTransaction=db.transaction((runId:string,input:Record<string,unknown>)=>commandResult(runId,input.requestId,"revise-program",()=>{
  const {draft}=requireActiveAuthorRun(runId);
  if(draft.target_program_id===null){
    throw new WorkspaceError(409,"not_a_revision","This draft proposes a new program. Use propose-program and propose-suite.");
  }
  const record=draftRecord(draft);
  const result=applyRevisionChanges(record.body,input);
  if(!result.ok)refuseInvalid(result.errors);
  writeDraftBody(draft.id,result.value.body);
  const pending=diffProgramRevision(record.baseline??result.value.body,result.value.body);
  return {
    draftId:draft.id,
    applied:result.value.applied,
    pendingChanges:pending.length,
    next:"Post more changes if the request needs them, then summarise what you changed and why, and stop. The operator reviews the changes and applies them.",
  };
}));

interface RevisionApplySummary { added:number; updated:number; removed:number; moved:number; newPromptIds:number[] }

type IndexedBody={
  suites:Map<number,ProgramDraftSuite>;
  items:Map<number,{prompt:ProgramDraftPrompt;suiteId:number|null}>;
  idByKey:Map<string,number>;
};

function indexRevisionBody(body:ProgramDraftBody):IndexedBody {
  const suites=new Map<number,ProgramDraftSuite>();const items=new Map<number,{prompt:ProgramDraftPrompt;suiteId:number|null}>();const idByKey=new Map<string,number>();
  for(const suite of body.suites){
    if(typeof suite.sourceId==="number")suites.set(suite.sourceId,suite);
    for(const prompt of suite.prompts){
      if(typeof prompt.sourceId!=="number")continue;
      items.set(prompt.sourceId,{prompt,suiteId:typeof suite.sourceId==="number"?suite.sourceId:null});
      idByKey.set(prompt.key,prompt.sourceId);
    }
  }
  return {suites,items,idByKey};
}

const gateText=(gate:ProgramDraftPrompt["gate"])=>gate===null?"":JSON.stringify([gate.name,gate.description]);

/**
 * Writes a revision draft back into its program.
 *
 * Three versions are in play: the baseline (the program when the draft was
 * opened), the draft, and the program now. A field is written only when the
 * draft differs from the baseline, and refused when the program has *also*
 * moved away from the baseline to something else — that is someone's edit
 * made after the draft was opened, and applying over it would lose it with no
 * trace. Everything the draft did not change is left exactly as it is now.
 *
 * Rows are updated in place, never deleted and re-created, so an item keeps its
 * status, its run history and its revisions; a changed instruction is recorded
 * in `prompt_revision` exactly like an operator's edit.
 */
const applyProgramRevisionTransaction=db.transaction((id:number):{programId:number;summary:RevisionApplySummary}=>{
  const row=draftRow(id);
  if(row.state!=="PENDING")throw new WorkspaceError(409,"draft_settled",`This draft was already ${row.state.toLowerCase()}.`);
  const record=draftRecord(row);
  const programId=row.target_program_id!;
  const program=db.prepare("SELECT id,workspace_id workspaceId,name,overview FROM program WHERE id=?").get(programId) as {id:number;workspaceId:number;name:string;overview:string}|undefined;
  if(!program||program.workspaceId!==row.workspace_id)throw new WorkspaceError(409,"revision_target_gone","The program this draft revises no longer exists. Discard the draft.");
  if(record.baseline===null)throw new WorkspaceError(409,"revision_baseline_missing","This revision draft has no record of where it started, so it cannot be applied safely.");
  const draft=record.body;const base=record.baseline;
  if(!canApplyProgramDraft(draft)){
    throw new WorkspaceError(422,"draft_incomplete","This draft cannot be applied yet.",undefined,{issues:programDraftIssues(draft)});
  }
  if(row.run_id!==null&&db.prepare("SELECT 1 FROM agent_run WHERE id=? AND state IN ('STARTING','RUNNING')").get(row.run_id)){
    throw new WorkspaceError(409,"draft_busy","The agent is still writing this draft. Wait for it to finish, or stop it, before applying.");
  }
  if(db.prepare("SELECT 1 FROM agent_run r JOIN prompt p ON p.id=r.prompt_id JOIN suite s ON s.id=p.suite_id WHERE s.program_id=? AND r.state IN ('STARTING','RUNNING') LIMIT 1").get(programId)){
    throw new WorkspaceError(409,"program_busy","An agent is working on a work item in this program. Apply the changes once it has finished.");
  }
  if(db.prepare("SELECT 1 FROM suite_pipeline_run WHERE workspace_id=? AND state IN ('PLAYING','WAITING_HUMAN','PAUSED')").get(row.workspace_id)){
    throw new WorkspaceError(409,"workspace_busy","A pipeline is active in this workspace. Stop or finish it before changing the program it may be running.");
  }

  const B=indexRevisionBody(base);
  const C=indexRevisionBody(programRevisionBody(programId));
  const status=new Map((db.prepare("SELECT p.id,p.status FROM prompt p JOIN suite s ON s.id=p.suite_id WHERE s.program_id=?").all(programId) as Array<{id:number;status:string}>).map(entry=>[entry.id,entry.status]));

  // A sourceId counts only if the baseline has it, and only once: anything
  // else is a new row, whatever the body claims.
  const claimedSuites=new Set<number>();const claimedItems=new Set<number>();
  const plan=draft.suites.map(suite=>{
    const suiteId=typeof suite.sourceId==="number"&&B.suites.has(suite.sourceId)&&!claimedSuites.has(suite.sourceId)?suite.sourceId:null;
    if(suiteId!==null)claimedSuites.add(suiteId);
    return {suite,suiteId,items:suite.prompts.map(prompt=>{
      const itemId=typeof prompt.sourceId==="number"&&B.items.has(prompt.sourceId)&&!claimedItems.has(prompt.sourceId)?prompt.sourceId:null;
      if(itemId!==null)claimedItems.add(itemId);
      return {prompt,itemId};
    })};
  });
  const planItems=plan.flatMap(suite=>suite.items);
  const draftDeps=(prompt:ProgramDraftPrompt)=>prompt.dependsOn.map(key=>{
    const entry=planItems.find(item=>item.prompt.key===key);
    return entry===undefined?`?${key}`:entry.itemId===null?`new:${key}`:`#${entry.itemId}`;
  }).sort().join(",");
  const knownDeps=(index:IndexedBody,prompt:ProgramDraftPrompt)=>prompt.dependsOn.map(key=>index.idByKey.has(key)?`#${index.idByKey.get(key)}`:`?${key}`).sort().join(",");

  const conflicts:string[]=[];
  const threeWay=(label:string,baseValue:string,draftValue:string,currentValue:string)=>{
    if(draftValue!==baseValue&&currentValue!==baseValue&&currentValue!==draftValue)conflicts.push(`${label} was changed in the program after this draft was made.`);
  };
  threeWay("The program name",base.name,draft.name,program.name);
  threeWay("The program overview",base.overview,draft.overview,program.overview);
  for(const suite of plan){
    if(suite.suiteId===null)continue;
    const b=B.suites.get(suite.suiteId)!;const c=C.suites.get(suite.suiteId);
    if(c===undefined){conflicts.push(`Suite ${b.key} (${b.name}) was deleted from the program after this draft was made.`);continue;}
    threeWay(`Suite ${b.key}'s name`,b.name,suite.suite.name,c.name);
    threeWay(`Suite ${b.key}'s overview`,b.overview,suite.suite.overview,c.overview);
  }
  // Items deleted from the program since, that the draft did not change: they
  // stay deleted, and nothing below may point at them.
  const skipped=new Set<number>();
  for(const suite of plan){
    for(const item of suite.items){
      if(item.itemId===null)continue;
      const b=B.items.get(item.itemId)!;const c=C.items.get(item.itemId);
      const draftSuite=suite.suiteId===null?"new":String(suite.suiteId);
      const changed=b.prompt.title!==item.prompt.title||b.prompt.content!==item.prompt.content||gateText(b.prompt.gate)!==gateText(item.prompt.gate)
        ||knownDeps(B,b.prompt)!==draftDeps(item.prompt)||String(b.suiteId)!==draftSuite;
      if(c===undefined){
        if(changed)conflicts.push(`${b.prompt.key} was deleted from the program after this draft was made.`);
        skipped.add(item.itemId);
        continue;
      }
      const label=b.prompt.key;
      threeWay(`${label}'s title`,b.prompt.title,item.prompt.title,c.prompt.title);
      threeWay(`${label}'s instructions`,b.prompt.content,item.prompt.content,c.prompt.content);
      threeWay(`${label}'s gate`,gateText(b.prompt.gate),gateText(item.prompt.gate),gateText(c.prompt.gate));
      threeWay(`${label}'s dependencies`,knownDeps(B,b.prompt),draftDeps(item.prompt),knownDeps(C,c.prompt));
      threeWay(`${label}'s suite`,String(b.suiteId),draftSuite,String(c.suiteId));
    }
  }
  const removedItems=[...B.items.keys()].filter(itemId=>!claimedItems.has(itemId)&&C.items.has(itemId));
  for(const itemId of removedItems){
    const b=B.items.get(itemId)!.prompt;const c=C.items.get(itemId)!.prompt;
    if(b.title!==c.title||b.content!==c.content)conflicts.push(`${b.key} was edited after this draft was made; removing it would lose that edit.`);
    if(status.get(itemId)==="IN_PROGRESS")conflicts.push(`${b.key} is in progress and cannot be removed.`);
    const keptChildren=(db.prepare("SELECT id FROM prompt WHERE parent_prompt_id=?").all(itemId) as Array<{id:number}>).filter(child=>claimedItems.has(child.id));
    if(keptChildren.length>0)conflicts.push(`${b.key} has sub-steps this draft keeps; removing it would delete them too.`);
  }
  const removedSuites=[...B.suites.keys()].filter(suiteId=>!claimedSuites.has(suiteId)&&C.suites.has(suiteId));
  for(const suiteId of removedSuites){
    const b=B.suites.get(suiteId)!;
    if([...C.items].some(([itemId,entry])=>entry.suiteId===suiteId&&!B.items.has(itemId))){
      conflicts.push(`Suite ${b.key} gained work items after this draft was made; removing it would delete them.`);
    }
  }
  if(conflicts.length>0){
    throw new WorkspaceError(409,"revision_conflict","The program changed since this draft was made.",undefined,{issues:conflicts});
  }

  const now=new Date().toISOString();
  const reason=`Applied program revision draft ${id}`;
  const summary:RevisionApplySummary={added:0,updated:0,removed:0,moved:0,newPromptIds:[]};
  const temp=(rowId:number)=>`~revision-${id}-${rowId}~`;

  if(draft.name!==base.name||draft.overview!==base.overview){
    db.prepare("UPDATE program SET name=?,overview=?,updated_at=? WHERE id=?").run(draft.name!==base.name?draft.name:program.name,draft.overview!==base.overview?draft.overview:program.overview,now,programId);
  }

  // 1. Work items the draft removed.
  for(const itemId of removedItems){db.prepare("DELETE FROM prompt WHERE id=?").run(itemId);summary.removed+=1;}

  // 2. Set aside every name that is about to change or go, so a swap or a
  //    reuse cannot trip a unique index halfway through.
  for(const suiteId of removedSuites)db.prepare("UPDATE suite SET name=?,sort_order=? WHERE id=?").run(temp(suiteId),-suiteId,suiteId);
  for(const suite of plan){
    if(suite.suiteId!==null&&C.suites.has(suite.suiteId)&&B.suites.get(suite.suiteId)!.name!==suite.suite.name){
      db.prepare("UPDATE suite SET name=? WHERE id=?").run(temp(suite.suiteId),suite.suiteId);
    }
  }
  for(const item of planItems){
    if(item.itemId!==null&&!skipped.has(item.itemId)&&B.items.get(item.itemId)!.prompt.title!==item.prompt.title){
      db.prepare("UPDATE prompt SET title=? WHERE id=?").run(temp(item.itemId),item.itemId);
    }
  }

  // 3. Suites: new ones in, retained ones renamed.
  const suiteIds=new Map<(typeof plan)[number],number>();
  const takenSuiteKeys=new Set((db.prepare("SELECT external_key key FROM suite WHERE program_id=? AND external_key IS NOT NULL").all(programId) as Array<{key:string}>).map(entry=>entry.key));
  plan.forEach((suite,index)=>{
    if(suite.suiteId!==null){
      suiteIds.set(suite,suite.suiteId);
      const b=B.suites.get(suite.suiteId)!;const c=C.suites.get(suite.suiteId)!;
      if(b.name!==suite.suite.name||b.overview!==suite.suite.overview){
        db.prepare("UPDATE suite SET name=?,overview=?,updated_at=? WHERE id=?").run(
          b.name!==suite.suite.name?suite.suite.name:c.name,
          b.overview!==suite.suite.overview?suite.suite.overview:c.overview,now,suite.suiteId);
      }
      return;
    }
    const key=takenSuiteKeys.has(suite.suite.key)?null:suite.suite.key;
    if(key!==null)takenSuiteKeys.add(key);
    suiteIds.set(suite,Number(db.prepare("INSERT INTO suite(program_id,name,overview,sort_order,created_at,updated_at,external_key) VALUES(?,?,?,?,?,?,?)")
      .run(programId,suite.suite.name,suite.suite.overview,-1_000_000-index,now,now,key).lastInsertRowid));
  });

  // 4. Work items: moves, new rows, edits.
  const itemIds=new Map<string,number>();
  const takenPromptKeys=new Set((db.prepare("SELECT p.external_key key FROM prompt p JOIN suite s ON s.id=p.suite_id WHERE s.program_id=? AND p.external_key IS NOT NULL").all(programId) as Array<{key:string}>).map(entry=>entry.key));
  let fresh=0;
  for(const suite of plan){
    const targetSuiteId=suiteIds.get(suite)!;
    for(const item of suite.items){
      if(item.itemId!==null&&skipped.has(item.itemId))continue;
      if(item.itemId===null){
        const key=takenPromptKeys.has(item.prompt.key)?null:item.prompt.key;
        if(key!==null)takenPromptKeys.add(key);
        fresh+=1;
        const newId=Number(db.prepare("INSERT INTO prompt(suite_id,title,content,sort_order,created_at,updated_at,external_key,status,completed_at,result,is_gate) VALUES(?,?,?,?,?,?,?,'TODO',NULL,'',?)")
          .run(targetSuiteId,item.prompt.title,item.prompt.content,-2_000_000-fresh,now,now,key,item.prompt.gate===null?0:1).lastInsertRowid);
        syncPromptVerifyCriteria(newId,item.prompt.content);
        itemIds.set(item.prompt.key,newId);
        summary.added+=1;summary.newPromptIds.push(newId);
        continue;
      }
      const itemId=item.itemId;
      itemIds.set(item.prompt.key,itemId);
      const b=B.items.get(itemId)!;const c=C.items.get(itemId)!;
      if(b.suiteId!==suite.suiteId){
        db.prepare("UPDATE prompt SET suite_id=?,sort_order=? WHERE id=?").run(targetSuiteId,-itemId,itemId);
        summary.moved+=1;
      }
      const titleChanged=b.prompt.title!==item.prompt.title;const contentChanged=b.prompt.content!==item.prompt.content;
      if(titleChanged||contentChanged){
        const stored=db.prepare("SELECT title,content FROM prompt WHERE id=?").get(itemId) as {title:string;content:string};
        const previousTitle=titleChanged?c.prompt.title:stored.title;
        db.prepare("INSERT INTO prompt_revision(prompt_id,title,content,actor_type,reason,created_at) VALUES(?,?,?,'USER',?,?)").run(itemId,previousTitle,stored.content,reason,now);
        db.prepare("UPDATE prompt SET title=?,content=?,updated_at=? WHERE id=?").run(titleChanged?item.prompt.title:stored.title,contentChanged?item.prompt.content:stored.content,now,itemId);
        if(contentChanged)syncPromptVerifyCriteria(itemId,item.prompt.content);
      }
      if(titleChanged||contentChanged||gateText(b.prompt.gate)!==gateText(item.prompt.gate)||knownDeps(B,b.prompt)!==draftDeps(item.prompt))summary.updated+=1;
    }
  }

  // 5. Suites the draft removed. Their items were deleted or moved out above.
  for(const suiteId of removedSuites)db.prepare("DELETE FROM suite WHERE id=?").run(suiteId);

  // 6. Order: the draft's order, then anything added to the program since the
  //    draft was made, in the order it already had.
  const reorder=(table:"suite"|"prompt",parent:"program_id"|"suite_id",parentId:number,wanted:number[])=>{
    const rest=(db.prepare(`SELECT id FROM ${table} WHERE ${parent}=? ORDER BY sort_order,id`).all(parentId) as Array<{id:number}>).map(entry=>entry.id).filter(rowId=>!wanted.includes(rowId));
    const order=[...wanted,...rest];
    for(const rowId of order)db.prepare(`UPDATE ${table} SET sort_order=? WHERE id=?`).run(-rowId,rowId);
    order.forEach((rowId,index)=>db.prepare(`UPDATE ${table} SET sort_order=? WHERE id=?`).run(index,rowId));
  };
  reorder("suite","program_id",programId,plan.map(suite=>suiteIds.get(suite)!));
  for(const suite of plan){
    reorder("prompt","suite_id",suiteIds.get(suite)!,suite.items.map(item=>itemIds.get(item.prompt.key)).filter((rowId):rowId is number=>rowId!==undefined));
  }

  // 7. Dependencies, as a difference: edges the draft added go in, edges it
  //    dropped come out, and edges to other programs are never touched.
  const baseEdges=new Set([...B.items].flatMap(([itemId,entry])=>entry.prompt.dependsOn
    .map(key=>B.idByKey.get(key)).filter((to):to is number=>to!==undefined).map(to=>`${itemId}>${to}`)));
  const draftEdges=new Set(planItems.flatMap(item=>{
    const from=itemIds.get(item.prompt.key);
    if(from===undefined)return [];
    return item.prompt.dependsOn.map(key=>itemIds.get(key)).filter((to):to is number=>to!==undefined&&to!==from).map(to=>`${from}>${to}`);
  }));
  for(const edge of draftEdges)if(!baseEdges.has(edge)){const [from,to]=edge.split(">").map(Number);db.prepare("INSERT OR IGNORE INTO prompt_dependency(prompt_id,depends_on_prompt_id) VALUES(?,?)").run(from,to);}
  for(const edge of baseEdges)if(!draftEdges.has(edge)){const [from,to]=edge.split(">").map(Number);db.prepare("DELETE FROM prompt_dependency WHERE prompt_id=? AND depends_on_prompt_id=?").run(from,to);}

  // 8. Gates.
  for(const item of planItems){
    const promptId=itemIds.get(item.prompt.key);
    if(promptId===undefined)continue;
    const was=item.itemId===null?null:B.items.get(item.itemId)!.prompt.gate;
    if(gateText(was)===gateText(item.prompt.gate))continue;
    const existing=db.prepare("SELECT id FROM program_gate WHERE prompt_id=?").get(promptId) as {id:number}|undefined;
    if(item.prompt.gate===null){
      db.prepare("DELETE FROM program_gate WHERE prompt_id=?").run(promptId);
      db.prepare("UPDATE prompt SET is_gate=0 WHERE id=?").run(promptId);
    } else if(existing!==undefined){
      db.prepare("UPDATE program_gate SET name=?,description=? WHERE id=?").run(item.prompt.gate.name,item.prompt.gate.description,existing.id);
    } else {
      const codes=new Set((db.prepare("SELECT code FROM program_gate WHERE program_id=?").all(programId) as Array<{code:string}>).map(entry=>entry.code));
      let n=codes.size+1;while(codes.has(`G${n}`))n+=1;
      const order=(db.prepare("SELECT COALESCE(MAX(sort_order),-1)+1 value FROM program_gate WHERE program_id=?").get(programId) as {value:number}).value;
      db.prepare("INSERT INTO program_gate(program_id,prompt_id,code,name,description,sort_order) VALUES(?,?,?,?,?,?)").run(programId,promptId,`G${n}`,item.prompt.gate.name,item.prompt.gate.description,order);
      db.prepare("UPDATE prompt SET is_gate=1 WHERE id=?").run(promptId);
    }
  }

  db.prepare("UPDATE program SET updated_at=? WHERE id=?").run(now,programId);
  db.prepare("UPDATE program_draft SET state='APPLIED',applied_program_id=?,updated_at=? WHERE id=?").run(programId,now,id);
  return {programId,summary};
});

/*
 * The resolved status catalog: the shipped defaults with the operator's edits
 * layered on top.
 *
 * Memoized because it is read once per work item in the operations snapshot,
 * which walks every prompt in every suite in every workspace. The cache is
 * dropped on any write to `status_definition`, and nothing else can change it.
 */
let statusCatalogCache: StatusDefinition[] | null = null;

function resolvedStatusCatalog(): StatusDefinition[] {
  if (statusCatalogCache !== null) return statusCatalogCache;
  const overrides = new Map(
    (db.prepare("SELECT * FROM status_definition").all() as Array<Record<string, unknown>>)
      .map(row => [row.id as string, row]),
  );
  statusCatalogCache = DEFAULT_STATUS_CATALOG.map(base => {
    const row = overrides.get(base.id);
    if (row === undefined) return base;
    // A null column means "not overridden", so each field falls through to the
    // shipped default independently. An operator who renames one state has not
    // opted out of every later improvement to the others.
    const text = (key: string, fallback: string): string =>
      typeof row[key] === "string" && (row[key] as string).length > 0 ? row[key] as string : fallback;
    const flag = (key: string, fallback: boolean): boolean =>
      row[key] === null || row[key] === undefined ? fallback : row[key] === 1;
    const editable = (field: StatusEditableKey): boolean => statusFieldEditable(base, field);
    return {
      ...base,
      label: text("label", base.label),
      shortLabel: text("short_label", base.shortLabel),
      description: text("description", base.description),
      tone: isStatusTone(row.tone) ? row.tone : base.tone,
      icon: isStatusIcon(row.icon) ? row.icon : base.icon,
      // A locked field ignores whatever is in the row. The API refuses these
      // writes, but the invariants they protect are load-bearing enough that a
      // row inserted by hand must not be able to break them either.
      isTerminal: editable("isTerminal") ? flag("is_terminal", base.isTerminal) : base.isTerminal,
      satisfiesDependency: editable("satisfiesDependency") ? flag("satisfies_dependency", base.satisfiesDependency) : base.satisfiesDependency,
      blocksParent: editable("blocksParent") ? flag("blocks_parent", base.blocksParent) : base.blocksParent,
      needsAttention: editable("needsAttention") ? flag("needs_attention", base.needsAttention) : base.needsAttention,
      precedence: editable("precedence") && typeof row.precedence === "number" ? row.precedence : base.precedence,
      onEnter: editable("onEnter") && isStatusOnEnter(row.on_enter) ? row.on_enter : base.onEnter,
    };
  });
  return statusCatalogCache;
}

/** The operator's sentence for each trigger, over the shipped defaults. */
function resolvedTriggerSentences(): Record<string, string> {
  const rows = db.prepare("SELECT id,sentence FROM trigger_definition").all() as Array<{ id: string; sentence: string }>;
  return { ...DEFAULT_TRIGGER_SENTENCES, ...Object.fromEntries(rows.map(r => [r.id, r.sentence])) };
}

/*
 * The one place a work item's status changes.
 *
 * Every status write in this file goes through here. Before, thirteen call
 * sites each did their own UPDATE plus their own INSERT into
 * prompt_status_event, which meant thirteen chances to write a status without
 * recording why, to record a reason that did not match what was written, or to
 * forget the ledger row entirely. It also meant there was no single place that
 * could enforce an invariant, so the invariants lived in comments.
 *
 * Callers must already be inside a transaction: a status and its ledger row
 * that can be separated by a crash are worse than either alone.
 */
interface StatusWrite {
  promptId: number;
  to: StepStatus;
  trigger: StatusTrigger;
  actor: ActorType;
  /** The transition row that decided, when a rule did. */
  ruleId?: string | null;
  runId?: string | null;
  /** One sentence for the operator. Stored on the event, not invented later. */
  reason: string;
  verificationSummary?: string;
  /** Anything that backs the decision: verdicts, exit codes, failing criteria. */
  evidence?: Record<string, unknown> | null;
  /** Optimistic concurrency. When given, the write is refused unless it holds. */
  expect?: StepStatus;
  /** Replaces prompt.result. Omit to leave it as it is. */
  result?: string | null;
  /** A remark to file alongside, as the agent-facing API already does. */
  remark?: { kind: RemarkKind; content: string } | null;
  /**
   * Close even though the definition of done is not met.
   *
   * Only an operator may set this. A human override is always allowed — the
   * point of the gate is to stop the *pipeline* concluding something it has not
   * established, never to stop the person who owns the work from saying so —
   * and it is recorded as `operator_override` with the unmet criteria attached,
   * so a close made over a red criterion is visible as exactly that.
   */
  overrideDefinitionOfDone?: boolean;
}

function writeStatus(write: StatusWrite): { previous: StepStatus; changed: boolean; to: StepStatus } {
  const row = db.prepare("SELECT status FROM prompt WHERE id=?").get(write.promptId) as { status: StepStatus } | undefined;
  if (row === undefined) throw new WorkspaceError(404, "not_found", "Work item not found");
  const previous = row.status;
  if (write.expect !== undefined && previous !== write.expect) {
    throw new WorkspaceError(409, "stale_status", `Work item is ${previous}, not ${write.expect}`);
  }
  if (!isStepStatus(write.to)) {
    // An overlay is derived on every read; storing one would make the display
    // disagree with the database the moment the underlying fact changed.
    throw new WorkspaceError(422, "invalid_status", `${write.to} is not a storable status`);
  }

  /*
   * The closing gate.
   *
   * Sitting it inside the one writer rather than at each call site is the whole
   * reason `writeStatus` exists: there were thirteen ways to reach DONE, and a
   * gate spelled thirteen times is a gate with holes in it. Whatever route the
   * close came by — the agent's own post, a reviewer's verdict, a rule — it
   * passes here.
   *
   * A refused close is not an error and does not throw. The work item lands on
   * the state the `dod-unmet` rule row names, with the failing criteria as its
   * evidence, because "we could not confirm this" is an outcome the operator
   * has to be able to see and act on, not an exception for a caller to swallow.
   * Callers learn what was actually written from the returned `to`.
   */
  let to = write.to;
  let trigger = write.trigger;
  let ruleId = write.ruleId ?? null;
  let reason = write.reason;
  let result = write.result;
  let evidence = write.evidence;
  let remark = write.remark;
  if (write.to === "DONE") {
    const dod = evaluateDefinitionOfDone(write.promptId);
    if (!dod.satisfied && dod.blocking && write.overrideDefinitionOfDone !== true) {
      const rule = matchStepTransition({ signal: "dod_unmet" });
      to = rule?.to ?? "NEEDS_REVIEW";
      ruleId = rule?.id ?? "dod-unmet";
      // The rule row decides *where* it lands; the trigger names *what* went
      // wrong, and those are two fields on the ledger for a reason. A failing
      // command is a sharper answer than "a criterion did not pass", and it is
      // the sentence the operator reads next to the badge.
      trigger = dod.criteria.some((entry) => entry.required && entry.kind === "COMMAND" && entry.result === "FAILED")
        ? "dod_command_failed"
        : (rule?.trigger ?? "dod_unmet");
      reason = dodUnmetReason(dod);
      result = reason;
      evidence = dodUnmetEvidence(dod);
      remark = { kind: "BLOCKER", content: reason };
    } else if (!dod.satisfied) {
      // Closed anyway, under `warn` or an operator override. The criteria that
      // did not pass are recorded on the very event that closed it, so nobody
      // reading this later has to work out that it was closed over a red check.
      evidence = {
        ...(write.evidence ?? {}),
        ...dodUnmetEvidence(dod),
        definitionOfDone: write.overrideDefinitionOfDone === true
          ? "Not met; you closed this work item anyway."
          : `Not met; enforcement is "${dod.enforcement}", so it did not stop the close.`,
      };
    }
  }

  const now = new Date().toISOString();
  const terminal = statusDefinition(resolvedStatusCatalog(), to).isTerminal;
  db.prepare("UPDATE prompt SET status=?,result=COALESCE(?,result),completed_at=?,updated_at=? WHERE id=?")
    .run(to, result ?? null, terminal ? now : null, now, write.promptId);
  db.prepare(`INSERT INTO prompt_status_event
      (prompt_id,run_id,previous_status,new_status,reason,verification_summary,actor_type,created_at,trigger_id,rule_id,evidence_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      write.promptId, write.runId ?? null, previous, to, reason,
      write.verificationSummary ?? "", write.actor, now, trigger,
      ruleId, evidence === undefined || evidence === null ? null : JSON.stringify(evidence),
    );
  if (remark != null && remark.content.trim() !== "") {
    db.prepare("INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,?,?,?,?,?)")
      .run(write.promptId, write.runId ?? null, remark.kind, remark.content.slice(0, 20000), write.actor, now);
  }
  return { previous, changed: previous !== to, to };
}

/*
 * Forget definitions of done whose scope no longer exists.
 *
 * `definition_of_done` is keyed by (scope, scope_id) rather than by four
 * nullable foreign keys, which is what lets one table serve all four levels —
 * and it means SQLite will not clean it up for us. That matters more than it
 * sounds: SQLite reuses an INTEGER PRIMARY KEY once the row holding it is gone,
 * so a deleted work item's criteria do not merely linger, they silently attach
 * themselves to the next work item to be given that id. The symptom is a work
 * item that will not close for reasons nobody wrote.
 *
 * One statement rather than a cleanup at each delete site, because the delete
 * sites are not the whole story: removing a suite takes its prompts with it by
 * cascade, and a per-site cleanup would have to re-derive every one of those
 * paths by hand and stay correct as they change. Asking "is the thing this row
 * points at still there" cannot go stale.
 */
const forgetOrphanedScopedRows = db.transaction(() => {
  db.prepare(`
    DELETE FROM definition_of_done WHERE
      (scope='workspace' AND scope_id NOT IN (SELECT id FROM workspace)) OR
      (scope='program'   AND scope_id NOT IN (SELECT id FROM program))   OR
      (scope='suite'     AND scope_id NOT IN (SELECT id FROM suite))     OR
      (scope='prompt'    AND scope_id NOT IN (SELECT id FROM prompt))
  `).run();
});

// Once at boot as well as after every delete. The delete sites only cover rows
// orphaned by this process: a row can also be orphaned by an older build that
// lacked the cleanup, or by a delete that happened while a different version
// was running, and an id waiting to be reused is a hazard however it got there.
// Two indexed anti-joins over small tables, so it costs nothing to be sure.
forgetOrphanedScopedRows();

/* ------------------------------------------------------------------ */
/* The definition of done                                              */
/* ------------------------------------------------------------------ */

type DodRow = { id: number; scope: string; scope_id: number; enforcement: string | null };
type DodCriterionRow = {
  id: number; dod_id: number; kind: string; text: string; command: string | null; cwd: string | null;
  expect_exit_code: number; timeout_ms: number; required: number; sort_order: number;
};

function criterionDto(row: DodCriterionRow): DodCriterion {
  return {
    id: row.id,
    kind: isDodCriterionKind(row.kind) ? row.kind : "PROSE",
    text: row.text,
    command: row.command,
    cwd: row.cwd,
    expectExitCode: row.expect_exit_code,
    timeoutMs: clampDodTimeout(row.timeout_ms),
    required: row.required === 1,
    sortOrder: row.sort_order,
  };
}

/**
 * Every scope a work item inherits from, broadest first.
 *
 * Narrower entries come later so a single pass can let the nearest one win,
 * which is the same shape `resolveReviewerConfig` uses.
 */
function dodScopeChain(promptId: number): Array<[DodScope, number]> {
  const row = db.prepare(`
    SELECT p.id promptId, s.id suiteId, g.id programId, g.workspace_id workspaceId
    FROM prompt p JOIN suite s ON s.id = p.suite_id JOIN program g ON g.id = s.program_id
    WHERE p.id = ?
  `).get(promptId) as { promptId: number; suiteId: number; programId: number; workspaceId: number } | undefined;
  if (row === undefined) throw new WorkspaceError(404, "not_found", "Work item not found");
  return [["workspace", row.workspaceId], ["program", row.programId], ["suite", row.suiteId], ["prompt", row.promptId]];
}

const selectDod = () => db.prepare("SELECT id,scope,scope_id,enforcement FROM definition_of_done WHERE scope=? AND scope_id=?");
const selectCriteria = () => db.prepare("SELECT * FROM dod_criterion WHERE dod_id=? ORDER BY sort_order,id");

/** What one scope says on its own, with nothing inherited. For the editors. */
function ownDefinitionOfDone(scope: DodScope, scopeId: number): DefinitionOfDone {
  const row = selectDod().get(scope, scopeId) as DodRow | undefined;
  const criteria = row === undefined ? [] : (selectCriteria().all(row.id) as DodCriterionRow[]).map(criterionDto);
  return {
    scope,
    scopeId,
    enforcement: isDodEnforcement(row?.enforcement) ? row.enforcement : settings.pipelinePolicy.dodEnforcement,
    inheritedFrom: criteria.length === 0 ? null : { scope, scopeId },
    criteria,
  };
}

/*
 * What a work item is actually judged against.
 *
 * Two different resolutions, deliberately:
 *
 * - **Enforcement** resolves field-wise, narrowest non-null wins, over the
 *   `pipeline.dodEnforcement` house rule. So a suite can say "warn" without
 *   also having to restate the workspace's criteria.
 * - **Criteria** are taken whole from the nearest scope that has any, rather
 *   than accumulated down the chain. Accumulating reads well until an item
 *   needs to *drop* something its workspace imposes, at which point there is no
 *   way to say so; "this item has its own definition of done, which replaces
 *   the one above it" is a rule an operator can hold in their head.
 */
function resolveDefinitionOfDone(promptId: number): DefinitionOfDone {
  const chain = dodScopeChain(promptId);
  const select = selectDod();
  const criteriaFor = selectCriteria();
  let enforcement: DodEnforcement = settings.pipelinePolicy.dodEnforcement;
  let criteria: DodCriterion[] = [];
  let inheritedFrom: { scope: DodScope; scopeId: number } | null = null;
  for (const [scope, scopeId] of chain) {
    const row = select.get(scope, scopeId) as DodRow | undefined;
    if (row === undefined) continue;
    if (isDodEnforcement(row.enforcement)) enforcement = row.enforcement;
    const found = (criteriaFor.all(row.id) as DodCriterionRow[]).map(criterionDto);
    if (found.length > 0) { criteria = found; inheritedFrom = { scope, scopeId }; }
  }
  const [, promptScopeId] = chain[chain.length - 1]!;
  return { scope: "prompt", scopeId: promptScopeId, enforcement, inheritedFrom, criteria };
}

/** The newest thing anyone recorded about each criterion on this work item. */
function latestDodResults(promptId: number, criterionIds: number[]): Map<number, {
  source: string; result: string; evidence: string; output: string; exit_code: number | null;
  run_id: string | null; created_at: string;
}> {
  const results = new Map<number, ReturnType<typeof latestDodResults> extends Map<number, infer V> ? V : never>();
  if (criterionIds.length === 0) return results;
  const select = db.prepare(`
    SELECT source,result,evidence,output,exit_code,run_id,created_at FROM dod_result
    WHERE prompt_id=? AND criterion_id=? ORDER BY created_at DESC, id DESC LIMIT 1
  `);
  for (const id of criterionIds) {
    const row = select.get(promptId, id) as {
      source: string; result: string; evidence: string; output: string; exit_code: number | null;
      run_id: string | null; created_at: string;
    } | undefined;
    if (row !== undefined) results.set(id, row);
  }
  return results;
}

/**
 * Whether every sub-step has settled cleanly. Read off the same catalog the
 * board rolls up with, so an operator who marks a state terminal changes this
 * and the parent's badge together rather than one of them.
 */
function childrenClosed(promptId: number): { result: DodResult; evidence: string } {
  const children = db.prepare("SELECT id,status FROM prompt WHERE parent_prompt_id=?").all(promptId) as Array<{ id: number; status: StepStatus }>;
  if (children.length === 0) return { result: "PASSED", evidence: "This work item has no sub-steps." };
  const catalog = resolvedStatusCatalog();
  const open = children.filter((child) => !statusDefinition(catalog, child.status).isTerminal);
  if (open.length > 0) {
    return { result: "FAILED", evidence: `${open.length} of ${children.length} sub-steps have not settled (${open.map((child) => child.status).join(", ")}).` };
  }
  const worst = rollupStatus(catalog, children.map((child) => child.status));
  if (worst !== null) return { result: "FAILED", evidence: `A sub-step is ${statusDefinition(catalog, worst).label}.` };
  return { result: "PASSED", evidence: `All ${children.length} sub-steps closed cleanly.` };
}

/*
 * The gate, as a read.
 *
 * Deliberately synchronous and evidence-only: it consults what has been
 * *recorded* about each criterion and never runs anything itself. Executing a
 * command from in here would mean holding a SQLite write transaction open for
 * the length of a test suite, and it would put a several-minute block on the
 * event loop of a console whose whole job is watching live agents.
 *
 * Producing the evidence is `runDefinitionOfDoneCommands`' job, and the paths
 * that intend to close a work item call it first. A COMMAND nobody has run is
 * UNVERIFIED, which does not close anything — the same rule as a run that ended
 * without reporting. Absence of evidence is not evidence.
 */
/**
 * Rewrite prompt-scope COMMAND criteria from a work item's `## Verify` block.
 *
 * Called after every write of `prompt.content`. Unchanged command lines keep
 * their criterion id (and therefore their `dod_result` history); removed lines
 * drop their criteria; PROSE / CHILDREN_CLOSED rows at this scope are left
 * alone. An overlong line is a 422 naming it — better than a criterion that
 * can never be stored.
 */
function syncPromptVerifyCriteria(promptId: number, content: string): void {
  const parsed = parseVerifyBlock(content);
  if (parsed.tooLong.length > 0) {
    const line = parsed.tooLong[0]!;
    throw new WorkspaceError(
      422,
      "validation_error",
      `Verify command exceeds ${DOD_COMMAND_MAX_LENGTH} characters`,
      { command: line.length > 200 ? `${line.slice(0, 200)}…` : line },
    );
  }
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO definition_of_done(scope,scope_id,updated_at) VALUES('prompt',?,?) ON CONFLICT(scope,scope_id) DO UPDATE SET updated_at=excluded.updated_at",
  ).run(promptId, now);
  const dodId = (db.prepare("SELECT id FROM definition_of_done WHERE scope='prompt' AND scope_id=?").get(promptId) as { id: number }).id;
  const existing = db.prepare(
    "SELECT id,text,command,timeout_ms FROM dod_criterion WHERE dod_id=? AND kind='COMMAND'",
  ).all(dodId) as Array<{ id: number; text: string; command: string | null; timeout_ms: number }>;
  const byText = new Map(existing.map((row) => [row.text, row]));
  const keep = new Set<number>();
  parsed.commands.forEach((command, index) => {
    const found = byText.get(command.text);
    if (found !== undefined) {
      keep.add(found.id);
      db.prepare(
        "UPDATE dod_criterion SET command=?,cwd=NULL,expect_exit_code=0,timeout_ms=?,required=1,sort_order=? WHERE id=?",
      ).run(command.text, command.timeoutMs, index, found.id);
      return;
    }
    db.prepare(
      "INSERT INTO dod_criterion(dod_id,kind,text,command,cwd,expect_exit_code,timeout_ms,required,sort_order) VALUES(?,'COMMAND',?,?,NULL,0,?,1,?)",
    ).run(dodId, command.text, command.text, command.timeoutMs, index);
  });
  for (const row of existing) {
    if (!keep.has(row.id)) db.prepare("DELETE FROM dod_criterion WHERE id=?").run(row.id);
  }
}

function evaluateDefinitionOfDone(promptId: number): DodEvaluation {
  const definition = resolveDefinitionOfDone(promptId);
  if (definition.enforcement === "off" || definition.criteria.length === 0) {
    return { enforcement: definition.enforcement, satisfied: true, blocking: false, criteria: [] };
  }
  const recorded = latestDodResults(promptId, definition.criteria.filter((entry) => entry.kind !== "CHILDREN_CLOSED").map((entry) => entry.id));
  const criteria: DodCriterionResult[] = definition.criteria.map((criterion) => {
    const base = { criterionId: criterion.id, kind: criterion.kind, text: criterion.text, required: criterion.required };
    if (criterion.kind === "CHILDREN_CLOSED") {
      const children = childrenClosed(promptId);
      return { ...base, ...children, source: "RUNNER" as DodResultSource, output: "", exitCode: null, runId: null, createdAt: null };
    }
    const row = recorded.get(criterion.id);
    if (row === undefined) {
      return {
        ...base, result: "UNVERIFIED" as DodResult, source: null,
        evidence: criterion.kind === "COMMAND" ? "This command has not been run yet." : "No reviewer has judged this yet.",
        output: "", exitCode: null, runId: null, createdAt: null,
      };
    }
    return {
      ...base,
      result: isDodResult(row.result) ? row.result : "UNVERIFIED",
      source: isDodResultSource(row.source) ? row.source : null,
      evidence: row.evidence,
      output: row.output,
      exitCode: row.exit_code,
      runId: row.run_id,
      createdAt: row.created_at,
    };
  });
  const satisfied = criteria.every((entry) => !entry.required || entry.result === "PASSED");
  return { enforcement: definition.enforcement, satisfied, blocking: definition.enforcement === "block", criteria };
}

function sessionPromptTitle(savedTitle:string|null, displayText:string|null, role:string):string {
  if(typeof savedTitle==="string"&&savedTitle.trim()!=="")return savedTitle;
  const line=(displayText??"").split("\n")[0]?.trim()??"";
  if(line!=="")return line.slice(0,80);
  return role==="consult"?"(research)":"(custom)";
}

type SessionQueryRow = Omit<AgentSession,"events"|"promptTitle"> & { savedTitle:string|null };

function hydrateSession(row:SessionQueryRow, events:NormalizedEvent[]):AgentSession {
  const {savedTitle, displayText, ...rest}=row;
  return {
    ...rest,
    displayText: displayText ?? null,
    promptTitle: sessionPromptTitle(savedTitle, displayText, rest.role),
    events,
  };
}

const SESSION_SELECT=`SELECT r.id,r.workspace_id workspaceId,w.name workspaceName,w.work_directory workDirectory,r.prompt_id promptId,p.external_key promptKey,p.title savedTitle,r.display_text displayText,p.status promptStatus,COALESCE(g.name,'') programName,COALESCE(s.name,'') suiteName,r.provider,r.model,r.role,r.state,r.started_at startedAt,r.ended_at endedAt FROM agent_run r JOIN workspace w ON w.id=r.workspace_id LEFT JOIN prompt p ON p.id=r.prompt_id LEFT JOIN suite s ON s.id=p.suite_id LEFT JOIN program g ON g.id=s.program_id`;

export const workspaces = {
  databasePath,
  /**
   * Refuse to run with the database inside a directory an agent can write to.
   *
   * This is the guarantee. The prompt text asking agents not to touch SQLite is
   * an instruction a model may drop; a file it cannot reach is a fact. Checked
   * at boot rather than at write time because by the time an agent has opened
   * the file the damage — a status set behind the API's back, with no ledger
   * row and no trigger — has already happened and is indistinguishable from a
   * legitimate change.
   *
   * Realpaths on both sides, so a symlinked workspace cannot slip past.
   */
  assertDatabaseOutOfReach(): void {
    let database: string;
    try { database = realpathSync(databasePath); } catch { database = databasePath; }
    for (const workspace of this.list()) {
      if (!workspace.workDirectoryExists) continue;
      let root: string;
      try { root = realpathSync(workspace.workDirectory); } catch { continue; }
      if (database === root || database.startsWith(`${root}/`)) {
        throw new Error(
          `The orchestration database is inside workspace "${workspace.name}" (${root}).\n`
          + `  database: ${database}\n`
          + "Agents run there with write access, so they could change their own status without going\n"
          + "through the API — no ledger row, no recorded cause, and no way to tell that from a real\n"
          + "change. Move the database with AGENT_CONSOLE_DB, or point the workspace elsewhere.",
        );
      }
    }
  },
  /* ---------------------------------------------------------------- */
  /* Definition of done                                                */
  /* ---------------------------------------------------------------- */

  /** What one scope says on its own — what the editor for that scope shows. */
  definitionOfDone(scope: string, scopeId: number): DefinitionOfDone {
    if (!isDodScope(scope)) throw new WorkspaceError(404, "not_found", `No definition-of-done scope called ${scope}`);
    return ownDefinitionOfDone(scope, scopeId);
  },
  /** What a work item is judged against, after inheritance. */
  resolvedDefinitionOfDone(promptId: number): DefinitionOfDone { return resolveDefinitionOfDone(promptId); },
  /** The gate, as a read. See `evaluateDefinitionOfDone`. */
  definitionOfDoneEvaluation(promptId: number): DodEvaluation { return evaluateDefinitionOfDone(promptId); },

  /** Change what an unmet definition of done does at one scope. */
  setDodEnforcement(scope: string, scopeId: number, enforcement: string | null): DefinitionOfDone {
    if (!isDodScope(scope)) throw new WorkspaceError(404, "not_found", `No definition-of-done scope called ${scope}`);
    if (enforcement !== null && !isDodEnforcement(enforcement)) {
      throw new WorkspaceError(422, "validation_error", "Some changes were refused", { enforcement: "Must be block, warn or off" });
    }
    const now = new Date().toISOString();
    sqliteGuard(() => db.transaction(() => {
      db.prepare("INSERT INTO definition_of_done(scope,scope_id,enforcement,updated_at) VALUES(?,?,?,?) ON CONFLICT(scope,scope_id) DO UPDATE SET enforcement=excluded.enforcement,updated_at=excluded.updated_at")
        .run(scope, scopeId, enforcement, now);
    })());
    return ownDefinitionOfDone(scope, scopeId);
  },

  /**
   * Add or change one criterion.
   *
   * Everything a `COMMAND` needs is validated here rather than at run time,
   * because this is the operator's side of the API and the run happens
   * unattended: a criterion that cannot be run is a work item that can never
   * close, discovered hours later. The command length, the timeout range and
   * the relative-path rule are the same bounds `dodCommands.ts` enforces, and
   * they are stated once in `shared` so the two cannot drift.
   */
  saveDodCriterion(args: { scope: string; scopeId: number; criterionId?: number | null; patch: Record<string, unknown> }): DefinitionOfDone {
    if (!isDodScope(args.scope)) throw new WorkspaceError(404, "not_found", `No definition-of-done scope called ${args.scope}`);
    const patch = args.patch;
    const errors: Record<string, string> = {};

    const kind = patch.kind;
    if (!isDodCriterionKind(kind)) errors.kind = "Must be PROSE, COMMAND or CHILDREN_CLOSED";
    const text = typeof patch.text === "string" ? patch.text.trim().slice(0, 2000) : "";
    const command = typeof patch.command === "string" ? patch.command.trim() : "";
    if (kind === "COMMAND") {
      if (command === "") errors.command = "A command criterion needs a command to run";
      else if (command.length > DOD_COMMAND_MAX_LENGTH) errors.command = `Must be under ${DOD_COMMAND_MAX_LENGTH} characters`;
    }
    if (text === "" && command === "") errors.text = "Say what this criterion is, in your own words";
    const cwd = typeof patch.cwd === "string" && patch.cwd.trim() !== "" ? patch.cwd.trim() : null;
    if (cwd !== null && (isAbsolute(cwd) || cwd.split("/").includes(".."))) {
      errors.cwd = "Must be a path inside the workspace, relative to its root";
    }
    const expectExitCode = typeof patch.expectExitCode === "number" && Number.isInteger(patch.expectExitCode) ? patch.expectExitCode : 0;
    if (expectExitCode < 0 || expectExitCode > 255) errors.expectExitCode = "Must be between 0 and 255";
    const timeoutMs = clampDodTimeout(typeof patch.timeoutMs === "number" ? patch.timeoutMs : DOD_COMMAND_TIMEOUT_DEFAULT_MS);
    const required = patch.required === undefined ? true : patch.required === true;
    if (Object.keys(errors).length > 0) throw new WorkspaceError(422, "validation_error", "Some changes were refused", errors);

    const now = new Date().toISOString();
    sqliteGuard(() => db.transaction(() => {
      db.prepare("INSERT INTO definition_of_done(scope,scope_id,updated_at) VALUES(?,?,?) ON CONFLICT(scope,scope_id) DO UPDATE SET updated_at=excluded.updated_at")
        .run(args.scope, args.scopeId, now);
      const dodId = (db.prepare("SELECT id FROM definition_of_done WHERE scope=? AND scope_id=?").get(args.scope, args.scopeId) as { id: number }).id;
      const label = text === "" ? command : text;
      if (args.criterionId != null) {
        const owned = db.prepare("SELECT 1 FROM dod_criterion WHERE id=? AND dod_id=?").get(args.criterionId, dodId);
        if (!owned) throw new WorkspaceError(404, "not_found", "That criterion does not belong to this definition of done");
        db.prepare("UPDATE dod_criterion SET kind=?,text=?,command=?,cwd=?,expect_exit_code=?,timeout_ms=?,required=? WHERE id=?")
          .run(kind, label, kind === "COMMAND" ? command : null, kind === "COMMAND" ? cwd : null, expectExitCode, timeoutMs, required ? 1 : 0, args.criterionId);
      } else {
        const next = (db.prepare("SELECT COALESCE(MAX(sort_order),-1)+1 n FROM dod_criterion WHERE dod_id=?").get(dodId) as { n: number }).n;
        db.prepare("INSERT INTO dod_criterion(dod_id,kind,text,command,cwd,expect_exit_code,timeout_ms,required,sort_order) VALUES(?,?,?,?,?,?,?,?,?)")
          .run(dodId, kind, label, kind === "COMMAND" ? command : null, kind === "COMMAND" ? cwd : null, expectExitCode, timeoutMs, required ? 1 : 0, next);
      }
    })());
    return ownDefinitionOfDone(args.scope, args.scopeId);
  },

  removeDodCriterion(scope: string, scopeId: number, criterionId: number): DefinitionOfDone {
    if (!isDodScope(scope)) throw new WorkspaceError(404, "not_found", `No definition-of-done scope called ${scope}`);
    const dod = selectDod().get(scope, scopeId) as DodRow | undefined;
    if (dod === undefined) throw new WorkspaceError(404, "not_found", "This scope has no definition of done");
    if (db.prepare("DELETE FROM dod_criterion WHERE id=? AND dod_id=?").run(criterionId, dod.id).changes === 0) {
      throw new WorkspaceError(404, "not_found", "That criterion does not belong to this definition of done");
    }
    return ownDefinitionOfDone(scope, scopeId);
  },

  /**
   * What has to be run before a work item can close, and where.
   *
   * Handed out rather than acted on here: this module owns the database and the
   * gate that reads it, and executing a shell command belongs somewhere it can
   * be read on its own. `definitionOfDone.ts` is the caller.
   */
  dodCommandPlan(promptId: number): { workDirectory: string; criteria: DodCriterion[] } {
    const home = this.promptHome(promptId);
    const definition = resolveDefinitionOfDone(promptId);
    const workDirectory = (db.prepare("SELECT work_directory FROM workspace WHERE id=?").get(home.workspaceId) as { work_directory: string }).work_directory;
    if (definition.enforcement === "off") return { workDirectory, criteria: [] };
    return { workDirectory, criteria: definition.criteria.filter((entry) => entry.kind === "COMMAND" && entry.command !== null) };
  },

  /** File what something concluded about one criterion. Append-only. */
  recordDodResult(args: {
    promptId: number; criterionId: number; runId?: string | null; source: DodResultSource;
    result: DodResult; evidence?: string; output?: string; exitCode?: number | null;
  }): void {
    sqliteGuard(() => {
      db.prepare("INSERT INTO dod_result(prompt_id,criterion_id,run_id,source,result,evidence,output,exit_code,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          args.promptId, args.criterionId, args.runId ?? null, args.source, args.result,
          (args.evidence ?? "").slice(0, 4000), (args.output ?? "").slice(0, DOD_COMMAND_OUTPUT_MAX_BYTES),
          args.exitCode ?? null, new Date().toISOString(),
        );
    });
  },

  /**
   * What a blocked agent `done` must show: each unmet required criterion with
   * the command's own exit code and output. `null` when the close may proceed
   * (satisfied, warn, or off).
   */
  agentDoneVerificationFailures(promptId: number): Array<{
    command: string; exitCode: number | null; output: string; result: string; evidence: string;
  }> | null {
    const evaluation = evaluateDefinitionOfDone(promptId);
    if (evaluation.satisfied || !evaluation.blocking) return null;
    return unmetCriteria(evaluation).map((entry) => ({
      command: entry.text,
      exitCode: entry.exitCode,
      output: entry.output,
      result: entry.result,
      evidence: entry.evidence,
    }));
  },

  /**
   * Bank a refused `done` as a SYSTEM VERIFICATION remark so the next run's
   * continuation brief starts from the compiler's words rather than the top.
   */
  recordVerificationFailureRemark(promptId: number, runId: string, failures: Array<{
    command: string; exitCode: number | null; output: string;
  }>): void {
    const blocks = failures.map((failure) => {
      const exit = failure.exitCode === null ? "killed" : String(failure.exitCode);
      const output = failure.output.trim() === "" ? "(no output)" : failure.output.trim();
      return `$ ${failure.command}\nexit ${exit}\n${output}`;
    });
    const content = [
      "Verification failed.",
      "",
      ...blocks,
      "",
      "Fix the implementation and post `done` again. If the command itself is defective, use `agent-step repair-verify --file repair.json`. If the work cannot finish in this run, post `continue` with what remains.",
    ].join("\n").slice(0, 20000);
    const now = new Date().toISOString();
    sqliteGuard(() => {
      db.prepare(
        "INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,?,'VERIFICATION',?,'SYSTEM',?)",
      ).run(promptId, runId, content, now);
    });
  },

  /** The resolved status catalog. See `resolvedStatusCatalog`. */
  statusCatalog(): StatusDefinition[] { return resolvedStatusCatalog(); },
  triggerSentences(): Record<string, string> { return resolvedTriggerSentences(); },
  /**
   * Change how a status presents itself, or what entering it does.
   *
   * Refuses a locked field rather than quietly ignoring it: a settings screen
   * that appears to accept a change it will not honour is worse than one that
   * says no. The locks protect invariants the rest of the engine relies on —
   * DONE has to stay terminal, and an item nobody confirmed cannot be made to
   * satisfy a dependency.
   */
  updateStatusDefinition(id: string, patch: Record<string, unknown>): StatusDefinition {
    if (!isStepDisplayStatus(id)) throw new WorkspaceError(404, "not_found", `No status called ${id}`);
    const base = defaultStatusDefinition(id);
    const columns: Array<[StatusEditableKey, string, "text" | "flag" | "number" | "tone" | "icon" | "onEnter"]> = [
      ["label", "label", "text"], ["shortLabel", "short_label", "text"], ["description", "description", "text"],
      ["tone", "tone", "tone"], ["icon", "icon", "icon"],
      ["isTerminal", "is_terminal", "flag"], ["satisfiesDependency", "satisfies_dependency", "flag"],
      ["blocksParent", "blocks_parent", "flag"], ["needsAttention", "needs_attention", "flag"],
      ["precedence", "precedence", "number"], ["onEnter", "on_enter", "onEnter"],
    ];
    const fields: string[] = [];
    const values: unknown[] = [];
    const errors: Record<string, string> = {};
    for (const [key, column, kind] of columns) {
      if (!(key in patch)) continue;
      if (!statusFieldEditable(base, key)) {
        errors[key] = base.lockedReason ?? "This field cannot be changed.";
        continue;
      }
      const value = patch[key];
      if (value === null) { fields.push(`${column}=?`); values.push(null); continue; }
      if (kind === "text") {
        if (typeof value !== "string" || value.trim() === "") { errors[key] = "Must be some text"; continue; }
        fields.push(`${column}=?`); values.push(value.trim().slice(0, 2000));
      } else if (kind === "flag") {
        if (typeof value !== "boolean") { errors[key] = "Must be true or false"; continue; }
        fields.push(`${column}=?`); values.push(value ? 1 : 0);
      } else if (kind === "number") {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) { errors[key] = "Must be a whole number, zero or more"; continue; }
        fields.push(`${column}=?`); values.push(value);
      } else if (kind === "tone") {
        if (!isStatusTone(value)) { errors[key] = "Not a known tone"; continue; }
        fields.push(`${column}=?`); values.push(value);
      } else if (kind === "icon") {
        if (!isStatusIcon(value)) { errors[key] = "Not a known icon"; continue; }
        fields.push(`${column}=?`); values.push(value);
      } else {
        if (!isStatusOnEnter(value)) { errors[key] = "Not a known entry behaviour"; continue; }
        fields.push(`${column}=?`); values.push(value);
      }
    }
    if (Object.keys(errors).length > 0) throw new WorkspaceError(422, "validation_error", "Some changes were refused", errors);
    if (fields.length === 0) return statusDefinition(resolvedStatusCatalog(), id);
    const now = new Date().toISOString();
    sqliteGuard(() => db.transaction(() => {
      db.prepare("INSERT INTO status_definition(id,updated_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING").run(id, now);
      db.prepare(`UPDATE status_definition SET ${fields.join(",")},updated_at=? WHERE id=?`).run(...values, now, id);
    })());
    statusCatalogCache = null;
    return statusDefinition(resolvedStatusCatalog(), id);
  },
  /** Drop every override on a status, returning it to what ships. */
  resetStatusDefinition(id: string): StatusDefinition {
    if (!isStepDisplayStatus(id)) throw new WorkspaceError(404, "not_found", `No status called ${id}`);
    db.prepare("DELETE FROM status_definition WHERE id=?").run(id);
    statusCatalogCache = null;
    return defaultStatusDefinition(id);
  },
  /** Reword what caused a status change. The token stays ours; the sentence is theirs. */
  updateTriggerSentence(id: string, sentence: unknown): Record<string, string> {
    if (!isStatusTrigger(id)) throw new WorkspaceError(404, "not_found", `No trigger called ${id}`);
    if (sentence === null) { db.prepare("DELETE FROM trigger_definition WHERE id=?").run(id); return resolvedTriggerSentences(); }
    if (typeof sentence !== "string" || sentence.trim() === "") {
      throw new WorkspaceError(422, "validation_error", "A trigger needs a sentence", { sentence: "Must be some text" });
    }
    db.prepare("INSERT INTO trigger_definition(id,sentence,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET sentence=excluded.sentence,updated_at=excluded.updated_at")
      .run(id, sentence.trim().slice(0, 2000), new Date().toISOString());
    return resolvedTriggerSentences();
  },
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
  update(id: number, input: Record<string, unknown>): WorkspaceRecord { return sqliteGuard(() => db.transaction(() => {
    const current = this.get(id);
    const next = {
      name: input.name === undefined ? current.name : requireText(input.name, "name", 120),
      description: input.description === undefined ? current.description : requireText(input.description, "description", 64000, true),
      workDirectory: input.workDirectory === undefined ? current.workDirectory : directory(input.workDirectory),
      claudeMd: input.claudeMd === undefined ? current.claudeMd : requireText(input.claudeMd, "claudeMd", 64000, true),
      agentsMd: input.agentsMd === undefined ? current.agentsMd : requireText(input.agentsMd, "agentsMd", 64000, true),
    };
    // Agents may rewrite these, so the text they replace is kept the way a
    // prompt's is. An instruction file edited badly is as costly as a prompt
    // edited badly, and neither is recoverable from git here.
    const actor = input.actorType === "AGENT" ? "AGENT" : input.actorType === "SYSTEM" ? "SYSTEM" : "USER";
    const reason = typeof input.reason === "string" ? input.reason.slice(0, 500) : "";
    const snapshot = db.prepare("INSERT INTO workspace_revision(workspace_id,field,content,actor_type,reason,created_at) VALUES(?,?,?,?,?,?)");
    const now = new Date().toISOString();
    for (const field of ["description", "claudeMd", "agentsMd"] as const) {
      if (next[field] !== current[field]) snapshot.run(id, field, current[field], actor, reason, now);
    }
    db.prepare("UPDATE workspace SET name=?, description=?, work_directory=?, claude_md=?, agents_md=?, updated_at=? WHERE id=?")
      .run(next.name, next.description, next.workDirectory, next.claudeMd, next.agentsMd, now, id);
    return this.get(id);
  })()); },
  /** Newest first. A revision holds the text as it was *before* that edit. */
  workspaceRevisions(id: number, field?: string): WorkspaceRevision[] {
    this.get(id);
    const sql = "SELECT id,workspace_id workspaceId,field,content,actor_type actorType,reason,created_at createdAt FROM workspace_revision WHERE workspace_id=?";
    return (field === undefined
      ? db.prepare(`${sql} ORDER BY id DESC`).all(id)
      : db.prepare(`${sql} AND field=? ORDER BY id DESC`).all(id, field)) as WorkspaceRevision[];
  },
  restoreWorkspaceRevision(id: number, revisionId: number): WorkspaceRecord {
    const revision = db.prepare("SELECT field,content FROM workspace_revision WHERE id=? AND workspace_id=?").get(revisionId, id) as { field: string; content: string } | undefined;
    if (!revision) throw new WorkspaceError(404, "not_found", "Revision not found for this workspace");
    return this.update(id, { [revision.field]: revision.content, reason: `Restored revision ${revisionId}` });
  },
  remove(id: number): void {
    if (db.prepare("DELETE FROM workspace WHERE id=?").run(id).changes === 0) throw new WorkspaceError(404, "not_found", "Workspace not found");
    forgetOrphanedScopedRows();
  },
  tree(id: number): WorkspaceTree {
    const workspace = this.get(id);
    const programs = (db.prepare("SELECT * FROM program WHERE workspace_id=? ORDER BY sort_order").all(id) as ProgramRow[]).map((p): ProgramRecord => ({ id:p.id, workspaceId:p.workspace_id, name:p.name, overview:p.overview, sortOrder:p.sort_order, createdAt:p.created_at, updatedAt:p.updated_at, externalKey:p.external_key, suites:(db.prepare("SELECT * FROM suite WHERE program_id=? ORDER BY sort_order").all(p.id) as SuiteRow[]).map((s): SuiteRecord => ({ id:s.id, programId:s.program_id, name:s.name, overview:s.overview, sortOrder:s.sort_order, createdAt:s.created_at, updatedAt:s.updated_at, externalKey:s.external_key, prompts:(db.prepare("SELECT * FROM prompt WHERE suite_id=? ORDER BY sort_order").all(s.id) as PromptRow[]).map(promptDto) })) }));
    return { ...workspace, programs };
  },
  promptOptions(id: number): PromptOption[] { this.get(id); const rows=db.prepare(`SELECT p.id,p.title,p.content,p.external_key externalKey,p.status,p.parent_prompt_id parentPromptId,p.child_order childOrder,(SELECT COUNT(*) FROM prompt c WHERE c.parent_prompt_id=p.id AND c.status NOT IN ('DONE','SKIPPED')) openChildren,(SELECT COUNT(*) FROM prompt earlier WHERE p.parent_prompt_id IS NOT NULL AND earlier.parent_prompt_id=p.parent_prompt_id AND (earlier.child_order<p.child_order OR (earlier.child_order=p.child_order AND earlier.id<p.id)) AND earlier.status NOT IN ('DONE','SKIPPED')) openEarlierSiblings,s.id suiteId,s.name suiteName,g.id programId,g.name programName FROM prompt p JOIN suite s ON s.id=p.suite_id JOIN program g ON g.id=s.program_id WHERE g.workspace_id=? ORDER BY g.sort_order,s.sort_order,p.sort_order`).all(id) as Array<Omit<PromptOption,"ready"|"blockedBy"|"currentRun"|"recoverable">&{openChildren:number;openEarlierSiblings:number}>; const latest=db.prepare("SELECT id,provider,model,role,state,started_at startedAt,ended_at endedAt FROM agent_run WHERE prompt_id=? ORDER BY CASE WHEN role='execute' THEN 0 ELSE 1 END, started_at DESC LIMIT 1"); return rows.map(({openChildren,openEarlierSiblings,...row})=>{const blockedBy=(db.prepare(`SELECT prerequisite.external_key FROM prompt_dependency d JOIN prompt prerequisite ON prerequisite.id=d.depends_on_prompt_id WHERE d.prompt_id=? AND prerequisite.status<>'DONE' ORDER BY prerequisite.external_key`).all(row.id) as Array<{external_key:string}>).map(x=>x.external_key);const run=latest.get(row.id) as {id:string;provider:string;model:string|null;role:RunRole;state:string;startedAt:string;endedAt:string|null}|undefined;const processActive=run?run.role==="execute"&&activeRuns.has(run.id):false;const abandoned=row.status==="IN_PROGRESS"&&!!run&&!processActive&&(run.state==="STARTING"||run.state==="RUNNING");const systemInterrupted=endedWithoutAgentStatus(row.status);return{...row,ready:row.status==="TODO"&&blockedBy.length===0&&openChildren===0&&openEarlierSiblings===0,blockedBy,currentRun:run?{...run,processActive}:null,recoverable:blockedBy.length===0&&(abandoned||systemInterrupted)};}); },
  resolvePrompt(workspaceId: number, promptId: number): PromptOption {
    const row = this.promptOptions(workspaceId).find(prompt => prompt.id === promptId);
    if (!row) throw new WorkspaceError(404, "not_found", "Prompt was not found in this workspace"); return row;
  },
  /**
   * Remarks of the given kinds, newest first. A query rather than a filter over
   * `promptHistory`, so the execute context can pick CONTINUATION / BLOCKER /
   * PROGRESS without pulling every AGENT_RESPONSE into memory first.
   */
  recentRemarks(promptId:number,opts:{kinds:string[];limit:number}):PromptRemark[] {
    if(!db.prepare("SELECT 1 FROM prompt WHERE id=?").get(promptId))throw new WorkspaceError(404,"not_found","Prompt not found");
    const kinds=opts.kinds.filter((kind)=>kind.trim()!=="");
    if(kinds.length===0||opts.limit<=0)return[];
    const placeholders=kinds.map(()=>"?").join(",");
    return db.prepare(
      `SELECT id,prompt_id promptId,run_id runId,kind,content,actor_type actorType,created_at createdAt
       FROM prompt_remark WHERE prompt_id=? AND kind IN (${placeholders})
       ORDER BY id DESC LIMIT ?`,
    ).all(promptId,...kinds,opts.limit) as PromptRemark[];
  },
  agentContext(workspaceId:number,promptId:number,opts?:{full?:boolean}):AgentPromptContext {
    const full=opts?.full===true;
    const row=db.prepare(`SELECT p.*,s.id context_suite_id,s.external_key suite_external_key,s.name suite_name,s.overview suite_overview,g.id context_program_id,g.external_key program_external_key,g.name program_name,g.overview program_overview,w.id context_workspace_id,w.name workspace_name,w.work_directory,w.description workspace_description,w.agents_md workspace_agents_md,w.claude_md workspace_claude_md FROM prompt p JOIN suite s ON s.id=p.suite_id JOIN program g ON g.id=s.program_id JOIN workspace w ON w.id=g.workspace_id WHERE p.id=? AND w.id=?`).get(promptId,workspaceId) as (PromptRow&Record<string,unknown>)|undefined;
    if(!row) throw new WorkspaceError(404,"not_found","Prompt was not found in this workspace");
    const dependencies=db.prepare(`SELECT p.external_key externalKey,p.title,p.status,p.result FROM prompt_dependency d JOIN prompt p ON p.id=d.depends_on_prompt_id WHERE d.prompt_id=? ORDER BY p.external_key`).all(promptId) as AgentPromptContext["dependencies"];
    const gate=db.prepare("SELECT code,name,description FROM program_gate WHERE prompt_id=?").get(promptId) as AgentPromptContext["gate"]|undefined;
    const history=this.promptHistory(promptId,full?undefined:CONTEXT_REMARK_LIMIT);
    const prompt=promptDto(row);
    const parent=buildParentContext(prompt.parentPromptId);
    const children=buildChildrenContext(promptId);
    const verificationCommands=resolveDefinitionOfDone(promptId).criteria
      .filter((criterion)=>criterion.kind==="COMMAND")
      .map((criterion)=>(criterion.command??criterion.text).trim())
      .filter((command)=>command!=="");
    const stoppedRemarks=full?[]:buildStoppedRemarks(promptId);
    const clarifications=full?this.clarifications(promptId):clarificationsSinceLastSettled(promptId);
    return {
      workspace:{
        id:Number(row.context_workspace_id),
        name:String(row.workspace_name),
        workDirectory:String(row.work_directory),
        description:String(row.workspace_description),
        agentsMd:String(row.workspace_agents_md??""),
        claudeMd:String(row.workspace_claude_md??""),
      },
      program:{id:Number(row.context_program_id),externalKey:row.program_external_key as string|null,name:String(row.program_name),overview:String(row.program_overview)},
      suite:{id:Number(row.context_suite_id),externalKey:row.suite_external_key as string|null,name:String(row.suite_name),overview:String(row.suite_overview)},
      prompt,
      parent,
      children,
      verificationCommands,
      stoppedRemarks,
      dependencies,
      gate:gate??null,
      history:{remarks:[...history.remarks].reverse() as PromptRemark[],events:[...history.events].reverse() as PromptStatusEvent[]},
      clarifications,
    };
  },
  createChild(kind: "program"|"suite"|"prompt", parentId: number, input: Record<string, unknown>): unknown { return sqliteGuard(() => {
    const now = new Date().toISOString();
    if (kind === "program") { this.get(parentId); const r=db.prepare("INSERT INTO program(workspace_id,name,overview,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(parentId,requireText(input.name,"name",120),requireText(input.overview??"","overview",10000,true),nextOrder("program","workspace_id",parentId),now,now); return this.tree(parentId).programs.find(x=>x.id===Number(r.lastInsertRowid)); }
    if (kind === "suite") { const parent=db.prepare("SELECT workspace_id FROM program WHERE id=?").get(parentId) as {workspace_id:number}|undefined; if(!parent) throw new WorkspaceError(404,"not_found","Program not found"); const r=db.prepare("INSERT INTO suite(program_id,name,overview,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(parentId,requireText(input.name,"name",120),requireText(input.overview??"","overview",10000,true),nextOrder("suite","program_id",parentId),now,now); return this.tree(parent.workspace_id).programs.flatMap(x=>x.suites).find(x=>x.id===Number(r.lastInsertRowid)); }
    const parent=db.prepare("SELECT g.workspace_id FROM suite s JOIN program g ON g.id=s.program_id WHERE s.id=?").get(parentId) as {workspace_id:number}|undefined; if(!parent) throw new WorkspaceError(404,"not_found","Suite not found");
    const content=requireText(input.content,"content",64000);
    const r=db.prepare("INSERT INTO prompt(suite_id,title,content,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(parentId,requireText(input.title,"title",160),content,nextOrder("prompt","suite_id",parentId),now,now);
    const promptId=Number(r.lastInsertRowid);
    syncPromptVerifyCriteria(promptId, content);
    return this.tree(parent.workspace_id).programs.flatMap(x=>x.suites).flatMap(x=>x.prompts).find(x=>x.id===promptId);
  }); },
  updateChild(kind: "program"|"suite"|"prompt", id:number, input:Record<string,unknown>): unknown { return sqliteGuard(() => db.transaction(() => {
    const table=kind; const row=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as Record<string,unknown>|undefined; if(!row) throw new WorkspaceError(404,"not_found",`${kind} not found`); const now=new Date().toISOString();
    if(kind==="prompt") {
      const title=input.title===undefined?String(row.title):requireText(input.title,"title",160);
      const content=input.content===undefined?String(row.content):requireText(input.content,"content",64000);
      // Snapshot the outgoing text before it is overwritten, so a bad edit is
      // recoverable from the database rather than from a file backup.
      if(title!==row.title||content!==row.content){
        const actor=typeof input.actorType==="string"&&input.actorType==="SYSTEM"?"SYSTEM":"USER";
        const reason=typeof input.reason==="string"?input.reason.slice(0,500):"";
        db.prepare("INSERT INTO prompt_revision(prompt_id,title,content,actor_type,reason,created_at) VALUES(?,?,?,?,?,?)").run(id,row.title,row.content,actor,reason,now);
      }
      db.prepare("UPDATE prompt SET title=?,content=?,updated_at=? WHERE id=?").run(title,content,now,id);
      if(content!==row.content) syncPromptVerifyCriteria(id, content);
    }
    else { db.prepare(`UPDATE ${table} SET name=?,overview=?,updated_at=? WHERE id=?`).run(input.name===undefined?row.name:requireText(input.name,"name",120),input.overview===undefined?row.overview:requireText(input.overview,"overview",10000,true),now,id); }
    return db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  })()); },
  /** Newest first. The revision holds the text as it was *before* that edit. */
  promptRevisions(promptId:number):Array<Record<string,unknown>> {
    if(!db.prepare("SELECT 1 FROM prompt WHERE id=?").get(promptId))throw new WorkspaceError(404,"not_found","Prompt not found");
    return db.prepare("SELECT id,prompt_id promptId,title,content,actor_type actorType,reason,created_at createdAt FROM prompt_revision WHERE prompt_id=? ORDER BY id DESC").all(promptId) as Array<Record<string,unknown>>;
  },
  /** Restores a revision's text, recording the current text as a new revision. */
  restorePromptRevision(promptId:number,revisionId:number):unknown {
    return this.updateChild("prompt",promptId,(()=>{
      const revision=db.prepare("SELECT title,content FROM prompt_revision WHERE id=? AND prompt_id=?").get(revisionId,promptId) as {title:string;content:string}|undefined;
      if(!revision)throw new WorkspaceError(404,"not_found","Revision not found for this prompt");
      return {title:revision.title,content:revision.content,reason:`Restored revision ${revisionId}`};
    })());
  },
  removeChild(kind:"program"|"suite"|"prompt",id:number):void {
    if(db.prepare(`DELETE FROM ${kind} WHERE id=?`).run(id).changes===0) throw new WorkspaceError(404,"not_found",`${kind} not found`);
    forgetOrphanedScopedRows();
  },
  importProgram(workspaceId:number,pack:ImportedProgram):WorkspaceTree { return sqliteGuard(()=>{ importProgramTransaction(workspaceId,pack); return this.tree(workspaceId); }); },

  /* ---------------------------------------------------------------- */
  /* Agent-authored programs                                           */
  /* ---------------------------------------------------------------- */

  /** Opens a proposal. Empty until an author run, or the operator, fills it in. */
  createProgramDraft(args:{workspaceId:number;goal:string}):ProgramDraftRecord { return sqliteGuard(()=>{
    this.get(args.workspaceId);
    const goal=requireText(args.goal,"goal",DRAFT_GOAL_MAX);
    const now=new Date().toISOString();
    const id=Number(db.prepare("INSERT INTO program_draft(workspace_id,run_id,state,goal,body_json,created_at,updated_at) VALUES(?,NULL,'PENDING',?,?,?,?)")
      .run(args.workspaceId,goal,JSON.stringify(emptyProgramDraftBody()),now,now).lastInsertRowid);
    return draftRecord(draftRow(id));
  }); },

  /**
   * Points a draft at the run that is about to write it.
   *
   * One run per draft and one draft per run, enforced by a unique index: two
   * author runs filling the same proposal would each replace the other's
   * suites, and the operator would approve whichever happened to post last.
   */
  attachDraftRun(draftId:number,runId:string):ProgramDraftRecord { return sqliteGuard(()=>{
    const row=draftRow(draftId);
    if(row.state!=="PENDING")throw new WorkspaceError(409,"draft_settled",`This draft was already ${row.state.toLowerCase()}.`);
    const live=row.run_id===null?undefined:db.prepare("SELECT id FROM agent_run WHERE id=? AND state IN ('STARTING','RUNNING')").get(row.run_id) as {id:string}|undefined;
    if(live!==undefined)throw new WorkspaceError(409,"draft_busy",`An author run is already working on this draft (${live.id}). Stop it before starting another.`);
    db.prepare("UPDATE program_draft SET run_id=?,updated_at=? WHERE id=?").run(runId,new Date().toISOString(),draftId);
    return draftRecord(draftRow(draftId));
  }); },

  programDrafts(workspaceId:number):ProgramDraftRecord[] {
    this.get(workspaceId);
    return (db.prepare("SELECT * FROM program_draft WHERE workspace_id=? ORDER BY id DESC").all(workspaceId) as ProgramDraftRow[]).map(draftRecord);
  },

  programDraft(id:number):ProgramDraftRecord { return draftRecord(draftRow(id)); },

  programDraftForRun(runId:string):ProgramDraftRecord|null {
    const row=db.prepare("SELECT * FROM program_draft WHERE run_id=?").get(runId) as ProgramDraftRow|undefined;
    return row===undefined?null:draftRecord(row);
  },

  /** The operator's edit. Same bounds as the agent's post, same assigned keys. */
  saveProgramDraft(id:number,input:unknown):ProgramDraftRecord { return sqliteGuard(()=>{
    const row=draftRow(id);
    if(row.state!=="PENDING")throw new WorkspaceError(409,"draft_settled",`This draft was already ${row.state.toLowerCase()}; it can no longer be changed.`);
    const parsed=normalizeProgramDraftBody(input,{revision:row.target_program_id!==null});
    if(!parsed.ok)throw new WorkspaceError(422,"validation_error","Some changes were refused",parsed.errors);
    writeDraftBody(id,parsed.value);
    return draftRecord(draftRow(id));
  }); },

  discardProgramDraft(id:number):ProgramDraftRecord { return sqliteGuard(()=>{
    const row=draftRow(id);
    if(row.state==="APPLIED")throw new WorkspaceError(409,"draft_settled","This draft has already been applied; delete the program instead.");
    db.prepare("UPDATE program_draft SET state='DISCARDED',updated_at=? WHERE id=?").run(new Date().toISOString(),id);
    return draftRecord(draftRow(id));
  }); },

  /** Removes a draft outright. The record is the operator's, not the ledger's. */
  removeProgramDraft(id:number):void {
    if(db.prepare("DELETE FROM program_draft WHERE id=?").run(id).changes===0)throw new WorkspaceError(404,"not_found","Program draft not found");
  },

  /**
   * The operator's approval: the draft becomes a program.
   *
   * `withPipeline` also stages it — every suite in order, every work item a
   * station — because a program that cannot be run until someone assembles a
   * pipeline by hand is a list, not work. The pipeline is built after the tree
   * lands and in its own guard: if it fails, the program is still correct and
   * the caller is told which half happened.
   */
  applyProgramDraft(id:number,options:{withPipeline?:boolean}={}):{draft:ProgramDraftRecord;programId:number;prompts:number;pipelineId:number|null;pipelineError:string|null;revision:(RevisionApplySummary&{pipelineSteps:number})|null} {
    if(draftRow(id).target_program_id!==null)return this.applyProgramRevision(id,options);
    const result=sqliteGuard(()=>applyProgramDraftTransaction(id));
    const draft=draftRecord(draftRow(id));
    let pipelineId:number|null=null;
    let pipelineError:string|null=null;
    if(options.withPipeline===true){
      try{
        const suites=this.tree(draft.workspaceId).programs.find(program=>program.id===result.programId)?.suites??[];
        const pipeline=this.createPipeline({workspaceId:draft.workspaceId,name:draft.body.name.slice(0,120),description:`Created with program draft ${id}.`,suiteIds:suites.map(suite=>suite.id)});
        for(const suite of suites)for(const prompt of suite.prompts)this.addNamedPipelineStep(pipeline.id,prompt.id);
        pipelineId=pipeline.id;
      }catch(error){
        pipelineError=error instanceof Error?error.message:String(error);
      }
    }
    return {draft,programId:result.programId,prompts:result.prompts,pipelineId,pipelineError,revision:null};
  },

  /**
   * The operator's approval of a revision: the draft's changes, written into
   * the program it copies.
   *
   * `withPipeline` here means "put the new work items on the flowcharts that
   * already run their suite", appended after that suite's existing stations. A
   * new suite is not added to any pipeline — where a whole stage belongs in
   * someone's pipeline is not something to guess.
   */
  applyProgramRevision(id:number,options:{withPipeline?:boolean}={}):{draft:ProgramDraftRecord;programId:number;prompts:number;pipelineId:number|null;pipelineError:string|null;revision:RevisionApplySummary&{pipelineSteps:number}} {
    const result=sqliteGuard(()=>applyProgramRevisionTransaction(id));
    if(result.summary.removed>0)forgetOrphanedScopedRows();
    let pipelineSteps=0;
    let pipelineError:string|null=null;
    if(options.withPipeline===true){
      for(const promptId of result.summary.newPromptIds){
        try{
          const home=this.promptHome(promptId);
          const pipelines=db.prepare("SELECT pipeline_id id FROM pipeline_stage WHERE suite_id=?").all(home.suiteId) as Array<{id:number}>;
          for(const pipeline of pipelines){this.addNamedPipelineStep(pipeline.id,promptId);pipelineSteps+=1;}
        }catch(error){
          pipelineError=error instanceof Error?error.message:String(error);
        }
      }
    }
    return {
      draft:draftRecord(draftRow(id)),
      programId:result.programId,
      prompts:result.summary.added+result.summary.updated+result.summary.removed+result.summary.moved,
      pipelineId:null,
      pipelineError,
      revision:{...result.summary,pipelineSteps},
    };
  },

  /**
   * Opens a revision of an existing program: a draft that starts as an exact
   * copy of it, for an agent or the operator to change.
   */
  createProgramRevision(args:{workspaceId:number;programId:number;goal:string}):ProgramDraftRecord { return sqliteGuard(()=>{
    this.get(args.workspaceId);
    const owner=db.prepare("SELECT workspace_id FROM program WHERE id=?").get(args.programId) as {workspace_id:number}|undefined;
    if(!owner||owner.workspace_id!==args.workspaceId)throw new WorkspaceError(404,"not_found","Program not found in this workspace");
    const goal=requireText(args.goal,"goal",DRAFT_GOAL_MAX);
    const body=JSON.stringify(programRevisionBody(args.programId));
    const now=new Date().toISOString();
    const id=Number(db.prepare("INSERT INTO program_draft(workspace_id,run_id,state,goal,body_json,created_at,updated_at,target_program_id,baseline_json) VALUES(?,NULL,'PENDING',?,?,?,?,?,?)")
      .run(args.workspaceId,goal,body,now,now,args.programId,body).lastInsertRowid);
    return draftRecord(draftRow(id));
  }); },

  /** Agent door: a list of changes to a revision draft. */
  reviseProgram(runId:string,input:Record<string,unknown>):unknown { return sqliteGuard(()=>reviseProgramTransaction(runId,input)); },

  /* ---------------------------------------------------------------- */
  /* Instruction proposals                                             */
  /* ---------------------------------------------------------------- */

  instructionProposals(workspaceId:number):InstructionProposalRecord[] {
    this.get(workspaceId);
    return (db.prepare("SELECT * FROM instruction_proposal WHERE workspace_id=? ORDER BY id DESC").all(workspaceId) as InstructionProposalRow[]).map(instructionProposalRecord);
  },

  instructionProposal(id:number):InstructionProposalRecord { return instructionProposalRecord(instructionProposalRow(id)); },

  /**
   * Opens a proposal. It starts as the stored text, so a proposal nobody has
   * touched yet applies as no change at all.
   */
  createInstructionProposal(args:{workspaceId:number;field:WorkspaceInstructionField;goal:string;origin?:InstructionProposalOrigin;runId?:string|null;content?:string}):InstructionProposalRecord { return sqliteGuard(()=>{
    if(!isInstructionField(args.field))throw new WorkspaceError(422,"validation_error","Choose CLAUDE.md or AGENTS.md",{field:"Unknown file"});
    const workspace=this.get(args.workspaceId);
    const origin=args.origin??"request";
    const goal=origin==="run"?args.goal.slice(0,DRAFT_GOAL_MAX):requireText(args.goal,"goal",DRAFT_GOAL_MAX);
    const baseline=workspace[args.field];
    const content=args.content===undefined?baseline:requireText(args.content,"content",INSTRUCTION_CONTENT_MAX,true);
    const now=new Date().toISOString();
    const id=Number(db.prepare("INSERT INTO instruction_proposal(workspace_id,field,state,origin,goal,run_id,baseline,content,created_at,updated_at) VALUES(?,?,'PENDING',?,?,?,?,?,?,?)")
      .run(args.workspaceId,args.field,origin,goal,args.runId??null,baseline,content,now,now).lastInsertRowid);
    return instructionProposalRecord(instructionProposalRow(id));
  }); },

  /** The newest proposal for a file with exactly this content, in any state. */
  latestInstructionProposalWithContent(workspaceId:number,field:WorkspaceInstructionField,content:string):InstructionProposalRecord|null {
    const row=db.prepare("SELECT * FROM instruction_proposal WHERE workspace_id=? AND field=? AND content=? ORDER BY id DESC LIMIT 1").get(workspaceId,field,content) as InstructionProposalRow|undefined;
    return row===undefined?null:instructionProposalRecord(row);
  },

  /** Points a proposal at the run about to write it. One writer at a time. */
  attachInstructionProposalRun(id:number,runId:string):InstructionProposalRecord { return sqliteGuard(()=>{
    const row=instructionProposalRow(id);
    if(row.origin!=="request")throw new WorkspaceError(409,"proposal_from_run","This proposal was found in the working tree. Edit it by hand, or ask for a new change.");
    requireIdleProposal(row);
    db.prepare("UPDATE instruction_proposal SET run_id=?,updated_at=? WHERE id=?").run(runId,new Date().toISOString(),id);
    return instructionProposalRecord(instructionProposalRow(id));
  }); },

  /**
   * What a run left in the file, stored as the proposal's content.
   *
   * Not `saveInstructionProposal`: this is called as the run ends, while its
   * row may still read RUNNING, so the busy check would refuse the run's own
   * result.
   */
  recordInstructionRunResult(id:number,content:string):InstructionProposalRecord|null { return sqliteGuard(()=>{
    const row=instructionProposalRow(id);
    if(row.state!=="PENDING")return null;
    const text=content.trim().slice(0,INSTRUCTION_CONTENT_MAX);
    db.prepare("UPDATE instruction_proposal SET content=?,updated_at=? WHERE id=?").run(text,new Date().toISOString(),id);
    return instructionProposalRecord(instructionProposalRow(id));
  }); },

  /** The operator's edit. */
  saveInstructionProposal(id:number,input:Record<string,unknown>):InstructionProposalRecord { return sqliteGuard(()=>{
    const row=instructionProposalRow(id);
    requireIdleProposal(row);
    const content=requireText(input.content,"content",INSTRUCTION_CONTENT_MAX,true);
    db.prepare("UPDATE instruction_proposal SET content=?,updated_at=? WHERE id=?").run(content,new Date().toISOString(),id);
    return instructionProposalRecord(instructionProposalRow(id));
  }); },

  discardInstructionProposal(id:number):InstructionProposalRecord { return sqliteGuard(()=>{
    const row=instructionProposalRow(id);
    if(row.state==="APPLIED")throw new WorkspaceError(409,"proposal_settled","This proposal has already been applied. Restore an earlier version of the file instead.");
    db.prepare("UPDATE instruction_proposal SET state='DISCARDED',updated_at=? WHERE id=?").run(new Date().toISOString(),id);
    return instructionProposalRecord(instructionProposalRow(id));
  }); },

  removeInstructionProposal(id:number):void {
    if(db.prepare("DELETE FROM instruction_proposal WHERE id=?").run(id).changes===0)throw new WorkspaceError(404,"not_found","Proposal not found");
  },

  /**
   * The operator's approval: the proposed text becomes the stored file.
   *
   * Refuses when the stored text is no longer the proposal's baseline, unless
   * `force` — applying over an edit made since would revert it without anyone
   * having seen that edit in the diff. The replaced text is kept as a workspace
   * revision either way, so an apply can be undone.
   */
  applyInstructionProposal(id:number,options:{force?:boolean}={}):{proposal:InstructionProposalRecord;workspace:WorkspaceRecord} { return sqliteGuard(()=>db.transaction(()=>{
    const row=instructionProposalRow(id);
    requireIdleProposal(row);
    const current=this.get(row.workspace_id);
    const name=INSTRUCTION_FILE_NAMES[row.field];
    if(row.content.trim()===""&&current[row.field]!==""){
      throw new WorkspaceError(422,"proposal_empty",`This proposal would empty ${name}. Discard it instead, or clear the file in its editor.`);
    }
    if(current[row.field]!==row.baseline&&options.force!==true){
      throw new WorkspaceError(409,"instructions_changed",`${name} has changed since this proposal was opened. The diff is against the old text, so applying would undo that change.`);
    }
    const workspace=this.update(row.workspace_id,{[row.field]:row.content,actorType:row.origin==="run"?"AGENT":"USER",reason:`Applied proposal ${id}${row.goal===""?"":`: ${row.goal}`}`});
    db.prepare("UPDATE instruction_proposal SET state='APPLIED',updated_at=? WHERE id=?").run(new Date().toISOString(),id);
    return {proposal:instructionProposalRecord(instructionProposalRow(id)),workspace};
  })()); },

  /**
   * Everything an agent needs to reason about a whole program: its items in
   * order with status, dependencies, gates and definition of done, and the
   * pipelines that would run it.
   */
  programBrief(programId:number):ProgramBrief {
    const program=db.prepare("SELECT g.id,g.external_key key,g.name,g.overview,w.id workspaceId FROM program g JOIN workspace w ON w.id=g.workspace_id WHERE g.id=?").get(programId) as {id:number;key:string|null;name:string;overview:string;workspaceId:number}|undefined;
    if(!program)throw new WorkspaceError(404,"not_found","Program not found");
    const workspace=this.get(program.workspaceId);
    const suites=db.prepare("SELECT id,external_key key,name,overview FROM suite WHERE program_id=? ORDER BY sort_order,id").all(programId) as Array<{id:number;key:string|null;name:string;overview:string}>;
    const itemsFor=db.prepare("SELECT p.id,p.external_key key,p.title,p.status,p.content,parent.external_key parentKey,parent.title parentTitle,(SELECT COUNT(*) FROM agent_run r WHERE r.prompt_id=p.id AND r.role='execute') runs FROM prompt p LEFT JOIN prompt parent ON parent.id=p.parent_prompt_id WHERE p.suite_id=? ORDER BY p.sort_order,p.id");
    const depsFor=db.prepare("SELECT d.external_key key,d.title,d.status,CASE WHEN g.id=? THEN NULL ELSE g.name END programName FROM prompt_dependency e JOIN prompt d ON d.id=e.depends_on_prompt_id JOIN suite s ON s.id=d.suite_id JOIN program g ON g.id=s.program_id WHERE e.prompt_id=? ORDER BY d.external_key,d.title");
    const gateFor=db.prepare("SELECT code,name,description FROM program_gate WHERE prompt_id=?");
    const programSuiteIds=new Set(suites.map(suite=>suite.id));
    return {
      workspace:{id:workspace.id,name:workspace.name,workDirectory:workspace.workDirectory,description:workspace.description},
      program:{id:program.id,key:program.key,name:program.name,overview:program.overview},
      suites:suites.map(suite=>({
        ...suite,
        items:(itemsFor.all(suite.id) as Array<{id:number;key:string|null;title:string;status:StepStatus;content:string;parentKey:string|null;parentTitle:string|null;runs:number}>).map((item):ProgramBriefItem=>({
          id:item.id,key:item.key,title:item.title,status:item.status,content:item.content,
          parentKey:item.parentKey??item.parentTitle,
          dependsOn:depsFor.all(programId,item.id) as ProgramBriefItem["dependsOn"],
          gate:(gateFor.get(item.id) as ProgramBriefItem["gate"]|undefined)??null,
          criteria:resolveDefinitionOfDone(item.id).criteria.map(criterion=>({kind:criterion.kind,text:criterion.kind==="COMMAND"?(criterion.command??criterion.text):criterion.text,required:criterion.required})),
          runs:item.runs,
        })),
      })),
      pipelines:this.listPipelines(program.workspaceId)
        .filter(pipeline=>pipeline.stages.some(stage=>programSuiteIds.has(stage.suiteId)))
        .map(pipeline=>({
          id:pipeline.id,
          name:pipeline.name,
          active:pipeline.active?.state??null,
          stages:pipeline.stages.map(stage=>{
            const label=`${stage.suiteKey===null?"":`${stage.suiteKey} — `}${stage.suiteName}`;
            if(!programSuiteIds.has(stage.suiteId))return {suiteId:stage.suiteId,label:`${label} (${stage.programName})`,steps:null};
            const titles=new Map((itemsFor.all(stage.suiteId) as Array<{id:number;key:string|null;title:string}>).map(item=>[item.id,item]));
            return {
              suiteId:stage.suiteId,label,
              steps:this.enabledNamedPipelineSteps(pipeline.id,stage.suiteId).map(step=>({
                key:titles.get(step.promptId)?.key??null,title:titles.get(step.promptId)?.title??`#${step.promptId}`,
                provider:step.provider,model:step.model,onDone:step.onDone,onUnfinished:step.onUnfinished,
              })),
            };
          }),
        })),
      maxContinuations:settings.pipelinePolicy.maxContinuations,
    };
  },

  /** Agent door: the program and its suites. */
  proposeProgram(runId:string,input:Record<string,unknown>):unknown { return sqliteGuard(()=>proposeProgramTransaction(runId,input)); },
  /** Agent door: one suite's work items. */
  proposeSuite(runId:string,input:Record<string,unknown>):unknown { return sqliteGuard(()=>proposeSuiteTransaction(runId,input)); },

  beginAuthorRun(args:{runId:string;workspaceId:number;provider:string;model:string|null;tokenHash:string;expiresAt:string;displayText:string}):void { sqliteGuard(()=>{
    if(!db.prepare("SELECT 1 FROM workspace WHERE id=?").get(args.workspaceId))throw new WorkspaceError(404,"not_found","Workspace not found");
    const now=new Date().toISOString();
    db.prepare("INSERT INTO agent_run(id,workspace_id,prompt_id,provider,model,state,started_at,context_token_hash,token_expires_at,role,display_text) VALUES(?,?,NULL,?,?,'STARTING',?,?,?,'author',?)")
      .run(args.runId,args.workspaceId,args.provider,args.model,now,args.tokenHash,args.expiresAt,clipDisplayText(args.displayText));
  }); },
  beginAgentRun(args:{runId:string;workspaceId:number;promptId:number;provider:string;model:string|null;tokenHash:string;expiresAt:string;role?:RunRole}):void { sqliteGuard(()=>beginRunTransaction(args)); },
  beginConsultRun(args:{runId:string;workspaceId:number;promptId:number|null;provider:string;model:string|null;tokenHash:string;expiresAt:string;displayText?:string|null}):void { sqliteGuard(()=>beginConsultTransaction(args)); },
  beginCustomExecuteRun(args:{runId:string;workspaceId:number;provider:string;model:string|null;tokenHash:string;expiresAt:string;displayText:string}):void { sqliteGuard(()=>beginCustomExecuteTransaction(args)); },
  beginHandoffAgentRun(args:{runId:string;workspaceId:number;promptId:number;provider:string;model:string|null;tokenHash:string;expiresAt:string}):void { sqliteGuard(()=>{
    const now=new Date().toISOString();
    db.prepare("INSERT INTO agent_run(id,workspace_id,prompt_id,provider,model,state,started_at,context_token_hash,token_expires_at,role) VALUES(?,?,?,?,?,'STARTING',?,?,?,'handoff')")
      .run(args.runId,args.workspaceId,args.promptId,args.provider,args.model,now,args.tokenHash,args.expiresAt);
  }); },
  markAgentRunRunning(runId:string):void { db.prepare("UPDATE agent_run SET state='RUNNING' WHERE id=? AND state='STARTING'").run(runId); },
  /**
   * Opens the short run that speaks for a run the budget stopped.
   *
   * Deliberately *not* `beginAgentRun`: that one refuses a second active run on
   * the same prompt (right, for two agents racing on one working tree) and moves
   * TODO → IN_PROGRESS (wrong here — the item never left IN_PROGRESS, because
   * the source run's status transition was deferred for exactly this). The
   * wrap-up is the same work item, the same tree and the same session; it is the
   * tail of the run before it, not a new attempt at the work.
   */
  beginWrapUpRun(args:{runId:string;workspaceId:number;promptId:number;provider:string;model:string|null;tokenHash:string;expiresAt:string;sourceRunId:string;sessionId:string|null}):void { sqliteGuard(()=>{
    const now=new Date().toISOString();
    db.prepare("INSERT INTO agent_run(id,workspace_id,prompt_id,provider,model,state,started_at,context_token_hash,token_expires_at,role,wrapup_of,session_id) VALUES(?,?,?,?,?,'STARTING',?,?,?,'execute',?,?)")
      .run(args.runId,args.workspaceId,args.promptId,args.provider,args.model,now,args.tokenHash,args.expiresAt,args.sourceRunId,args.sessionId);
  }); },
  /** The provider session a run had, for a wrap-up turn to resume. */
  runSessionId(runId:string):string|null { const row=db.prepare("SELECT session_id sessionId FROM agent_run WHERE id=?").get(runId) as {sessionId:string|null}|undefined;return row?.sessionId??null; },
  /** The run a wrap-up turn is speaking for, or null for an ordinary run. */
  wrapupSourceRunId(runId:string):string|null { const row=db.prepare("SELECT wrapup_of wrapupOf FROM agent_run WHERE id=?").get(runId) as {wrapupOf:string|null}|undefined;return row?.wrapupOf??null; },
  /**
   * The cause recorded by the newest status change on a work item.
   *
   * Read by the scheduler to tell one TODO from another: a decompose and a
   * continuation both land on TODO, and they need opposite things done about
   * them (hand off to the first child, versus re-run this same station). The
   * status alone cannot say which, and inferring it from the shape of the item
   * is how the two got confused in the first place.
   */
  latestStatusTrigger(promptId:number):string|null {
    // `trigger_id IS NOT NULL` because not every ledger row is a status change
    // with a recorded cause: `agentDecomposeTransaction` files a second,
    // causeless row for the sub-step count, and it is newer than the transition
    // it annotates. Reading the newest row outright would report "no cause" for
    // the one case this function exists to tell apart.
    const row=db.prepare("SELECT trigger_id triggerId FROM prompt_status_event WHERE prompt_id=? AND trigger_id IS NOT NULL ORDER BY id DESC LIMIT 1").get(promptId) as {triggerId:string|null}|undefined;
    return row?.triggerId??null;
  },
  /**
   * Unfinished continuations since the most recent operator (USER) ledger row.
   *
   * An operator Resume / override / recover grants a fresh allowance: that is
   * what a human intervening means. Counted by `rule_id = "continuation"` rows
   * only — an agent's own `agent-step continue` uses a different rule id and
   * does not spend this allowance.
   */
  continuationCount(promptId:number):number {
    const since=(db.prepare("SELECT COALESCE(MAX(id),0) id FROM prompt_status_event WHERE prompt_id=? AND actor_type='USER'").get(promptId) as {id:number}).id;
    const row=db.prepare("SELECT count(*) count FROM prompt_status_event WHERE prompt_id=? AND rule_id='continuation' AND id>?").get(promptId,since) as {count:number};
    return row.count;
  },
  /**
   * Operator Resume after the rail parked on this station: write a USER ledger
   * row so `continuationCount` resets, and ensure the item is TODO so Play can
   * start it. Idempotent when already TODO — the USER row is the point.
   */
  grantFreshContinuations(promptId:number,reason:string):void {
    sqliteGuard(()=>db.transaction(()=>{
      const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as {status:PromptRecord["status"]}|undefined;
      if(!prompt)throw new WorkspaceError(404,"not_found","Prompt not found");
      if(prompt.status==="DONE"||prompt.status==="SKIPPED"){
        throw new WorkspaceError(409,"already_terminal","Work item is already complete");
      }
      if(prompt.status==="IN_PROGRESS"){
        const run=db.prepare("SELECT id FROM agent_run WHERE prompt_id=? AND role='execute' AND state IN ('STARTING','RUNNING') ORDER BY started_at DESC LIMIT 1").get(promptId) as {id:string}|undefined;
        if(run&&activeRuns.has(run.id))throw new WorkspaceError(409,"run_active","The agent process is still active");
      }
      writeStatus({
        promptId,
        to:"TODO",
        trigger:"operator_resume",
        ruleId:"operator-resume",
        actor:"USER",
        reason,
        result:"",
        evidence:{grant:"fresh_continuations"},
      });
    })());
  },
  /** Latest continuation evidence for the station card's "n/N" chip. */
  latestContinuation(promptId:number):{attempt:number;of:number}|null {
    const row=db.prepare("SELECT evidence_json evidenceJson FROM prompt_status_event WHERE prompt_id=? AND rule_id='continuation' ORDER BY id DESC LIMIT 1").get(promptId) as {evidenceJson:string|null}|undefined;
    if(row===undefined||row.evidenceJson===null||row.evidenceJson==="") return null;
    try{
      const evidence=JSON.parse(row.evidenceJson) as {attempt?:unknown;of?:unknown};
      if(typeof evidence.attempt!=="number"||typeof evidence.of!=="number") return null;
      return {attempt:evidence.attempt,of:evidence.of};
    }catch{return null;}
  },
  /** Newest CONTINUATION remark on the item, when the agent (or a prior SYSTEM brief) left one. */
  latestContinuationRemark(promptId:number):string|null {
    const row=db.prepare("SELECT content FROM prompt_remark WHERE prompt_id=? AND kind='CONTINUATION' ORDER BY id DESC LIMIT 1").get(promptId) as {content:string}|undefined;
    return row?.content??null;
  },
  /** Whether this run already filed a CONTINUATION remark (so the scheduler must not invent another). */
  runHasContinuationRemark(promptId:number,runId:string):boolean {
    return db.prepare("SELECT 1 FROM prompt_remark WHERE prompt_id=? AND run_id=? AND kind='CONTINUATION' LIMIT 1").get(promptId,runId)!==undefined;
  },
  /**
   * Re-queue a station for another run on the same working tree.
   *
   * When `countsTowardAllowance` is true (default), writes
   * `rule_id=continuation` so `continuationCount` can bound unfinished loops.
   * An agent's own `continue` passes false — those re-queues must not park the
   * rail. Only invents a SYSTEM CONTINUATION remark when the agent left none.
   */
  queueContinuation(promptId:number,args:{
    attempt:number;
    of:number;
    cause:string;
    previousRunId:string;
    writeSystemRemark:boolean;
    /** Default true. False for agent_continue — does not spend the unfinished allowance. */
    countsTowardAllowance?:boolean;
  }):void {
    sqliteGuard(()=>db.transaction(()=>{
      const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as {status:PromptRecord["status"]}|undefined;
      if(!prompt)throw new WorkspaceError(404,"not_found","Prompt not found");
      if(prompt.status==="DONE"||prompt.status==="SKIPPED")throw new WorkspaceError(409,"already_terminal","Work item is already complete");
      const counts=args.countsTowardAllowance!==false;
      const reason=(counts
        ?`Continuation ${args.attempt}/${args.of}: ${args.cause}`
        :`Agent continue: ${args.cause}`).slice(0,2000);
      writeStatus({
        promptId,
        to:"TODO",
        trigger:"continuation",
        ruleId:counts?"continuation":"agent-continue-loop",
        actor:"SYSTEM",
        runId:args.previousRunId,
        reason,
        result:"",
        evidence:{
          attempt:args.attempt,
          of:args.of,
          cause:args.cause,
          previousRunId:args.previousRunId,
          countsTowardAllowance:counts,
        },
        remark:args.writeSystemRemark
          ?{kind:"CONTINUATION",content:`${args.cause}\n\nInspect the working tree before changing anything; do not redo verified work.`}
          :null,
      });
    })());
  },
  /**
   * Re-queue the station on a different provider after a transient failure.
   * Does not consume a continuation — the ledger row is `provider_fallback`.
   */
  queueProviderFallback(promptId:number,args:{from:ProviderId;to:ProviderId;failure:string|null;because:string;previousRunId:string|null}):void {
    sqliteGuard(()=>db.transaction(()=>{
      const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as {status:PromptRecord["status"]}|undefined;
      if(!prompt)throw new WorkspaceError(404,"not_found","Prompt not found");
      if(prompt.status==="DONE"||prompt.status==="SKIPPED")throw new WorkspaceError(409,"already_terminal","Work item is already complete");
      writeStatus({
        promptId,
        to:"TODO",
        trigger:"provider_fallback",
        ruleId:"provider-fallback",
        actor:"SYSTEM",
        runId:args.previousRunId,
        reason:`Provider fallback ${args.from} → ${args.to}: ${args.because}`.slice(0,2000),
        result:"",
        evidence:{from:args.from,to:args.to,failure:args.failure,because:args.because},
      });
    })());
  },
  /**
   * Error text + tool-call count for classifyFailure. Prefers the last fatal
   * error event; falls back to the run's stop_reason / result.
   */
  runFailureFacts(runId:string):{errorText:string;toolCalls:number;provider:ProviderId;startFailed:boolean} {
    const run=db.prepare("SELECT provider,tool_calls toolCalls,stop_reason stopReason,state FROM agent_run WHERE id=?").get(runId) as {provider:string;toolCalls:number|null;stopReason:string|null;state:string}|undefined;
    if(!run||!isProviderId(run.provider)) throw new WorkspaceError(404,"not_found","Run not found");
    const rows=db.prepare("SELECT event_json FROM agent_run_event WHERE run_id=? ORDER BY id DESC").all(runId) as Array<{event_json:string}>;
    let errorText="";
    for(const row of rows){
      try{
        const event=JSON.parse(row.event_json) as {type?:string;payload?:{message?:string;fatal?:boolean}};
        if(event.type==="error"&&typeof event.payload?.message==="string"&&event.payload.message.trim()!==""){
          errorText=event.payload.message;
          break;
        }
      }catch{/* ignore malformed */ }
    }
    if(errorText===""&&run.stopReason) errorText=run.stopReason;
    return {
      errorText,
      toolCalls:run.toolCalls??0,
      provider:run.provider,
      startFailed:false,
    };
  },
  /**
   * The last few things an agent banked on this item, newest last.
   *
   * The brief a fresh-session wrap-up is handed when its provider could not
   * resume: PROGRESS and VERIFICATION only, because those are the kinds that
   * record what was actually established rather than what was being attempted.
   */
  recentProgressRemarks(promptId:number,limit=5):Array<{kind:string;content:string;createdAt:string}> {
    const rows=db.prepare("SELECT kind,content,created_at createdAt FROM prompt_remark WHERE prompt_id=? AND kind IN ('PROGRESS','VERIFICATION') ORDER BY id DESC LIMIT ?").all(promptId,limit) as Array<{kind:string;content:string;createdAt:string}>;
    return rows.reverse();
  },
  /**
   * Records how a run ended, and — unless a wrap-up turn is about to follow —
   * what that means for the work item.
   *
   * `deferStatus` is the whole trap of the wrap-up turn in one option. The
   * status transition below fires the instant the source run's process ends,
   * which would move the item out of IN_PROGRESS and make the wrap-up's own
   * `done`/`continue` post fail with `invalid_transition` — the run given a turn
   * to speak would be refused the moment it spoke. With `deferStatus` the run
   * row is closed (state, ended_at, metrics, stop reason) and the item is left
   * IN_PROGRESS for the wrap-up run to post against; the wrap-up's own end then
   * applies the transition, attributing the *source* run's stop reason.
   */
  finishAgentRun(runId:string,state:string,answer="",metrics?:RunCostMetrics,options?:{deferStatus?:boolean}):void { sqliteGuard(()=>db.transaction(()=>{
    const run=db.prepare("SELECT prompt_id,role,wrapup_of wrapupOf FROM agent_run WHERE id=?").get(runId) as {prompt_id:number|null;role:RunRole;wrapupOf:string|null}|undefined;if(!run)return;
    const now=new Date().toISOString();
    db.prepare("UPDATE agent_run SET state=?,ended_at=?,input_tokens=?,output_tokens=?,cached_input_tokens=?,tool_calls=?,tool_output_bytes=?,stop_reason=?,session_id=COALESCE(?,session_id) WHERE id=?")
      .run(state.toUpperCase(),now,metrics?.usage?.inputTokens??null,metrics?.usage?.outputTokens??null,metrics?.usage?.cachedInputTokens??null,metrics?.toolCalls??null,metrics?.toolOutputBytes??null,metrics?.stopReason??null,metrics?.sessionId??null,runId);
    if(run.role!=="execute"||run.prompt_id===null)return;
    if(answer.trim()!=="")db.prepare("INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,?,'AGENT_RESPONSE',?,'AGENT',?)").run(run.prompt_id,runId,answer.trim().slice(0,20000),now);
    if(options?.deferStatus===true)return;
    applyEndOfRunStatus(runId,run.prompt_id,run.wrapupOf,state,metrics?.stopReason??null,metrics?.toolCalls??null);
  })()); },
  /**
   * Applies the transition a `deferStatus: true` finish held back, for the one
   * case that needs it: the wrap-up run could not be started at all, so nothing
   * is coming and the item must land exactly where it would have without this
   * feature. Idempotent by construction — `endOfRunSignal` returns null unless
   * the item is still IN_PROGRESS.
   */
  applyDeferredRunEnd(runId:string):void { sqliteGuard(()=>db.transaction(()=>{
    const run=db.prepare("SELECT prompt_id,role,wrapup_of wrapupOf,state,stop_reason stopReason,tool_calls toolCalls FROM agent_run WHERE id=?").get(runId) as {prompt_id:number|null;role:RunRole;wrapupOf:string|null;state:string;stopReason:string|null;toolCalls:number|null}|undefined;
    if(!run||run.role!=="execute"||run.prompt_id===null)return;
    applyEndOfRunStatus(runId,run.prompt_id,run.wrapupOf,run.state.toLowerCase(),run.stopReason,run.toolCalls);
  })()); },
  authorizeAgentRun(runId:string,tokenHash:string):{workspaceId:number;promptId:number|null;state:string;role:RunRole} { const row=db.prepare("SELECT workspace_id workspaceId,prompt_id promptId,state,role FROM agent_run WHERE id=? AND context_token_hash=? AND token_expires_at>?").get(runId,tokenHash,new Date().toISOString()) as {workspaceId:number;promptId:number|null;state:string;role:RunRole}|undefined;if(!row)throw new WorkspaceError(401,"invalid_run_token","Run credential is invalid or expired");return row; },
  addAgentRemark(runId:string,input:Record<string,unknown>):unknown { return sqliteGuard(()=>agentRemarkTransaction(runId,input)); },
  updateAgentStatus(runId:string,input:Record<string,unknown>):unknown { return sqliteGuard(()=>agentStatusTransaction(runId,input)); },
  repairAgentVerifyCommand(runId:string,input:Record<string,unknown>):Record<string,unknown> { return sqliteGuard(()=>agentVerifyRepairTransaction(runId,input)) as Record<string,unknown>; },
  decomposePrompt(runId:string,input:Record<string,unknown>):unknown { return sqliteGuard(()=>agentDecomposeTransaction(runId,input)); },
  /**
   * Newest first, unbounded — the UI wants the whole record.
   *
   * `remarkLimit` bounds it for the callers that pay per character: an
   * agent's context and a handoff dossier. Without it the most-retried work
   * items get the biggest prompts, so failure makes the next attempt more
   * expensive and more distracting than the first.
   */
  promptHistory(promptId:number,remarkLimit?:number):{events:unknown[];remarks:unknown[];runs:unknown[]} {
    const exists=db.prepare("SELECT 1 FROM prompt WHERE id=?").get(promptId);if(!exists)throw new WorkspaceError(404,"not_found","Prompt not found");
    const remarks=remarkLimit===undefined
      ?db.prepare("SELECT id,prompt_id promptId,run_id runId,kind,content,actor_type actorType,created_at createdAt FROM prompt_remark WHERE prompt_id=? ORDER BY id DESC").all(promptId)
      :db.prepare("SELECT id,prompt_id promptId,run_id runId,kind,content,actor_type actorType,created_at createdAt FROM prompt_remark WHERE prompt_id=? ORDER BY id DESC LIMIT ?").all(promptId,remarkLimit);
    return{events:statusEvents(promptId),remarks,runs:db.prepare("SELECT id,provider,model,role,state,started_at startedAt,ended_at endedAt FROM agent_run WHERE prompt_id=? ORDER BY started_at DESC").all(promptId)};
  },
  humanInputRequests():HumanInputRequest[] {
    const rows=db.prepare(`SELECT p.id promptId,g.workspace_id workspaceId FROM prompt p JOIN suite s ON s.id=p.suite_id JOIN program g ON g.id=s.program_id WHERE p.status='BLOCKED' OR EXISTS(SELECT 1 FROM prompt_remark r WHERE r.prompt_id=p.id AND r.kind='HUMAN_RESPONSE') ORDER BY p.updated_at DESC`).all() as Array<{promptId:number;workspaceId:number}>;
    return rows.map(({promptId,workspaceId})=>{const prompt=this.resolvePrompt(workspaceId,promptId);const workspace=this.get(workspaceId);const history=this.promptHistory(promptId);const remarks=history.remarks as PromptRemark[];return{prompt,workspace:{id:workspace.id,name:workspace.name,workDirectory:workspace.workDirectory,workDirectoryExists:workspace.workDirectoryExists},latestBlocker:remarks.find(item=>item.kind==="BLOCKER")??null,remarks,events:history.events as PromptStatusEvent[],clarifications:this.clarifications(promptId),currentRun:this.latestRunActivity(promptId)};});
  },
  /**
   * Newest transcript events for one run, capped so a single detail view cannot
   * pull tens of thousands of rows into the heap. Older events beyond the cap
   * stay in the database for retention sweeps; the live WebSocket replay uses
   * the same bound.
   */
  runEvents(runId:string,limit=MAX_SESSION_EVENTS):NormalizedEvent[] {
    const rows=db.prepare(
      "SELECT event_json FROM agent_run_event WHERE run_id=? ORDER BY id DESC LIMIT ?",
    ).all(runId,Math.max(0,limit)) as Array<{event_json:string}>;
    return rows.reverse().map((row)=>JSON.parse(row.event_json) as NormalizedEvent);
  },
  latestRunActivity(promptId:number):AgentRunActivity|null {
    const run=db.prepare("SELECT id,provider,model,role,state,started_at startedAt,ended_at endedAt FROM agent_run WHERE prompt_id=? ORDER BY started_at DESC LIMIT 1").get(promptId) as Omit<AgentRunActivity,"events">|undefined;
    if(!run)return null;
    return{...run,events:this.runEvents(run.id)};
  },
  /**
   * Session index for the Activity page. Deliberately omits transcripts —
   * shipping every `agent_run_event` row on a 30s poll OOMs the Node heap once
   * the database holds more than a few dozen long runs. Fetch one session's
   * events with `sessionById` when the operator opens it.
   */
  sessions():AgentSession[] {
    const rows=db.prepare(`${SESSION_SELECT} ORDER BY r.started_at DESC`).all() as SessionQueryRow[];
    return rows.map((run)=>hydrateSession(run, []));
  },
  /** One session with a capped transcript, for the Activity detail pane. */
  sessionById(runId:string):AgentSession|null {
    const run=db.prepare(`${SESSION_SELECT} WHERE r.id=?`).get(runId) as SessionQueryRow|undefined;
    if(run===undefined)return null;
    return hydrateSession(run, this.runEvents(run.id));
  },
  /** Sessions for one work item, each with a capped transcript. */
  sessionsForPrompt(promptId:number):AgentSession[] {
    const rows=db.prepare(`${SESSION_SELECT} WHERE r.prompt_id=? ORDER BY r.started_at DESC`).all(promptId) as SessionQueryRow[];
    return rows.map((run)=>hydrateSession(run, this.runEvents(run.id)));
  },
  /**
   * Token + estimated-cost rollup for the report page. Pulls usage from run
   * events without shipping full transcripts to the client.
   */
  usageReport(workspaceId?:number):UsageReport {
    if(workspaceId!==undefined)this.get(workspaceId);
    const rows=db.prepare(`SELECT r.id,r.workspace_id workspaceId,w.name workspaceName,r.prompt_id promptId,p.external_key promptKey,p.title savedTitle,r.display_text displayText,s.id suiteId,COALESCE(s.name,'') suiteName,g.id programId,COALESCE(g.name,'') programName,r.provider,r.model,r.role,r.state,r.started_at startedAt,r.ended_at endedAt,r.input_tokens inputTokens,r.output_tokens outputTokens,r.cached_input_tokens cachedInputTokens FROM agent_run r JOIN workspace w ON w.id=r.workspace_id LEFT JOIN prompt p ON p.id=r.prompt_id LEFT JOIN suite s ON s.id=p.suite_id LEFT JOIN program g ON g.id=s.program_id WHERE (? IS NULL OR r.workspace_id=?) ORDER BY r.started_at DESC`).all(workspaceId??null,workspaceId??null) as Array<{id:string;workspaceId:number;workspaceName:string;promptId:number|null;promptKey:string|null;savedTitle:string|null;displayText:string|null;suiteId:number|null;suiteName:string;programId:number|null;programName:string;provider:string;model:string|null;role:string;state:string;startedAt:string;endedAt:string|null;inputTokens:number|null;outputTokens:number|null;cachedInputTokens:number|null}>;
    const eventsStmt=db.prepare("SELECT event_json FROM agent_run_event WHERE run_id=? ORDER BY id");
    const sessions:SessionUsageRow[]=rows.map(row=>{
      // Runs finished since usage was persisted answer from their own columns;
      // older ones still get it rebuilt from the transcript.
      const usage=row.inputTokens===null
        ?usageFromEvents((eventsStmt.all(row.id) as Array<{event_json:string}>).map(entry=>JSON.parse(entry.event_json) as NormalizedEvent))
        :{inputTokens:row.inputTokens,outputTokens:row.outputTokens??0,cachedInputTokens:row.cachedInputTokens??0,reasoningOutputTokens:0,totalTokens:row.inputTokens+(row.outputTokens??0)};
      const cost=estimateCost(usage,row.provider,row.model);
      return{id:row.id,workspaceId:row.workspaceId,workspaceName:row.workspaceName,promptId:row.promptId,promptKey:row.promptKey,promptTitle:sessionPromptTitle(row.savedTitle,row.displayText,row.role),suiteId:row.suiteId,suiteName:row.suiteName,programId:row.programId,programName:row.programName,provider:row.provider,model:row.model,role:isRunRole(row.role)?row.role:"execute",state:row.state,startedAt:row.startedAt,endedAt:row.endedAt,usage,cost};
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
    const humanIntervention=db.prepare(`
      SELECT e.id,e.verification_summary requiredAction,e.created_at requestedAt,
        (SELECT r.content FROM prompt_remark r WHERE r.prompt_id=e.prompt_id AND r.kind='HUMAN_RESPONSE' AND r.created_at>=e.created_at ORDER BY r.id LIMIT 1) response,
        (SELECT r.created_at FROM prompt_remark r WHERE r.prompt_id=e.prompt_id AND r.kind='HUMAN_RESPONSE' AND r.created_at>=e.created_at ORDER BY r.id LIMIT 1) completedAt
      FROM prompt_status_event e
      WHERE e.prompt_id=? AND e.new_status='BLOCKED' AND e.actor_type='AGENT' AND e.verification_summary<>''
      ORDER BY e.id DESC LIMIT 1
    `);
    const latestAudit=db.prepare("SELECT * FROM completion_audit WHERE prompt_id=? ORDER BY created_at DESC LIMIT 1");
    const sessionCount=db.prepare("SELECT count(*) count FROM agent_run WHERE prompt_id=?");
    const sessionsBySuite=db.prepare("SELECT r.id,r.workspace_id workspaceId,r.prompt_id promptId,p.external_key promptKey,p.title promptTitle,r.provider,r.model,r.role,r.state,r.started_at startedAt,r.ended_at endedAt FROM agent_run r JOIN prompt p ON p.id=r.prompt_id WHERE p.suite_id=? ORDER BY r.started_at DESC");
    const latestVerification=db.prepare("SELECT id,kind,state,verdict,started_at startedAt,ended_at endedAt FROM suite_verification WHERE suite_id=? ORDER BY started_at DESC,id DESC LIMIT 1");
    const suiteDefaults=db.prepare("SELECT default_provider defaultProvider,default_model defaultModel,default_fallback_providers defaultFallbackProviders FROM suite WHERE id=?");
    const activePipeline=db.prepare("SELECT * FROM suite_pipeline_run WHERE suite_id=? AND state IN ('PLAYING','WAITING_HUMAN','PAUSED') ORDER BY started_at DESC LIMIT 1");
    const latestPipeline=db.prepare("SELECT * FROM suite_pipeline_run WHERE suite_id=? ORDER BY started_at DESC LIMIT 1");
    const suites:OperationsSuite[]=[];
    for(const workspace of workspaceRows){const options=new Map(this.promptOptions(workspace.id).map(item=>[item.id,item]));for(const program of this.tree(workspace.id).programs)for(const suite of program.suites){const counts=Object.fromEntries(OPERATIONAL_STATES.map(state=>[state,0])) as Record<PromptOperationalState,number>;const allPrompts:OperationsPrompt[]=suite.prompts.map(record=>{const prompt=options.get(record.id)!;const state=operationalState(prompt);counts[state]++;const latest=(intervention.get(prompt.id) as {content:string}|undefined)?.content??null;const human=(humanIntervention.get(prompt.id) as {id:number;requiredAction:string;requestedAt:string;response:string|null;completedAt:string|null}|undefined);const auditRow=latestAudit.get(prompt.id) as Record<string,unknown>|undefined;const count=(sessionCount.get(prompt.id) as {count:number}).count;const lastActivityAt=prompt.currentRun?.endedAt??prompt.currentRun?.startedAt??record.updatedAt;return{prompt,workspace:{id:workspace.id,name:workspace.name,workDirectory:workspace.workDirectory,workDirectoryExists:workspace.workDirectoryExists},programKey:program.externalKey,suiteKey:suite.externalKey,operationalState:state,attention:statusDefinition(this.statusCatalog(),state).needsAttention,latestIntervention:latest,humanIntervention:human?{id:`human-${human.id}`,promptId:prompt.id,requiredAction:human.requiredAction,status:human.completedAt===null?"PENDING":"COMPLETE",requestedAt:human.requestedAt,response:human.response,completedAt:human.completedAt}:null,lastActivityAt,sessionCount:count,latestAudit:auditRow?completionAuditDto(auditRow):null,continuation:this.latestContinuation(prompt.id),pipelineRule:defaultPromptPipelineRule(prompt.id,settings.pipelinePolicy),children:[],childAttention:null,childAttentionCount:0};});
      // Sub-steps are real OperationsPrompt items, but they nest under the
      // parent's `children` rather than appearing as flowchart entries.
      const byId=new Map(allPrompts.map(item=>[item.prompt.id,item]));
      const prompts:OperationsPrompt[]=[];
      for(const item of allPrompts){
        const parentId=item.prompt.parentPromptId;
        if(parentId===null){prompts.push(item);continue;}
        byId.get(parentId)?.children.push(item);
      }
      for(const item of prompts) item.children.sort((a,b)=>a.prompt.childOrder-b.prompt.childOrder);
      // The worst outcome underneath each item, rolled up from the leaves.
      //
      // Derived, not stored, and deliberately kept off the parent's own status:
      // after a decompose, a fresh run resumes the *parent* for final
      // integration once its sub-steps are done, and it posts its own outcome.
      // Writing a status onto the parent from its children would pre-empt that
      // and would assert something about the parent's work that nothing had
      // established. This says "there is trouble underneath" and nothing more.
      const catalog=this.statusCatalog();
      const rollUp=(item:OperationsPrompt):void=>{
        for(const child of item.children) rollUp(child);
        const states:PromptOperationalState[]=[];
        for(const child of item.children){
          states.push(child.operationalState);
          if(child.childAttention!==null) states.push(child.childAttention);
        }
        item.childAttention=rollupStatus(catalog,states);
        if(item.childAttention===null) return;
        const worst=item.childAttention;
        const countIn=(node:OperationsPrompt):number=>node.children.reduce(
          (total,child)=>total+(child.operationalState===worst?1:0)+countIn(child),0);
        item.childAttentionCount=countIn(item);
      };
      for(const item of prompts) rollUp(item);
      const sessions=sessionsBySuite.all(suite.id) as OperationsSession[];const defaultsRow=suiteDefaults.get(suite.id) as {defaultProvider:string|null;defaultModel:string|null;defaultFallbackProviders?:string|null};suites.push({id:suite.id,key:suite.externalKey,name:suite.name,programId:program.id,programKey:program.externalKey,programName:program.name,workspaceId:workspace.id,workspaceName:workspace.name,counts,attentionCount:allPrompts.filter(item=>item.attention).length,prompts,sessions,latestVerification:(latestVerification.get(suite.id) as SuiteVerificationBadge|undefined)??null,pipeline:{defaults:{suiteId:suite.id,defaultProvider:asProviderId(defaultsRow.defaultProvider),defaultModel:defaultsRow.defaultModel,defaultFallbackProviders:parseFallbackProvidersJson(defaultsRow.defaultFallbackProviders)},active:(()=>{const row=activePipeline.get(suite.id) as PipelineRunRow|undefined;return row?pipelineRunDto(row):null;})(),latest:(()=>{const row=latestPipeline.get(suite.id) as PipelineRunRow|undefined;return row?pipelineRunDto(row):null;})()}});}}
    return{generatedAt:new Date().toISOString(),suites,policy:settings.pipelinePolicy,statusCatalog:resolvedStatusCatalog(),triggerSentences:resolvedTriggerSentences()};
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
    const prompts=this.operations(row.workspaceId).suites.find(suite=>suite.id===row.suiteId)?.prompts??[];
    const item=findOperationsPrompt(prompts,promptId);if(!item)throw new WorkspaceError(404,"not_found","Prompt not found");
    const history=this.promptHistory(promptId);return{item,remarks:history.remarks as PromptRemark[],events:history.events as PromptStatusEvent[],clarifications:this.clarifications(promptId),sessions:this.sessionsForPrompt(promptId),audits:this.completionAuditsForPrompt(promptId),producedWork:this.promptProducedWork(promptId)};
  },
  /**
   * The per-second "running" heartbeat is a live-UI signal, not a record: it
   * accounted for 79k rows and 24 MB here while telling the transcript nothing
   * a reader or a replay needs. It still reaches clients over the socket; only
   * the persisted copy is dropped. Terminal status events are kept, so usage
   * stays recoverable from the transcript for runs that predate the columns on
   * `agent_run`.
   */
  recordAgentEvent(runId:string,event:NormalizedEvent):void {
    if(event.type==="status"&&event.payload.state==="running")return;
    db.prepare("INSERT INTO agent_run_event(run_id,event_json,created_at) VALUES(?,?,?)").run(runId,JSON.stringify(event),event.timestamp);
  },
  /**
   * Per-run event counts for retention. Only `agent_run_event` is ever swept —
   * the run row itself is the record and stays.
   */
  runEventRetentionStats(): Array<{ runId: string; endedAt: string | null; eventCount: number }> {
    return db.prepare(`
      SELECT r.id AS runId, r.ended_at AS endedAt, COUNT(e.id) AS eventCount
      FROM agent_run r
      JOIN agent_run_event e ON e.run_id = r.id
      GROUP BY r.id
      HAVING eventCount > 0
    `).all() as Array<{ runId: string; endedAt: string | null; eventCount: number }>;
  },
  /** Event ids for a run, oldest first. Retention deletes from the front. */
  runEventIdsOldestFirst(runId: string): number[] {
    return (db.prepare("SELECT id FROM agent_run_event WHERE run_id=? ORDER BY id ASC").all(runId) as Array<{ id: number }>)
      .map((row) => row.id);
  },
  /**
   * Delete by primary key, in small batches the caller sizes. Not wrapped in a
   * long transaction — a sweep that holds one across tens of thousands of rows
   * is how a restart mid-prune used to leave the WAL fat and the lock held.
   */
  deleteAgentRunEventsByIds(ids: number[]): number {
    if (ids.length === 0) return 0;
    const stmt = db.prepare("DELETE FROM agent_run_event WHERE id=?");
    let deleted = 0;
    for (const id of ids) deleted += stmt.run(id).changes;
    return deleted;
  },
  /** `PRAGMA incremental_vacuum` when auto_vacuum is incremental; else null. */
  tryIncrementalVacuum(): { autoVacuum: string; ran: boolean } {
    const autoVacuum = String(db.pragma("auto_vacuum", { simple: true }));
    // 0=none, 1=full, 2=incremental — better-sqlite3 may return the number or name.
    const incremental = autoVacuum === "2" || autoVacuum.toLowerCase() === "incremental";
    if (incremental) {
      db.pragma("incremental_vacuum");
      return { autoVacuum: "incremental", ran: true };
    }
    return { autoVacuum: autoVacuum === "1" || autoVacuum.toLowerCase() === "full" ? "full" : "none", ran: false };
  },
  databaseByteSize(): number {
    try { return statSync(databasePath).size; } catch { return 0; }
  },
  clarifications(promptId:number):ClarificationExchange[] { return db.prepare("SELECT id,prompt_id promptId,question,answer,provider,model,state,created_at createdAt,answered_at answeredAt FROM clarification_exchange WHERE prompt_id=? ORDER BY id").all(promptId) as ClarificationExchange[]; },
  beginClarification(promptId:number,questionValue:unknown,provider:string,model:string|null):number { const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as {status:string}|undefined;if(!prompt)throw new WorkspaceError(404,"not_found","Prompt not found");if(prompt.status!=="BLOCKED")throw new WorkspaceError(409,"prompt_not_blocked","Clarification is only available while a prompt is blocked");const question=requireText(questionValue,"question",10000);return Number(db.prepare("INSERT INTO clarification_exchange(prompt_id,question,provider,model,state,created_at) VALUES(?,?,?,?, 'RUNNING',?)").run(promptId,question,provider,model,new Date().toISOString()).lastInsertRowid); },
  finishClarification(id:number,state:"DONE"|"INTERRUPTED"|"ERROR",answer:string|null):void { db.prepare("UPDATE clarification_exchange SET state=?,answer=?,answered_at=? WHERE id=?").run(state,answer?.trim()||null,new Date().toISOString(),id); },
  respondToBlockedPrompt(promptId:number,input:Record<string,unknown>):PromptRemark { return sqliteGuard(()=>db.transaction(()=>{
    const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as {status:PromptRecord["status"]}|undefined;
    if(!prompt)throw new WorkspaceError(404,"not_found","Prompt not found");
    if(prompt.status!=="BLOCKED")throw new WorkspaceError(409,"prompt_not_blocked","Prompt no longer needs human input");
    const content=requireText(input.content,"content",20000);const now=new Date().toISOString();
    const remarkId=Number(db.prepare("INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,NULL,'HUMAN_RESPONSE',?,'USER',?)").run(promptId,content,now).lastInsertRowid);
    writeStatus({promptId,to:"TODO",trigger:"operator_override",actor:"USER",reason:"You answered the question, so it is ready to resume.",result:""});
    return{id:remarkId,promptId,runId:null,kind:"HUMAN_RESPONSE",content,actorType:"USER",createdAt:now} satisfies PromptRemark;
  })()); },
  recoveryRunId(promptId:number):string { const run=db.prepare("SELECT id FROM agent_run WHERE prompt_id=? AND role='execute' ORDER BY started_at DESC LIMIT 1").get(promptId) as {id:string}|undefined;if(!run)throw new WorkspaceError(409,"nothing_to_recover","This prompt has no prior developer run to recover");return run.id; },
  latestExecuteRunId(promptId:number):string { const run=db.prepare("SELECT id FROM agent_run WHERE prompt_id=? AND role='execute' ORDER BY started_at DESC LIMIT 1").get(promptId) as {id:string}|undefined;if(!run)throw new WorkspaceError(409,"nothing_to_handoff","This work item has no prior developer run");return run.id; },
  runSummary(runId:string):{id:string;workspaceId:number;promptId:number|null;provider:ProviderId;model:string|null;state:string} { const run=db.prepare("SELECT id,workspace_id workspaceId,prompt_id promptId,provider,model,state FROM agent_run WHERE id=?").get(runId) as {id:string;workspaceId:number;promptId:number|null;provider:ProviderId;model:string|null;state:string}|undefined;if(!run)throw new WorkspaceError(404,"not_found","Run not found");return run; },
  runProducedWork(runId:string):boolean {
    const rows=db.prepare("SELECT event_json FROM agent_run_event WHERE run_id=?").all(runId) as Array<{event_json:string}>;
    return rows.some(row=>{
      const event=JSON.parse(row.event_json) as NormalizedEvent;
      return event.type==="tool_use"||event.type==="tool_result";
    });
  },
  /** Whether the latest developer run on this prompt made any tool call. */
  promptProducedWork(promptId:number):boolean {
    let runId:string;
    try { runId=this.latestExecuteRunId(promptId); } catch { return false; }
    return this.runProducedWork(runId);
  },
  recoverPrompt(promptId:number,expectedRunId:string):void { sqliteGuard(()=>db.transaction(()=>{
    const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as {status:PromptRecord["status"]}|undefined;
    if(!prompt)throw new WorkspaceError(404,"not_found","Prompt not found");
    const run=db.prepare("SELECT id,state FROM agent_run WHERE prompt_id=? AND role='execute' ORDER BY started_at DESC LIMIT 1").get(promptId) as {id:string;state:string}|undefined;
    if(!run||run.id!==expectedRunId)throw new WorkspaceError(409,"run_changed","A newer run exists; refresh before recovering");
    if(activeRuns.has(run.id))throw new WorkspaceError(409,"run_active","The agent process is still active; stop it before recovering");
    const abandoned=prompt.status==="IN_PROGRESS"&&(run.state==="STARTING"||run.state==="RUNNING");
    const systemInterrupted=endedWithoutAgentStatus(prompt.status);
    if(!abandoned&&!systemInterrupted)throw new WorkspaceError(409,"not_recoverable","This prompt is not an abandoned or system-interrupted run");
    const now=new Date().toISOString();
    if(run.state==="STARTING"||run.state==="RUNNING")db.prepare("UPDATE agent_run SET state='INTERRUPTED',ended_at=? WHERE id=?").run(now,run.id);
    writeStatus({promptId,to:"TODO",trigger:"operator_recover",actor:"USER",runId:run.id,reason:"You recovered a run that had stopped.",result:""});
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

  /** Null for a top-level prompt; the id it was decomposed from otherwise. */
  parentPromptId(promptId:number):number|null {
    const row=db.prepare("SELECT parent_prompt_id parentPromptId FROM prompt WHERE id=?").get(promptId) as {parentPromptId:number|null}|undefined;
    return row?.parentPromptId ?? null;
  },

  /** Sub-steps of `promptId`, in run order. Empty for an ordinary prompt. */
  childrenOf(promptId:number):Array<{id:number;status:PromptRecord["status"]}> {
    return db.prepare("SELECT id,status FROM prompt WHERE parent_prompt_id=? ORDER BY child_order,id").all(promptId) as Array<{id:number;status:PromptRecord["status"]}>;
  },

  /**
   * The next depth-first sub-step of `promptId` that still needs to run.
   * A TODO child may itself be waiting on children after decomposing, so walk
   * to its first open leaf instead of trying to resume it prematurely.
   */
  nextOpenChild(promptId:number):{id:number}|null {
    const next=db.prepare("SELECT id FROM prompt WHERE parent_prompt_id=? AND status NOT IN ('DONE','SKIPPED') ORDER BY child_order,id LIMIT 1");
    let row=next.get(promptId) as {id:number}|undefined;
    if(row===undefined)return null;
    while(true){const nested=next.get(row.id) as {id:number}|undefined;if(nested===undefined)return row;row=nested;}
  },

  /** How many decompose levels deep `promptId` already sits. 0 for a top-level prompt. */
  decomposeDepth(promptId:number):number {
    let depth=0; let current=this.parentPromptId(promptId);
    while(current!==null){ depth++; current=this.parentPromptId(current); }
    return depth;
  },

  suitePromptCount(suiteId:number):number {
    this.suiteHeader(suiteId);
    return (db.prepare("SELECT count(*) count FROM prompt WHERE suite_id=?").get(suiteId) as {count:number}).count;
  },

  suitePipelineDefaults(suiteId:number):SuitePipelineDefaults {
    this.suiteHeader(suiteId);
    const row=db.prepare("SELECT default_provider defaultProvider,default_model defaultModel,default_fallback_providers defaultFallbackProviders FROM suite WHERE id=?").get(suiteId) as {defaultProvider:string|null;defaultModel:string|null;defaultFallbackProviders?:string|null};
    return {
      suiteId,
      defaultProvider:asProviderId(row.defaultProvider),
      defaultModel:row.defaultModel,
      defaultFallbackProviders:parseFallbackProvidersJson(row.defaultFallbackProviders),
    };
  },

  updateSuitePipelineDefaults(suiteId:number,input:Record<string,unknown>):SuitePipelineDefaults {
    this.suiteHeader(suiteId);
    const current=this.suitePipelineDefaults(suiteId);
    const defaultProvider="defaultProvider" in input ? optionalProviderField(input.defaultProvider,"defaultProvider") : current.defaultProvider;
    const defaultModel="defaultModel" in input ? optionalModelField(input.defaultModel,"defaultModel") : current.defaultModel;
    const defaultFallbackProviders="defaultFallbackProviders" in input
      ? validateFallbackProviders(input.defaultFallbackProviders,defaultProvider,"defaultFallbackProviders")
      : current.defaultFallbackProviders;
    db.prepare("UPDATE suite SET default_provider=?,default_model=?,default_fallback_providers=?,updated_at=? WHERE id=?")
      .run(defaultProvider,defaultModel,JSON.stringify(defaultFallbackProviders),new Date().toISOString(),suiteId);
    return this.suitePipelineDefaults(suiteId);
  },

  pipelineRule(promptId:number,pipelineId?:number):PromptPipelineRule {
    this.promptHome(promptId);
    // A sub-step is never a flowchart entry. By default it runs under whatever
    // policy its parent station carries; a named pipeline may pin its own agent
    // on one without disturbing the station.
    const parentId=this.parentPromptId(promptId);
    if(parentId!==null){
      const inherited={...this.pipelineRule(parentId,pipelineId),promptId};
      if(pipelineId===undefined) return inherited;
      // A named pipeline may pin a different agent on one sub-step. The row is
      // seeded from the parent, so it is complete on its own; deleting it drops
      // the sub-step back to inheriting.
      const override=db.prepare("SELECT * FROM pipeline_step WHERE pipeline_id=? AND prompt_id=?").get(pipelineId,promptId) as PipelineStepRow|undefined;
      if(override===undefined) return inherited;
      return {...pipelineStepDto(promptId,override),onDone:inherited.onDone,enabled:inherited.enabled,stepOrder:inherited.stepOrder};
    }
    if(pipelineId!==undefined){
      const row=db.prepare("SELECT * FROM pipeline_step WHERE pipeline_id=? AND prompt_id=?").get(pipelineId,promptId) as PipelineStepRow|undefined;
      if(row!==undefined) return pipelineStepDto(promptId,row);
      return {...defaultPromptPipelineRule(promptId, settings.pipelinePolicy),enabled:false};
    }
    // Suite-level prompt_pipeline_rule is gone; without a named pipeline the
    // operations board shows settings defaults (Play is named-only).
    return defaultPromptPipelineRule(promptId, settings.pipelinePolicy);
  },

  assertPipelineSuite(pipelineId:number,suiteId:number):void {
    this.getPipeline(pipelineId);
    const row=db.prepare("SELECT 1 FROM pipeline_stage WHERE pipeline_id=? AND suite_id=?").get(pipelineId,suiteId);
    if(!row) throw new WorkspaceError(404,"not_found","Suite is not a stage of this pipeline");
  },

  enabledNamedPipelineSteps(pipelineId:number,suiteId:number):PromptPipelineRule[] {
    this.assertPipelineSuite(pipelineId,suiteId);
    const rows=db.prepare(`SELECT ps.* FROM pipeline_step ps JOIN prompt p ON p.id=ps.prompt_id WHERE ps.pipeline_id=? AND p.suite_id=? AND p.parent_prompt_id IS NULL ORDER BY ps.step_order,p.sort_order,p.id`).all(pipelineId,suiteId) as PipelineStepRow[];
    return rows.map(row=>pipelineStepDto(row.prompt_id,row));
  },

  upsertNamedPipelineRule(pipelineId:number,promptId:number,input:Record<string,unknown>):PromptPipelineRule {
    const home=this.promptHome(promptId);
    this.assertPipelineSuite(pipelineId,home.suiteId);
    const current=this.pipelineRule(promptId,pipelineId);
    const next:PromptPipelineRule={
      promptId,
      provider:"provider" in input ? optionalProviderField(input.provider,"provider") : current.provider,
      model:"model" in input ? optionalModelField(input.model,"model") : current.model,
      fallbackProviders:current.fallbackProviders,
      onDone:current.onDone,
      onUnfinished:current.onUnfinished,
      enabled:true,
      stepOrder:current.stepOrder,
    };
    if("onDone" in input){
      if(!isOnDoneAction(input.onDone)) throw new WorkspaceError(422,"validation_error","onDone must be continue, stop, or skip_rest",{onDone:"Unknown action"});
      next.onDone=input.onDone;
    }
    if("onUnfinished" in input){
      if(!isOnUnfinishedAction(input.onUnfinished)) throw new WorkspaceError(422,"validation_error","onUnfinished must be continue, skip, or wait",{onUnfinished:"Unknown action"});
      next.onUnfinished=input.onUnfinished;
    }
    if("fallbackProviders" in input){
      next.fallbackProviders=validateFallbackProviders(input.fallbackProviders,next.provider);
    }
    if("stepOrder" in input){
      const value=input.stepOrder;
      if(typeof value!=="number"||!Number.isInteger(value)||value<0) throw new WorkspaceError(422,"validation_error","stepOrder must be a non-negative integer",{stepOrder:"Must be >= 0"});
      next.stepOrder=value;
    }
    const now=new Date().toISOString();
    db.prepare(`INSERT INTO pipeline_step(pipeline_id,prompt_id,provider,model,on_done,on_unfinished,fallback_providers,step_order,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(pipeline_id,prompt_id) DO UPDATE SET
        provider=excluded.provider, model=excluded.model, on_done=excluded.on_done,
        on_unfinished=excluded.on_unfinished, fallback_providers=excluded.fallback_providers,
        step_order=excluded.step_order, updated_at=excluded.updated_at`)
      .run(pipelineId,promptId,next.provider,next.model,next.onDone,next.onUnfinished,JSON.stringify(next.fallbackProviders),next.stepOrder,now);
    return this.pipelineRule(promptId,pipelineId);
  },

  addNamedPipelineStep(pipelineId:number,promptId:number,input:Record<string,unknown>={}):PromptPipelineRule {
    const home=this.promptHome(promptId);
    this.assertPipelineSuite(pipelineId,home.suiteId);
    if(this.parentPromptId(promptId)!==null) throw new WorkspaceError(422,"validation_error","Sub-steps run inside their station and cannot be added to the flowchart");
    const current=this.pipelineRule(promptId,pipelineId);
    if(current.enabled) return this.upsertNamedPipelineRule(pipelineId,promptId,input);
    const max=(db.prepare(`SELECT COALESCE(MAX(ps.step_order), -1) AS value FROM pipeline_step ps JOIN prompt p ON p.id=ps.prompt_id WHERE ps.pipeline_id=? AND p.suite_id=? AND p.parent_prompt_id IS NULL`).get(pipelineId,home.suiteId) as {value:number}).value;
    const provider="provider" in input ? optionalProviderField(input.provider,"provider") : current.provider;
    const model="model" in input ? optionalModelField(input.model,"model") : current.model;
    return this.upsertNamedPipelineRule(pipelineId,promptId,{...input,provider,model,stepOrder:max+1});
  },

  removeNamedPipelineStep(pipelineId:number,promptId:number):void {
    const home=this.promptHome(promptId);
    this.assertPipelineSuite(pipelineId,home.suiteId);
    db.prepare("DELETE FROM pipeline_step WHERE pipeline_id=? AND prompt_id=?").run(pipelineId,promptId);
  },

  reorderNamedPipelineSteps(pipelineId:number,suiteId:number,promptIds:number[]):PromptPipelineRule[] {
    this.assertPipelineSuite(pipelineId,suiteId);
    const current=this.enabledNamedPipelineSteps(pipelineId,suiteId);
    if(promptIds.length!==current.length || new Set(promptIds).size!==promptIds.length){
      throw new WorkspaceError(422,"validation_error","promptIds must list every enabled step once");
    }
    const allowed=new Set(current.map(step=>step.promptId));
    for(const promptId of promptIds){
      if(!allowed.has(promptId)) throw new WorkspaceError(422,"validation_error","promptIds must be the enabled steps of this pipeline stage");
    }
    sqliteGuard(()=>db.transaction(()=>{
      promptIds.forEach((promptId,index)=>{
        db.prepare("UPDATE pipeline_step SET step_order=?,updated_at=? WHERE pipeline_id=? AND prompt_id=?").run(index,new Date().toISOString(),pipelineId,promptId);
      });
    })());
    return this.enabledNamedPipelineSteps(pipelineId,suiteId);
  },

  /**
   * Every sub-step under this stage's stations, depth-first, with the rule the
   * scheduler would use for it and whether that rule is inherited or pinned.
   */
  namedPipelineSubStepRules(pipelineId:number,suiteId:number):PipelineSubStepRule[] {
    this.assertPipelineSuite(pipelineId,suiteId);
    const rows=db.prepare("SELECT id,parent_prompt_id parentPromptId FROM prompt WHERE suite_id=? AND parent_prompt_id IS NOT NULL ORDER BY child_order,id").all(suiteId) as Array<{id:number;parentPromptId:number}>;
    if(rows.length===0) return [];
    const byParent=new Map<number,Array<{id:number;parentPromptId:number}>>();
    for(const row of rows){
      const list=byParent.get(row.parentPromptId);
      if(list===undefined) byParent.set(row.parentPromptId,[row]); else list.push(row);
    }
    const overrides=db.prepare("SELECT prompt_id promptId FROM pipeline_step WHERE pipeline_id=?").all(pipelineId) as Array<{promptId:number}>;
    const pinned=new Set(overrides.map(row=>row.promptId));
    const out:PipelineSubStepRule[]=[];
    const walk=(parentId:number,depth:number):void=>{
      for(const row of byParent.get(parentId)??[]){
        out.push({promptId:row.id,parentPromptId:parentId,depth,inherited:!pinned.has(row.id),rule:this.pipelineRule(row.id,pipelineId)});
        walk(row.id,depth+1);
      }
    };
    for(const station of db.prepare("SELECT id FROM prompt WHERE suite_id=? AND parent_prompt_id IS NULL ORDER BY sort_order,id").all(suiteId) as Array<{id:number}>){
      walk(station.id,1);
    }
    return out;
  },

  namedPipelineFlowchart(pipelineId:number,suiteId:number,options:{incompleteOnly?:boolean}={}):PipelineFlowchartView {
    this.assertPipelineSuite(pipelineId,suiteId);
    const defaults=this.suitePipelineDefaults(suiteId);
    const prompts=db.prepare("SELECT id,title,external_key externalKey,status FROM prompt WHERE suite_id=? AND parent_prompt_id IS NULL ORDER BY sort_order,id").all(suiteId) as Array<{id:number;title:string;externalKey:string|null;status:PromptRecord["status"]}>;
    const steps=this.enabledNamedPipelineSteps(pipelineId,suiteId);
    const enabled=new Set(steps.map(step=>step.promptId));
    let available:PipelineAvailablePrompt[]=prompts.filter(row=>!enabled.has(row.id)).map(row=>({id:row.id,title:row.title,externalKey:row.externalKey,status:row.status}));
    if(options.incompleteOnly===true){
      available=available.filter(row=>row.status!=="DONE"&&row.status!=="SKIPPED");
    }
    const rules=prompts.map(row=>{
      const rule=this.pipelineRule(row.id,pipelineId);
      return rule.enabled?rule:{...rule,enabled:false};
    });
    return {pipelineId,suiteId,defaults,steps,available,rules,subSteps:this.namedPipelineSubStepRules(pipelineId,suiteId),active:this.activePipeline(suiteId),latest:this.latestPipeline(suiteId)};
  },

  pipelineDashboard(workspaceId:number):PipelineDashboard {
    this.get(workspaceId);
    const operations=this.operations(workspaceId);
    const pipelines=this.listPipelines(workspaceId);
    const sevenDaysAgo=new Date(Date.now()-7*24*60*60*1000).toISOString();
    const thirtyDaysAgo=new Date(Date.now()-30*24*60*60*1000).toISOString();
    let totalSteps=0;
    let completedSteps=0;
    let attentionCount=0;
    const blockedStations:PipelineBlockedStation[]=[];
    const items:PipelineDashboardItem[]=pipelines.map(pipeline=>{
      let pTotal=0;
      let pCompleted=0;
      let pAttention=0;
      for(const stage of pipeline.stages){
        const ops=operations.suites.find(suite=>suite.id===stage.suiteId);
        const stepIds=this.enabledNamedPipelineSteps(pipeline.id,stage.suiteId).map(step=>step.promptId);
        pTotal+=stepIds.length;
        for(const promptId of stepIds){
          const prompt=ops?.prompts.find(item=>item.prompt.id===promptId);
          if(prompt!==undefined&&isTerminalDisplayStatus(this.statusCatalog(),prompt.operationalState)) pCompleted++;
          if(prompt?.attention===true){
            pAttention++;
            blockedStations.push({
              pipelineId:pipeline.id,
              pipelineName:pipeline.name,
              suiteId:stage.suiteId,
              suiteName:stage.suiteName,
              promptId,
              promptKey:prompt.prompt.externalKey,
              promptTitle:prompt.prompt.title,
              operationalState:prompt.operationalState,
              latestIntervention:prompt.latestIntervention,
            });
          }
        }
      }
      totalSteps+=pTotal;
      completedSteps+=pCompleted;
      attentionCount+=pAttention;
      const lastRun=pipeline.latest;
      const lastRunDurationMs=lastRun?.endedAt===null||lastRun?.endedAt===undefined
        ?null
        :new Date(lastRun.endedAt).getTime()-new Date(lastRun.startedAt).getTime();
      return {pipeline,completedSteps:pCompleted,totalSteps:pTotal,attentionCount:pAttention,lastRunDurationMs};
    });
    blockedStations.sort((a,b)=>a.pipelineName.localeCompare(b.pipelineName)||a.suiteName.localeCompare(b.suiteName)||a.promptTitle.localeCompare(b.promptTitle));
    const throughputBuckets=new Map<string,{complete:number;stopped:number}>();
    for(let offset=29;offset>=0;offset--){
      const day=new Date();
      day.setUTCDate(day.getUTCDate()-offset);
      throughputBuckets.set(day.toISOString().slice(0,10),{complete:0,stopped:0});
    }
    const runRows=db.prepare("SELECT started_at startedAt,state FROM pipeline_run WHERE workspace_id=? AND started_at>=?").all(workspaceId,thirtyDaysAgo) as Array<{startedAt:string;state:string}>;
    for(const row of runRows){
      const key=row.startedAt.slice(0,10);
      const bucket=throughputBuckets.get(key);
      if(bucket===undefined) continue;
      if(row.state==="COMPLETE") bucket.complete++;
      else if(row.state==="STOPPED"||row.state==="INTERRUPTED") bucket.stopped++;
    }
    const throughput:PipelineThroughputDay[]=[...throughputBuckets.entries()].map(([date,counts])=>({
      date,
      complete:counts.complete,
      stopped:counts.stopped,
      total:counts.complete+counts.stopped,
    }));
    const runsLast7Days=(db.prepare("SELECT count(*) count FROM pipeline_run WHERE workspace_id=? AND started_at>=? AND state IN ('COMPLETE','STOPPED')").get(workspaceId,sevenDaysAgo) as {count:number}).count;
    const avgRow=db.prepare("SELECT AVG((julianday(ended_at)-julianday(started_at))*86400000) avgMs FROM pipeline_run WHERE workspace_id=? AND ended_at IS NOT NULL").get(workspaceId) as {avgMs:number|null};
    return {
      generatedAt:new Date().toISOString(),
      summary:{
        pipelineCount:pipelines.length,
        activePipelineCount:pipelines.filter(pipeline=>pipeline.active!==null).length,
        totalSteps,
        completedSteps,
        pendingSteps:totalSteps-completedSteps,
        attentionCount,
        runsLast7Days,
        avgRunDurationMs:avgRow.avgMs,
      },
      pipelines:items,
      blockedStations,
      throughput,
    };
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
      db.prepare("INSERT INTO suite_pipeline_run(id,suite_id,workspace_id,state,current_prompt_id,current_run_id,play_provider,play_model,started_at,pipeline_run_id) VALUES(?,?,?,'PLAYING',NULL,NULL,?,?,?,?)")
        .run(args.id,args.suiteId,args.workspaceId,args.playProvider,args.playModel,now,args.pipelineRunId??null);
      return this.pipelineById(args.id)!;
    });
  },

  updatePipelineRun(id:string,patch:{
    state?:PipelineState;
    currentPromptId?:number|null;
    currentRunId?:string|null;
    playProvider?:ProviderId|null;
    playModel?:string|null;
    endedAt?:string|null;
    stopReason?:string|null;
    waitReason?:string|null;
  }):SuitePipelineRun {
    const current=this.pipelineById(id);
    if(!current)throw new WorkspaceError(404,"not_found","Pipeline run not found");
    const next={
      state:patch.state??current.state,
      currentPromptId:patch.currentPromptId===undefined?current.currentPromptId:patch.currentPromptId,
      currentRunId:patch.currentRunId===undefined?current.currentRunId:patch.currentRunId,
      playProvider:patch.playProvider===undefined?current.playProvider:patch.playProvider,
      playModel:patch.playModel===undefined?current.playModel:patch.playModel,
      endedAt:patch.endedAt===undefined?current.endedAt:patch.endedAt,
      stopReason:patch.stopReason===undefined?current.stopReason:patch.stopReason,
      waitReason:patch.waitReason===undefined?current.waitReason:patch.waitReason,
    };
    db.prepare("UPDATE suite_pipeline_run SET state=?,current_prompt_id=?,current_run_id=?,play_provider=?,play_model=?,ended_at=?,stop_reason=?,wait_reason=? WHERE id=?")
      .run(next.state,next.currentPromptId,next.currentRunId,next.playProvider,next.playModel,next.endedAt,next.stopReason,next.waitReason,id);
    return this.pipelineById(id)!;
  },

  enabledPipelineSteps(suiteId:number,pipelineId?:number):PromptPipelineRule[] {
    if(pipelineId===undefined) return [];
    return this.enabledNamedPipelineSteps(pipelineId,suiteId);
  },

  readyPromptsInSuite(workspaceId:number,suiteId:number,pipelineId?:number):PromptOption[] {
    const options=new Map(this.promptOptions(workspaceId).map(prompt=>[prompt.id,prompt]));
    const next:PromptOption[]=[];
    for(const step of this.enabledPipelineSteps(suiteId,pipelineId)){
      const prompt=options.get(step.promptId);
      if(prompt===undefined) continue;
      if(prompt.status==="DONE"||prompt.status==="SKIPPED") continue;
      if(prompt.ready){ next.push(prompt); continue; }
      break;
    }
    return next;
  },

  remainingPipelinePromptIds(suiteId:number,pipelineId?:number):number[] {
    return this.enabledPipelineSteps(suiteId,pipelineId).map(step=>step.promptId);
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
      writeStatus({promptId,to:"SKIPPED",trigger:"operator_skip",actor,reason});
      db.prepare("INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,NULL,?,?,?,?)").run(promptId,actor==="USER"?"HUMAN_RESPONSE":"PROGRESS",reason,actor,now);
    })());
  },

  /**
   * The operator's override for work that is finished but whose status never
   * landed: a run interrupted between doing the work and reporting it, or a
   * final Progress call rejected because the run was no longer active.
   *
   * It writes the same evidence the agent's own DONE path demands, against the
   * same run, so the suite audit reads it as a real completion — and still
   * warns when that run ended badly — rather than a station marked done with
   * nothing behind it. Skipping is not a substitute: SKIPPED records that the
   * work was *not* done, and an explicit dependency on a skipped prerequisite
   * goes on blocking, because `blockedBy` clears only on DONE.
   */
  completePrompt(promptId:number,actor:"SYSTEM"|"USER",input:{reason?:unknown;verificationSummary:unknown}):StepStatus {
    return sqliteGuard(()=>db.transaction(()=>{
      const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as {status:PromptRecord["status"]}|undefined;
      if(!prompt)throw new WorkspaceError(404,"not_found","Prompt not found");
      if(prompt.status==="DONE")throw new WorkspaceError(409,"already_complete","Work item is already complete");
      if(prompt.status==="SKIPPED")throw new WorkspaceError(409,"invalid_transition","Skipped work items cannot be completed; reset it to TODO first");
      if(prompt.status==="IN_PROGRESS"){
        const active=db.prepare("SELECT id FROM agent_run WHERE prompt_id=? AND role='execute' AND state IN ('STARTING','RUNNING') ORDER BY started_at DESC LIMIT 1").get(promptId) as {id:string}|undefined;
        if(active&&activeRuns.has(active.id))throw new WorkspaceError(409,"prompt_run_active","Stop the running agent before completing this work item");
      }
      const verification=requireText(input.verificationSummary,"verificationSummary",20000);
      const reason=requireText(input.reason??"","reason",10000,true)||"Operator marked this work item complete.";
      // Attributed to the run that did the work, so the audit's run-state join
      // keeps reporting how that run ended instead of losing the provenance.
      const runId=(db.prepare("SELECT id FROM agent_run WHERE prompt_id=? AND role='execute' ORDER BY started_at DESC LIMIT 1").get(promptId) as {id:string}|undefined)?.id??null;
      const now=new Date().toISOString();
      // SYSTEM here is a reviewer closing a station on its verdict; USER is the
      // operator overriding. The trigger keeps those apart, which is what lets
      // the UI say "closed by review" rather than implying the agent finished.
      // The operator is allowed past the definition-of-done gate and a reviewer
      // is not. The gate exists to stop the *pipeline* concluding something it
      // has not established; the person who owns the work saying "I have looked,
      // this is done" is the one authority it was never meant to override. It
      // is recorded either way — see the evidence written in `writeStatus`.
      return writeStatus({promptId,to:"DONE",trigger:actor==="USER"?"operator_override":"review_complete",ruleId:actor==="USER"?null:"review-complete",actor,runId,reason,verificationSummary:verification,result:verification,remark:{kind:"COMPLETION",content:verification},overrideDefinitionOfDone:actor==="USER"}).to;
    })());
  },

  /**
   * Flag a work item for human attention without claiming an outcome for it.
   *
   * Distinct from parking the run: the run's state says where the *rail* is,
   * this says the *item* was left unsettled, and an operator scanning the
   * attention list needs the second even when no pipeline is sitting on it.
   */
  markPromptNeedsReview(promptId:number,reason:string):void { sqliteGuard(()=>db.transaction(()=>{
    const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as {status:PromptRecord["status"]}|undefined;
    if(!prompt)throw new WorkspaceError(404,"not_found","Prompt not found");
    if(prompt.status==="DONE"||prompt.status==="SKIPPED")throw new WorkspaceError(409,"already_terminal","Work item is already complete");
    writeStatus({promptId,to:"NEEDS_REVIEW",trigger:"review_not_complete",ruleId:"review-not-complete",actor:"SYSTEM",reason});
  })()); },

  resetPromptToTodo(promptId:number,reason:string):void {
    sqliteGuard(()=>db.transaction(()=>{
      const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as {status:PromptRecord["status"]}|undefined;
      if(!prompt)throw new WorkspaceError(404,"not_found","Prompt not found");
      if(prompt.status==="IN_PROGRESS"){
        const run=db.prepare("SELECT id FROM agent_run WHERE prompt_id=? AND role='execute' AND state IN ('STARTING','RUNNING') ORDER BY started_at DESC LIMIT 1").get(promptId) as {id:string}|undefined;
        if(run&&activeRuns.has(run.id))throw new WorkspaceError(409,"run_active","The agent process is still active");
      }else if(!UNFINISHED_STATUSES.has(prompt.status)){
        // Widened past BLOCKED when a run that ended without reporting stopped
        // being written as BLOCKED. A retry has to be able to reset the very
        // statuses that now describe an unfinished run, or the retry rule could
        // never fire again.
        throw new WorkspaceError(409,"invalid_transition",`Pipeline cannot reset a ${prompt.status} station to TODO`);
      }
      const now=new Date().toISOString();
      writeStatus({promptId,to:"TODO",trigger:"operator_retry",actor:"SYSTEM",reason,result:""});
      db.prepare("INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,NULL,'HUMAN_RESPONSE',?,'SYSTEM',?)")
        .run(promptId,"Pipeline is retrying / recovering this station. Inspect the working tree and prior evidence; do not repeat resolved work.",now);
    })());
  },

  /**
   * Put a station the restart caught mid-run back on the queue.
   *
   * Deliberately not `resetPromptToTodo`: that one is the operator pressing
   * Retry, and says so in the ledger and in a remark addressed to the next
   * agent. This is the rail picking itself up, so it records `restart_resume`
   * and claims nothing about the work — the tree is untouched and no outcome is
   * inferred, exactly as when the run was interrupted.
   *
   * Returns false when the station is not one of the two shapes a restart
   * leaves behind, so the caller can resume the pipeline without re-queueing.
   */
  requeueStationAfterRestart(promptId:number):boolean {
    return sqliteGuard(()=>db.transaction(()=>{
      const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as {status:PromptRecord["status"]}|undefined;
      if(!prompt)return false;
      if(prompt.status!=="UNREPORTED"&&prompt.status!=="IN_PROGRESS")return false;
      if(prompt.status==="IN_PROGRESS"){
        // Still genuinely running — a run that outlived the restart, or one
        // this boot already started. Re-queueing under it would hand the same
        // station to a second agent in the same tree.
        const run=db.prepare("SELECT id FROM agent_run WHERE prompt_id=? AND role='execute' AND state IN ('STARTING','RUNNING') ORDER BY started_at DESC LIMIT 1").get(promptId) as {id:string}|undefined;
        if(run&&activeRuns.has(run.id))return false;
      }
      const reason="The server restarted mid-run, so this station was re-queued on the same working tree. Nothing was concluded about the work itself.";
      writeStatus({promptId,to:"TODO",trigger:"restart_resume",actor:"SYSTEM",reason,result:"",evidence:{cause:"server_restart"}});
      return true;
    })());
  },

  /**
   * The pipeline runs an auto-resume should pick back up.
   *
   * `ended_at` bounds it: a machine that has been off for a week should not
   * wake up and relaunch agents against a tree whose state nobody remembers.
   * The "no newer run" clause is what keeps a resume from resurrecting an
   * archived run the operator has already moved past — only the most recent run
   * of a suite or a named pipeline is ever adopted.
   */
  interruptedRunsToResume(withinHours:number):{suiteRuns:SuitePipelineRun[];namedRuns:PipelineRun[]} {
    const cutoff=new Date(Date.now()-withinHours*3600_000).toISOString();
    const suiteRows=db.prepare(`SELECT * FROM suite_pipeline_run r
      WHERE r.state='INTERRUPTED' AND r.stop_reason='server_restart' AND r.ended_at>=?
        AND NOT EXISTS(SELECT 1 FROM suite_pipeline_run newer WHERE newer.suite_id=r.suite_id AND newer.started_at>r.started_at)
      ORDER BY r.started_at`).all(cutoff) as PipelineRunRow[];
    const namedRows=db.prepare(`SELECT * FROM pipeline_run r
      WHERE r.state='INTERRUPTED' AND r.stop_reason='server_restart' AND r.ended_at>=?
        AND NOT EXISTS(SELECT 1 FROM pipeline_run newer WHERE newer.pipeline_id=r.pipeline_id AND newer.started_at>r.started_at)
      ORDER BY r.started_at`).all(cutoff) as NamedPipelineRunRow[];
    return {suiteRuns:suiteRows.map(pipelineRunDto),namedRuns:namedRows.map(namedPipelineRunDto)};
  },

  /** Boot-time reconciliation. See `recoverAbandonedRuns` for who may call it. */
  recoverAbandonedRuns():void { recoverAbandonedRuns(); },

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
             (SELECT count(*) FROM pipeline_step ps JOIN prompt p ON p.id=ps.prompt_id WHERE ps.pipeline_id=st.pipeline_id AND p.suite_id=s.id AND p.parent_prompt_id IS NULL) stepCount
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
      if("suiteIds" in input && current.active!==null){
        throw new WorkspaceError(409,"pipeline_active","Stop the running pipeline before changing its stages");
      }
      db.prepare("UPDATE pipeline SET name=?,description=?,updated_at=? WHERE id=?").run(name,description,new Date().toISOString(),id);
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
    waitReason?:string|null;
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
      waitReason:patch.waitReason===undefined?current.waitReason:patch.waitReason,
    };
    db.prepare("UPDATE pipeline_run SET state=?,current_suite_id=?,current_suite_run_id=?,play_provider=?,play_model=?,ended_at=?,stop_reason=?,wait_reason=? WHERE id=?")
      .run(next.state,next.currentSuiteId,next.currentSuiteRunId,next.playProvider,next.playModel,next.endedAt,next.stopReason,next.waitReason,id);
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

  /* ---------------------------------------------------------------- */
  /* Completion audits                                                  */
  /* ---------------------------------------------------------------- */

  createCompletionAudit(args:{id:string;workspaceId:number;promptId:number;sourceRunId:string;provider:ProviderId;model:string|null}):CompletionAuditRecord {
    return sqliteGuard(()=>{
      const now=new Date().toISOString();
      db.prepare("INSERT INTO completion_audit(id,workspace_id,prompt_id,source_run_id,provider,model,state,created_at) VALUES(?,?,?,?,?,?,'QUEUED',?)")
        .run(args.id,args.workspaceId,args.promptId,args.sourceRunId,args.provider,args.model,now);
      return this.completionAuditById(args.id)!;
    });
  },
  completionAuditById(id:string):CompletionAuditRecord|null { const row=db.prepare("SELECT * FROM completion_audit WHERE id=?").get(id) as Record<string,unknown>|undefined;return row?completionAuditDto(row):null; },
  completionAuditsForPrompt(promptId:number):CompletionAuditRecord[] { return (db.prepare("SELECT * FROM completion_audit WHERE prompt_id=? ORDER BY created_at DESC").all(promptId) as Record<string,unknown>[]).map(completionAuditDto); },
  latestCompletionAudit(promptId:number):CompletionAuditRecord|null { const row=db.prepare("SELECT * FROM completion_audit WHERE prompt_id=? ORDER BY created_at DESC LIMIT 1").get(promptId) as Record<string,unknown>|undefined;return row?completionAuditDto(row):null; },
  /** Attempts already made against one developer run, so a loop cannot form. */
  completionAuditsForRun(sourceRunId:string):CompletionAuditRecord[] { return (db.prepare("SELECT * FROM completion_audit WHERE source_run_id=? ORDER BY created_at DESC").all(sourceRunId) as Record<string,unknown>[]).map(completionAuditDto); },
  updateCompletionAudit(id:string,patch:{auditRunId?:string|null;state?:CompletionAuditRecord["state"];verdict?:CompletionVerdict|null;report?:CompletionAuditReport|null;reportMarkdown?:string;applied?:boolean;error?:string|null;completedAt?:string|null}):CompletionAuditRecord {
    const current=this.completionAuditById(id);if(!current)throw new WorkspaceError(404,"not_found","Completion audit not found");
    const next={auditRunId:patch.auditRunId===undefined?current.auditRunId:patch.auditRunId,state:patch.state??current.state,verdict:patch.verdict===undefined?current.verdict:patch.verdict,report:patch.report===undefined?current.report:patch.report,reportMarkdown:patch.reportMarkdown===undefined?current.reportMarkdown:patch.reportMarkdown,applied:patch.applied===undefined?current.applied:patch.applied,error:patch.error===undefined?current.error:patch.error,completedAt:patch.completedAt===undefined?current.completedAt:patch.completedAt};
    db.prepare("UPDATE completion_audit SET audit_run_id=?,state=?,verdict=?,report_json=?,report_markdown=?,applied=?,error=?,completed_at=? WHERE id=?")
      .run(next.auditRunId,next.state,next.verdict,next.report===null?null:JSON.stringify(next.report),next.reportMarkdown,next.applied?1:0,next.error,next.completedAt,id);
    return this.completionAuditById(id)!;
  },
  /**
   * Whether a work item is waiting because its run never reported, which is
   * exactly the case a reviewer exists to settle: the work may in fact be
   * finished. Covers both UNREPORTED (the run ended saying nothing) and FAILED
   * (the process died saying nothing) — how the process exited says nothing
   * about how much of the work got done.
   *
   * A BLOCKED item is deliberately excluded. That is an agent asking a human a
   * question, and reviewing past it would be a machine overruling a request for
   * a human decision.
   */
  endedWithoutAgentStatus(promptId:number):boolean {
    const prompt=db.prepare("SELECT status FROM prompt WHERE id=?").get(promptId) as {status:PromptRecord["status"]}|undefined;
    if(!prompt)return false;
    return endedWithoutAgentStatus(prompt.status);
  },
  /**
   * Everything an auditor is allowed to see about a finished run, plus what it
   * is judging the work against. Same evidence budget as a handoff dossier —
   * the transport limit is the provider's argv, not the question being asked.
   *
   * `definitionOfDone` is the structured list, each criterion carrying the id
   * the reviewer must quote back so its verdict lands on the right row. The
   * commands are named but marked as already run by this server: a reviewer
   * re-running them is welcome to, and its opinion of the result changes
   * nothing, because the exit code was recorded before it was asked.
   *
   * `acceptanceCriteria` stays as the work item's own prose. It is background
   * rather than the checklist now, but a work item with no definition of done
   * written yet still has to be reviewable against *something*, and the thing
   * the operator wrote is the best available answer.
   */
  completionAuditDossier(workspaceId:number,promptId:number,sourceRunId:string):string {
    const content=this.agentContext(workspaceId,promptId,{full:true}).prompt.content;
    const evaluation=evaluateDefinitionOfDone(promptId);
    return JSON.stringify({
      definitionOfDone:{
        enforcement:evaluation.enforcement,
        criteria:evaluation.criteria.map(entry=>({
          criterionId:entry.criterionId,kind:entry.kind,criterion:entry.text,required:entry.required,
          alreadyChecked:entry.kind==="PROSE"?null:{result:entry.result,evidence:entry.evidence},
        })),
      },
      acceptanceCriteria:compactWorkItem(content),
      suggestedChecks:uniqueCommands([content]).slice(0,20),
      evidence:JSON.parse(this.handoffDossier(workspaceId,promptId,sourceRunId)) as unknown,
    },null,2);
  },
  handoffDossier(workspaceId:number,promptId:number,sourceRunId:string):string {
    // Audit/handoff need the uncapped remark set; the execute diet would hide
    // AGENT_RESPONSE text the reviewer is meant to read.
    const context=this.agentContext(workspaceId,promptId,{full:true});
    const source=(this.promptHistory(promptId).runs as Array<Record<string,unknown>>).find(run=>run.id===sourceRunId);
    if(!source)throw new WorkspaceError(404,"not_found","Source run not found");
    const events=(db.prepare("SELECT event_json FROM agent_run_event WHERE run_id=? ORDER BY id").all(sourceRunId) as Array<{event_json:string}>).map(row=>JSON.parse(row.event_json) as NormalizedEvent);
    const candidates=events.filter(event=>event.type!=="status"&&event.type!=="assistant_text"||event.type==="assistant_text"&&event.payload.kind==="message").slice(-120).map(handoffEvent);
    // Copilot accepts its headless prompt through `-p`. Linux caps one argv
    // entry at about 128 KiB even when ARG_MAX is much larger, so retain the
    // newest useful evidence within a conservative transport budget.
    //
    // `history` is deliberately absent: `context` already carries this prompt's
    // remarks and status events, and including both serialised every one twice.
    const compact:Record<string,unknown>[]=[];let eventBytes=0;
    for(let index=candidates.length-1;index>=0;index--){const event=candidates[index]!;const bytes=Buffer.byteLength(JSON.stringify(event));if(eventBytes+bytes>HANDOFF_EVENT_BUDGET_BYTES)break;compact.unshift(event);eventBytes+=bytes;}
    return JSON.stringify({context,sourceRun:source,sourceEvents:compact},null,2);
  },
  suitePipelineForRun(runId:string):SuitePipelineRun|null { const row=db.prepare("SELECT * FROM suite_pipeline_run WHERE current_run_id=? ORDER BY started_at DESC LIMIT 1").get(runId) as PipelineRunRow|undefined;return row?pipelineRunDto(row):null; },
  close(): void { db.close(); },
};
