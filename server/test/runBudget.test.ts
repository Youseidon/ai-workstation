import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import type { AdapterEvent, NormalizedEvent } from "@agent-console/shared";
import type { AgentAdapter, RunOptions } from "../src/adapters/types.ts";
import { startRun, truncateToolOutput, type RunMetrics } from "../src/runner.ts";
import { settings, snapshot } from "../src/settings.ts";

/**
 * Emits whatever the test asks for. A script ending in a `result` event returns
 * like a provider that finished on its own; anything else idles until it is
 * interrupted, which is what makes a budget stop observable — a run that ends
 * because the adapter ran out of events proves nothing.
 */
function scriptedAdapter(events: AdapterEvent[]): AgentAdapter {
  let stop: (() => void) | null = null;
  let interrupted = false;
  return {
    id: "claude",
    label: "Claude Code",
    transport: "sdk",
    reportsTokens: true,
    permissionMode: "bypassPermissions",
    model: null,
    checkAvailability: async () => ({ available: true, reason: null, version: null, binary: null }),
    isAvailable: async () => true,
    getVersion: async () => null,
    getAccountUsage: async () => ({ provider: "claude", available: false, reason: null, windows: [] }) as never,
    async *run(_prompt: string, _opts: RunOptions): AsyncGenerator<AdapterEvent, void> {
      for (const event of events) {
        if (interrupted) return;
        yield event;
        // Yield to the microtask queue so a stop decided in response to this
        // event is seen before the next one, the way a real transport does.
        await Promise.resolve();
      }
      if (interrupted || events.some((event) => event.type === "result")) return;
      await new Promise<void>((resolve) => { stop = resolve; });
    },
    async interrupt(): Promise<void> {
      // A real provider can be told to stop at any moment, including before it
      // has reached the point where it waits. Latching it is what makes that
      // true here too; without the latch a stop raced ahead of the idle and
      // was silently dropped.
      interrupted = true;
      stop?.();
    },
  } as AgentAdapter;
}

function toolCall(index: number, output = "ok"): AdapterEvent[] {
  return [
    { type: "tool_use", payload: { toolUseId: `t${index}`, name: "Bash", summary: "ls", input: { command: `ls ${index}` } } },
    { type: "tool_result", payload: { toolUseId: `t${index}`, name: "Bash", isError: false, summary: "ok", output, exitCode: 0 } },
  ];
}

async function run(events: AdapterEvent[], budget: Parameters<typeof startRun>[0]["budget"]): Promise<{ metrics: RunMetrics; events: NormalizedEvent[] }> {
  const seen: NormalizedEvent[] = [];
  let metrics!: RunMetrics;
  const handle = startRun({
    adapter: scriptedAdapter(events),
    prompt: "go",
    cwd: process.cwd(),
    role: "execute",
    budget,
    onEvent: (event) => seen.push(event),
    onEnd: (_runId, _state, ended) => { metrics = ended; },
  });
  await handle.done;
  return { metrics, events: seen };
}

const unlimited = { maxToolCalls: null, maxWallClockMs: null, maxInputTokens: null, maxToolOutputBytes: null, noProgressToolCalls: null, maxToolResultBytes: 0 };

describe("tool output truncation", () => {
  test("short output is returned untouched", () => {
    const { output, truncated } = truncateToolOutput("hello", 100);
    assert.equal(output, "hello");
    assert.equal(truncated, false);
  });

  test("long output keeps its head and its tail", () => {
    const source = `START${"x".repeat(5000)}END`;
    const { output, truncated } = truncateToolOutput(source, 100);
    assert.equal(truncated, true);
    assert.ok(output.startsWith("START"), "head survives");
    assert.ok(output.endsWith("END"), "tail survives");
    assert.ok(output.length < source.length);
    assert.match(output, /characters omitted by the orchestrator/);
  });

  test("a zero limit disables truncation", () => {
    const source = "y".repeat(5000);
    assert.equal(truncateToolOutput(source, 0).output, source);
  });
});

