import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import type { ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { claudePermissionConfig, claudeQueryOptions } from "./adapters/claude.ts";
import { createLogger } from "./lib/logger.ts";
import { claudeProgressToolDefinitions } from "./adapters/claudeProgressTools.ts";
import { getAdapter } from "./adapters/registry.ts";
import { bindAgentProgressTools, readAgentContext } from "./agentProgressApi.ts";
import { buildCanUseTool } from "./lib/claudePermissions.ts";
import { runContexts } from "./runContext.ts";
import { agentApiReachabilityProblem, savedTaskExecutePrompt } from "./runService.ts";
import { settings } from "./settings.ts";
import { workspaces } from "./workspaces.ts";

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

test("S-CLT-01/24: Claude takes the tool path and exposes exactly the three progress tools", () => {
  assert.equal(getAdapter("claude").supportsProgressTools, true);
  for (const provider of ["codex", "grok", "cursor"] as const) assert.equal(getAdapter(provider).supportsProgressTools, false);
  withHostAccess(false, () => {
    assert.equal(agentApiReachabilityProblem("claude"), null);
    assert.match(agentApiReachabilityProblem("codex") ?? "", /cannot reach the saved-prompt context/);
  });
  const names = claudeProgressToolDefinitions(bindAgentProgressTools("run_none", "none")).map((item) => item.name).sort();
  assert.deepEqual(names, ["get_context", "post_remark", "post_status"]);
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

test("S-CLT-20/21/25: the tool prompt carries no curl, token or URL; the HTTP prompt is unchanged", () => {
  const token = "tok_" + "x".repeat(32);
  const tools = savedTaskExecutePrompt({ taskLabel: "REL-1", runId: "run_abc", token, progress: "tools" });
  assert.doesNotMatch(tools, /curl|Bearer|\/api\/agent\/runs\//);
  assert.ok(!tools.includes(token));
  assert.match(tools, /call the `get_context` tool/);
  assert.match(tools, /`post_status` tool before finishing/);
  assert.match(tools, /never modify SQLite directly/);
  assert.match(tools, /## Progress tools/);
  assert.match(tools, /BLOCKED is only valid for a concrete external dependency/);
  const http = savedTaskExecutePrompt({ taskLabel: "REL-1", runId: "run_abc", token, progress: "http" });
  assert.match(http, /curl -fsS -H 'Authorization: Bearer tok_x+' \S+\/api\/agent\/runs\/run_abc\/context/);
  // The tool path does not depend on Host access: runService picks it from the adapter capability alone.
  const source = readFileSync(new URL("./runService.ts", import.meta.url), "utf8");
  assert.match(source, /if \(getAdapter\(provider\)\.supportsProgressTools\) \{\s*progressTools = bindAgentProgressTools/);
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
    assert.equal(`${context.text}\n\n${http.markdown.slice(http.markdown.indexOf("## Progress API"))}`, http.markdown, "tool context equals the HTTP context without its reporting section");

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

    // Only saved-task execute binds tools; consult, clarify and handoff start without them.
    const source = readFileSync(new URL("./runService.ts", import.meta.url), "utf8");
    assert.equal(source.match(/bindAgentProgressTools\(/g)?.length, 1);
    const handoffSource = readFileSync(new URL("./handoffCoordinator.ts", import.meta.url), "utf8");
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
    assert.equal(workspaces.resolvePrompt(f.workspace.id, f.prompt.id).status, "BLOCKED");
    const events = workspaces.promptHistory(f.prompt.id).events as Array<{ reason: string }>;
    assert.ok(events.some((event) => /without posting the required DONE or BLOCKED status/.test(event.reason)));
    const late = await callTool(tools, "post_status", DONE);
    assert.ok(!late.schemaRejected && late.isError);
    assert.match(late.text, /^(run_not_active|invalid_run_token): /);
    assert.equal(workspaces.resolvePrompt(f.workspace.id, f.prompt.id).status, "BLOCKED");
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
