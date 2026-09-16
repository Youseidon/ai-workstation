import assert from "node:assert/strict";
import test from "node:test";
import type { OperationsPrompt, OperationsSnapshot, OperationsSuite, PromptOperationalState } from "@agent-console/shared";
import { COMMANDS, decodeNav, encodeNav, HELP_HINT, PAGE_SIZE, parseCommand, renderView, TASK_FILTERS, type ViewContext, type ViewRequest } from "./integrations/telegram/views.ts";

// Scenario IDs refer to docs/e2e-scenarios/l3-b.md (slice B, RTC-24): the read-only view registry.

const NOW = new Date("2026-09-15T10:30:00");

function prompt(id: number, state: PromptOperationalState, extra: { key?: string; title?: string; lastActivityAt?: string; stepOrder?: number; enabled?: boolean } = {}): OperationsPrompt {
  return {
    prompt: { id, title: extra.title ?? `Task ${id}`, externalKey: extra.key ?? null } as OperationsPrompt["prompt"],
    operationalState: state,
    lastActivityAt: extra.lastActivityAt ?? NOW.toISOString(),
    pipelineRule: { enabled: extra.enabled ?? false, stepOrder: extra.stepOrder ?? 0 } as OperationsPrompt["pipelineRule"],
  } as OperationsPrompt;
}

function suite(id: number, workspaceName: string, prompts: OperationsPrompt[], pipeline: OperationsSuite["pipeline"] = null): OperationsSuite {
  return { id, name: `Suite ${id}`, workspaceName, programName: "Program", prompts, pipeline } as OperationsSuite;
}

function context(suites: OperationsSuite[], extra: Partial<ViewContext> = {}): ViewContext {
  return { snapshot: { generatedAt: NOW.toISOString(), suites } as OperationsSnapshot, summary: () => null, usage: null, now: NOW, workstation: "jd-laptop", ...extra };
}

const allStates: PromptOperationalState[] = ["WORKING", "AWAITING_RESPONSE", "RECOVERY_NEEDED", "FAILED", "READY", "WAITING_DEPENDENCY", "COMPLETE", "SKIPPED"];
const fixture = () => context([
  suite(1, "alpha", allStates.map((state, index) => prompt(index + 1, state, { key: `ALPHA-${index + 1}` }))),
  suite(2, "beta", [prompt(20, "AWAITING_RESPONSE", { key: "BETA-2" }), prompt(21, "READY"), prompt(22, "COMPLETE", { lastActivityAt: new Date(NOW.getTime() - 25 * 3_600_000).toISOString() })], {
    defaults: {} as never,
    active: { state: "WAITING_HUMAN", currentPromptId: 21 } as never,
    latest: null,
  }),
]);

const requests: ViewRequest[] = [{ view: "status" }, { view: "tasks", filter: null, page: 0 }, ...TASK_FILTERS.map((filter) => ({ view: "tasks", filter, page: 0 }) as ViewRequest), { view: "pipelines", page: 0 }, { view: "quota" }, { view: "find", ref: "BETA-2", page: 0 }, { view: "help" }];

test("S-L3-B-01: every view is deterministic, within the limit, uses only nv_ buttons of at most 64 bytes, and says so when empty", () => {
  for (const ctx of [context([]), fixture(), context([suite(9, "big", Array.from({ length: 35 }, (_, index) => prompt(100 + index, "READY", { title: `😀 ${"t".repeat(150)}` })))])]) {
    for (const request of requests) {
      const first = renderView(request, ctx);
      assert.deepEqual(renderView(request, ctx), first);
      assert.ok(first.text.length <= 4096);
      assert.ok(first.text.trim().length > 0);
      for (const button of first.buttons.flat()) {
        assert.ok(button.data.startsWith("nv_"), button.data);
        assert.ok(Buffer.byteLength(button.data) <= 64);
        assert.notEqual(decodeNav(button.data), null, `button ${button.data} decodes`);
      }
      for (const entity of first.entities) assert.ok(entity.offset + entity.length <= first.text.length);
    }
  }
  const empty = context([]);
  assert.match(renderView({ view: "status" }, empty).text, /No tasks on this workstation\./);
  assert.match(renderView({ view: "tasks", filter: "blocked", page: 0 }, empty).text, /No blocked tasks as of 10:30\./);
  assert.match(renderView({ view: "pipelines", page: 0 }, empty).text, /No pipelines have run/);
  assert.match(renderView({ view: "quota" }, empty).text, /No quota figures yet/);
});

