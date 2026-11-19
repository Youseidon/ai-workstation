import assert from "node:assert/strict";
import test from "node:test";
import type { AdapterEvent } from "@agent-console/shared";
import { CodexStreamMapper } from "../src/adapters/codexStream.ts";
import { codexServerArgs } from "../src/adapters/codex.ts";

function connection(overrides: Partial<ConstructorParameters<typeof CodexStreamMapper>[0]> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const events: AdapterEvent[] = [];
  const mapper = new CodexStreamMapper({ prompt: "Explain", cwd: "/tmp/project", model: "model", sandbox: "workspace-write", effort: "medium", ...overrides });
  mapper.start({ send: value => sent.push(value as Record<string, unknown>), emit: event => events.push(event), fail: error => { throw error; } });
  mapper.map({ id: 1, result: {} });
  const status = mapper.map({ id: 2, result: { thread: { id: "thread" }, sandbox: { type: "workspaceWrite", writableRoots: ["/tmp/project"], networkAccess: true } } });
  mapper.map({ method: "turn/started", params: { threadId: "thread", turn: { id: "turn" } } });
  mapper.map({ id: 3, result: { turn: { id: "turn" } } });
  const notify = (method: string, data: Record<string, unknown>) => mapper.map({ method, params: { threadId: "thread", turnId: "turn", ...data } });
  return { mapper, sent, events, status, notify };
}

test("Codex starts/resumes the native session with the current cwd, model and sandbox", () => {
  const { mapper, sent, status } = connection({ resumeSessionId: "old-thread", sandbox: "read-only" });
  assert.equal(sent[0]?.method, "initialize");
  assert.equal(sent[2]?.method, "thread/resume");
  assert.equal((sent[2]?.params as Record<string, unknown>).threadId, "old-thread");
  const params = sent[3]?.params as Record<string, unknown>;
  assert.equal(params.cwd, "/tmp/project");
  assert.equal(params.model, "model");
  assert.equal(params.approvalPolicy, "never");
  assert.deepEqual(params.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.equal(status[0]?.type === "status" && status[0].payload.sessionId, "thread");
  mapper.dispose();
});

test("Codex preserves resolved workspace policy and streams text before the terminal snapshot", () => {
  const { mapper, sent, notify } = connection();
  assert.equal(((sent[3]?.params as Record<string, unknown>).sandboxPolicy as Record<string, unknown>).networkAccess, true);
  const first = notify("item/agentMessage/delta", { itemId: "a", delta: "First " });
  assert.equal(mapper.settled, false);
  assert.deepEqual(first, [{ type: "assistant_text", payload: { blockId: "a", delta: true, text: "First ", kind: "message" } }]);
  notify("item/agentMessage/delta", { itemId: "a", delta: "words" });
  assert.deepEqual(notify("item/completed", { item: { id: "a", type: "agentMessage", text: "First words" } }), []);
  const terminal = notify("turn/completed", { turn: { id: "turn", status: "completed", items: [{ id: "a", type: "agentMessage", text: "First words" }] } });
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]?.type === "result" && terminal[0].payload.text, "First words");
  assert.deepEqual(notify("turn/completed", { turn: { id: "turn", status: "completed" } }), []);
  mapper.dispose();
});

test("Codex reconciles corrected final text and isolates reasoning, other threads and old turns", () => {
  const { mapper, notify } = connection();
  const thought = notify("item/reasoning/summaryTextDelta", { itemId: "a", summaryIndex: 0, delta: "Considering" });
  assert.equal(thought[0]?.type === "assistant_text" && thought[0].payload.kind, "thinking");
  assert.deepEqual(notify("item/agentMessage/delta", { threadId: "other", itemId: "a", delta: "leak" }), []);
  assert.deepEqual(notify("item/agentMessage/delta", { turnId: "old", itemId: "a", delta: "old" }), []);
  notify("item/agentMessage/delta", { itemId: "a", delta: "Draft" });
  const correction = notify("item/completed", { item: { id: "a", type: "agentMessage", text: "Corrected" } });
  assert.equal(correction[0]?.type === "assistant_text" && correction[0].payload.delta, false);
  assert.equal(correction[0]?.type === "assistant_text" && correction[0].payload.text, "Corrected");
  mapper.dispose();
});

