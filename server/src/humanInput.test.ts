import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { workspaces } from "./workspaces.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "human-input-"));
  const workspace = workspaces.create({ name: dir, workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: "Program" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: "Suite" }) as SuiteRecord;
  const prompt = workspaces.createChild("prompt", suite.id, { title: "Task", content: "Use an owner-supplied list" }) as PromptRecord;
  const runId = `run-${workspace.id}`;
  workspaces.beginAgentRun({ runId, workspaceId: workspace.id, promptId: prompt.id, provider: "claude", model: null, tokenHash: runId, expiresAt: new Date(Date.now() + 60000).toISOString(), role: "execute" });
  workspaces.finishAgentRun(runId, "done");
  workspaces.respondToBlockedPrompt(prompt.id, { content: "Octoport, seafood trade" });
  const handoff = workspaces.createHandoff({ id: `handoff-${workspace.id}`, workspaceId: workspace.id, promptId: prompt.id, sourceRunId: runId, provider: "claude", model: null });
  // This handoff follows the earlier response; use deterministic timestamps.
  workspaces.updateHandoff(handoff.id, { state: "READY", recommendation: "WAIT_FOR_HUMAN", completedAt: new Date(Date.now() + 1000).toISOString() });
  return { workspace, suite, prompt, handoff, cleanup() { workspaces.remove(workspace.id); rmSync(dir, { recursive: true, force: true }); } };
}

test("a TODO task with an unanswered handoff stays in attention and accepts a follow-up", async () => {
  const f = fixture();
  try {
    const item = workspaces.promptActivity(f.prompt.id).item;
    assert.equal(item.prompt.status, "TODO");
    assert.equal(item.prompt.ready, false);
    assert.equal(item.operationalState, "AWAITING_RESPONSE");
    assert.equal(item.attention, true);
    await new Promise(resolve => setTimeout(resolve, 5));
    // Keep the handoff newer than the old answer, but older than this answer.
    workspaces.updateHandoff(f.handoff.id, { completedAt: new Date().toISOString() });
    const response = workspaces.respondToBlockedPrompt(f.prompt.id, { content: "Use the supplied trade directory" });
    assert.equal(response.kind, "HUMAN_RESPONSE");
    assert.equal(workspaces.pendingHumanQuestion(f.prompt.id), null);
    assert.equal(workspaces.promptActivity(f.prompt.id).item.operationalState, "READY");
    assert.equal(workspaces.resolvePrompt(f.workspace.id, f.prompt.id).ready, true);
    const history = workspaces.promptActivity(f.prompt.id);
    assert.equal(history.events[0]?.previousStatus, "TODO");
  } finally { f.cleanup(); }
});
