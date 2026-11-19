import assert from "node:assert/strict";
import test from "node:test";
import type { AdapterEvent, NormalizedEvent, ProviderId, TokenUsage } from "@agent-console/shared";
import { mapClaudeMessage } from "../src/adapters/claude.ts";
import { CodexStreamMapper } from "../src/adapters/codexStream.ts";
import { CopilotMapper } from "../src/adapters/copilot.ts";
import { CursorMapper } from "../src/adapters/cursor.ts";
import { GrokMapper } from "../src/adapters/grok.ts";
import { KiloMapper } from "../src/adapters/kilocode.ts";
import { appendPrompt, applyEvent } from "../../web/lib/log.ts";
import { conversationProgress, conversationTurns } from "../../web/lib/conversation.ts";

const head = "**Hello** ";
const tail = "🌊\n\n```ts\nconst n = 1;\n```";
const answer = head + tail;
interface Fixture { thinking(): AdapterEvent[]; first(): AdapterEvent[]; second(): AdapterEvent[]; final(): AdapterEvent[]; dispose?(): void; }

function fixture(provider: ProviderId): Fixture {
  if (provider === "claude") {
    let usage: TokenUsage | null = null;
    let text: string | null = null;
    let messageId = "m";
    let settled = false;
    const state: Parameters<typeof mapClaudeMessage>[1] = {
      get usage() { return usage; }, setUsage: value => { usage = value; }, setText: value => { text = value; }, getText: () => text,
      getMessageId: () => messageId, setMessageId: id => { messageId = id; }, streamedBlocks: new Map(), isSettled: () => settled, markSettled: () => { settled = true; },
    };
    const map = (value: unknown) => [...mapClaudeMessage(value as Parameters<typeof mapClaudeMessage>[0], state)];
    const delta = (text: string) => map({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } } });
    return {
      thinking: () => map({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Considering" } } }),
      first: () => delta(head), second: () => delta(tail),
      final: () => [...map({ type: "assistant", message: { id: "m", content: [{ type: "thinking", thinking: "Considering" }, { type: "text", text: answer }] } }), ...map({ type: "result", subtype: "success", result: answer, usage: {} })],
    };
  }
  if (provider === "codex") {
    const mapper = new CodexStreamMapper({ prompt: "Explain", cwd: "/tmp", model: null, sandbox: "read-only", effort: "low" });
    mapper.start({ send: () => {}, emit: () => {}, fail: error => { throw error; } });
    mapper.map({ id: 1, result: {} }); mapper.map({ id: 2, result: { thread: { id: "thread" } } });
    mapper.map({ id: 3, result: { turn: { id: "turn" } } });
    const map = (method: string, data: Record<string, unknown>) => mapper.map({ method, params: { threadId: "thread", turnId: "turn", ...data } });
    return { thinking: () => map("item/reasoning/summaryTextDelta", { itemId: "reason", summaryIndex: 0, delta: "Considering" }), first: () => map("item/agentMessage/delta", { itemId: "m", delta: head }), second: () => map("item/agentMessage/delta", { itemId: "m", delta: tail }), final: () => map("turn/completed", { turn: { id: "turn", status: "completed", items: [{ id: "m", type: "agentMessage", text: answer }] } }), dispose: () => mapper.dispose() };
  }
  if (provider === "cursor") {
    const mapper = new CursorMapper();
    const chunk = (text: string, kind = "text", id = "m") => mapper.map({ type: "assistant", message: { id, content: [{ type: kind, text }] } });
    return { thinking: () => chunk("Considering", "thinking", "reason"), first: () => chunk(head), second: () => chunk(tail), final: () => mapper.map({ type: "result", result: answer }) };
  }
  if (provider === "copilot") {
    const mapper = new CopilotMapper();
    const chunk = (text: string, phase = "final_answer") => mapper.map({ type: "assistant.message_delta", data: { messageId: "m", deltaContent: text, phase } });
    return { thinking: () => chunk("Considering", "reasoning"), first: () => chunk(head), second: () => chunk(tail), final: () => [...mapper.map({ type: "assistant.message", data: { messageId: "m", content: answer, phase: "final_answer" } }), ...mapper.map({ type: "result", exitCode: 0 })] };
  }
  if (provider === "grok") {
    const mapper = new GrokMapper();
    return { thinking: () => mapper.map({ type: "thought", data: "Considering" }), first: () => mapper.map({ type: "text", data: head }), second: () => mapper.map({ type: "text", data: tail }), final: () => mapper.map({ type: "end", text: answer }) };
  }
  // These routed delta envelopes come from KiloStreamMapper's native SSE
  // consumer, exercised separately by the subprocess integration suite.
  const mapper = new KiloMapper();
  const chunk = (type: string, text: string, id = "m") => mapper.map({ type, sessionID: "ses", part: { id, text } });
  return { thinking: () => chunk("reasoning_delta", "Considering", "reason"), first: () => chunk("text_delta", head), second: () => chunk("text_delta", tail), final: () => [...chunk("text", answer), ...mapper.finish(0)] };
}

