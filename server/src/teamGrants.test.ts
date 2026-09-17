import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { TaskControlService } from "./taskControl.ts";
import { evaluateItemGrant, type ItemGrantCapability, type ItemGrantOperation } from "./teamGrants.ts";
import { workspaces } from "./workspaces.ts";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function runWorkspaceScript(root: string, source: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "-e", source], {
    cwd: serverDir,
    env: { ...process.env, AGENT_CONSOLE_REPO_ROOT: root },
    encoding: "utf8",
    timeout: 60_000,
  });
}

function boot(root: string) {
  return runWorkspaceScript(root, "const { workspaces } = await import('./src/workspaces.ts'); workspaces.close();");
}

test("TM-T0-2: grant matrix requires each named capability and owners need no grant", () => {
  const operations: Array<{ operation: ItemGrantOperation; required: ItemGrantCapability[] }> = [
    { operation: "context", required: ["context"] },
    { operation: "save_answer", required: ["answer"] },
    { operation: "answer_and_resume", required: ["answer", "resume"] },
    { operation: "resume_saved", required: ["resume"] },
  ];
  const sets: ItemGrantCapability[][] = [[], ["context"], ["answer"], ["resume"], ["answer", "resume"], ["context", "answer", "resume"]];
  for (const { operation, required } of operations) {
    assert.deepEqual(evaluateItemGrant({ actorPersonId: "jd", ownerPersonId: "jd", operation, activeCapabilities: [] }), { allowed: true, missing: [] });
    for (const activeCapabilities of sets) {
      const missing = required.filter(capability => !activeCapabilities.includes(capability));
      assert.deepEqual(
        evaluateItemGrant({ actorPersonId: "yousef", ownerPersonId: "jd", operation, activeCapabilities }),
        { allowed: missing.length === 0, missing },
      );
    }
    assert.deepEqual(
      evaluateItemGrant({ actorPersonId: "stranger", ownerPersonId: "jd", operation, activeCapabilities: [] }),
      { allowed: false, missing: required },
    );
  }
});

