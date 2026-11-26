import assert from "node:assert/strict";
import test from "node:test";
import { CursorMapper, cursorAgentArgs } from "../../../src/providers/adapters/cursor.ts";

test("Cursor protected invocations bind sandbox and hooks after extra flags and reject relocation", () => {
  const input = {prompt:"Implement",outputFormat:"stream-json",force:true,model:"auto",extraArgs:["--sandbox","disabled"],policyPlugin:"/tmp/policy",sandbox:"enabled" as const};
  const args = cursorAgentArgs(input);
  assert.ok(args.lastIndexOf("enabled") > args.indexOf("disabled"));
  assert.ok(args.includes("--plugin-dir"));
  for (const override of ["--workspace=/tmp/other", "--worktree", "--add-dir", "-w"])
    assert.throws(()=>cursorAgentArgs({...input,extraArgs:[override]}),/cannot bypass/);
});

test("Cursor policy refusals render as failed tool results", () => {
  const mapper = new CursorMapper();
  mapper.map({type:"tool_call",subtype:"started",call_id:"blocked",tool_call:{shellToolCall:{args:{command:"npm test"}}}});
  const [event] = mapper.map({type:"tool_call",subtype:"completed",call_id:"blocked",tool_call:{shellToolCall:{result:{rejected:{reason:"Verification belongs to S6-11"}}}}});
  assert.equal(event?.type,"tool_result");
  if (event?.type === "tool_result") { assert.equal(event.payload.isError,true); assert.match(event.payload.output,/S6-11/); }
});

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
  const [result] = mapper.map({ type: "result" });
  assert.equal(result?.type, "result");
  if (result?.type === "result") assert.equal(result.payload.text, "Hello world");
});

test("Cursor thinking and answer deltas use separate blocks", () => {
  const mapper = new CursorMapper();
  const [thinking] = mapper.map({ type: "assistant", session_id: "s", message: { content: [{ type: "thinking", text: "Considering" }] } });
  const [answer] = mapper.map({ type: "assistant", session_id: "s", message: { content: [{ type: "text", text: "Answer" }] } });
  assert.equal(thinking?.type, "assistant_text");
  assert.equal(answer?.type, "assistant_text");
  if (thinking?.type === "assistant_text" && answer?.type === "assistant_text") assert.notEqual(thinking.payload.blockId, answer.payload.blockId);
});

test("Cursor text after a tool starts a new block, preserving reply chronology", () => {
  const mapper = new CursorMapper();
  const chunk = (text: string) => mapper.map({ type: "assistant", session_id: "s", message: { content: [{ type: "text", text }] } })[0];
  const before = chunk("Checking the file.");
  mapper.map({ type: "tool_use", call_id: "read", name: "read_file", input: {} });
  mapper.map({ type: "tool_result", call_id: "read", name: "read_file", output: "File contents" });
  const after = chunk("The answer ");
  const last = chunk("is ready.");
  if (before?.type === "assistant_text" && after?.type === "assistant_text" && last?.type === "assistant_text") {
    assert.notEqual(before.payload.blockId, after.payload.blockId);
    assert.equal(after.payload.blockId, last.payload.blockId);
  } else assert.fail("expected text events");
  const result = mapper.map({ type: "result" })[0];
  if (result?.type === "result") assert.equal(result.payload.text, "The answer is ready.");
  else assert.fail("expected result");
});

test("Cursor final full-message snapshot after partial deltas is not appended twice", () => {
  const mapper = new CursorMapper();
  const chunk = (text: string) => mapper.map({ type: "assistant", session_id: "s", message: { content: [{ type: "text", text }] } });
  const deltas = [...chunk("From the retained turns "), ...chunk("in this thread, your prompts were:")];
  const snapshot = chunk("From the retained turns in this thread, your prompts were:");
  assert.equal(deltas.length, 2);
  assert.deepEqual(snapshot, []);
  const short = new CursorMapper();
  const ha = (text: string) => short.map({ type: "assistant", session_id: "s", message: { content: [{ type: "text", text }] } });
  assert.equal([...ha("ha"), ...ha("ha")].length, 2);
});