describe("run budgets", () => {
  test("a run is stopped once it exceeds its tool-call budget", async () => {
    const events = Array.from({ length: 20 }, (_, index) => toolCall(index)).flat();
    const { metrics } = await run(events, { ...unlimited, maxToolCalls: 5 });
    assert.equal(metrics.stopReason, "budget_tool_calls:5");
    assert.ok(metrics.toolCalls >= 5, `stopped after ${metrics.toolCalls} tool calls`);
  });

  test("a run is stopped once its tool output floods the context", async () => {
    const events = Array.from({ length: 20 }, (_, index) => toolCall(index, "z".repeat(1000))).flat();
    const { metrics } = await run(events, { ...unlimited, maxToolOutputBytes: 2500 });
    assert.equal(metrics.stopReason, "budget_tool_output_bytes:2500");
  });

  test("repeating one identical call is caught as a thrash loop", async () => {
    const events = Array.from({ length: 20 }, () => [
      { type: "tool_use", payload: { toolUseId: "t", name: "Bash", summary: "restart", input: { command: "restart-api" } } } as AdapterEvent,
    ]).flat();
    const { metrics } = await run(events, { ...unlimited, noProgressToolCalls: 4 });
    assert.equal(metrics.stopReason, "budget_no_progress:4");
  });

  test("varied work is never mistaken for a thrash loop", async () => {
    const events = Array.from({ length: 12 }, (_, index) => toolCall(index)).flat();
    const { metrics } = await run(events, { ...unlimited, noProgressToolCalls: 4, maxToolCalls: 12 });
    assert.notEqual(metrics.stopReason, "budget_no_progress:4");
  });

  test("input tokens are metered from the usage the provider reports", async () => {
    const usage = { inputTokens: 9_000, outputTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 9_010 };
    const { metrics } = await run([{ type: "status", payload: { state: "running", usage } }, ...toolCall(0)], { ...unlimited, maxInputTokens: 5_000 });
    assert.equal(metrics.stopReason, "budget_input_tokens:5000");
  });

  test("a run inside its budget ends with no stop reason and reports what it spent", async () => {
    const { metrics } = await run([...toolCall(0, "abc"), { type: "result", payload: { state: "done" } }], { ...unlimited, maxToolCalls: 50 });
    assert.equal(metrics.stopReason, null);
    assert.equal(metrics.toolCalls, 1);
    assert.equal(metrics.toolOutputBytes, 3);
  });

  test("the budget snapshot warns before it stops, so the run can bank its work", async () => {
    const seen: string[] = [];
    const handle = startRun({
      adapter: scriptedAdapter(Array.from({ length: 10 }, (_, index) => toolCall(index)).flat()),
      prompt: "go",
      cwd: process.cwd(),
      role: "execute",
      budget: { ...unlimited, maxToolCalls: 10 },
      onEvent: (event) => { if (event.type === "tool_result") { const warning = handle.budget().warning; if (warning !== null) seen.push(warning); } },
      onEnd: () => {},
    });
    await handle.done;
    assert.ok(seen.length > 0, "a warning is raised before the budget is spent");
    assert.match(seen[0]!, /Bank your work now/);
    // The first warning lands with allowance still left, which is the whole
    // point: a warning delivered at 100% is an obituary, not a warning.
    assert.ok(seen.length > 1, "the warning precedes the stop by more than one call");
  });
});

/* ------------------------------------------------------------------ */
/* The allowance itself                                               */
/* ------------------------------------------------------------------ */

/*
 * These budgets used to be halved for a decomposed sub-step. That is what
 * killed 23 execute runs on the owner's install: 50 % of 250 tool calls is 125,
 * Cursor spends about 30 a minute, and a sub-step died three or four minutes in
 * while it was still reading files. The ceilings below are safety ceilings, and
 * reaching one now earns a wrap-up turn rather than a silent kill.
 */
describe("the shipped allowance", () => {
  const field = (key: string) => snapshot().fields.find((entry) => entry.key === key);

  // The effective allowance, not the table entry: the suite runs against an
  // isolated settings store (see `server/package.json`'s test script), so this
  // is what a run on a fresh install is actually given.
  test("the ceilings are ceilings, not working limits", () => {
    const budget = settings.budgetFor();
    assert.equal(budget.maxToolCalls, 1000);
    assert.equal(budget.maxWallClockMs, 90 * 60_000);
    assert.equal(budget.maxToolOutputBytes, 8_388_608);
  });

  test("the two budgets that are not ceilings are untouched", () => {
    // Input tokens is the money, and no-progress is the thrash detector. Both
    // mean something the tool-call cap never did, so neither was relaxed.
    const budget = settings.budgetFor();
    assert.equal(budget.maxInputTokens, 8_000_000);
    assert.equal(budget.noProgressToolCalls, 25);
  });

  test("a sub-step's allowance is a station's — there is no depth to differ on", () => {
    // Stated as arity rather than as two equal numbers: the claim is that no
    // input exists which could make a sub-step's budget smaller, not that two
    // particular calls happen to agree today.
    assert.equal(settings.budgetFor.length, 0, "budgetFor still takes an argument to scale by");
    assert.deepEqual(settings.budgetFor(), settings.budgetFor());
  });

  test("the sub-step share is gone from the settings, not merely defaulted to 100 %", () => {
    // A switch that changes nothing is worse than no switch: it reads as a
    // supported way to bring the old behaviour back.
    assert.equal(field("budget.subStepFraction"), undefined);
    const sources = ["../src", "../../shared/src"].flatMap((directory) => {
      const base = new URL(`${directory}/`, import.meta.url).pathname;
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
      return walk(base);
    });
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(source, /subStepFraction|SUB_STEP_FRACTION|budgetDepth/, `${file} still scales a budget by depth`);
    }
  });
});
