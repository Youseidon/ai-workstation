import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import type { NormalizedEvent, ProviderId } from "@agent-console/shared";
import { appendPrompt, applyEvent, type LogItem } from "../../lib/log";
import { conversationProgress, conversationTurns } from "../../lib/conversation";

let seq = 0;
test("loading older history after recent messages preserves chronological turns", () => {
  const recent=appendPrompt([],{runId:"recent",provider:"codex",model:null,text:"Recent",timestamp:"2026-11-19T00:00:00.000Z"});
  const combined=appendPrompt(recent,{runId:"earlier",provider:"claude",model:null,text:"Earlier",timestamp:"2026-11-18T00:00:00.000Z"});
  assert.deepEqual(conversationTurns(combined).map(turn=>turn.id),["earlier","recent"]);
});
function event(type: string, payload: unknown, runId = "run", provider: ProviderId = "claude"): NormalizedEvent {
  return { id: `e${seq++}`, type, payload, runId, provider, model: "recorded-model", timestamp: "2026-11-16T00:00:00Z" } as NormalizedEvent;
}
const text = (value: string, delta = false, blockId = "b") => event("assistant_text", { text: value, delta, blockId, kind: "message" });
const final = (value: string | null) => event("result", { text: value, state: "done", elapsedMs: 1, usage: null, exitCode: 0 });

test("all six providers preserve final-only replies and deduplicate repeated finals in live and replay", () => {
  for (const provider of ["claude", "codex", "cursor", "grok", "copilot", "kilocode"] as const) {
    const events = [final("# Answer\n\n**literal** `a/*`"), final("# Answer\n\n**literal** `a/*`")].map(e => ({...e, provider}));
    const live = events.reduce(applyEvent, [] as LogItem[]);
    assert.deepEqual(conversationTurns(live), conversationTurns(JSON.parse(JSON.stringify(events)).reduce(applyEvent, [])));
    assert.equal(conversationTurns(live)[0]?.blocks.filter(b => b.kind === "text").length, 1);
    assert.equal(conversationTurns(live)[0]?.attribution.provider, provider);
  }
});
test("append and replacement streams settle identically; result doesn't replace commentary", () => {
  const a = [text("Read ", true), text("this", true), final("Read this")].reduce(applyEvent, [] as LogItem[]);
  const b = [text("Read"), text("Read this"), final("Read this")].reduce(applyEvent, [] as LogItem[]);
  assert.equal(conversationTurns(a)[0]?.blocks.length, 1);
  assert.equal(conversationTurns(b)[0]?.blocks.length, 1);
  const commentary = [text("Checking"), text("Answer", false, "answer"), final("Answer")].reduce(applyEvent, [] as LogItem[]);
  assert.equal(conversationTurns(commentary)[0]?.blocks.length, 2);
});
test("tools match run and tool identity; orphan results remain inspectable", () => {
  const use = (run: string) => event("tool_use", {toolUseId:"same",name:"bash",summary:"pwd",input:{command:"pwd"}},run);
  let items = [use("a"),use("b")].reduce(applyEvent, [] as LogItem[]);
  items = applyEvent(items, event("tool_result", {toolUseId:"same",name:"bash",isError:false,summary:"ok",output:"/tmp",exitCode:0},"a"));
  assert.equal(items[1]?.kind === "tool" && items[1].result, null);
  assert.equal(items[0]?.kind === "tool" && items[0].result?.output, "/tmp");
  const orphan = applyEvent(items, event("tool_result", {toolUseId:"same",name:"read",isError:true,summary:"bad",output:"missing",exitCode:1},"a"));
  assert.equal(orphan.length, 3);
  assert.equal(conversationTurns(orphan).length, 2);
});
test("reconnect event replay is idempotent and interrupted partial text survives", () => {
  const events = [text("par",true),text("tial",true),event("result", {state:"interrupted",text:"partial",elapsedMs:20,usage:null,exitCode:null})];
  const items = events.reduce(applyEvent, [] as LogItem[]);
  assert.deepEqual(events.reduce(applyEvent, items), items);
  assert.equal(conversationTurns(items)[0]?.result?.state,"interrupted");
  assert.equal(conversationTurns(items)[0]?.blocks.length,1);
});
test("large transcript projection baseline", () => {
  let items: LogItem[] = [];
  for (let n=0;n<1000;n++) items=appendPrompt(items,{runId:`r${n}`,provider:"codex",model:null,text:`Prompt ${n}`});
  const start=performance.now();
  const turns=conversationTurns(items);
  console.log(`1000-turn projection baseline: ${(performance.now()-start).toFixed(2)} ms`);
  assert.equal(turns.length,1000);
});

