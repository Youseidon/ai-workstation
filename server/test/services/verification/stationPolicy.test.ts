import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProgramRecord, SuiteRecord, PromptRecord } from "@hydra/shared";
import { resolveStationPolicy } from "@hydra/shared";
import { workspaces } from "../../../src/repositories/workspaces.ts";
import { requestCommand } from "../../../src/services/execution/commandTasks.ts";
import { runDefinitionOfDoneCommands } from "../../../src/services/verification/definitionOfDone.ts";

test("saved capabilities persist, inherit through decomposition, and refuse active edits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "station-policy-"));
  const workspace = workspaces.create({name:`Policy ${dir}`,workDirectory:dir});
  const program = workspaces.createChild("program",workspace.id,{name:"Policy"}) as ProgramRecord;
  const suite = workspaces.createChild("suite",program.id,{name:"Policy"}) as SuiteRecord;
  const policy = resolveStationPolicy("No verification execution in this station. Completion evidence goes to S6-11.");
  try {
    const prompt = workspaces.createChild("prompt",suite.id,{title:"Implementation",content:"Implement the feature",stationPolicy:policy}) as PromptRecord;
    assert.deepEqual(workspaces.stationPolicy(prompt.id),policy);
    assert.deepEqual(workspaces.agentContext(workspace.id,prompt.id).prompt.stationPolicy,policy);
    await assert.rejects(requestCommand(prompt.id,123,"policy-run"),/Verification belongs/);
    const count = workspaces.tree(workspace.id).programs[0]!.suites[0]!.prompts.length;
    assert.throws(()=>workspaces.createChild("prompt",suite.id,{title:"Invalid",content:"Invalid",stationPolicy:{...policy,build:"false"}}),/Invalid stationPolicy/);
    assert.equal(workspaces.tree(workspace.id).programs[0]!.suites[0]!.prompts.length,count,"invalid capabilities must not leave an orphan station");
    workspaces.beginAgentRun({runId:"policy-run",workspaceId:workspace.id,promptId:prompt.id,provider:"cursor",model:null,tokenHash:"fixture",expiresAt:new Date(Date.now()+60000).toISOString()});
    assert.throws(()=>workspaces.setStationPolicy(prompt.id,{...policy,verification:"allowed"}),/Stop the active run/);
    workspaces.markAgentRunRunning("policy-run");
    const decomposed = workspaces.decomposePrompt("policy-run",{requestId:"policy-decompose",resumeBrief:"Author both scenarios; hand off checks",children:[{title:"First",content:"First scenario"},{title:"Second",content:"Second scenario"}]}) as {children:Array<{id:number}>};
    for (const child of decomposed.children) assert.deepEqual(workspaces.agentContext(workspace.id,child.id).prompt.stationPolicy,policy);
  } finally { workspaces.remove(workspace.id); rmSync(dir,{recursive:true,force:true}); }
});

test("a conflicting completion recipe is refused without executing or recording failed tests", async () => {
  const dir = mkdtempSync(join(tmpdir(),"station-policy-dod-"));
  const workspace = workspaces.create({name:`Policy ${dir}`,workDirectory:dir});
  try {
    const program = workspaces.createChild("program",workspace.id,{name:"Policy"}) as ProgramRecord;
    const suite = workspaces.createChild("suite",program.id,{name:"Policy"}) as SuiteRecord;
    const prompt = workspaces.createChild("prompt",suite.id,{title:"Deferred",content:"No verification execution in this station.\n\n## Verify\n```sh\nnode -e 'process.exit(0)'\n```"}) as PromptRecord;
    await assert.rejects(runDefinitionOfDoneCommands(prompt.id,"deferred-run"),/Move them to the designated Verify station/);
    assert.equal(workspaces.definitionOfDoneEvaluation(prompt.id).criteria[0]?.result,"UNVERIFIED");
  } finally { workspaces.remove(workspace.id); rmSync(dir,{recursive:true,force:true}); }
});
