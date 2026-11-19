import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { workspaces, chatThreads } from "../src/workspaces.ts";

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),"chat-library-"));
  const workspace=workspaces.create({name:randomUUID(),description:"",workDirectory:dir});
  const threadId=randomUUID();
  const run=(index:number,thread=threadId) => {
    const runId=`${thread}-${index}`;
    workspaces.beginConsultRun({runId,workspaceId:workspace.id,promptId:null,provider:"codex",model:null,tokenHash:"fixture",expiresAt:new Date(Date.now()+60000).toISOString(),displayText:`Question ${index}`,threadId:thread});
    return runId;
  };
  return {workspace,threadId,run,cleanup:() => { workspaces.remove(workspace.id); rmSync(dir,{recursive:true,force:true}); }};
}

test("thread metadata survives new runs, title search treats wildcard input literally, and archive never changes runs",() => {
  const ctx=fixture();
  try {
    const first=ctx.run(0);
    assert.equal(chatThreads.list(ctx.workspace.id).threads.length,1);
    chatThreads.patch(ctx.workspace.id,ctx.threadId,{title:"A 100%_clear plan",pinned:true,archived:true});
    const latest=ctx.run(1);
    assert.equal(chatThreads.list(ctx.workspace.id).threads.length,0);
    const archived=chatThreads.list(ctx.workspace.id,{archived:true,query:"%_"}).threads;
    assert.equal(archived.length,1);
    assert.equal(archived[0]!.title,"A 100%_clear plan");
    assert.equal(archived[0]!.pinned,true);
    assert.equal(workspaces.sessionById(first)!.state,"STARTING");
    chatThreads.patch(ctx.workspace.id,ctx.threadId,{archived:false});
    assert.equal(chatThreads.list(ctx.workspace.id).threads.length,1);
    workspaces.finishAgentRun(latest,"error","");
    assert.equal(chatThreads.get(ctx.workspace.id,ctx.threadId).lastRunState,"ERROR");
  } finally { ctx.cleanup(); }
});

test("unread advances only for answers/decisions, read acknowledgements are bounded and monotonic",() => {
  const ctx=fixture();
  try {
    const runId=ctx.run(0);
    assert.equal(chatThreads.get(ctx.workspace.id,ctx.threadId).unread,false);
    const time=new Date(Date.now()-1000).toISOString();
    const base={id:"thought",runId,provider:"codex" as const,model:null,timestamp:time};
    workspaces.recordAgentEvent(runId,{...base,type:"assistant_text",payload:{kind:"thinking",text:"Considering",blockId:"a",delta:false}});
    assert.equal(chatThreads.get(ctx.workspace.id,ctx.threadId).unread,false);
    workspaces.recordAgentEvent(runId,{...base,id:"answer",type:"assistant_text",payload:{kind:"message",text:"An answer",blockId:"b",delta:false}});
    assert.equal(chatThreads.get(ctx.workspace.id,ctx.threadId).unread,true);
    const read=chatThreads.patch(ctx.workspace.id,ctx.threadId,{readAt:new Date().toISOString()});
    assert.equal(read.unread,false);
    assert.equal(read.lastReadAt,time);
    chatThreads.patch(ctx.workspace.id,ctx.threadId,{readAt:"2000-01-01T00:00:00.000Z"});
    assert.equal(chatThreads.get(ctx.workspace.id,ctx.threadId).lastReadAt,time);
    assert.throws(() => chatThreads.patch(ctx.workspace.id,ctx.threadId,{readAt:"2999-01-01T00:00:00.000Z"}));
  } finally { ctx.cleanup(); }
});

test("thread lists and history paginate without duplicate turns and enforce workspace scope",() => {
  const ctx=fixture(), other=fixture();
  try {
    for(let i=0;i<15;i++) ctx.run(i);
    for(let i=0;i<4;i++) ctx.run(0,randomUUID());
    const first=chatThreads.list(ctx.workspace.id,{limit:2});
    const second=chatThreads.list(ctx.workspace.id,{limit:2,cursor:first.next!});
    assert.equal(first.threads.length,2);
    assert.equal(second.threads.length,2);
    assert.equal(new Set([...first.threads,...second.threads].map(thread=>thread.id)).size,4);
    const recent=workspaces.chatThreadHistory(ctx.workspace.id,ctx.threadId);
    const earlier=workspaces.chatThreadHistory(ctx.workspace.id,ctx.threadId,recent.next!);
    assert.equal(recent.sessions.length,12);
    assert.equal(earlier.sessions.length,3);
    assert.equal(earlier.next,null);
    assert.equal(new Set([...recent.sessions,...earlier.sessions].map(session=>session.id)).size,15);
    assert.throws(() => chatThreads.get(other.workspace.id,ctx.threadId),/this workspace/);
    assert.throws(() => chatThreads.patch(other.workspace.id,ctx.threadId,{title:"Other"}));
    assert.throws(() => workspaces.chatThreadHistory(other.workspace.id,ctx.threadId));
    assert.throws(() => workspaces.chatThreadHistory(ctx.workspace.id,ctx.threadId,"foreign-run"),/cursor/);
    assert.throws(() => chatThreads.list(ctx.workspace.id,{cursor:"bad"}),/cursor/);
    for(const patch of [{title:""},{title:"x".repeat(121)},{pinned:"false"},{archived:1},{readAt:"nonsense"}]) assert.throws(() => chatThreads.patch(ctx.workspace.id,ctx.threadId,patch as never));
  } finally { ctx.cleanup(); other.cleanup(); }
});