for (const provider of ["claude", "codex", "cursor", "copilot", "grok", "kilocode"] as const) {
  test(`${provider}: partial text, thinking, exact Markdown, final reconciliation and replay share one contract`, () => {
    const source = fixture(provider);
    let sequence = 0;
    const events: NormalizedEvent[] = [];
    let items = appendPrompt([], { runId: "run", provider, model: "recorded", text: "My prompt" });
    const accept = (next: AdapterEvent[]) => {
      for (const event of next) {
        const normalized = { ...event, id: `event-${sequence++}`, runId: "run", provider, model: "recorded", timestamp: "2026-11-17T00:00:00Z", payload: { elapsedMs: 100, usage: null, ...event.payload } } as NormalizedEvent;
        events.push(normalized); items = applyEvent(items, normalized);
      }
    };
    try {
      accept(source.thinking());
      assert.equal(conversationProgress(conversationTurns(items)[0]!, { runId: "run", state: "running" }).phase, "thinking");
      accept(source.first());
      const partial = conversationTurns(items)[0]!;
      assert.equal(partial.result, undefined);
      assert.equal(partial.blocks.filter(block => block.kind === "text" && block.textKind === "message").map(block => block.kind === "text" ? block.text : "").join(""), head);
      assert.equal(conversationProgress(partial, { runId: "run", state: "running" }).phase, "responding");
      accept(source.second()); accept(source.final());
      const turn = conversationTurns(items)[0]!;
      const messages = turn.blocks.filter(block => block.kind === "text" && block.textKind === "message");
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.kind === "text" && messages[0].text, answer);
      assert.equal(turn.result?.state, "done");
      assert.equal(events.filter(event => event.type === "result").length, 1);
      assert.equal(conversationProgress(turn).active, false);
      const settledCount = events.length;
      accept(source.first()); accept(source.final());
      assert.equal(events.length, settledCount, "late text and repeated terminal payloads are ignored");
      const replay = events.reduce(applyEvent, appendPrompt([], { runId: "run", provider, model: "recorded", text: "My prompt", timestamp: turn.prompt!.timestamp }));
      assert.deepEqual(conversationTurns(replay), conversationTurns(items));
      assert.deepEqual(events.reduce(applyEvent, items), items, "reconnect replay is idempotent");
    } finally { source.dispose?.(); }
  });
}

test("Claude and Copilot reconcile corrected final snapshots without losing partial text", () => {
  const copilot = new CopilotMapper();
  copilot.map({ type: "assistant.message_delta", data: { messageId: "m", deltaContent: "Draft" } });
  const [correction] = copilot.map({ type: "assistant.message", data: { messageId: "m", content: "Corrected" } });
  assert.equal(correction?.type === "assistant_text" && correction.payload.delta, false);
  assert.equal(correction?.type === "assistant_text" && correction.payload.text, "Corrected");
  const messages = [...mapClaudeMessage({ type: "assistant", message: { id: "m", content: [{ type: "text", text: "Corrected" }] } } as Parameters<typeof mapClaudeMessage>[0], {
    usage: null, setUsage: () => {}, setText: () => {}, getText: () => "Draft", getMessageId: () => "m", setMessageId: () => {},
    streamedBlocks: new Map([["m:0", "Draft"]]), isSettled: () => false, markSettled: () => {},
  })];
  assert.equal(messages[0]?.type === "assistant_text" && messages[0].payload.delta, false);
  assert.equal(messages[0]?.type === "assistant_text" && messages[0].payload.text, "Corrected");
});