test("T18 grant history permits one active item/person/capability and revocation ends authority", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tm3-grants-"));
  const workspace = workspaces.create({ name: directory, workDirectory: directory });
  try {
    const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
    const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
    const prompt = workspaces.createChild("prompt", suite.id, { title: "Granted item", content: "Wait for an answer" }) as PromptRecord;
    const item = workspaces.createItemLink({ promptId: prompt.id, role: "requester", epoch: 1 });
    const actor = workspaces.upsertTaskControlActor({ id: `grant-owner-${workspace.id}`, transport: "fake_telegram", transportUserId: "101", chatId: `grant-chat-${workspace.id}`, label: "jd" });
    for (const action of ["resume_saved", "grant", "revoke", "close_thread"] as const) {
      const ref = `grant-action-${workspace.id}-${action}`;
      workspaces.createTaskControlAction({
        ref,
        action,
        promptId: prompt.id,
        actorId: actor.id,
        chatId: actor.chat_id,
        botId: `grant-bot-${workspace.id}`,
        expectedRevision: workspaces.humanInputState(prompt.id).revision,
        expiresAt: "2099-01-01T00:00:00.000Z",
        subjectKind: "item",
        itemId: item.itemId,
        payload: action === "grant" || action === "revoke" ? { capabilities: ["answer"] } : undefined,
      });
      const stored = workspaces.taskControlAction(ref)!;
      assert.equal(stored.subject_kind, "item");
      assert.equal(stored.item_id, item.itemId);
      if (action === "grant" || action === "revoke") assert.deepEqual(JSON.parse(stored.payload_json!), { capabilities: ["answer"] });
      const unavailable = await new TaskControlService({ enabled: true, teamEnabled: true, notificationsEnabled: true, remoteActionsEnabled: true, transport: "fake_telegram", botId: `grant-bot-${workspace.id}` })
        .handleCallback({ ref, transportUserId: "101", chatId: actor.chat_id, botId: `grant-bot-${workspace.id}`, commandId: `tap-${action}` });
      assert.equal(unavailable.errorCode, "action_not_available", `${action} cannot fall through to personal resume before T19`);
    }
    const first = workspaces.grantItemCapability({ itemId: item.itemId, personId: "yousef", capability: "answer", commandId: "grant-1" });
    assert.deepEqual(workspaces.grantItemCapability({ itemId: item.itemId, personId: "yousef", capability: "answer", commandId: "grant-retry" }), first);
    assert.equal(workspaces.hasItemCapability(item.itemId, "yousef", "answer"), true);
    assert.equal(workspaces.revokeItemCapability({ itemId: item.itemId, personId: "yousef", capability: "answer", commandId: "revoke-1" }), true);
    assert.equal(workspaces.hasItemCapability(item.itemId, "yousef", "answer"), false);
    const second = workspaces.grantItemCapability({ itemId: item.itemId, personId: "yousef", capability: "answer", commandId: "grant-2" });
    assert.notEqual(second.grantedCommandId, first.grantedCommandId);
    workspaces.grantItemCapability({ itemId: item.itemId, personId: "yousef", capability: "resume", commandId: "grant-resume" });
    assert.equal(workspaces.revokeItemGrants({ itemId: item.itemId, commandId: "thread-closed" }), 2);
    assert.equal(workspaces.itemGrants(item.itemId, { activeOnly: true }).length, 0);
    assert.deepEqual(workspaces.itemGrants(item.itemId).map(grant => [grant.capability, grant.grantedCommandId, grant.revokedCommandId]), [
      ["answer", "grant-1", "revoke-1"],
      ["answer", "grant-2", "thread-closed"],
      ["resume", "grant-resume", "thread-closed"],
    ]);
  } finally {
    workspaces.removeTelegramRecordsForBot(`grant-bot-${workspace.id}`);
    workspaces.removeTaskControlActor(`grant-owner-${workspace.id}`);
    workspaces.remove(workspace.id);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("TM-T0-5-26: migration 26 preserves old cards and widens actions exactly once", () => {
  const root = mkdtempSync(join(tmpdir(), "tm3-migration-26-"));
  try {
    mkdirSync(join(root, ".agent-console"), { recursive: true });
    mkdirSync(join(root, "workspace"));
    assert.equal(boot(root).status, 0);
    const seeded = runWorkspaceScript(root, `
      const { workspaces } = await import('./src/workspaces.ts');
      const workspace = workspaces.create({ name: 'migration-26', workDirectory: ${JSON.stringify(join(root, "workspace"))} });
      const program = workspaces.createChild('program', workspace.id, { name: 'Program' });
      const suite = workspaces.createChild('suite', program.id, { name: 'Suite' });
      const prompt = workspaces.createChild('prompt', suite.id, { title: 'Pending card', content: 'Answer once' });
      const runId = 'm26-source-run';
      workspaces.beginAgentRun({ runId, workspaceId: workspace.id, promptId: prompt.id, provider: 'claude', model: null, tokenHash: 'm26', expiresAt: '2099-01-01T00:00:00.000Z', role: 'execute' });
      workspaces.finishAgentRun(runId, 'done');
      workspaces.respondToBlockedPrompt(prompt.id, { content: 'Prior answer' });
      const handoff = workspaces.createHandoff({ id: 'm26-handoff', workspaceId: workspace.id, promptId: prompt.id, sourceRunId: runId, provider: 'claude', model: null });
      workspaces.updateHandoff(handoff.id, { state: 'READY', recommendation: 'WAIT_FOR_HUMAN', completedAt: new Date().toISOString() });
      workspaces.addPipelineStep(prompt.id, { provider: 'claude' });
      const pipeline = workspaces.createPipelineRun({ id: 'm26-pipeline', suiteId: suite.id, workspaceId: workspace.id, playProvider: 'claude', playModel: null });
      workspaces.updatePipelineRun(pipeline.id, { state: 'WAITING_HUMAN', currentPromptId: prompt.id });
      const actor = workspaces.upsertTaskControlActor({ id: 'm26-actor', transport: 'fake_telegram', transportUserId: '101', chatId: '42', label: 'jd' });
      workspaces.createTaskControlAction({ ref: 'm26-action', action: 'answer_and_resume', promptId: prompt.id, actorId: actor.id, chatId: '42', botId: 'telegram-m26', messageId: 'card-26', expectedRevision: workspaces.humanInputState(prompt.id).revision, provider: 'claude', expiresAt: '2099-01-01T00:00:00.000Z' });
      workspaces.close();
    `);
    assert.equal(seeded.status, 0, seeded.stderr);
    const file = join(root, ".agent-console/console.sqlite");
    const database = new Database(file);
    database.pragma("foreign_keys = OFF");
    database.exec(`
      DROP TABLE item_grant;
      CREATE TABLE task_control_action_v25 (
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
      INSERT INTO task_control_action_v25 SELECT ref,action,prompt_id,actor_id,chat_id,topic_id,bot_id,message_id,expected_revision,provider,model,expires_at,created_at,applied_command_id FROM task_control_action;
      DROP TABLE task_control_action;
      ALTER TABLE task_control_action_v25 RENAME TO task_control_action;
      CREATE INDEX task_control_action_prompt_idx ON task_control_action(prompt_id, created_at);
      DELETE FROM schema_migration WHERE version=26;
    `);
    const before = database.prepare("SELECT * FROM task_control_action ORDER BY ref").all();
    database.close();

    for (const run of [1, 2]) {
      const migrated = boot(root);
      assert.equal(migrated.status, 0, `boot ${run}: ${migrated.stderr}`);
      const check = new Database(file, { readonly: true });
      try {
        const preserved = check.prepare("SELECT ref,action,prompt_id,actor_id,chat_id,topic_id,bot_id,message_id,expected_revision,provider,model,expires_at,created_at,applied_command_id FROM task_control_action ORDER BY ref").all();
        assert.deepEqual(preserved, before, `boot ${run} preserves old action fields`);
        assert.deepEqual(check.prepare("SELECT version FROM schema_migration WHERE version=26").all(), [{ version: 26 }]);
        assert.deepEqual(check.pragma("foreign_key_check"), []);
        const columns = check.prepare("PRAGMA table_info(task_control_action)").all().map(column => (column as { name: string }).name);
        assert.deepEqual(columns.slice(-3), ["subject_kind", "item_id", "payload_json"]);
        assert.deepEqual(check.prepare("PRAGMA table_info(item_grant)").all().map(column => (column as { name: string }).name), ["item_id", "person_id", "capability", "granted_command_id", "granted_at", "revoked_command_id", "revoked_at"]);
      } finally {
        check.close();
      }
    }

    const applied = runWorkspaceScript(root, `
      const { setPipelineStationStarter } = await import('./src/pipelineScheduler.ts');
      const { TaskControlService } = await import('./src/taskControl.ts');
      const { workspaces } = await import('./src/workspaces.ts');
      let starts = 0;
      setPipelineStationStarter(async () => {
        starts++;
        const workspace = workspaces.list()[0];
        const prompt = workspaces.tree(workspace.id).programs[0].suites[0].prompts[0];
        const runId = 'm26-resumed-run';
        workspaces.beginAgentRun({ runId, workspaceId: workspace.id, promptId: prompt.id, provider: 'claude', model: null, tokenHash: 'm26-resumed', expiresAt: '2099-01-01T00:00:00.000Z' });
        return { runId };
      });
      const control = new TaskControlService({ enabled: true, notificationsEnabled: true, remoteActionsEnabled: true, transport: 'fake_telegram', botId: 'telegram-m26' });
      const input = { ref: 'm26-action', transportUserId: '101', chatId: '42', botId: 'telegram-m26', messageId: 'card-26', commandId: 'm26-command', content: 'Use blue.' };
      const first = await control.handleCallback(input);
      const duplicate = await control.handleCallback({ ...input, commandId: 'm26-duplicate' });
      if (first.state !== 'APPLIED' || !first.started || duplicate.commandId !== first.commandId || starts !== 1) process.exitCode = 2;
      setPipelineStationStarter(null);
      workspaces.close();
    `);
    assert.equal(applied.status, 0, applied.stderr);
    const final = new Database(file, { readonly: true });
    try {
      assert.deepEqual(final.prepare("SELECT command_id,state,started,run_id FROM task_control_receipt WHERE action_ref='m26-action'").all(), [
        { command_id: "m26-command", state: "APPLIED", started: 1, run_id: "m26-resumed-run" },
      ]);
      assert.doesNotThrow(() => final.prepare("SELECT 1 FROM task_control_action WHERE action='resume_saved' OR action='grant' OR action='revoke' OR action='close_thread'").all());
    } finally {
      final.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
