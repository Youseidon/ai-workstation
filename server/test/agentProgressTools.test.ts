import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { claudePermissionConfig, claudeQueryOptions } from "../src/adapters/claude.ts";
import { contextMarkdown, progressApiMarkdown } from "../src/agentContext.ts";
import { createLogger } from "../src/lib/logger.ts";
import { claudeProgressToolDefinitions } from "../src/adapters/claudeProgressTools.ts";
import { getAdapter } from "../src/adapters/registry.ts";
import { bindAgentProgressTools, progressToolsMarkdown, readAgentContext } from "../src/agentProgressApi.ts";
import { buildCanUseTool } from "../src/lib/claudePermissions.ts";
import { removeAgentShim, writeRunContextFile } from "../src/agentShim.ts";
import { runContexts } from "../src/runContext.ts";
import { runHub } from "../src/runHub.ts";
import { emptyBudgetSnapshot } from "../src/runner.ts";
import { agentApiReachabilityProblem, executeChannel, executeContextExtras, sandboxReadsRunFiles, savedTaskExecutePrompt } from "../src/runService.ts";
import { settings } from "../src/settings.ts";
import { DECOMPOSE_MAX_DEPTH, workspaces } from "../src/workspaces.ts";

// Scenario IDs refer to docs/telegram-task-control/scenarios/claude-sdk-tools.md.

