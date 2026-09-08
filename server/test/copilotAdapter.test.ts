import assert from "node:assert/strict";
import test from "node:test";
import { CopilotMapper } from "../src/adapters/copilot.ts";

test("Copilot streams a message once, and its terminal envelope adds nothing", () => {
  const mapper = new CopilotMapper();
  const first = mapper.map({
    type: "assistant.message_delta",
    data: { messageId: "m1", deltaContent: "Ran " },
  });
  const second = mapper.map({
    type: "assistant.message_delta",
    data: { messageId: "m1", deltaContent: "the tests." },
  });
  const terminal = mapper.map({
    type: "assistant.message",
    data: { messageId: "m1", content: "Ran the tests.", phase: "final_answer" },
  });

  assert.deepEqual(first, [{
    type: "assistant_text",
    payload: { blockId: "copilot-msg-m1", delta: false, text: "Ran ", kind: "message" },
  }]);
  assert.deepEqual(second, [{
    type: "assistant_text",
    payload: { blockId: "copilot-msg-m1", delta: true, text: "the tests.", kind: "message" },
  }]);
  assert.deepEqual(terminal, []);

  // The streamed text is still the run's final answer.
  const [result] = mapper.map({ type: "result", exitCode: 0 });
  assert.equal(result?.type, "result");
  assert.equal(result?.payload.text, "Ran the tests.");
});

test("Copilot emits a message that never streamed", () => {
  const mapper = new CopilotMapper();
  assert.deepEqual(
    mapper.map({ type: "assistant.message", data: { messageId: "m2", content: "DONE" } }),
    [{
      type: "assistant_text",
      payload: { blockId: "copilot-msg-m2", delta: false, text: "DONE", kind: "message" },
    }],
  );
});

test("Copilot tool calls correlate start and completion", () => {
  const mapper = new CopilotMapper();
  const started = mapper.map({
    type: "tool.execution_start",
    data: { toolCallId: "call-1", toolName: "bash", arguments: { command: "echo hi" } },
  });
  // Only the start event names the tool; the completion is correlated by id.
  const completed = mapper.map({
    type: "tool.execution_complete",
    data: { toolCallId: "call-1", success: true, result: { content: "hi\n" } },
  });

  assert.deepEqual(started, [{
    type: "tool_use",
    payload: {
      toolUseId: "call-1",
      name: "bash",
      summary: "echo hi",
      input: { command: "echo hi" },
    },
  }]);
  assert.deepEqual(completed, [{
    type: "tool_result",
    payload: {
      toolUseId: "call-1",
      name: "bash",
      isError: false,
      summary: "hi",
      output: "hi\n",
      exitCode: 0,
    },
  }]);
});

test("Copilot reports a denied tool call as an error result", () => {
  const mapper = new CopilotMapper();
  mapper.map({
    type: "tool.execution_start",
    data: {
      toolCallId: "call-2",
      toolName: "apply_patch",
      arguments: "*** Begin Patch\n*** Add File: notes.txt\n+hi\n*** End Patch\n",
    },
  });
  const [event] = mapper.map({
    type: "tool.execution_complete",
    data: {
      toolCallId: "call-2",
      success: false,
      error: { message: "Permission to run this tool was denied", code: "denied" },
    },
  });

  assert.equal(event?.type, "tool_result");
  assert.equal(event?.payload.isError, true);
  assert.equal(event?.payload.output, "Permission to run this tool was denied");
});

test("Copilot summarizes a patch by the file it touches", () => {
  const mapper = new CopilotMapper();
  const patch = "*** Begin Patch\n*** Add File: notes.txt\n+hi\n*** End Patch\n";
  const [event] = mapper.map({
    type: "tool.execution_start",
    data: { toolCallId: "call-3", toolName: "apply_patch", arguments: patch },
  });
  assert.deepEqual(event, {
    type: "tool_use",
    payload: {
      toolUseId: "call-3",
      name: "apply_patch",
      summary: "Add File: notes.txt",
      input: patch,
    },
  });
});

test("Copilot accumulates per-model-call token usage across turns", () => {
  const mapper = new CopilotMapper();
  mapper.map({
    type: "model.model_call_success",
    data: {
      responseUsage: {
        prompt_tokens: 1000,
        completion_tokens: 40,
        prompt_tokens_details: { cached_tokens: 600 },
        completion_tokens_details: { reasoning_tokens: 10 },
      },
    },
  });
  const [status] = mapper.map({
    type: "model.model_call_success",
    data: {
      responseUsage: {
        prompt_tokens: 1200,
        completion_tokens: 60,
        prompt_tokens_details: { cached_tokens: 900 },
      },
    },
  });

  assert.deepEqual(status, {
    type: "status",
    payload: {
      state: "running",
      detail: "usage",
      usage: {
        inputTokens: 2200,
        outputTokens: 100,
        cachedInputTokens: 1500,
        reasoningOutputTokens: 10,
        totalTokens: 2300,
      },
    },
  });
});

test("Copilot's flat result envelope ends the run and settles the mapper", () => {
  const mapper = new CopilotMapper();
  const events = mapper.map({ type: "result", exitCode: 2, sessionId: "s1" });

  assert.equal(mapper.settled, true);
  assert.equal(events[0]?.type, "error");
  assert.deepEqual(events[1], {
    type: "result",
    payload: { state: "error", usage: null, text: null, exitCode: 2 },
  });
  // A second terminal envelope must not produce a second result.
  assert.deepEqual(mapper.map({ type: "result", exitCode: 0 }), []);
});
