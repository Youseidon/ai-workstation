import assert from "node:assert/strict";
import test from "node:test";
import { KiloMapper } from "../src/adapters/kilocode.ts";

/**
 * Shapes transcribed from `kilo run --format json` (kilo 7.8.1). The CLI exits
 * 0 even when the run failed, so the mapper — not the exit code — owns the
 * terminal state.
 */

test("Kilo announces its session on the first event and streams text blocks", () => {
  const mapper = new KiloMapper();
  const [start, text] = mapper.map({
    type: "text",
    sessionID: "ses_1",
    part: { id: "prt_1", type: "text", text: "Created the file." },
  });

  assert.equal(start?.type, "status");
  assert.equal(start?.payload.sessionId, "ses_1");
  assert.deepEqual(text, {
    type: "assistant_text",
    payload: { blockId: "prt_1", delta: false, text: "Created the file.", kind: "message" },
  });

  // The session id is announced once, not on every line.
  assert.deepEqual(mapper.map({ type: "text", sessionID: "ses_1", part: { id: "prt_2", type: "text", text: "Done." } }), [
    { type: "assistant_text", payload: { blockId: "prt_2", delta: false, text: "Done.", kind: "message" } },
  ]);
});

test("Kilo's tool parts arrive complete and produce use plus result", () => {
  const mapper = new KiloMapper();
  // The first line also carries the session id, so it announces that first.
  const events = mapper.map({
    type: "tool_use",
    sessionID: "ses_1",
    part: {
      id: "prt_3",
      type: "tool",
      callID: "call_1",
      tool: "write",
      state: {
        status: "completed",
        input: { filePath: "/tmp/x/t1.txt", content: "hi\n" },
        output: "Wrote file successfully.",
        title: "tmp/x/t1.txt",
      },
    },
  });

  assert.equal(events.length, 3);
  assert.equal(events[0]?.type, "status");
  assert.deepEqual(events[1], {
    type: "tool_use",
    payload: {
      toolUseId: "call_1",
      name: "write",
      summary: "tmp/x/t1.txt",
      input: { filePath: "/tmp/x/t1.txt", content: "hi\n" },
    },
  });
  assert.deepEqual(events[2], {
    type: "tool_result",
    payload: {
      toolUseId: "call_1",
      name: "write",
      isError: false,
      summary: "Wrote file successfully.",
      output: "Wrote file successfully.",
      exitCode: 0,
    },
  });
});

test("Kilo sums per-step token usage, keeping cache reads separate", () => {
  const mapper = new KiloMapper();
  mapper.map({
    type: "step_finish",
    sessionID: "ses_1",
    part: { type: "step-finish", reason: "tool-calls", tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 30 } } },
  });
  const [status] = mapper.map({
    type: "step_finish",
    sessionID: "ses_1",
    part: { type: "step-finish", reason: "stop", tokens: { input: 200, output: 40, reasoning: 0, cache: { read: 60, write: 0 } } },
  });

  assert.deepEqual(status, {
    type: "status",
    payload: {
      state: "running",
      detail: "step stop",
      usage: {
        inputTokens: (100 + 30 + 50) + (200 + 60),
        outputTokens: 60,
        cachedInputTokens: 50 + 60,
        reasoningOutputTokens: 5,
        totalTokens: (100 + 30 + 50) + (200 + 60) + 60,
      },
    },
  });
});

test("Kilo reports a failed run as an error result despite exiting 0", () => {
  const mapper = new KiloMapper();
  const events = mapper.map({
    type: "error",
    sessionID: "ses_1",
    error: { name: "UnknownError", data: { message: "Model not found: kilo/nope." } },
  });

  assert.equal(mapper.settled, true);
  // events[0] is the session announcement that rides the first line.
  assert.deepEqual(events[1], { type: "error", payload: { message: "Model not found: kilo/nope.", fatal: true } });
  assert.equal(events[2]?.type, "result");
  assert.equal(events[2]?.payload.state, "error");
  // The process still exits 0; the settled result must win over a done result.
  assert.deepEqual(mapper.finish(0), []);
});

test("Kilo's clean exit closes the run with the last assistant text", () => {
  const mapper = new KiloMapper();
  mapper.map({ type: "text", sessionID: "ses_1", part: { id: "prt_9", type: "text", text: "All done." } });
  const [result] = mapper.finish(0);

  assert.equal(mapper.settled, true);
  assert.deepEqual(result, {
    type: "result",
    payload: { state: "done", usage: null, text: "All done.", exitCode: 0 },
  });
});