let seq = 0;
function unique(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${seq}`;
}

function withHostAccess<T>(enabled: boolean, fn: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(settings, "hostAccess");
  Object.defineProperty(settings, "hostAccess", { configurable: true, enumerable: true, get: () => enabled });
  try {
    return fn();
  } finally {
    if (previous) Object.defineProperty(settings, "hostAccess", previous);
    else delete (settings as { hostAccess?: unknown }).hostAccess;
  }
}

function withGrokSandbox<T>(mode: string, fn: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(settings.grok, "sandboxMode");
  Object.defineProperty(settings.grok, "sandboxMode", { configurable: true, enumerable: true, get: () => mode });
  try {
    return withHostAccess(false, fn);
  } finally {
    if (previous) Object.defineProperty(settings.grok, "sandboxMode", previous);
  }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "progress-tools-"));
  const workspace = workspaces.create({ name: unique("ws"), description: "Standing rules.", workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: unique("prog"), overview: "" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: unique("suite"), overview: "" }) as SuiteRecord;
  const newPrompt = () => workspaces.createChild("prompt", suite.id, { title: unique("task"), content: "Write the release note." }) as PromptRecord;
  const prompt = newPrompt();
  return {
    workspace,
    prompt,
    newPrompt,
    cleanup() {
      workspaces.remove(workspace.id);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function startExecuteRun(workspaceId: number, promptId: number, ttlMs?: number) {
  const runId = unique("run");
  const credential = runContexts.create(runId, workspaceId, promptId, ttlMs);
  workspaces.beginAgentRun({ runId, workspaceId, promptId, provider: "claude", model: null, tokenHash: credential.tokenHash, expiresAt: credential.expiresAt, role: "execute" });
  workspaces.markAgentRunRunning(runId);
  return { runId, token: credential.token };
}

type Definitions = ReturnType<typeof claudeProgressToolDefinitions>;

function definition(definitions: Definitions, name: string) {
  const found = definitions.find((item) => item.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
}

/** Calls a tool the way the SDK's MCP server does: schema-parse the input, then run the handler. */
async function callTool(definitions: Definitions, name: string, input: Record<string, unknown>) {
  const tool = definition(definitions, name);
  const parsed = z.object(tool.inputSchema).safeParse(input);
  if (!parsed.success) return { schemaRejected: true as const, text: parsed.error.message };
  const result = await tool.handler(parsed.data as never, {});
  const text = result.content.map((block: { type: string; text?: string }) => (block.text ?? "")).join("");
  return { schemaRejected: false as const, isError: result.isError === true, text };
}

function isTerminalEvent(event: unknown, runId: string): boolean {
  const { runId: eventRun, newStatus } = event as { runId: string; newStatus: string };
  return eventRun === runId && (newStatus === "DONE" || newStatus === "BLOCKED");
}

const DONE = { requestId: "status-done-1", expectedStatus: "IN_PROGRESS", status: "DONE", reason: "Completed", verificationSummary: "npm test passed" };

test("a done reported through the tools runs the item's Verify commands, as a done over HTTP does", async () => {
  // The gate that closes an item only reads recorded results; something has to
  // run the commands first. The HTTP route did and the tool path did not, so a
  // Claude run that finished its work was refused as "not verified" every time,
  // retried until its continuations ran out, and parked a pipeline whose checks
  // would all have passed.
  const f = fixture();
  try {
    const passing = workspaces.createChild("prompt", workspaces.promptHome(f.prompt.id).suiteId, { title: unique("verified"), content: "Do it.\n\n## Verify\n\n```sh\ntrue\n```\n" }) as PromptRecord;
    const run = startExecuteRun(f.workspace.id, passing.id);
    const done = await callTool(claudeProgressToolDefinitions(bindAgentProgressTools(run.runId, run.token)), "post_status", DONE);
    assert.equal(done.isError, false, done.text);
    assert.equal(workspaces.promptOutcome(passing.id).status, "DONE");

    // A failing command is handed back while the run can still act on it; the
    // item stays in progress instead of ending the run on NEEDS_REVIEW.
    const failing = workspaces.createChild("prompt", workspaces.promptHome(f.prompt.id).suiteId, { title: unique("unverified"), content: "Do it.\n\n## Verify\n\n```sh\necho broken; exit 3\n```\n" }) as PromptRecord;
    const second = startExecuteRun(f.workspace.id, failing.id);
    const refused = await callTool(claudeProgressToolDefinitions(bindAgentProgressTools(second.runId, second.token)), "post_status", DONE);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /^verification_failed: /);
    assert.match(refused.text, /broken/, "the command's output is in the refusal");
    assert.equal(workspaces.promptOutcome(failing.id).status, "IN_PROGRESS");
    const remarks = workspaces.promptHistory(failing.id).remarks as Array<{ kind: string; content: string }>;
    assert.equal(remarks.some((remark) => remark.kind === "VERIFICATION" && remark.content.includes("broken")), true, "the failure is banked for the next run");

    // The refusal tells the run to post `continue` if it cannot fix the check,
    // so the tool has to take one: the item is re-queued with the brief.
    const tools = claudeProgressToolDefinitions(bindAgentProgressTools(second.runId, second.token));
    const empty = await callTool(tools, "post_status", { ...DONE, requestId: "status-continue-0", status: "CONTINUE", reason: "", verificationSummary: "" });
    assert.ok(!empty.schemaRejected && empty.isError, "a continue with nothing remaining is refused by the server");
    const resumed = await callTool(tools, "post_status", { ...DONE, requestId: "status-continue-1", status: "CONTINUE", reason: "Make the check print ok instead of broken.", verificationSummary: "" });
    assert.ok(!resumed.schemaRejected && !resumed.isError, resumed.text);
    assert.equal(workspaces.promptOutcome(failing.id).status, "TODO");
    const after = workspaces.promptHistory(failing.id).remarks as Array<{ kind: string; content: string }>;
    assert.equal(after.some((remark) => remark.kind === "CONTINUATION" && remark.content === "Make the check print ok instead of broken."), true, "the brief is left for the run that resumes it");
  } finally {
    f.cleanup();
  }
});

test("a Verify command that is itself wrong can be repaired through the tools, and the done then lands", async () => {
  // The work is right and the check is not: the file holds what it should, and
  // the command greps for a word that was never asked for. Without a repair the
  // same command refused every done this run could post.
  const f = fixture();
  try {
    writeFileSync(join(f.workspace.workDirectory, "note.json"), "{}\n");
    const wrong = "test -f note.json && grep -q released note.json";
    const right = "test -f note.json && grep -q '{' note.json";
    const prompt = workspaces.createChild("prompt", workspaces.promptHome(f.prompt.id).suiteId, { title: unique("repair"), content: `Write it.\n\n## Verify\n\n\`\`\`sh\n${wrong}\n\`\`\`\n` }) as PromptRecord;
    const run = startExecuteRun(f.workspace.id, prompt.id);
    const tools = claudeProgressToolDefinitions(bindAgentProgressTools(run.runId, run.token));
    const repair = { requestId: "repair-verify-1", oldCommand: wrong, newCommand: right, reason: "The note is JSON and was never meant to contain that word." };

    const early = await callTool(tools, "repair_verify", { ...repair, requestId: "repair-verify-0" });
    assert.ok(!early.schemaRejected && early.isError);
    assert.match(early.text, /^verify_not_failed: /, "only a command the server has seen fail can be replaced");

    const refused = await callTool(tools, "post_status", DONE);
    assert.ok(!refused.schemaRejected && refused.isError);
    assert.match(refused.text, /^verification_failed: /);
    assert.match(refused.text, /`repair_verify`/, "the refusal names the tool that repairs a wrong command");

    const weakened = await callTool(tools, "repair_verify", { ...repair, requestId: "repair-verify-2", newCommand: "test -f note.json && true" });
    assert.ok(!weakened.schemaRejected && weakened.isError);
    assert.match(weakened.text, /^unsafe_verify_repair: /, "a repair cannot be a way to stop checking");

    const repaired = await callTool(tools, "repair_verify", repair);
    assert.ok(!repaired.schemaRejected && !repaired.isError, repaired.text);
    assert.deepEqual((JSON.parse(repaired.text) as { failures: unknown[] }).failures, [], "the commands were run again and none fails");
    assert.match(workspaces.promptActivity(prompt.id).item.prompt.content, /grep -q '\{' note\.json/);

    const done = await callTool(tools, "post_status", { ...DONE, requestId: "status-done-2" });
    assert.ok(!done.schemaRejected && !done.isError, done.text);
    assert.equal(workspaces.promptOutcome(prompt.id).status, "DONE");
  } finally {
    f.cleanup();
  }
});

