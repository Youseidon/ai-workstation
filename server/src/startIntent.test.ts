import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import Database from "better-sqlite3";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { runContexts } from "./runContext.ts";
import { TaskControlService } from "./taskControl.ts";
import { runHub } from "./runHub.ts";
import { handleWorkspaceApi } from "./workspaceApi.ts";
import { WorkspaceError, workspaces } from "./workspaces.ts";

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${seq}`;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "intent-work-"));
  const workspace = workspaces.create({ name: unique("ws"), description: "", workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: unique("program"), overview: "" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: unique("suite"), overview: "" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: unique("prompt"), content: "do it" }) as PromptRecord;
  return {
    dir,
    workspace,
    prompt,
    cleanup() {
      workspaces.remove(workspace.id);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function postApi(path: string, value: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = Readable.from([JSON.stringify(value)]) as unknown as import("node:http").IncomingMessage;
  req.method = "POST";
  req.url = path;
  const chunks: string[] = [];
  const res = new EventEmitter() as import("node:http").ServerResponse;
  res.writeHead = ((status: number) => {
    res.statusCode = status;
    return res;
  }) as typeof res.writeHead;
  res.end = ((chunk?: unknown) => {
    if (typeof chunk === "string") chunks.push(chunk);
    res.emit("finish");
    return res;
  }) as typeof res.end;
  const handled = await handleWorkspaceApi(req, res, new URL(path, "http://127.0.0.1"));
  assert.equal(handled, true);
  return { status: res.statusCode, body: JSON.parse(chunks.join("") || "{}") as Record<string, unknown> };
}

test("aliased workspace paths produce exactly one durable start intent", () => {
  const ctx = fixture();
  const link = `${ctx.dir}-link`;
  const db = new Database(workspaces.databasePath);
  try {
    symlinkSync(ctx.dir, link);
    const now = new Date().toISOString();
    const aliasId = Number(db.prepare("INSERT INTO workspace(name,description,work_directory,created_at,updated_at) VALUES(?,?,?,?,?)")
      .run(unique("alias"), "", link, now, now).lastInsertRowid);
    workspaces.reserveStartIntent({ runId: "run_alias_one", workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, source: "test" });
    assert.throws(
      () => workspaces.reserveStartIntent({ runId: "run_alias_two", workspaceId: aliasId, promptId: null, provider: "claude", model: null, source: "test" }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "workspace_busy",
    );
    const rows = db.prepare("SELECT * FROM workspace_start_intent WHERE released_at IS NULL AND effective_directory=?").all(realpathSync(ctx.dir));
    assert.equal(rows.length, 1);
  } finally {
    db.close();
    rmSync(link, { force: true });
    ctx.cleanup();
  }
});

test("restart reconciliation classifies reserved and spawned owners as START_UNKNOWN", () => {
  const ctx = fixture();
  const credential = runContexts.create("run_spawned_unknown", ctx.workspace.id, ctx.prompt.id);
  const db = new Database(workspaces.databasePath);
  try {
    workspaces.reserveStartIntent({ runId: "run_reserved_unknown", workspaceId: ctx.workspace.id, promptId: null, provider: "claude", model: null, source: "test" });
    workspaces.markStartIntent("run_reserved_unknown", "KNOWN_NO_SPAWN", "free for spawned case");
    workspaces.reserveStartIntent({ runId: "run_spawned_unknown", workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, source: "test" });
    workspaces.beginAgentRun({ runId: "run_spawned_unknown", workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute" });
    workspaces.reconcileStartIntentsForRestart();
    const row = db.prepare("SELECT state,released_at releasedAt FROM workspace_start_intent WHERE id='run_spawned_unknown'").get() as {state:string;releasedAt:string|null};
    assert.equal(row.state, "START_UNKNOWN");
    assert.equal(row.releasedAt, null);
  } finally {
    db.close();
    runContexts.revoke("run_spawned_unknown");
    ctx.cleanup();
  }
});

test("start-before-spawn remains START_UNKNOWN after restart reconciliation", () => {
  const ctx = fixture();
  const db = new Database(workspaces.databasePath);
  try {
    workspaces.reserveStartIntent({ runId: "run_before_spawn_unknown", workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, source: "test" });
    workspaces.reconcileStartIntentsForRestart();
    const row = db.prepare("SELECT state,released_at releasedAt,detail FROM workspace_start_intent WHERE id=?").get("run_before_spawn_unknown") as {state:string;releasedAt:string|null;detail:string|null};
    assert.equal(row.state, "START_UNKNOWN");
    assert.equal(row.releasedAt, null);
    assert.match(row.detail ?? "", /before spawn was observed/);
  } finally {
    db.close();
    ctx.cleanup();
  }
});

test("start-after-spawn remains START_UNKNOWN after restart reconciliation", () => {
  const ctx = fixture();
  const runId = "run_after_spawn_unknown";
  const credential = runContexts.create(runId, ctx.workspace.id, ctx.prompt.id);
  const db = new Database(workspaces.databasePath);
  try {
    workspaces.beginAgentRun({ runId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute" });
    workspaces.markAgentRunRunning(runId);
    workspaces.reconcileStartIntentsForRestart();
    const row = db.prepare("SELECT state,released_at releasedAt,source,detail FROM workspace_start_intent WHERE id=?").get(runId) as {state:string;releasedAt:string|null;source:string;detail:string|null};
    assert.equal(row.state, "START_UNKNOWN");
    assert.equal(row.releasedAt, null);
    assert.equal(row.source, "restart-reconciliation");
    assert.match(row.detail ?? "", /active run row/);
  } finally {
    db.close();
    runContexts.revoke(runId);
    ctx.cleanup();
  }
});

test("known no-spawn and known stopped classifications release ownership", () => {
  const ctx = fixture();
  const stoppedRunId = "run_known_stopped";
  const credential = runContexts.create(stoppedRunId, ctx.workspace.id, ctx.prompt.id);
  const db = new Database(workspaces.databasePath);
  try {
    workspaces.reserveStartIntent({ runId: "run_known_no_spawn", workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, source: "test" });
    workspaces.markStartIntent("run_known_no_spawn", "KNOWN_NO_SPAWN", "provider discovery failed before spawn");
    workspaces.reserveStartIntent({ runId: stoppedRunId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, source: "test" });
    workspaces.beginAgentRun({ runId: stoppedRunId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute" });
    workspaces.finishAgentRun(stoppedRunId, "interrupted");
    const rows = db.prepare("SELECT id,state,released_at releasedAt FROM workspace_start_intent WHERE id IN (?,?) ORDER BY id").all("run_known_no_spawn", stoppedRunId) as Array<{id:string;state:string;releasedAt:string|null}>;
    assert.deepEqual(rows.map(row => [row.id, row.state, row.releasedAt !== null]), [
      ["run_known_no_spawn", "KNOWN_NO_SPAWN", true],
      [stoppedRunId, "KNOWN_STOPPED", true],
    ]);
    assert.equal(workspaces.activeStartIntentForWorkspace(ctx.workspace.id), null);
  } finally {
    db.close();
    runContexts.revoke(stoppedRunId);
    ctx.cleanup();
  }
});

test("recovery refuses START_UNKNOWN and allows explicit recovery after known stopped classification", () => {
  const ctx = fixture();
  const runId = "run_recover_unknown_then_known";
  const credential = runContexts.create(runId, ctx.workspace.id, ctx.prompt.id);
  const db = new Database(workspaces.databasePath);
  try {
    workspaces.reserveStartIntent({ runId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, source: "test" });
    workspaces.beginAgentRun({ runId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute" });
    workspaces.reconcileStartIntentsForRestart();
    assert.throws(
      () => workspaces.recoverPrompt(ctx.prompt.id, runId),
      (error: unknown) => error instanceof WorkspaceError && error.code === "start_unknown",
    );
    workspaces.markStartIntent(runId, "KNOWN_STOPPED", "operator confirmed provider process is stopped");
    workspaces.recoverPrompt(ctx.prompt.id, runId);
    const prompt = workspaces.resolvePrompt(ctx.workspace.id, ctx.prompt.id);
    const row = db.prepare("SELECT state,released_at releasedAt FROM workspace_start_intent WHERE id=?").get(runId) as {state:string;releasedAt:string|null};
    assert.equal(prompt.status, "TODO");
    assert.equal(row.state, "KNOWN_STOPPED");
    assert.notEqual(row.releasedAt, null);
  } finally {
    db.close();
    runContexts.revoke(runId);
    ctx.cleanup();
  }
});

test("classification API records operator-confirmed START_UNKNOWN classification", async () => {
  const ctx = fixture();
  const runId = unique("run_api_classify_unknown");
  const credential = runContexts.create(runId, ctx.workspace.id, ctx.prompt.id);
  const db = new Database(workspaces.databasePath);
  try {
    workspaces.reserveStartIntent({ runId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, source: "test" });
    workspaces.beginAgentRun({ runId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute" });
    workspaces.reconcileStartIntentsForRestart();
    const response = await postApi(`/api/prompts/${ctx.prompt.id}/classify-start-unknown`, {
      classification: "known_stopped",
      expectedStartIntentId: runId,
      confirmed: true,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { classified: true, classification: "known_stopped", startIntentId: runId });
    const intent = db.prepare("SELECT state,released_at releasedAt,detail FROM workspace_start_intent WHERE id=?").get(runId) as {state:string;releasedAt:string|null;detail:string|null};
    assert.equal(intent.state, "KNOWN_STOPPED");
    assert.notEqual(intent.releasedAt, null);
    assert.match(intent.detail ?? "", /Operator confirmed START_UNKNOWN classification/);
    const event = db.prepare("SELECT reason,actor_type actorType FROM prompt_status_event WHERE prompt_id=? ORDER BY id DESC LIMIT 1").get(ctx.prompt.id) as {reason:string;actorType:string};
    assert.equal(event.actorType, "USER");
    assert.match(event.reason, /Operator confirmed previous start is known stopped/);
  } finally {
    db.close();
    runContexts.revoke(runId);
    ctx.cleanup();
  }
});

test("classification rejects stale expected start intent mismatches", () => {
  const ctx = fixture();
  const runId = unique("run_stale_classify_unknown");
  const credential = runContexts.create(runId, ctx.workspace.id, ctx.prompt.id);
  try {
    workspaces.reserveStartIntent({ runId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, source: "test" });
    workspaces.beginAgentRun({ runId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute" });
    workspaces.reconcileStartIntentsForRestart();
    assert.throws(
      () => workspaces.classifyStartUnknown(ctx.prompt.id, { classification: "known_stopped", expectedStartIntentId: "run_stale_old", confirmed: true }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "start_intent_changed",
    );
  } finally {
    runContexts.revoke(runId);
    ctx.cleanup();
  }
});

test("classification rejects while an in-memory active process is known", () => {
  const ctx = fixture();
  const runId = unique("run_active_classify_unknown");
  const credential = runContexts.create(runId, ctx.workspace.id, ctx.prompt.id);
  try {
    workspaces.reserveStartIntent({ runId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, source: "test" });
    workspaces.beginAgentRun({ runId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute" });
    workspaces.reconcileStartIntentsForRestart();
    runHub.start({
      handle: {
        runId,
        provider: "claude",
        model: null,
        role: "execute",
        permissionMode: null,
        interrupt: async () => {},
        done: new Promise(() => {}),
      },
      workspace: { id: ctx.workspace.id, name: ctx.workspace.name, workDirectory: ctx.workspace.workDirectory },
      source: { type: "saved", promptId: ctx.prompt.id, promptKey: ctx.prompt.externalKey, title: ctx.prompt.title, programName: "Program", suiteName: "Suite" },
      role: "execute",
    });
    assert.throws(
      () => workspaces.classifyStartUnknown(ctx.prompt.id, { classification: "known_stopped", expectedStartIntentId: runId, confirmed: true }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "run_active",
    );
  } finally {
    runHub.end(runId, "interrupted");
    runContexts.revoke(runId);
    ctx.cleanup();
  }
});

test("recovery works after operator confirms known no-spawn classification", () => {
  const ctx = fixture();
  const runId = unique("run_no_spawn_classify_recover");
  const credential = runContexts.create(runId, ctx.workspace.id, ctx.prompt.id);
  try {
    workspaces.reserveStartIntent({ runId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, source: "test" });
    workspaces.beginAgentRun({ runId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute" });
    workspaces.reconcileStartIntentsForRestart();
    assert.throws(
      () => workspaces.recoverPrompt(ctx.prompt.id, runId),
      (error: unknown) => error instanceof WorkspaceError && error.code === "start_unknown",
    );
    workspaces.classifyStartUnknown(ctx.prompt.id, { classification: "known_no_spawn", expectedStartIntentId: runId, confirmed: true });
    workspaces.recoverPrompt(ctx.prompt.id, runId);
    assert.equal(workspaces.resolvePrompt(ctx.workspace.id, ctx.prompt.id).status, "TODO");
  } finally {
    runContexts.revoke(runId);
    ctx.cleanup();
  }
});

test("prompt DTO distinguishes START_UNKNOWN from known recoverable without leaking start details", () => {
  const ctx = fixture();
  const runId = "run_prompt_dto_unknown_then_known";
  const credential = runContexts.create(runId, ctx.workspace.id, ctx.prompt.id);
  try {
    workspaces.reserveStartIntent({ runId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, source: "test" });
    workspaces.beginAgentRun({ runId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute" });
    workspaces.reconcileStartIntentsForRestart();

    const unknown = workspaces.promptOptions(ctx.workspace.id).find(option => option.id === ctx.prompt.id)!;
    assert.equal(unknown.recoverable, false);
    assert.equal(unknown.recovery.kind, "start_unknown");
    assert.match(unknown.recovery.message ?? "", /Ownership is unknown/);
    assert.match(unknown.recovery.message ?? "", /Confirm the provider process state/);
    assert.doesNotMatch(unknown.recovery.message ?? "", /Server restarted|in-memory supervisor|before spawn/);

    workspaces.markStartIntent(runId, "KNOWN_STOPPED", "operator confirmed provider process is stopped");
    const known = workspaces.promptOptions(ctx.workspace.id).find(option => option.id === ctx.prompt.id)!;
    assert.equal(known.recoverable, true);
    assert.equal(known.recovery.kind, "recoverable");
  } finally {
    runContexts.revoke(runId);
    ctx.cleanup();
  }
});

test("fake Telegram resume path respects the same active start ownership", async () => {
  const ctx = fixture();
  const botId = unique("fake-bot");
  const transportUserId = unique("user");
  const chatId = unique("chat");
  const control = new TaskControlService({
    enabled: true,
    notificationsEnabled: true,
    remoteActionsEnabled: true,
    transport: "fake_telegram",
    botId,
  });
  let actorId: string | null = null;
  try {
    const blockerRunId = "run_fake_blocker";
    const credential = runContexts.create(blockerRunId, ctx.workspace.id, ctx.prompt.id);
    workspaces.beginAgentRun({ runId: blockerRunId, workspaceId: ctx.workspace.id, promptId: ctx.prompt.id, provider: "claude", model: null, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute" });
    workspaces.markAgentRunRunning(blockerRunId);
    workspaces.updateAgentStatus(blockerRunId, { requestId: randomUUID(), expectedStatus: "IN_PROGRESS", status: "BLOCKED", reason: "need input", verificationSummary: "answer" });
    workspaces.finishAgentRun(blockerRunId, "done");
    workspaces.reserveStartIntent({ runId: "run_fake_owner", workspaceId: ctx.workspace.id, promptId: null, provider: "claude", model: null, source: "test" });
    actorId = control.enrollFakeActor({ transportUserId, chatId, label: "fake" }).id;
    const card = control.postPersonalQuestion(ctx.prompt.id, actorId, { provider: "claude" });
    const resume = card.actions.find((action) => action.action === "answer_and_resume")!;
    const receipt = await control.handleCallback({
      ref: resume.ref,
      transportUserId,
      chatId,
      botId,
      messageId: `question-${ctx.prompt.id}`,
      commandId: unique("cmd"),
      content: "answer",
    });
    assert.equal(receipt.state, "APPLIED");
    assert.equal(receipt.errorCode, "resume_failed");
    assert.match(receipt.message, /owns this working directory|already in progress/);
  } finally {
    workspaces.markStartIntent("run_fake_owner", "KNOWN_NO_SPAWN", "test cleanup");
    if (actorId !== null) workspaces.removeTaskControlActor(actorId);
    runContexts.revoke("run_fake_blocker");
    ctx.cleanup();
  }
});