test("live progress survives context, distinguishes thinking, tools and text, and settles on completion", () => {
  const live = { runId: "run", state: "starting" as const };
  let items = appendPrompt([], { runId: "run", provider: "claude", model: null, text: "My prompt" });
  const progress = () => conversationProgress(conversationTurns(items)[0]!, live);
  assert.equal(progress().phase, "starting");
  items = applyEvent(items, event("status", { state: "running", conversation: { permissionKey: "read-only", context: "History" } }));
  assert.equal(progress().active, true);
  items = applyEvent(items, event("assistant_text", { blockId: "thinking", text: "Considering", delta: true, kind: "thinking" }));
  assert.equal(progress().phase, "thinking");
  items = applyEvent(items, event("tool_use", { toolUseId: "read", name: "read_file", summary: "Read README", input: {} }));
  assert.equal(progress().label, "Running read_file");
  items = applyEvent(items, event("tool_result", { toolUseId: "read", name: "read_file", isError: false, summary: "Read", output: "Contents", exitCode: 0 }));
  assert.equal(progress().phase, "working");
  items = applyEvent(items, text("First ", true));
  assert.equal(progress().phase, "responding");
  assert.equal(conversationTurns(items)[0]?.blocks.some(block => block.kind === "text" && block.text === "First "), true);
  items = applyEvent(items, text("words", true));
  assert.equal(conversationTurns(items)[0]?.blocks.some(block => block.kind === "text" && block.text === "First words"), true);
  items = applyEvent(items, final("First words"));
  assert.deepEqual(progress(), { phase: "done", label: "Completed", active: false });
});

test("interleaved streams keep every response with its own prompt", () => {
  let items = appendPrompt([], { runId: "a", provider: "claude", model: null, text: "First question" });
  items = appendPrompt(items, { runId: "b", provider: "codex", model: null, text: "Second question" });
  items = applyEvent(items, { ...text("Second answer"), runId: "b" });
  items = applyEvent(items, { ...text("First answer"), runId: "a" });
  assert.deepEqual(conversationTurns(items).map(turn => [turn.prompt?.text, turn.blocks[0]?.kind === "text" && turn.blocks[0].text]), [
    ["First question", "First answer"], ["Second question", "Second answer"],
  ]);
});

test("history never pretends to be thinking and live questions remain actionable", () => {
  const items = [event("assistant_text", { blockId: "reason", text: "Thinking", delta: false, kind: "thinking" })].reduce(applyEvent, [] as LogItem[]);
  assert.equal(conversationProgress(conversationTurns(items)[0]!).active, false);
  const question = applyEvent(items, event("input_request", { requestId: "q", heading: "Choose", questions: [] }));
  assert.equal(conversationProgress(conversationTurns(question)[0]!, { runId: "run", state: "running" }).phase, "question");
});

test("/btw: a note updates in place as it is delivered, and the reply follows it in the same turn", () => {
  let items: LogItem[] = [];
  items = applyEvent(items, event("operator_message", { messageId: 7, text: "Skip the build", delivery: "inbox", state: "QUEUED" }, "run-btw", "cursor"));
  items = applyEvent(items, event("operator_message", { messageId: 7, text: "Skip the build", delivery: "inbox", state: "DELIVERED" }, "run-btw", "cursor"));
  items = applyEvent(items, event("agent_message", { messageId: 8, text: "Skipping it." }, "run-btw", "cursor"));
  const notes = items.filter((item) => item.kind === "btw");
  assert.equal(notes.length, 2, "one bubble per message, not per state change");
  assert.equal(notes[0]!.kind === "btw" && notes[0]!.state, "DELIVERED");
  assert.equal(notes[1]!.kind === "btw" && notes[1]!.direction, "AGENT");
  const [turn] = conversationTurns(items);
  assert.deepEqual(turn!.blocks.map((block) => block.kind), ["btw", "btw"]);
});