test("every trip a run makes through the tools is in the access log, refusals included", async () => {
  // The log answers "did this agent talk to the app, and what did it change?".
  // Only the HTTP route wrote it, so a Claude run that posted and was refused
  // looked exactly like one that never tried.
  const f = fixture();
  try {
    const prompt = workspaces.createChild("prompt", workspaces.promptHome(f.prompt.id).suiteId, { title: unique("logged"), content: "Do it.\n\n## Verify\n\n```sh\necho broken; exit 3\n```\n" }) as PromptRecord;
    const run = startExecuteRun(f.workspace.id, prompt.id);
    const tools = claudeProgressToolDefinitions(bindAgentProgressTools(run.runId, run.token));
    await callTool(tools, "get_context", {});
    await callTool(tools, "post_remark", { requestId: "remark-logged-1", kind: "FINDING", content: "noted" });
    await callTool(tools, "post_status", DONE);
    await callTool(tools, "post_status", { ...DONE, requestId: "status-continue-1", status: "CONTINUE", reason: "Fix the check.", verificationSummary: "" });

    const lines = workspaces.runEvents(run.runId).filter((event) => event.type === "db_access").map((event) => {
      const { method, operation, outcome, httpStatus, errorCode, changed, requestId } = event.payload;
      return { method, operation, outcome, httpStatus, errorCode, changed, requestId };
    });
    assert.deepEqual(lines, [
      { method: "TOOL", operation: "context", outcome: "accepted", httpStatus: 200, errorCode: null, changed: [], requestId: null },
      { method: "TOOL", operation: "remarks", outcome: "accepted", httpStatus: 200, errorCode: null, changed: ["prompt_remark"], requestId: "remark-logged-1" },
      { method: "TOOL", operation: "status", outcome: "rejected", httpStatus: 409, errorCode: "verification_failed", changed: [], requestId: "status-done-1" },
      { method: "TOOL", operation: "status", outcome: "accepted", httpStatus: 200, errorCode: null, changed: ["prompt", "prompt_status_event"], requestId: "status-continue-1" },
    ]);
    const summaries = workspaces.runEvents(run.runId).filter((event) => event.type === "db_access").map((event) => event.payload.summary);
    assert.equal(summaries[1], "+1 FINDING remark");
    assert.equal(summaries[3], "IN_PROGRESS → TODO");
  } finally {
    f.cleanup();
  }
});

test("a cut section tells each run how it can get the rest, and a run that cannot ask is given a file to read", async () => {
  // The notice named `agent-step context --full` for every run. A tools run has
  // no launcher and an offline run can call nothing at all, so for both the
  // rest of a long section was simply out of reach.
  const f = fixture();
  try {
    const program = workspaces.createChild("program", f.workspace.id, { name: unique("long"), overview: `${"y".repeat(3000)} TAIL-OF-THE-OVERVIEW` }) as ProgramRecord;
    const suite = workspaces.createChild("suite", program.id, { name: unique("suite"), overview: "" }) as SuiteRecord;
    const prompt = workspaces.createChild("prompt", suite.id, { title: unique("task"), content: "Write the release note." }) as PromptRecord;
    const run = startExecuteRun(f.workspace.id, prompt.id);
    const tools = claudeProgressToolDefinitions(bindAgentProgressTools(run.runId, run.token));

    const capped = await callTool(tools, "get_context", {});
    assert.ok(!capped.schemaRejected && !capped.isError);
    assert.match(capped.text, /truncated; call `get_context` with `full: true` for everything/);
    assert.doesNotMatch(capped.text, /agent-step context --full|TAIL-OF-THE-OVERVIEW/);
    const full = await callTool(tools, "get_context", { full: true });
    assert.ok(!full.schemaRejected && !full.isError);
    assert.match(full.text, /TAIL-OF-THE-OVERVIEW/);
    assert.doesNotMatch(full.text, /truncated/);
    assert.match(progressToolsMarkdown(), /call it with `full: true` for everything/);

    // A run with the launcher is told what it always was.
    assert.match(readAgentContext(run.runId, run.token, "http").markdown, /truncated; run `agent-step context --full` for everything/);

    assert.deepEqual(executeContextExtras("shim", 0), { depth: 0, maxDepth: DECOMPOSE_MAX_DEPTH });
    assert.deepEqual(executeContextExtras("tools", 1), { depth: 1, maxDepth: DECOMPOSE_MAX_DEPTH, progressTools: { getContext: "get_context", postRemark: "post_remark", postStatus: "post_status", repairVerify: "repair_verify", decompose: "decompose" } });
    // An offline run can call nothing, but it can read: the whole context goes
    // into a file for it, and its prompt stays the size everyone else's is.
    assert.deepEqual(executeContextExtras("offline", 0), { depth: 0, maxDepth: DECOMPOSE_MAX_DEPTH, offline: true, fullContextPath: null });
    const whole = contextMarkdown(workspaces.agentContext(f.workspace.id, prompt.id, { full: true }), "execute", { ...executeContextExtras("offline", 0), full: true });
    const file = writeRunContextFile(run.runId, whole);
    assert.ok(file !== null);
    try {
      assert.match(readFileSync(file, "utf8"), /TAIL-OF-THE-OVERVIEW/);
      assert.doesNotMatch(readFileSync(file, "utf8"), /truncated/);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      const inlined = contextMarkdown(workspaces.agentContext(f.workspace.id, prompt.id), "execute", executeContextExtras("offline", 0, file));
      assert.ok(inlined.includes(`…(truncated; the full text of this context is in the file ${file})`));
      assert.doesNotMatch(inlined, /agent-step context --full|TAIL-OF-THE-OVERVIEW/);
    } finally {
      removeAgentShim(run.runId);
    }
    assert.equal(existsSync(file), false, "the file goes when the run's directory does");
    // With no file it can read, the run is told the rest is out of reach, not sent to a command.
    const inlined = contextMarkdown(workspaces.agentContext(f.workspace.id, prompt.id), "execute", executeContextExtras("offline", 0, null));
    assert.match(inlined, /truncated; the rest is not available to this run/);
    assert.doesNotMatch(inlined, /agent-step context --full/);
    withGrokSandbox("strict", () => assert.equal(sandboxReadsRunFiles("grok"), false));
    withGrokSandbox("workspace", () => assert.equal(sandboxReadsRunFiles("grok"), true));
    assert.equal(sandboxReadsRunFiles("codex"), true);

    // How it ends is told in the one thing an offline run can do: its status block.
    const ending = inlined.slice(inlined.indexOf("## How this run ends"));
    assert.match(ending, /exactly one `agent-status` block saying DONE, CONTINUE or BLOCKED/);
    assert.doesNotMatch(ending, /agent-step|decompose|remark --kind/);
  } finally {
    f.cleanup();
  }
});

