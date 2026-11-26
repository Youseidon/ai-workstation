import assert from "node:assert/strict";
import test from "node:test";
import type { NormalizedEvent } from "@hydra/shared";
import { compatibleSession, conversationContext } from "../../../src/services/runs/conversationContext.ts";

const turn = (id: string, provider = "claude", role = "consult") => ({ id, provider, role, model:null, sessionId:"native", prompt:`question-${id}`,events:[{type:"assistant_text",payload:{kind:"message",blockId:"a",text:`answer-${id}`,delta:false}} as NormalizedEvent] });
test("handoffs include intervening providers, omit tools, and enforce retained bounds", () => {
  const turns = [turn("a"),turn("b","codex"),turn("c")];
  assert.match(conversationContext(turns),/question-b/);
  assert.match(conversationContext(turns),/answer-b/);
  assert.match(conversationContext(turns,1),/0 of 3/);
  assert.match(conversationContext(Array.from({length:20},(_,i)=>turn(String(i)))),/12 of 20/);
});
test("native sessions require provider, model, role and recorded permission compatibility", () => {
  const t=turn("a");
  assert.equal(compatibleSession(t,"claude",null,"consult","read"),null);
  t.events.push({type:"status",payload:{conversation:{permissionKey:"read",context:"recorded"}}} as NormalizedEvent);
  assert.equal(compatibleSession(t,"claude",null,"consult","read"),"native");
  for (const [provider,model,role,key] of [["codex",null,"consult","read"],["claude","new","consult","read"],["claude",null,"execute","read"],["claude",null,"consult","write"]] as const) assert.equal(compatibleSession(t,provider,model,role,key),null);
});

test("Ask threads persist, reopen with intervening provider history, and reject cross-workspace access", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { workspaces } = await import("../../../src/repositories/workspaces.ts");
  const dir = mkdtempSync(join(tmpdir(), "chat-context-"));
  const workspace = workspaces.create({name:`chat-context-${process.pid}`,description:"",workDirectory:dir});
  const otherDir = mkdtempSync(join(tmpdir(), "chat-other-"));
  const other = workspaces.create({name:`chat-other-${process.pid}`,description:"",workDirectory:otherDir});
  const threadId = `chat-${process.pid}`;
  try {
    for (const [index, provider] of ["claude", "codex"].entries()) {
      const runId = `${threadId}-${index}`;
      workspaces.beginConsultRun({runId,workspaceId:workspace.id,promptId:null,provider,model:null,tokenHash:"fixture",expiresAt:new Date(Date.now()+60000).toISOString(),displayText:`question-${provider}`,threadId});
      workspaces.recordAgentEvent(runId,{id:`${runId}-text`,runId,provider:provider as "claude"|"codex",model:null,timestamp:new Date().toISOString(),type:"assistant_text",payload:{blockId:"answer",kind:"message",delta:false,text:`answer-${provider}`}});
      workspaces.finishAgentRun(runId,"done","");
      const restored=workspaces.sessionById(runId)!;
      assert.equal(restored.threadId,threadId);
      assert.equal(restored.role,"consult");
    }
    const history=workspaces.conversationHistory(workspace.id,threadId);
    assert.equal(history.length,2);
    assert.match(conversationContext(history),/answer-codex/);
    assert.match(conversationContext(history),/question-claude/);
    assert.equal(compatibleSession(history.at(-1),"claude",null,"consult","read"),null);
    assert.throws(()=>workspaces.conversationHistory(other.id,threadId),/another workspace/);
  } finally {
    workspaces.remove(workspace.id); workspaces.remove(other.id); rmSync(dir,{recursive:true,force:true}); rmSync(otherDir,{recursive:true,force:true});
  }
});
