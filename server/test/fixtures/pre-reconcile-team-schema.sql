-- Schema of a database last migrated on the pre-reconcile Team numbering (1-27).
-- Schema only, no rows. Used by migrationReconcile.test.ts.
CREATE TABLE schema_migration (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
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
      updated_at TEXT NOT NULL, external_key TEXT,
      UNIQUE(workspace_id, name), UNIQUE(workspace_id, sort_order)
    );
CREATE TABLE suite (
      id INTEGER PRIMARY KEY,
      program_id INTEGER NOT NULL REFERENCES program(id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      overview TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, external_key TEXT, default_provider TEXT, default_model TEXT,
      UNIQUE(program_id, name), UNIQUE(program_id, sort_order)
    );
CREATE TABLE prompt (
      id INTEGER PRIMARY KEY,
      suite_id INTEGER NOT NULL REFERENCES suite(id) ON DELETE CASCADE,
      title TEXT NOT NULL COLLATE NOCASE,
      content TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, external_key TEXT, status TEXT NOT NULL DEFAULT 'TODO', completed_at TEXT, result TEXT NOT NULL DEFAULT '', is_gate INTEGER NOT NULL DEFAULT 0,
      UNIQUE(suite_id, title), UNIQUE(suite_id, sort_order)
    );
CREATE TABLE prompt_dependency (
        prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
        depends_on_prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
        PRIMARY KEY(prompt_id, depends_on_prompt_id),
        CHECK(prompt_id <> depends_on_prompt_id)
      );
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
      , options_json TEXT);
CREATE TABLE prompt_remark (
        id INTEGER PRIMARY KEY,
        prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES agent_run(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE agent_command (
        run_id TEXT NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        response TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id,request_id)
      );
CREATE TABLE clarification_exchange (id INTEGER PRIMARY KEY,prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,question TEXT NOT NULL,answer TEXT,provider TEXT NOT NULL,model TEXT,state TEXT NOT NULL,created_at TEXT NOT NULL,answered_at TEXT);
CREATE TABLE agent_run_event (id INTEGER PRIMARY KEY,run_id TEXT NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,event_json TEXT NOT NULL,created_at TEXT NOT NULL);
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
      , scope_prompt_id INTEGER REFERENCES prompt(id) ON DELETE SET NULL);
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
CREATE TABLE suite_verification_event (
        id INTEGER PRIMARY KEY,
        verification_id INTEGER NOT NULL REFERENCES suite_verification(id) ON DELETE CASCADE,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
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
      , enabled INTEGER NOT NULL DEFAULT 0, step_order INTEGER NOT NULL DEFAULT 0);
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
      , pipeline_run_id TEXT);
CREATE TABLE pipeline (
        id INTEGER PRIMARY KEY,
        workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, execution_provider TEXT, execution_model TEXT,
        UNIQUE(workspace_id, name)
      );