test("S-L3-B-02/04/05: counts and lists follow the filter mapping; waiting-on-dependency and skipped tasks are in no list", () => {
  const ctx = fixture();
  const status = renderView({ view: "status" }, ctx).text;
  assert.match(status, /Running 1 · Blocked 2 · Needs recovery 1 · Failed 1 · Ready 2/);
  assert.match(status, /beta \/ Suite 2: waiting for you/);
  const listed = (filter: (typeof TASK_FILTERS)[number]) => renderView({ view: "tasks", filter, page: 0 }, ctx).buttons.flat().filter((button) => button.data.startsWith("nv_k")).map((button) => Number(/^nv_k(\d+)/.exec(button.data)![1]));
  assert.deepEqual(listed("blocked"), [2, 20]);
  assert.deepEqual(listed("done"), [7], "done covers 24 hours only");
  const everyListed = TASK_FILTERS.flatMap(listed);
  assert.equal(new Set(everyListed).size, everyListed.length, "a task is in at most one list");
  assert.ok(!everyListed.includes(6) && !everyListed.includes(8), "WAITING_DEPENDENCY and SKIPPED are not listed");
  const blocked = renderView({ view: "tasks", filter: "blocked", page: 0 }, ctx).text;
  assert.match(blocked, /alpha:\n• ALPHA-2 Task 2\n\nbeta:\n• BETA-2 Task 20/);
});

test("S-L3-B-09/26: /task finds by id or key, offers a picker for ambiguity, reports unknown keys, and long lists paginate", () => {
  const duplicate = context([suite(1, "alpha", [prompt(1, "READY", { key: "DUP-1" })]), suite(2, "beta", [prompt(2, "READY", { key: "dup-1" })])], { summary: (id) => ({ promptId: id, key: String(id), tag: `#w_t${id}`, source: "title", breadcrumb: { workstation: "jd-laptop", workspace: "w", program: "p", suite: "s", step: null, nextStep: null }, title: `Task ${id}`, blockedAt: null, options: null, optionsOmitted: 0, history: { runs: [], moreRuns: 0, blocks: 0, previousAnswer: null, morePreviousAnswers: 0 }, objective: null, completedWork: null, verification: null, blockers: null, decisions: null, importantFiles: null, recommendation: null, ifYouWait: "Only this task waits; other tasks and workspaces continue." }) });
  const picker = renderView({ view: "find", ref: "DUP-1", page: 0 }, duplicate);
  assert.equal(picker.buttons.flat().length, 2);
  assert.match(renderView({ view: "find", ref: "2", page: 0 }, duplicate).text, /\nTask: Task 2\n/);
  assert.match(renderView({ view: "find", ref: "NOPE-9", page: 0 }, duplicate).text, /No task matches "NOPE-9"/);
  const many = context([suite(1, "alpha", Array.from({ length: 25 }, (_, index) => prompt(index + 1, "READY")))]);
  const seen: number[] = [];
  let request: ViewRequest | null = { view: "tasks", filter: "ready", page: 0 };
  let pages = 0;
  while (request) {
    const rendered = renderView(request, many);
    pages += 1;
    seen.push(...rendered.buttons.flat().filter((button) => button.data.startsWith("nv_k")).map((button) => Number(/^nv_k(\d+)/.exec(button.data)![1])));
    const next = rendered.buttons.flat().find((button) => button.text === "Next");
    request = next ? decodeNav(next.data) : null;
  }
  assert.equal(pages, Math.ceil(25 / PAGE_SIZE));
  assert.deepEqual(seen, Array.from({ length: 25 }, (_, index) => index + 1), "every task once, in order");
});

