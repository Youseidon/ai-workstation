import assert from "node:assert/strict";
import test from "node:test";
import { answerAgentInput, normalizeAgentInputRequest, waitForAgentInput } from "../src/agentInput.ts";
import { progressApiMarkdown } from "../src/agentContext.ts";

test("normalizes a mixed decision deck", () => {
  const request = normalizeAgentInputRequest({
    heading: "Choose the shape",
    questions: [
      { id: "scope", prompt: "Which scope?", kind: "single", options: ["Small", { value: "large", label: "Large", description: "All modules" }], recommendation: "Small" },
      { id: "notes", prompt: "Anything else?", kind: "text", required: false },
    ],
  });
  assert.equal(request.heading, "Choose the shape");
  assert.equal(request.questions[0]?.options[0]?.value, "Small");
  assert.equal(request.questions[1]?.required, false);
});

test("holds a run until its complete answer set arrives", async () => {
  const request = normalizeAgentInputRequest({
    requestId: "input-one",
    questions: [{ id: "target", prompt: "Choose a target", kind: "single", options: ["web", "server"] }],
  });
  const waiting = waitForAgentInput("run-input-one", request);
  assert.equal(waiting.registered, true);
  answerAgentInput("run-input-one", request.requestId, { target: "web" });
  assert.deepEqual(await waiting.answers, { target: "web" });
});

test("accepts an explicit best-judgment delegation", async () => {
  const request = normalizeAgentInputRequest({
    requestId: "input-two",
    questions: [{ id: "target", prompt: "Choose a target", kind: "single", options: ["web", "server"] }],
  });
  const waiting = waitForAgentInput("run-input-two", request);
  answerAgentInput("run-input-two", request.requestId, { target: "__agent_decide__" });
  assert.deepEqual(await waiting.answers, { target: "__agent_decide__" });
});

test("a timed-out caller can reattach before or after the operator answers", async () => {
  const request = normalizeAgentInputRequest({
    requestId: "input-durable",
    questions: [{ id: "target", prompt: "Choose a target", kind: "single", options: ["web", "server"] }],
  });
  const first = waitForAgentInput("run-input-durable", request);
  const attached = waitForAgentInput("run-input-durable", request);
  assert.equal(first.registered, true);
  assert.equal(attached.registered, false);
  assert.equal(first.answers, attached.answers);

  answerAgentInput("run-input-durable", request.requestId, { target: "server" });
  assert.deepEqual(await attached.answers, { target: "server" });

  const replay = waitForAgentInput("run-input-durable", request);
  assert.equal(replay.registered, false);
  assert.deepEqual(await replay.answers, { target: "server" });
});

test("the agent contract exposes questions only for standalone runs", () => {
  const standalone = progressApiMarkdown({ runId: "run-1", token: "token", port: 4000, canDecompose: true, canAsk: true, shimPath: "/tmp/agent-step" });
  const pipeline = progressApiMarkdown({ runId: "run-2", token: "token", port: 4000, canDecompose: true, canAsk: false, shimPath: "/tmp/agent-step" });
  assert.match(standalone, /ask --file questions\.json/);
  assert.doesNotMatch(pipeline, /ask --file/);
  assert.match(pipeline, /unattended pipeline run/i);
});