CREATE TABLE pipeline_stage (
        pipeline_id INTEGER NOT NULL REFERENCES pipeline(id) ON DELETE CASCADE,
        suite_id INTEGER NOT NULL REFERENCES suite(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL,
        PRIMARY KEY (pipeline_id, suite_id)
      );
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
CREATE TABLE "agent_run" (
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
CREATE TABLE human_response_hold (
      prompt_id INTEGER PRIMARY KEY REFERENCES prompt(id) ON DELETE CASCADE,
      response_id INTEGER NOT NULL REFERENCES prompt_remark(id) ON DELETE CASCADE
    );
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
      , next_attempt_at TEXT, sent_message_id TEXT, operation TEXT NOT NULL DEFAULT 'send' CHECK(operation IN ('send','edit')), target_outbox_id INTEGER REFERENCES telegram_outbox(id) ON DELETE CASCADE, payload_version INTEGER NOT NULL DEFAULT 0, thread_id INTEGER REFERENCES telegram_thread(id) ON DELETE SET NULL);
CREATE TABLE telegram_inbox (
        bot_id TEXT NOT NULL,
        update_id INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        processed_at TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(bot_id, update_id)
      );
CREATE TABLE telegram_poll_cursor (
        bot_id TEXT PRIMARY KEY,
        next_update_id INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
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
CREATE TABLE telegram_action_content (
        action_ref TEXT PRIMARY KEY REFERENCES task_control_action(ref) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE team_roster (
        team_id TEXT PRIMARY KEY,
        group_chat_id TEXT NOT NULL,
        remote_url TEXT NOT NULL,
        revision TEXT NOT NULL,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE "telegram_thread" (
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
CREATE TABLE item_link (
            item_id TEXT PRIMARY KEY,
            prompt_id INTEGER NOT NULL REFERENCES prompt(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK(role IN ('requester','executor')),
            epoch INTEGER NOT NULL CHECK(epoch >= 1),
            control_head TEXT
          , closed_at TEXT, closed_command_id TEXT);
CREATE TABLE "task_control_action" (
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
CREATE INDEX program_workspace_idx ON program(workspace_id);
CREATE INDEX suite_program_idx ON suite(program_id);
CREATE INDEX prompt_suite_idx ON prompt(suite_id);
CREATE UNIQUE INDEX program_external_key_uq ON program(workspace_id, external_key) WHERE external_key IS NOT NULL;
CREATE UNIQUE INDEX suite_external_key_uq ON suite(program_id, external_key) WHERE external_key IS NOT NULL;
CREATE UNIQUE INDEX prompt_external_key_uq ON prompt(suite_id, external_key) WHERE external_key IS NOT NULL;
CREATE INDEX prompt_dependency_target_idx ON prompt_dependency(depends_on_prompt_id);
CREATE INDEX program_gate_program_idx ON program_gate(program_id);
CREATE INDEX prompt_status_event_prompt_idx ON prompt_status_event(prompt_id,created_at);
CREATE INDEX prompt_remark_prompt_idx ON prompt_remark(prompt_id,created_at);
CREATE INDEX clarification_prompt_idx ON clarification_exchange(prompt_id,created_at);
CREATE INDEX agent_run_event_run_idx ON agent_run_event(run_id,id);
CREATE INDEX suite_verification_suite_idx ON suite_verification(suite_id,started_at);
CREATE UNIQUE INDEX suite_verification_run_uq ON suite_verification(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX suite_verification_item_idx ON suite_verification_item(verification_id,sort_order);
CREATE INDEX suite_verification_event_idx ON suite_verification_event(verification_id,id);
CREATE INDEX suite_pipeline_run_suite_idx ON suite_pipeline_run(suite_id, started_at);
CREATE UNIQUE INDEX suite_pipeline_active_uq
        ON suite_pipeline_run(suite_id)
        WHERE state IN ('PLAYING','WAITING_HUMAN','PAUSED');
CREATE INDEX pipeline_workspace_idx ON pipeline(workspace_id);
CREATE INDEX pipeline_stage_suite_idx ON pipeline_stage(suite_id);
CREATE INDEX pipeline_run_pipeline_idx ON pipeline_run(pipeline_id, started_at);
CREATE UNIQUE INDEX pipeline_run_active_uq
        ON pipeline_run(pipeline_id)
        WHERE state IN ('PLAYING','WAITING_HUMAN','PAUSED');
CREATE UNIQUE INDEX active_prompt_run_uq ON agent_run(prompt_id)
          WHERE state IN ('STARTING','RUNNING') AND role = 'execute';
CREATE INDEX agent_run_prompt_idx ON agent_run(prompt_id,started_at);
CREATE INDEX agent_run_workspace_role_idx ON agent_run(workspace_id,role,started_at);
CREATE INDEX handoff_prompt_idx ON handoff(prompt_id,created_at);
CREATE UNIQUE INDEX handoff_active_prompt_uq ON handoff(prompt_id) WHERE state IN ('QUEUED','RUNNING');
CREATE UNIQUE INDEX task_control_receipt_action_applied_uq ON task_control_receipt(action_ref) WHERE state='APPLIED';
CREATE INDEX telegram_outbox_state_idx ON telegram_outbox(state, updated_at);
CREATE INDEX telegram_inbox_processed_idx ON telegram_inbox(bot_id, processed_at, update_id);
CREATE UNIQUE INDEX workspace_start_intent_active_dir_uq
        ON workspace_start_intent(effective_directory)
        WHERE released_at IS NULL;
CREATE INDEX workspace_start_intent_workspace_idx ON workspace_start_intent(workspace_id, created_at);
CREATE INDEX workspace_start_intent_prompt_idx ON workspace_start_intent(prompt_id, created_at);
CREATE INDEX telegram_outbox_sent_message_idx ON telegram_outbox(bot_id, chat_id, sent_message_id);
CREATE INDEX telegram_outbox_target_idx ON telegram_outbox(target_outbox_id, state);
CREATE UNIQUE INDEX task_control_actor_team_group_uq
        ON task_control_actor(transport, transport_user_id, chat_id)
        WHERE topic_id='__team_group__';
CREATE UNIQUE INDEX telegram_thread_subject_uq ON telegram_thread(bot_id, chat_id, subject_kind, subject_id);
CREATE INDEX item_link_prompt_idx ON item_link(prompt_id);
CREATE INDEX task_control_action_prompt_idx ON task_control_action(prompt_id, created_at);
CREATE UNIQUE INDEX item_grant_active_uq
            ON item_grant(item_id, person_id, capability)
            WHERE revoked_at IS NULL;
CREATE INDEX item_grant_item_idx ON item_grant(item_id, person_id, granted_at);