test("Codex tool lifecycle, native stop and per-run usage survive resumed threads", () => {
  const { mapper, sent, notify } = connection();
  assert.equal(notify("item/started", { item: { id: "cmd", type: "commandExecution", command: "pwd" } })[0]?.type, "tool_use");
  assert.equal(notify("item/completed", { item: { id: "cmd", type: "commandExecution", command: "pwd", aggregatedOutput: "/tmp", exitCode: 0 } })[0]?.type, "tool_result");
  const usage = { inputTokens: 100, outputTokens: 30, cachedInputTokens: 10, reasoningOutputTokens: 5 };
  notify("thread/tokenUsage/updated", { tokenUsage: { total: { ...usage, inputTokens: 1100, outputTokens: 330 }, last: usage } });
  notify("item/agentMessage/delta", { itemId: "a", delta: "Partial" });
  assert.equal(mapper.interrupt(), true);
  assert.equal(sent.at(-1)?.method, "turn/interrupt");
  const result = notify("turn/completed", { turn: { id: "turn", status: "interrupted" } })[0];
  assert.equal(result?.type === "result" && result.payload.state, "interrupted");
  assert.equal(result?.type === "result" && result.payload.text, "Partial");
  assert.equal(result?.type === "result" && result.payload.usage?.inputTokens, 100);
  mapper.dispose();
});

test("Codex unsupported server requests fail visibly and never grant extra permissions", () => {
  const { mapper, sent } = connection();
  const events = mapper.map({ id: "approval", method: "item/commandExecution/requestApproval", params: {} });
  assert.ok(sent.at(-1)?.error);
  const result = events.at(-1);
  assert.equal(result?.type === "result" && result.payload.state, "error");
  mapper.dispose();
});

test("Codex extra arguments preserve supported configuration and reject incompatible flags explicitly", () => {
  assert.deepEqual(codexServerArgs(["-c", 'model_provider="test"', "--enable", "feature"]), ["app-server", "-c", 'model_provider="test"', "--enable", "feature"]);
  assert.throws(() => codexServerArgs(["--full-auto"]), /exec-only/);
  assert.deepEqual(codexServerArgs([], true), ["app-server", "-c", 'cli_auth_credentials_store="ephemeral"']);
});

test("Codex API-key connections authenticate before starting a thread", () => {
  const sent: Array<Record<string, unknown>> = [];
  const mapper = new CodexStreamMapper({ prompt: "Explain", cwd: "/tmp", model: null, sandbox: "read-only", effort: "low", apiKey: "fixture-key" });
  mapper.start({ send: value => sent.push(value as Record<string, unknown>), emit: () => {}, fail: error => { throw error; } });
  mapper.map({ id: 1, result: {} });
  assert.equal(sent.at(-1)?.method, "account/login/start");
  assert.equal(sent.some(message => message.method === "thread/start"), false);
  mapper.map({ id: 5, result: { type: "apiKey" } });
  assert.equal(sent.at(-1)?.method, "thread/start");
  mapper.dispose();
});

test("Codex duplicate handshake responses never submit a second turn", () => {
  const { mapper, sent } = connection();
  const requests = sent.length;
  mapper.map({ id: 1, result: {} });
  mapper.map({ id: 2, result: { thread: { id: "thread" } } });
  assert.equal(sent.length, requests);
  assert.equal(sent.filter(message => message.method === "turn/start").length, 1);
  mapper.dispose();
});

test("Codex a Stop/completion race follows the terminal notification", () => {
  const { mapper, notify } = connection();
  mapper.interrupt();
  assert.deepEqual(mapper.map({ id: 4, error: { message: "Turn already completed" } }), []);
  const result = notify("turn/completed", { turn: { id: "turn", status: "completed" } })[0];
  assert.equal(result?.type === "result" && result.payload.state, "done");
  mapper.dispose();
});

test("Codex /btw steers the active turn and survives a refused steer", async () => {
  const { mapper, sent, notify } = connection();
  const accepted = mapper.steer("Skip the build; I ran it.");
  const request = sent.at(-1)!;
  assert.equal(request.method, "turn/steer");
  assert.deepEqual(request.params, { threadId: "thread", expectedTurnId: "turn", input: [{ type: "text", text: "Skip the build; I ran it.", text_elements: [] }] });
  assert.deepEqual(mapper.map({ id: request.id, result: { turnId: "turn" } }), []);
  assert.equal(await accepted, true);

  const refused = mapper.steer("Too late?");
  // A refused steer is the operator's note going to the inbox, not a failed run.
  assert.deepEqual(mapper.map({ id: sent.at(-1)!.id, error: { message: "turn mismatch" } }), []);
  assert.equal(await refused, false);
  assert.equal(mapper.settled, false);

  notify("turn/completed", { turn: { id: "turn", status: "completed" } });
  assert.equal(await mapper.steer("After the end"), false, "no steer once the turn is over");
  mapper.dispose();
});