test("a run is stopped once its status is accepted through the tools, and only then", async () => {
  // Over HTTP a status post ends the provider. The tool path left it running, so
  // a run could go on editing a tree whose checks had already passed.
  const f = fixture();
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const live = (runId: string) => {
    let stops = 0;
    runHub.start({
      handle: { runId, provider: "claude", model: null, role: "execute", permissionMode: null, budget: emptyBudgetSnapshot, sessionId: () => null, interrupt: async () => {}, complete: async () => { stops += 1; }, done: Promise.resolve("done") },
      workspace: { id: f.workspace.id, name: f.workspace.name, workDirectory: f.workspace.workDirectory },
      source: { type: "custom", displayText: "x" },
      role: "execute",
      permissionMode: null,
    });
    return { stops: () => stops, end: () => runHub.end(runId, "done") };
  };
  try {
    const failing = workspaces.createChild("prompt", workspaces.promptHome(f.prompt.id).suiteId, { title: unique("stop"), content: "Do it.\n\n## Verify\n\n```sh\nexit 3\n```\n" }) as PromptRecord;
    const run = startExecuteRun(f.workspace.id, failing.id);
    const hub = live(run.runId);
    try {
      const tools = claudeProgressToolDefinitions(bindAgentProgressTools(run.runId, run.token));
      await callTool(tools, "post_remark", { requestId: "remark-stop-1", kind: "PROGRESS", content: "x" });
      const refused = await callTool(tools, "post_status", DONE);
      assert.ok(!refused.schemaRejected && refused.isError);
      await tick();
      assert.equal(hub.stops(), 0, "a remark and a refused done leave the run alive to act on them");
      const resumed = await callTool(tools, "post_status", { ...DONE, requestId: "status-continue-1", status: "CONTINUE", reason: "Fix the check.", verificationSummary: "" });
      assert.ok(!resumed.schemaRejected && !resumed.isError, resumed.text);
      await tick();
      assert.equal(hub.stops(), 1, "an accepted status stops the provider");
    } finally {
      hub.end();
    }
  } finally {
    f.cleanup();
  }
});

test("a run can split its work item into sub-steps through the tools, under the rules the launcher has", async () => {
  // Every other provider could decompose; a run on the tool path could only
  // post continue and have the same oversized item handed back whole.
  const f = fixture();
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  try {
    const run = startExecuteRun(f.workspace.id, f.prompt.id);
    let stops = 0;
    runHub.start({
      handle: { runId: run.runId, provider: "claude", model: null, role: "execute", permissionMode: null, budget: emptyBudgetSnapshot, sessionId: () => null, interrupt: async () => {}, complete: async () => { stops += 1; }, done: Promise.resolve("done") },
      workspace: { id: f.workspace.id, name: f.workspace.name, workDirectory: f.workspace.workDirectory },
      source: { type: "custom", displayText: "x" },
      role: "execute",
      permissionMode: null,
    });
    try {
      const tools = claudeProgressToolDefinitions(bindAgentProgressTools(run.runId, run.token));
      const child = (title: string) => ({ title, content: `Do ${title}.\n\n## Verify\n\n\`\`\`sh\ntrue\n\`\`\`\n` });
      const single = await callTool(tools, "decompose", { requestId: "decompose-0", resumeBrief: "Nothing yet.", children: [child("only one")] });
      assert.equal(single.schemaRejected, true, "one sub-step is not a split");

      const first = unique("slice-a");
      const second = unique("slice-b");
      const split = await callTool(tools, "decompose", { requestId: "decompose-1", resumeBrief: "The outline is written; join the two halves once they are done.", children: [child(first), child(second)] });
      assert.ok(!split.schemaRejected && !split.isError, split.text);
      const created = (JSON.parse(split.text) as { children: Array<{ id: number; title: string }> }).children;
      assert.deepEqual(created.map((entry) => entry.title), [first, second]);
      assert.equal(workspaces.promptOutcome(f.prompt.id).status, "TODO", "the parent waits for its sub-steps");
      for (const entry of created) {
        assert.equal(workspaces.promptOutcome(entry.id).status, "TODO");
        assert.equal(workspaces.dodCommandPlan(entry.id).criteria.some((criterion) => criterion.command === "true"), true, "a sub-step's Verify section is its own check");
      }
      await tick();
      assert.equal(stops, 1, "a split ends the run, as a status does");
      const logged = workspaces.runEvents(run.runId).filter((event) => event.type === "db_access").map((event) => `${event.payload.method} ${event.payload.operation} ${event.payload.outcome}`);
      assert.deepEqual(logged, ["TOOL decompose accepted"]);

      // A sub-step two levels down is refused a further split, and is not offered one.
      const childRun = startExecuteRun(f.workspace.id, created[0]!.id);
      const childTools = claudeProgressToolDefinitions(bindAgentProgressTools(childRun.runId, childRun.token));
      const deeper = await callTool(childTools, "decompose", { requestId: "decompose-2", resumeBrief: "x", children: [child(unique("deep-a")), child(unique("deep-b"))] });
      assert.ok(!deeper.schemaRejected && !deeper.isError, "one level down may still split");
      const grandchild = (JSON.parse(deeper.text) as { children: Array<{ id: number }> }).children[0]!.id;
      const leafRun = startExecuteRun(f.workspace.id, grandchild);
      const refused = await callTool(claudeProgressToolDefinitions(bindAgentProgressTools(leafRun.runId, leafRun.token)), "decompose", { requestId: "decompose-3", resumeBrief: "x", children: [child(unique("leaf-a")), child(unique("leaf-b"))] });
      assert.ok(!refused.schemaRejected && refused.isError);
      assert.match(refused.text, /^decompose_depth_exceeded: /);
      const leafContext = readAgentContext(leafRun.runId, leafRun.token, "tools").markdown;
      assert.match(leafContext, /`decompose` is refused at this depth/);
      assert.match(progressToolsMarkdown(), /`decompose` splits the remaining work/);
      assert.doesNotMatch(progressToolsMarkdown({ canDecompose: false }), /`decompose`/);
    } finally {
      runHub.end(run.runId, "done");
    }
  } finally {
    f.cleanup();
  }
});

