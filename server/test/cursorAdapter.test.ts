import assert from "node:assert/strict";
import test from "node:test";
import { CursorMapper } from "../src/adapters/cursor.ts";

test("Cursor nested tool calls correlate started and completed events", () => {
  const mapper = new CursorMapper();
  const started = mapper.map({
    type: "tool_call",
    subtype: "started",
    call_id: "call-1",
    tool_call: { readToolCall: { args: { path: "README.md" } } },
  });
  const completed = mapper.map({
    type: "tool_call",
    subtype: "completed",
    call_id: "call-1",
    tool_call: {
      readToolCall: {
        args: { path: "README.md" },
        result: { success: { content: "hello", totalLines: 1 } },
      },
    },
  });

  assert.deepEqual(started, [{
    type: "tool_use",
    payload: {
      toolUseId: "call-1",
      name: "read",
      summary: '{"path":"README.md"}',
      input: { path: "README.md" },
    },
  }]);
  assert.deepEqual(completed, [{
    type: "tool_result",
    payload: {
      toolUseId: "call-1",
      name: "read",
      isError: false,
      summary: '{ "content": "hello", "totalLines": 1 }',
      output: '{\n  "content": "hello",\n  "totalLines": 1\n}',
      exitCode: null,
    },
  }]);
});

test("Cursor nested tool failures are marked as errors", () => {
  const mapper = new CursorMapper();
  mapper.map({
    type: "tool_call",
    subtype: "started",
    call_id: "call-2",
    tool_call: { readToolCall: { args: { path: "missing" } } },
  });
  const [event] = mapper.map({
    type: "tool_call",
    subtype: "completed",
    call_id: "call-2",
    tool_call: { readToolCall: { result: { error: { message: "not found" } } } },
  });

  assert.equal(event?.type, "tool_result");
  if (event?.type === "tool_result") {
    assert.equal(event.payload.name, "read");
    assert.equal(event.payload.isError, true);
    assert.match(event.payload.output, /not found/);
  }
});

test("Cursor assistant stream chunks append to one response block", () => {
  const mapper = new CursorMapper();
  const first = mapper.map({
    type: "assistant",
    session_id: "session-1",
    message: { content: [{ type: "text", text: "Hello " }] },
  });
  const second = mapper.map({
    type: "assistant",
    session_id: "session-1",
    message: { content: [{ type: "text", text: "world" }] },
  });

  assert.equal(first[0]?.type, "assistant_text");
  assert.equal(second[0]?.type, "assistant_text");
  if (first[0]?.type === "assistant_text" && second[0]?.type === "assistant_text") {
    assert.equal(first[0].payload.blockId, second[0].payload.blockId);
    assert.equal(first[0].payload.delta, true);
    assert.equal(second[0].payload.delta, true);
  }
});