test("S-L3-B-10/29: help and the command menu come from one registry with valid names", () => {
  const help = renderView({ view: "help" }, context([])).text;
  assert.ok(help.startsWith(HELP_HINT));
  for (const entry of COMMANDS) {
    assert.match(entry.command, /^[a-z0-9_]{1,32}$/);
    assert.ok(entry.description.length > 0 && entry.description.length <= 256);
    assert.ok(help.includes(`/${entry.command} - ${entry.description}`));
  }
  assert.ok(!COMMANDS.some((entry) => (TASK_FILTERS as readonly string[]).includes(entry.command) && entry.command !== "running" && entry.command !== "blocked"), "filters other than the two shortcuts are not commands");
});

test("S-L3-B-11: views show the snapshot time, with the date when it is not today", () => {
  assert.match(renderView({ view: "status" }, context([])).text, /as of 10:30/);
  const yesterday = context([], { snapshot: { generatedAt: new Date("2026-09-14T23:05:00").toISOString(), suites: [] } as OperationsSnapshot });
  assert.match(renderView({ view: "status" }, yesterday).text, /as of 2026-09-14 23:05/);
});

test("S-L3-B-16: navigation data round-trips and crafted data decodes to nothing", () => {
  for (const request of [...requests, { view: "task", promptId: 42, back: { view: "tasks", filter: "blocked", page: 3 } } as ViewRequest, { view: "task", promptId: 7, back: null } as ViewRequest]) {
    const data = encodeNav(request);
    assert.deepEqual(decodeNav(data), request, data);
  }
  for (const crafted of ["nv_", "nv_zz", "nv_k-1", "nv_kabc", "nv_t", "nvs", "NV_s", `nv_${"s".repeat(70)}`, "nv_s", "nv_k1.k2", "tc_AAAAAAAAAAAAAAAAAAAAAAAA", "nv_f0.bad key"]) {
    assert.equal(decodeNav(crafted), null, JSON.stringify(crafted));
  }
  assert.equal(encodeNav({ view: "find", ref: "bad key!", page: 0 }), "nv_s", "untransportable keys fall back to status");
});

test("S-L3-B-20/21: only registered commands parse; bot-addressed forms work; other bots and non-commands do not", () => {
  const view = (text: string) => parseCommand(text, "harness_fake_bot");
  assert.deepEqual(view("/status"), { kind: "view", request: { view: "status" } });
  assert.deepEqual(view("  /STATUS  "), { kind: "view", request: { view: "status" } });
  assert.deepEqual(view("/status@harness_fake_bot"), { kind: "view", request: { view: "status" } });
  assert.deepEqual(view("/tasks@Harness_Fake_Bot blocked"), { kind: "view", request: { view: "tasks", filter: "blocked", page: 0 } });
  assert.deepEqual(view("/tasks   blocked"), { kind: "view", request: { view: "tasks", filter: "blocked", page: 0 } });
  assert.deepEqual(view("/tasks nonsense"), { kind: "view", request: { view: "tasks", filter: null, page: 0 } });
  assert.deepEqual(view("/blocked"), { kind: "view", request: { view: "tasks", filter: "blocked", page: 0 } });
  assert.deepEqual(view("/task BETA-2"), { kind: "view", request: { view: "find", ref: "BETA-2", page: 0 } });
  assert.deepEqual(view("/task"), { kind: "view", request: { view: "help" } });
  assert.deepEqual(view("/status@SomeOtherBot"), { kind: "other_bot" });
  for (const unknown of ["/foo", "/foo bar", "/start"]) assert.equal(view(unknown).kind, "unknown", unknown);
  // Both outcomes reach the same path: help when sent alone, an answer when replying to a card.
  for (const text of ["status", "please /status", "/ status", "/", "what's running?", "/usr/local is fine"]) assert.equal(view(text).kind, "not_command", text);
});
