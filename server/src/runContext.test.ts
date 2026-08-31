import assert from "node:assert/strict";
import test from "node:test";
import { runContexts } from "./runContext.ts";
import { contextMarkdown } from "./agentContext.ts";

test("run context tokens are unique, scoped, revocable, and expire", async () => {
  const first=runContexts.create("run-1",1,2);
  const second=runContexts.create("run-2",3,4);
  assert.notEqual(first.token,second.token);
  assert.equal(runContexts.authenticate("run-1",first.token)?.promptId,2);
  assert.equal(runContexts.authenticate("run-1",second.token),null);
  runContexts.revoke("run-1"); assert.equal(runContexts.authenticate("run-1",first.token),null); assert.notEqual(runContexts.authenticate("run-2",second.token),null);
  const expiring=runContexts.create("run-3",5,6,1); await new Promise(resolve=>setTimeout(resolve,5)); assert.equal(runContexts.authenticate("run-3",expiring.token),null);
  runContexts.revoke("run-2");
});

test("agent context is composed from records without directing the agent to prompt files", () => {
  const markdown=contextMarkdown({
    workspace:{id:1,name:"Example",workDirectory:"/tmp",description:"Shared rules"},
    program:{id:1,externalKey:"migration",name:"Migration",overview:"Replace the legacy service."},
    suite:{id:1,externalKey:"S4",name:"Money path",overview:""},
    prompt:{id:2,suiteId:1,title:"Checkout",content:"Implement checkout.",sortOrder:0,createdAt:"",updatedAt:"",externalKey:"S4-02",status:"TODO",completedAt:null,result:"",isGate:false},
    dependencies:[{externalKey:"S4-01",title:"Cart",status:"DONE",result:"33/33 green"}],gate:null,
    history:{remarks:[{id:1,promptId:2,runId:"prior",kind:"BLOCKER",content:"Need a payment decision.",actorType:"AGENT",createdAt:"2026-08-28T00:00:00.000Z"},{id:2,promptId:2,runId:null,kind:"HUMAN_RESPONSE",content:"Use Stripe test mode.",actorType:"USER",createdAt:"2026-08-28T00:01:00.000Z"}],events:[]},
    clarifications:[],
  });
  assert.match(markdown,/S4-02 — Checkout/);
  assert.match(markdown,/S4-01 — DONE/);
  assert.match(markdown,/Implement checkout/);
  assert.match(markdown,/Need a payment decision/);
  assert.match(markdown,/Use Stripe test mode/);
  assert.match(markdown,/Incomplete implementation, a large remaining scope/);
  assert.match(markdown,/Do not repeat an earlier blocker/);
  assert.match(markdown,/exact action only the human can take/);
  assert.match(markdown,/Do not search for a Markdown prompt file/);
  assert.doesNotMatch(markdown,/PREAMBLE\.md|TRACKER\.md/);
});