test("S-CLT-01/24: Claude takes the tool path and exposes exactly the five progress tools", () => {
  assert.equal(getAdapter("claude").supportsProgressTools, true);
  for (const provider of ["codex", "grok", "cursor"] as const) assert.equal(getAdapter(provider).supportsProgressTools, false);
  withHostAccess(false, () => {
    assert.equal(agentApiReachabilityProblem("claude"), null);
    assert.match(agentApiReachabilityProblem("codex") ?? "", /cannot reach the saved-prompt context/);
  });
  const names = claudeProgressToolDefinitions(bindAgentProgressTools("run_none", "none")).map((item) => item.name).sort();
  assert.deepEqual(names, ["decompose", "get_context", "post_remark", "post_status", "repair_verify"]);
});

test("S-CLT-01/09/26: only runs given progress tools get the in-process server; permissions are otherwise identical", () => {
  const base = { runId: "run_opts", cwd: tmpdir(), signal: new AbortController().signal, model: null, log: createLogger("test") };
  withHostAccess(false, () => {
    const withTools = claudeQueryOptions({ ...base, permissionOverride: "inherit", progressTools: bindAgentProgressTools("run_opts", "t") }, new AbortController());
    const server = withTools.mcpServers?.["agent-console"] as { type?: string; instance?: unknown } | undefined;
    assert.equal(server?.type, "sdk");
    assert.ok(server?.instance);
    assert.deepEqual(Object.keys(withTools.mcpServers ?? {}), ["agent-console"]);

    const without = claudeQueryOptions({ ...base, permissionOverride: "inherit" }, new AbortController());
    assert.equal(without.mcpServers, undefined);
    const strip = (options: typeof without) => ({ ...options, mcpServers: undefined, abortController: undefined, canUseTool: typeof options.canUseTool, stderr: undefined });
    assert.deepEqual(strip(withTools), strip(without));

    const consult = claudeQueryOptions({ ...base, permissionOverride: "consult" }, new AbortController());
    assert.equal(consult.mcpServers, undefined);
    assert.equal(consult.permissionMode, "plan");
  });
});

