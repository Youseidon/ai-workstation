import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { runContexts } from "./runContext.ts";
import { TaskControlService } from "./taskControl.ts";
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
    const rows = db.prepare("SELECT * FROM workspace_start_intent WHERE released_at IS NULL").all();
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