test("S-CLT-20/21/25: every channel is chosen once, and only the launcher channel carries a token", () => {
  const token = "tok_" + "x".repeat(32);
  withHostAccess(false, () => {
    assert.equal(executeChannel("claude", agentApiReachabilityProblem("claude")), "tools");
    assert.equal(executeChannel("grok", agentApiReachabilityProblem("grok")), "offline");
    assert.equal(executeChannel("cursor", agentApiReachabilityProblem("cursor")), "shim");
  });
  withHostAccess(true, () => {
    assert.equal(executeChannel("grok", agentApiReachabilityProblem("grok")), "shim");
  });

  const context = "## Work item\n\nRename the INSTALL section.";
  const tools = savedTaskExecutePrompt({ taskLabel: "REL-1", context, channel: "tools", contract: progressToolsMarkdown() });
  assert.doesNotMatch(tools, /curl|Bearer|\/api\/agent\/runs\//);
  assert.ok(!tools.includes(token));
  assert.match(tools, /`post_status` records exactly one terminal status/);
  assert.match(tools, /never open or modify SQLite directly/);
  assert.match(tools, /## Progress tools/);
  assert.match(tools, /BLOCKED is only valid for a concrete external dependency/);
  assert.ok(tools.includes(context));

  const shim = savedTaskExecutePrompt({ taskLabel: "REL-1", context, channel: "shim", contract: progressApiMarkdown({ runId: "run_abc", token, port: 4000, canDecompose: true, shimPath: "/tmp/run_abc/agent-step" }) });
  assert.match(shim, /"\/tmp\/run_abc\/agent-step" done --verification/);
  assert.doesNotMatch(shim, /curl/);
  assert.ok(!shim.includes(token));

  const offline = savedTaskExecutePrompt({ taskLabel: "REL-1", context, channel: "offline", contract: "## Offline completion reporting\n\nnone" });
  assert.match(offline, /## Offline completion reporting/);
  assert.doesNotMatch(offline, /agent-step|curl|Bearer/);
  assert.match(offline, /nothing in this run can reach it/);

  // The prompt is assembled in exactly one place. Two branches each building a
  // prompt is what let a merge overwrite the offline one and leave every
  // sandboxed run unable to report (gap M-9), and a green suite did not see it.
  const source = readFileSync(new URL("../src/runService.ts", import.meta.url), "utf8");
  const savedTaskBody = source.slice(source.indexOf("const taskLabel = record.externalKey"), source.indexOf("  } else {\n    resolvedPrompt = prompt?.trim()"));
  assert.equal(savedTaskBody.match(/resolvedPrompt = /g)?.length, 1);
});

test("the context of a run that reports through tools ends in the tools it has, not in agent-step", () => {
  // The section was written for the launcher and reached tools runs unchanged:
  // it sent them to a command they do not have and offered `decompose`, which
  // has no tool.
  const f = fixture();
  try {
    const run = startExecuteRun(f.workspace.id, f.prompt.id);
    const protocol = (markdown: string) => markdown.slice(markdown.indexOf("## How this run ends")).split("\n## ")[0] as string;
    const tools = protocol(readAgentContext(run.runId, run.token, "tools").markdown);
    assert.match(tools, /Post exactly one of DONE, CONTINUE or BLOCKED with the `post_status` tool, or split the work with `decompose`\./);
    assert.match(tools, /Bank progress with `post_remark`/);
    assert.doesNotMatch(tools, /agent-step/);
    const http = protocol(readAgentContext(run.runId, run.token, "http").markdown);
    assert.match(http, /through `agent-step` \(below\)/, "a run with the launcher is told what it always was");
    assert.match(http, /decompose/);
  } finally {
    f.cleanup();
  }
});

test("S-CLT-04/05/06/28: remarks, DONE status and context work through the tools without leaking the credential", async () => {
  const f = fixture();
  try {
    const run = startExecuteRun(f.workspace.id, f.prompt.id);
    const tools = claudeProgressToolDefinitions(bindAgentProgressTools(run.runId, run.token));

    const context = await callTool(tools, "get_context", {});
    assert.equal(context.schemaRejected, false);
    assert.ok(!context.schemaRejected && !context.isError);
    assert.match(context.text, /Write the release note\./);
    assert.doesNotMatch(context.text, /## Progress|curl|Bearer|\/api\/agent\/runs\//);
    const http = readAgentContext(run.runId, run.token, "http");
    assert.ok(http.purpose === "execute");
    // Up to how the run ends, which names the channel each of them reports through.
    const workItem = (markdown: string) => markdown.slice(0, markdown.indexOf("## How this run ends"));
    assert.equal(workItem(context.text), workItem(http.markdown), "tool context carries the same work item as the HTTP context");

    for (const kind of ["PROGRESS", "FINDING", "DECISION_NEEDED", "BLOCKER", "VERIFICATION", "COMPLETION"]) {
      const remark = await callTool(tools, "post_remark", { requestId: `remark-${kind.toLowerCase().replaceAll("_", "-")}`, kind, content: `${kind} note` });
      assert.ok(!remark.schemaRejected && !remark.isError, remark.text);
      const parsed = JSON.parse(remark.text) as { kind: string; runId: string; promptId: number; actorType: string };
      assert.deepEqual([parsed.kind, parsed.runId, parsed.promptId, parsed.actorType], [kind, run.runId, f.prompt.id, "AGENT"]);
    }

    const status = await callTool(tools, "post_status", DONE);
    assert.ok(!status.schemaRejected && !status.isError, status.text);
    assert.equal(workspaces.resolvePrompt(f.workspace.id, f.prompt.id).status, "DONE");
    const history = workspaces.promptHistory(f.prompt.id);
    assert.equal(history.events.filter((event) => isTerminalEvent(event, run.runId)).length, 1);

    const everything = [context.text, status.text].join("\n");
    assert.ok(!everything.includes(run.token));
  } finally {
    f.cleanup();
  }
});

test("S-CLT-03 (T0 part): BLOCKED through the tool records the human action the phone card shows", async () => {
  const f = fixture();
  try {
    const run = startExecuteRun(f.workspace.id, f.prompt.id);
    const tools = claudeProgressToolDefinitions(bindAgentProgressTools(run.runId, run.token));
    const blocked = await callTool(tools, "post_status", { requestId: "status-blocked-1", expectedStatus: "IN_PROGRESS", status: "BLOCKED", reason: "The release date is not decided.", verificationSummary: "Choose the release date." });
    assert.ok(!blocked.schemaRejected && !blocked.isError, blocked.text);
    assert.equal(workspaces.resolvePrompt(f.workspace.id, f.prompt.id).status, "BLOCKED");
    const blocker = workspaces.promptHistory(f.prompt.id).remarks.at(-1) as { kind: string; content: string; actorType: string };
    assert.deepEqual([blocker.kind, blocker.actorType], ["BLOCKER", "AGENT"]);
    assert.match(blocker.content, /The release date is not decided\.\n\nRequired human action: Choose the release date\./);
  } finally {
    f.cleanup();
  }
});

test("S-CLT-07/08/09: read-only runs are refused and never get write tools", async () => {
  const f = fixture();
  try {
    const consultId = unique("run");
    const consult = runContexts.create(consultId, f.workspace.id, f.prompt.id, undefined, "why?");
    workspaces.beginConsultRun({ runId: consultId, workspaceId: f.workspace.id, promptId: f.prompt.id, provider: "claude", model: null, tokenHash: consult.tokenHash, expiresAt: consult.expiresAt });
    workspaces.markAgentRunRunning(consultId);
    const handoffId = unique("run");
    const handoff = runContexts.create(handoffId, f.workspace.id, f.prompt.id);
    workspaces.beginHandoffAgentRun({ runId: handoffId, workspaceId: f.workspace.id, promptId: f.prompt.id, provider: "claude", model: null, tokenHash: handoff.tokenHash, expiresAt: handoff.expiresAt });

    for (const [runId, token] of [[consultId, consult.token], [handoffId, handoff.token]] as const) {
      const tools = claudeProgressToolDefinitions(bindAgentProgressTools(runId, token));
      const remark = await callTool(tools, "post_remark", { requestId: "remark-001", kind: "PROGRESS", content: "writing" });
      const status = await callTool(tools, "post_status", DONE);
      for (const result of [remark, status]) {
        assert.ok(!result.schemaRejected && result.isError);
        assert.match(result.text, /^consult_read_only: /);
      }
    }
    assert.equal(workspaces.resolvePrompt(f.workspace.id, f.prompt.id).status, "TODO");
    assert.equal(workspaces.promptHistory(f.prompt.id).remarks.length, 0);

    // Only a saved-task execute run and the wrap-up turn that speaks for it bind
    // tools; consult, clarify and handoff start without them.
    const source = readFileSync(new URL("../src/runService.ts", import.meta.url), "utf8");
    assert.equal(source.match(/bindAgentProgressTools\(/g)?.length, 2);
    assert.match(source.slice(source.indexOf("export async function startWrapUp")), /bindAgentProgressTools\(plannedRunId, credential\.token\)/);
    const handoffSource = readFileSync(new URL("../src/handoffCoordinator.ts", import.meta.url), "utf8");
    assert.doesNotMatch(handoffSource, /progressTools/);
  } finally {
    f.cleanup();
  }
});

test("S-CLT-10/19: expired, revoked or restart-lost credentials are refused with no write", async () => {
  const f = fixture();
  try {
    const expired = startExecuteRun(f.workspace.id, f.prompt.id, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const tools = claudeProgressToolDefinitions(bindAgentProgressTools(expired.runId, expired.token));
    for (const [name, input] of [["get_context", {}], ["post_remark", { requestId: "remark-002", kind: "PROGRESS", content: "x" }], ["post_status", DONE]] as const) {
      const result = await callTool(tools, name, input);
      assert.ok(!result.schemaRejected && result.isError);
      assert.match(result.text, /^invalid_run_token: /);
      assert.ok(!result.text.includes(expired.token));
    }
    workspaces.finishAgentRun(expired.runId, "interrupted");

    const other = f.newPrompt();
    const revoked = startExecuteRun(f.workspace.id, other.id);
    runContexts.revoke(revoked.runId); // what a server restart does to in-memory credentials
    const result = await callTool(claudeProgressToolDefinitions(bindAgentProgressTools(revoked.runId, revoked.token)), "post_status", DONE);
    assert.ok(!result.schemaRejected && result.isError);
    assert.match(result.text, /^invalid_run_token: /);
    assert.equal(workspaces.resolvePrompt(f.workspace.id, other.id).status, "IN_PROGRESS");
  } finally {
    f.cleanup();
  }
});

test("S-CLT-11/12: tools are bound to their run; model-supplied ids cannot redirect them", async () => {
  const f = fixture();
  try {
    const a = startExecuteRun(f.workspace.id, f.prompt.id);
    const promptB = f.newPrompt();
    const b = startExecuteRun(f.workspace.id, promptB.id);
    const toolsA = claudeProgressToolDefinitions(bindAgentProgressTools(a.runId, a.token));
    for (const tool of toolsA) assert.deepEqual(Object.keys(tool.inputSchema).filter((key) => /run|prompt|token/i.test(key)), []);
    const remark = await callTool(toolsA, "post_remark", { requestId: "remark-001", kind: "PROGRESS", content: "on A", runId: b.runId, promptId: promptB.id, token: b.token });
    assert.ok(!remark.schemaRejected && !remark.isError, remark.text);
    assert.equal((JSON.parse(remark.text) as { runId: string }).runId, a.runId);
    assert.equal(workspaces.promptHistory(promptB.id).remarks.length, 0);

    const crossed = await callTool(claudeProgressToolDefinitions(bindAgentProgressTools(b.runId, a.token)), "post_status", DONE);
    assert.ok(!crossed.schemaRejected && crossed.isError);
    assert.match(crossed.text, /^invalid_run_token: /);
    assert.equal(workspaces.resolvePrompt(f.workspace.id, promptB.id).status, "IN_PROGRESS");
  } finally {
    f.cleanup();
  }
});

test("S-CLT-13/14: invalid input and invalid transitions are refused readably with nothing written", async () => {
  const f = fixture();
  try {
    const run = startExecuteRun(f.workspace.id, f.prompt.id);
    const tools = claudeProgressToolDefinitions(bindAgentProgressTools(run.runId, run.token));
    const schemaRejects = [
      ["post_remark", { requestId: "remark-002", kind: "SHOUT", content: "x" }],
      ["post_remark", { requestId: "remark-002", kind: "PROGRESS", content: "" }],
      ["post_remark", { requestId: "remark-002", kind: "PROGRESS", content: "x".repeat(20001) }],
      ["post_remark", { requestId: "short", kind: "PROGRESS", content: "x" }],
      ["post_remark", { requestId: "has space in it", kind: "PROGRESS", content: "x" }],
      ["post_status", { ...DONE, status: "SKIPPED" }],
      ["post_status", { ...DONE, expectedStatus: "TODO" }],
    ] as const;
    for (const [name, input] of schemaRejects) assert.equal((await callTool(tools, name, input)).schemaRejected, true, JSON.stringify(input).slice(0, 80));

    const handlerRejects = [
      [{ ...DONE, requestId: "status-s1", verificationSummary: "" }, /^validation_error: verificationSummary is required/],
      [{ ...DONE, requestId: "status-s2", status: "BLOCKED", reason: "" }, /^validation_error: reason is required/],
      [{ ...DONE, requestId: "status-s3", status: "BLOCKED", reason: "evidence", verificationSummary: "" }, /^validation_error: (verificationSummary is required|BLOCKED requires verificationSummary)/],
    ] as const;
    for (const [input, expected] of handlerRejects) {
      const result = await callTool(tools, "post_status", input);
      assert.ok(!result.schemaRejected && result.isError);
      assert.match(result.text, expected);
    }
    assert.equal(workspaces.resolvePrompt(f.workspace.id, f.prompt.id).status, "IN_PROGRESS");
    assert.equal(workspaces.promptHistory(f.prompt.id).remarks.length, 0);

    assert.ok(!(await callTool(tools, "post_status", DONE)).isError);
    const late = await callTool(tools, "post_status", { ...DONE, requestId: "status-s4", status: "BLOCKED", reason: "late", verificationSummary: "late" });
    assert.ok(!late.schemaRejected && late.isError);
    assert.match(late.text, /^stale_status: /);
  } finally {
    f.cleanup();
  }
});

test("S-CLT-15/16: retries return the recorded result; a second terminal status loses", async () => {
  const f = fixture();
  try {
    const run = startExecuteRun(f.workspace.id, f.prompt.id);
    const tools = claudeProgressToolDefinitions(bindAgentProgressTools(run.runId, run.token));
    const first = await callTool(tools, "post_remark", { requestId: "same-request", kind: "PROGRESS", content: "one" });
    const again = await callTool(tools, "post_remark", { requestId: "same-request", kind: "PROGRESS", content: "one" });
    assert.equal(again.text, first.text);
    assert.equal(workspaces.promptHistory(f.prompt.id).remarks.length, 1);
    const conflict = await callTool(tools, "post_status", { ...DONE, requestId: "same-request" });
    assert.ok(!conflict.schemaRejected && conflict.isError);
    assert.match(conflict.text, /^request_id_conflict: /);

    const [done, blocked] = await Promise.all([
      callTool(tools, "post_status", DONE),
      callTool(tools, "post_status", { ...DONE, requestId: "other-request", status: "BLOCKED", reason: "x", verificationSummary: "y" }),
    ]);
    assert.ok(!done.schemaRejected && !done.isError);
    assert.ok(!blocked.schemaRejected && blocked.isError);
    const retry = await callTool(tools, "post_status", DONE);
    assert.equal(retry.text, done.text);
    assert.equal(workspaces.promptHistory(f.prompt.id).events.filter((event) => isTerminalEvent(event, run.runId)).length, 1);
  } finally {
    f.cleanup();
  }
});

test("S-CLT-17/18: after the run ends, tools cannot overwrite the finalized status", async () => {
  const f = fixture();
  try {
    const run = startExecuteRun(f.workspace.id, f.prompt.id);
    const tools = claudeProgressToolDefinitions(bindAgentProgressTools(run.runId, run.token));
    workspaces.finishAgentRun(run.runId, "done");
    runContexts.complete(run.runId);
    // A run that ends without posting now finalizes as UNREPORTED rather than
    // BLOCKED. Upstream's reading is the right one: BLOCKED is what the
    // pipeline parks on for a human, and "the run said nothing" is not a
    // question anyone can answer. The assertion still pins the same thing -
    // that the end of the run finalizes a status, that the status names the
    // cause, and that a late tool call cannot overwrite it.
    const finalized = "UNREPORTED";
    assert.equal(workspaces.resolvePrompt(f.workspace.id, f.prompt.id).status, finalized);
    const events = workspaces.promptHistory(f.prompt.id).events as Array<{ reason: string }>;
    assert.ok(events.some((event) => /ended done without posting a status/.test(event.reason)));
    const late = await callTool(tools, "post_status", DONE);
    assert.ok(!late.schemaRejected && late.isError);
    assert.match(late.text, /^(run_not_active|invalid_run_token): /);
    assert.equal(workspaces.resolvePrompt(f.workspace.id, f.prompt.id).status, finalized);
  } finally {
    f.cleanup();
  }
});

test("S-CLT-26: no shell or network permission is added; the progress tools pass the headless permission check", async () => {
  withHostAccess(false, () => {
    const config = claudePermissionConfig("inherit");
    assert.equal(config.permissionMode, settings.claude.permissionMode);
    assert.equal(config.allowDangerouslySkipPermissions, config.permissionMode === "bypassPermissions");
    assert.equal(config.disableSandboxForHostAccess, false);
  });
  const dir = mkdtempSync(join(tmpdir(), "progress-perm-"));
  try {
    const canUseTool = buildCanUseTool(dir, "acceptEdits");
    const signal = new AbortController().signal;
    for (const name of ["get_context", "post_remark", "post_status"]) {
      const verdict = await canUseTool(`mcp__agent-console__${name}`, {}, { signal, suggestions: [] } as never);
      assert.equal(verdict.behavior, "allow");
    }
    const curl = await canUseTool("Bash", { command: "curl -fsS http://127.0.0.1:4000/api/agent/runs/x/context" }, { signal, suggestions: [] } as never);
    assert.equal(curl.behavior, "deny");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S-CLT-30: zod is a direct server dependency", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> };
  assert.ok(pkg.dependencies.zod);
});
