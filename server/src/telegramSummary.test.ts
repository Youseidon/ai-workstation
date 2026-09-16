import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { HandoffBrief, ProgramRecord, PromptRecord, SuiteRecord } from "@agent-console/shared";
import { config } from "./config.ts";
import { blockText, HISTORY_RUNS, lineText, MAX_OPTIONS, redactPhoneText, TAG_SLUG_MAX, taskSummary, TRADE_OFF_MAX } from "./telegramSummary.ts";
import { workspaces } from "./workspaces.ts";

// Scenario IDs refer to docs/e2e-scenarios/l3-f3-a.md (slice F3, RTC-22): the task summary model.

const database = () => new Database(join(config.repoRoot, ".agent-console/console.sqlite"));

function fixture(names: { workspace?: string; program?: string; suite?: string; title?: string; steps?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "summary-"));
  const workspace = workspaces.create({ name: names.workspace ?? "ai-workstation", workDirectory: dir });
  const program = workspaces.createChild("program", workspace.id, { name: names.program ?? "Telegram L1" }) as ProgramRecord;
  const suite = workspaces.createChild("suite", program.id, { name: names.suite ?? "Live setup" }) as SuiteRecord;
  const prompts = Array.from({ length: names.steps ?? 1 }, (_, index) => workspaces.createChild("prompt", suite.id, { title: index === 0 ? (names.title ?? "Add live bot credential storage") : `Other step ${index}`, content: "Do it" }) as PromptRecord);
  let runs = 0;
  return {
    workspace, program, suite, prompt: prompts[0]!, prompts,
    run(startedAt = new Date().toISOString()) {
      const runId = `summary-run-${workspace.id}-${++runs}`;
      workspaces.beginAgentRun({ runId, workspaceId: workspace.id, promptId: prompts[0]!.id, provider: "claude", model: null, tokenHash: runId, expiresAt: new Date(Date.now() + 60_000).toISOString(), role: "execute" });
      workspaces.finishAgentRun(runId, "done");
      const db = database();
      try {
        db.prepare("UPDATE agent_run SET started_at=? WHERE id=?").run(startedAt, runId);
      } finally {
        db.close();
      }
      return runId;
    },
    remark(kind: string, content: string) {
      const db = database();
      try {
        db.prepare("INSERT INTO prompt_remark(prompt_id,run_id,kind,content,actor_type,created_at) VALUES(?,NULL,?,?,'AGENT',?)").run(prompts[0]!.id, kind, content, new Date().toISOString());
        db.prepare("UPDATE prompt SET status='BLOCKED' WHERE id=?").run(prompts[0]!.id);
      } finally {
        db.close();
      }
    },
    handoff(state: "READY" | "QUEUED" | "RUNNING" | "FAILED" | "SUPERSEDED", brief: HandoffBrief | null, completedAt = new Date().toISOString()) {
      const sourceRunId = this.run(new Date(Date.parse(completedAt) - 60_000).toISOString());
      const id = `summary-handoff-${workspace.id}-${runs}`;
      workspaces.createHandoff({ id, workspaceId: workspace.id, promptId: prompts[0]!.id, sourceRunId, provider: "claude", model: null });
      workspaces.updateHandoff(id, { state, brief, recommendation: brief?.recommendation ?? null, completedAt });
      return id;
    },
    cleanup() {
      workspaces.remove(workspace.id);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const fullBrief = (overrides: Partial<HandoffBrief> = {}): HandoffBrief => ({
  version: 1,
  originalObjective: "Store the live bot token outside the repository.",
  terminationReason: "needs owner",
  completedWork: ["Wrote the credential loader", "Added redaction", "Documented setup"],
  pendingWork: ["Rotate the token"],
  verificationPassed: Array.from({ length: 41 }, (_, index) => `check ${index}`),
  verificationFailed: [],
  blockers: [
    { description: "Which vault holds the token?", requiresHuman: true, requiredAction: "Name the vault." },
    { description: "Flaky DNS in CI", requiresHuman: false, requiredAction: null },
  ],
  importantFiles: ["server/src/credentials.ts"],
  decisionsAndAssumptions: ["Tokens never touch settings.json", "The operator owns the bot"],
  recommendation: "WAIT_FOR_HUMAN",
  successorInstructions: "Ask before rotating.",
  ...overrides,
});

test("S-L3-F3-01: a current READY brief supplies every field, with the breadcrumb and flowchart position", () => {
  const f = fixture({ steps: 5 });
  try {
    for (const prompt of f.prompts) workspaces.addPipelineStep(prompt.id, { provider: "claude" });
    f.remark("DECISION_NEEDED", "older remark text");
    f.handoff("READY", fullBrief());
    const summary = taskSummary(f.prompt.id, "owner", { workstationLabel: "jd-laptop" });
    assert.equal(summary.source, "brief");
    assert.deepEqual(summary.breadcrumb, { workstation: "jd-laptop", workspace: "ai-workstation", program: "Telegram L1", suite: "Live setup", step: { index: 1, total: 5 }, nextStep: "Other step 1" });
    assert.equal(summary.objective, "Store the live bot token outside the repository.");
    assert.deepEqual(summary.completedWork, ["Wrote the credential loader", "Added redaction", "Documented setup"]);
    assert.deepEqual(summary.verification, { passed: 41, failed: 0 });
    assert.deepEqual(summary.blockers, [{ description: "Which vault holds the token?", requiredAction: "Name the vault." }]);
    assert.deepEqual(summary.decisions, ["Tokens never touch settings.json", "The operator owns the bot"]);
    assert.equal(summary.recommendation, "Wait for your decision.");
    assert.ok(summary.ifYouWait.length > 0);
    assert.ok(!JSON.stringify(summary).includes("older remark text"));
    assert.ok(!JSON.stringify(summary).includes("WAIT_FOR_HUMAN"));
  } finally {
    f.cleanup();
  }
});

test("S-L3-F3-02/03: without a usable brief the latest blocker remark stands in, else the title alone", () => {
  const f = fixture();
  try {
    assert.deepEqual({ ...taskSummary(f.prompt.id), breadcrumb: null, ifYouWait: null, tag: null, history: null }, { promptId: f.prompt.id, key: String(f.prompt.id), tag: null, source: "title", breadcrumb: null, title: "Add live bot credential storage", blockedAt: null, options: null, optionsOmitted: 0, history: null, objective: null, completedWork: null, verification: null, blockers: null, decisions: null, importantFiles: null, recommendation: null, ifYouWait: null });
    f.remark("PROGRESS", "just progress");
    assert.equal(taskSummary(f.prompt.id).source, "title", "progress remarks are not blockers");
    f.handoff("READY", null);
    // At most one handoff per task may be in flight, so one in-flight state stands for both, created last.
    for (const state of ["FAILED", "SUPERSEDED", "QUEUED"] as const) f.handoff(state, fullBrief());
    f.remark("BLOCKER", "old");
    f.remark("DECISION_NEEDED", "new\r\nline two");
    for (const kind of ["PROGRESS", "FINDING", "VERIFICATION", "AGENT_RESPONSE"]) f.remark(kind, `${kind} text`);
    const summary = taskSummary(f.prompt.id);
    assert.equal(summary.source, "remark");
    assert.deepEqual(summary.blockers, [{ description: "new\nline two", requiredAction: null }]);
    for (const field of ["objective", "completedWork", "verification", "decisions", "recommendation", "importantFiles"] as const) assert.equal(summary[field], null, field);
    f.remark("BLOCKER", "newest blocker");
    assert.equal(taskSummary(f.prompt.id).blockers![0]!.description, "newest blocker");
  } finally {
    f.cleanup();
  }
});

test("S-L3-F3-04: the latest READY brief wins over older and in-flight handoffs, and a brief older than the latest run is not used", () => {
  const f = fixture();
  try {
    const now = Date.now();
    const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
    f.handoff("READY", fullBrief({ originalObjective: "A" }), at(-40));
    const b = f.handoff("READY", fullBrief({ originalObjective: "B" }), at(-30));
    f.handoff("FAILED", fullBrief({ originalObjective: "C" }), at(-20));
    f.handoff("RUNNING", fullBrief({ originalObjective: "D" }), at(-10));
    // The handoff helper starts a run a minute before each handoff; the latest run precedes D's time, after B.
    assert.equal(taskSummary(f.prompt.id).objective, null, "B completed before the latest execute run started, so it is stale");
    f.remark("BLOCKER", "current blocker");
    assert.equal(taskSummary(f.prompt.id).source, "remark");
    workspaces.updateHandoff(b, { completedAt: at(5) });
    assert.equal(taskSummary(f.prompt.id).objective, "B", "a READY brief newer than the latest run is used");
    workspaces.updateHandoff(b, { state: "SUPERSEDED" });
    assert.equal(taskSummary(f.prompt.id).source, "remark", "A is older than the latest run too");
  } finally {
    f.cleanup();
  }
});

test("S-L3-F3-05: empty lists are absent, failed checks stay failed, and blockers without actions have no action", () => {
  const f = fixture();
  try {
    f.handoff("READY", fullBrief({ completedWork: [], decisionsAndAssumptions: ["  "], importantFiles: [], verificationPassed: [], verificationFailed: ["a", "b"], originalObjective: "", blockers: [{ description: "Pick one", requiresHuman: true, requiredAction: null }] }));
    const summary = taskSummary(f.prompt.id);
    assert.equal(summary.completedWork, null);
    assert.equal(summary.decisions, null);
    assert.equal(summary.objective, null);
    assert.deepEqual(summary.verification, { passed: 0, failed: 2 });
    assert.deepEqual(summary.blockers, [{ description: "Pick one", requiredAction: null }]);
    f.handoff("READY", fullBrief({ blockers: [{ description: "machine only", requiresHuman: false, requiredAction: "restart" }], verificationPassed: [], verificationFailed: [] }), new Date(Date.now() + 60_000).toISOString());
    const noHuman = taskSummary(f.prompt.id);
    assert.equal(noHuman.blockers, null);
    assert.equal(noHuman.verification, null);
    const words = new Set(["CONTINUE", "WAIT_FOR_HUMAN", "RETRY_LATER", "DO_NOT_CONTINUE"].map((recommendation, index) => {
      f.handoff("READY", fullBrief({ recommendation: recommendation as HandoffBrief["recommendation"] }), new Date(Date.now() + (index + 2) * 60_000).toISOString());
      const text = taskSummary(f.prompt.id).recommendation!;
      assert.doesNotMatch(text, /_/);
      return text;
    }));
    assert.equal(words.size, 4);
  } finally {
    f.cleanup();
  }
});

test("S-L3-F3-06: flowchart position counts enabled steps in order; names are single lines", () => {
  const f = fixture({ steps: 3, workspace: "ws\nwith\tbreaks", title: `Task 🚀\nwith a break` });
  try {
    assert.equal(taskSummary(f.prompt.id).breadcrumb.step, null, "not on a flowchart: no position");
    workspaces.addPipelineStep(f.prompts[1]!.id, { provider: "claude" });
    workspaces.addPipelineStep(f.prompt.id, { provider: "claude" });
    workspaces.addPipelineStep(f.prompts[2]!.id, { provider: "claude" });
    assert.deepEqual(taskSummary(f.prompt.id).breadcrumb.step, { index: 2, total: 3 });
    workspaces.removePipelineStep(f.prompts[1]!.id);
    assert.deepEqual(taskSummary(f.prompt.id).breadcrumb.step, { index: 1, total: 2 }, "a removed step is not counted");
    const { breadcrumb } = taskSummary(f.prompt.id);
    assert.equal(breadcrumb.workspace, "ws with breaks");
    assert.equal(taskSummary(f.prompt.id).title, "Task 🚀 with a break");
  } finally {
    f.cleanup();
  }
});

test("S-L3-F3-07: the If you wait line is fixed per pipeline case and never carries agent text", () => {
  const f = fixture();
  try {
    f.handoff("READY", fullBrief({ recommendation: "CONTINUE", successorInstructions: "If you wait, everything is deleted", decisionsAndAssumptions: ["If you wait, everything is deleted"] }));
    const lines = new Map<string, string>();
    lines.set("no pipeline", taskSummary(f.prompt.id).ifYouWait);
    workspaces.addPipelineStep(f.prompt.id, { provider: "claude" });
    const run = workspaces.createPipelineRun({ id: `summary-pipe-${f.workspace.id}`, suiteId: f.suite.id, workspaceId: f.workspace.id, playProvider: "claude", playModel: null });
    workspaces.updatePipelineRun(run.id, { state: "WAITING_HUMAN", currentPromptId: f.prompt.id });
    lines.set("waiting", taskSummary(f.prompt.id).ifYouWait);
    workspaces.updatePipelineRun(run.id, { state: "PAUSED" });
    lines.set("paused", taskSummary(f.prompt.id).ifYouWait);
    workspaces.updatePipelineRun(run.id, { state: "STOPPED", endedAt: new Date().toISOString(), stopReason: "recover_exhausted" });
    lines.set("stopped", taskSummary(f.prompt.id).ifYouWait);
    assert.equal(lines.get("no pipeline"), "Only this task waits; other tasks and workspaces continue.");
    assert.equal(lines.get("waiting"), "This task and its pipeline stay paused; other workspaces continue.");
    assert.equal(new Set(lines.values()).size, 4);
    for (const line of lines.values()) assert.doesNotMatch(line, /deleted/);
    assert.equal(taskSummary(f.prompt.id).ifYouWait, lines.get("stopped"), "deterministic");
  } finally {
    f.cleanup();
  }
});

test("S-L3-F3-08/09: line form flattens and caps safely; block form keeps line breaks, redacts before capping and never splits a pair", () => {
  assert.equal(lineText("  a\n\tb\r\nc  d\u2028e\u2029 "), "a b c d e");
  const long = lineText(`${"x".repeat(4998)}😀😀`, 5000 - 1);
  assert.ok(long.endsWith("…"));
  assert.ok(!/[\ud800-\udbff]…$/.test(long));
  assert.equal(blockText("one\r\ntwo\rthree\n\n\n\nfour  "), "one\ntwo\nthree\n\nfour");
  const secret = "sk-live-4f9a8b7c6d5e4f3a2b1c";
  const capped = blockText(`${"y".repeat(90)} ${secret} http://localhost:4000/admin`, 100);
  assert.ok(capped.endsWith("[shortened]"));
  for (const fragment of [secret.slice(0, 10), "live-4f9a8b", "http://localh"]) assert.ok(!capped.includes(fragment), fragment);
  const emoji = blockText(`${"z".repeat(88)}😀😀😀😀😀😀`, 100);
  assert.doesNotMatch(emoji.replace("\n[shortened]", ""), /[\ud800-\udbff]$/);
});

test("S-L3-F3-10: secrets and local addresses are redacted in both forms, including the widened shapes", () => {
  const corpus = ["sk-abcdefgh1234", "sk-ant-abcdefgh1234", "xai-abcdefgh1234", "glpat-abcdefgh1234", "ghp-abcdefgh1234", "ghp_abcdefgh1234abcd", "api_key=abc123", "token: abc123", "password=hunter22", "secret=abc123", "http://localhost:4000/x", "https://127.0.0.1:4100/y", "http://[::1]:3000/z", "Authorization: Bearer abcdefghijklmnop", "123456789:AAabcdefghijklmnopqrstuvwxyz0123456", "localhost:4000/api", "http://0.0.0.0:4000"];
  for (const value of corpus) {
    for (const form of [lineText, blockText]) {
      const output = form(`before ${value} after`);
      assert.ok(output.includes("[redacted]"), `${value} via ${form.name}`);
      assert.ok(!output.includes(value), `${value} via ${form.name}`);
    }
    assert.ok(!redactPhoneText(value).includes(value.slice(-8)), value);
  }
});

test("S-L3-F3-11/12: building a summary writes nothing, is repeatable, refuses unknown tasks and non-owner audiences", () => {
  const f = fixture();
  try {
    f.handoff("READY", fullBrief());
    const snapshot = () => {
      const db = database();
      try {
        return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((table) => JSON.stringify(db.prepare(`SELECT * FROM "${table.name}"`).all())).join("\n");
      } finally {
        db.close();
      }
    };
    const before = snapshot();
    assert.deepEqual(taskSummary(f.prompt.id), taskSummary(f.prompt.id));
    assert.equal(snapshot(), before);
    assert.throws(() => taskSummary(99_999_999), /not found/i);
    for (const audience of ["team", "", "OWNER"]) assert.throws(() => taskSummary(f.prompt.id, audience as "owner"), /owner audience only/);
    assert.equal(taskSummary(f.prompt.id).breadcrumb.workstation, lineText(hostname(), 64), "an empty label means the hostname");
  } finally {
    f.cleanup();
  }
});

test("S-L3-F3-13 (T0): the workstation label defaults to the hostname, refuses long or multi-line values, and empty means the hostname", async () => {
  const { resetSettings, settings, snapshot, updateSettings } = await import("./settings.ts");
  try {
    const field = snapshot().fields.find((entry: { key: string }) => entry.key === "taskControl.workstationLabel") as { group: string; type: string; defaultValue: unknown; overridden: boolean };
    assert.equal(field.group, "Task Control");
    assert.equal(field.type, "string");
    assert.equal(field.defaultValue, hostname());
    assert.equal(field.overridden, false);
    assert.ok(updateSettings({ "taskControl.workstationLabel": "jd-laptop" }).ok);
    assert.equal(settings.taskControl.workstationLabel, "jd-laptop");
    for (const bad of ["x".repeat(65), "two\nlines", "tab\there"]) {
      const result = updateSettings({ "taskControl.workstationLabel": bad });
      assert.equal(result.ok, false, JSON.stringify(bad));
      assert.match(result.errors.join(" "), /Workstation label/);
      assert.equal(settings.taskControl.workstationLabel, "jd-laptop", "a refused value leaves the stored label unchanged");
    }
    assert.ok(updateSettings({ "taskControl.workstationLabel": "   " }).ok);
    assert.equal(settings.taskControl.workstationLabel, "");
    resetSettings(["taskControl.workstationLabel"]);
    assert.equal(settings.taskControl.workstationLabel, hostname().trim());
  } finally {
    resetSettings(["taskControl.workstationLabel"]);
  }
});

/* ---- L3 slice A2 (docs/e2e-scenarios/l3-a2.md): options, history, where it fits and the tag ---- */

let statuses = 0;
/** Blocks the task through the agent Progress API, exactly as an agent would. */
function blockWithStatus(f: ReturnType<typeof fixture>, options?: unknown): unknown {
  const runId = `a2-run-${f.workspace.id}-${++statuses}`;
  workspaces.beginAgentRun({ runId, workspaceId: f.workspace.id, promptId: f.prompt.id, provider: "grok", model: null, tokenHash: runId, expiresAt: new Date(Date.now() + 60_000).toISOString(), role: "execute" });
  try {
    return workspaces.updateAgentStatus(runId, { requestId: `a2-status-${statuses}-${f.workspace.id}`, expectedStatus: "IN_PROGRESS", status: "BLOCKED", reason: "The brand guide allows red or blue.", verificationSummary: "Pick red or blue.", ...(options === undefined ? {} : { options }) });
  } finally {
    workspaces.finishAgentRun(runId, "done");
  }
}

test("S-L3-A2-01: options posted with a blocking status reach the summary in order, with their text preserved", () => {
  const f = fixture();
  try {
    const before = taskSummary(f.prompt.id);
    blockWithStatus(f, [
      { label: "Ship red", advantages: ["On brand", "Ready today"], disadvantages: ["Clashes with the charts"] },
      { label: "Ship blue", advantages: ["Matches the charts"], disadvantages: ["Needs a new palette"] },
      { label: "Ask marketing", advantages: [], disadvantages: ["Waits a week"] },
    ]);
    const summary = taskSummary(f.prompt.id);
    assert.deepEqual(summary.options, [
      { label: "Ship red", advantages: ["On brand", "Ready today"], disadvantages: ["Clashes with the charts"] },
      { label: "Ship blue", advantages: ["Matches the charts"], disadvantages: ["Needs a new palette"] },
      { label: "Ask marketing", advantages: [], disadvantages: ["Waits a week"] },
    ]);
    assert.equal(summary.optionsOmitted, 0);
    assert.ok(summary.blockedAt !== null, "the block time is the age at delivery");
    // Nothing else about the summary changed: the same fields as before the options existed.
    assert.deepEqual({ ...summary, options: null, blockedAt: null, blockers: null, history: null, source: null }, { ...before, options: null, blockedAt: null, blockers: null, history: null, source: null, optionsOmitted: 0 });
  } finally {
    f.cleanup();
  }
});

test("S-L3-A2-01/02: a later block without options replaces the earlier list rather than keeping a stale one", () => {
  const f = fixture();
  try {
    blockWithStatus(f, [{ label: "Ship red", advantages: ["On brand"], disadvantages: [] }]);
    assert.equal(taskSummary(f.prompt.id).options!.length, 1);
    workspaces.respondToBlockedPrompt(f.prompt.id, { content: "Ship red" });
    blockWithStatus(f);
    assert.equal(taskSummary(f.prompt.id).options, null, "a new block replaces the options");
    assert.equal(taskSummary(f.prompt.id).optionsOmitted, 0);
  } finally {
    f.cleanup();
  }
});

test("S-L3-A2-04: a read-only run cannot post options, with the same refusal as a refused remark", () => {
  const f = fixture();
  try {
    const runId = `a2-consult-${f.workspace.id}`;
    workspaces.beginConsultRun({ runId, workspaceId: f.workspace.id, promptId: f.prompt.id, provider: "grok", model: null, tokenHash: runId, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const status = () => workspaces.updateAgentStatus(runId, { requestId: `a2-consult-status-${f.workspace.id}`, expectedStatus: "IN_PROGRESS", status: "BLOCKED", reason: "r", verificationSummary: "v", options: [{ label: "Ship red" }] });
    const remark = () => workspaces.addAgentRemark(runId, { requestId: `a2-consult-remark-${f.workspace.id}`, kind: "BLOCKER", content: "c" });
    for (const call of [status, remark]) assert.throws(call, /Read-only runs cannot post remarks or status\./);
    assert.equal(taskSummary(f.prompt.id).options, null, "no option reaches any card");
  } finally {
    f.cleanup();
  }
});

test("S-L3-A2-05: option count and each field are capped by documented limits, empty labels are dropped and the cut is declared", () => {
  const f = fixture();
  try {
    const many = Array.from({ length: 20 }, (_, index) => ({ label: `Option ${index}`, advantages: [`advantage ${index}`], disadvantages: [] }));
    assert.throws(() => blockWithStatus(f, [...many, { label: "one too many" }]), /Too many options/);
    // The run then ends without a status, so the system blocks the task itself: no options, never a stale list.
    assert.equal(taskSummary(f.prompt.id).options, null);
    workspaces.respondToBlockedPrompt(f.prompt.id, { content: "Try again" });
    blockWithStatus(f, [{ label: "   ", advantages: ["dropped with its option"], disadvantages: [] }, ...many.slice(0, 19)]);
    const summary = taskSummary(f.prompt.id);
    assert.equal(summary.options!.length, MAX_OPTIONS);
    assert.equal(summary.optionsOmitted, 15, "the rest are declared, not silently dropped");
    assert.ok(!JSON.stringify(summary.options).includes("dropped with its option"), "an option with an empty label is dropped");
    workspaces.respondToBlockedPrompt(f.prompt.id, { content: "Ship red" });
    blockWithStatus(f, [{ label: "Long", advantages: ["a".repeat(4000)], disadvantages: ["d".repeat(4000)] }, { label: "Many", advantages: ["1", "2", "3", "4", "5"], disadvantages: [] }]);
    const capped = taskSummary(f.prompt.id).options!;
    assert.equal(capped[0]!.advantages[0]!.length, TRADE_OFF_MAX);
    assert.ok(capped[0]!.advantages[0]!.endsWith(" [shortened]"), "a cut trade-off declares itself");
    assert.ok(capped[0]!.disadvantages[0]!.endsWith(" [shortened]"));
    assert.deepEqual(capped[1]!.advantages, ["1", "2", "3", "and 2 more in the local app"]);
  } finally {
    f.cleanup();
  }
});

test("S-L3-A2-03: options and history are redacted and flattened exactly as the other summary fields are", () => {
  const f = fixture();
  try {
    const secret = "sk-live-4f9a8b7c6d5e4f3a2b1c";
    blockWithStatus(f);
    workspaces.respondToBlockedPrompt(f.prompt.id, { content: `Use ${secret} at http://localhost:4000/admin *bold*` });
    blockWithStatus(f, [{ label: `Ship <b>red</b> with ${secret}`, advantages: ["See http://localhost:4000/admin\nand more"], disadvantages: [`Bearer abcdefghijklmnop`] }]);
    const summary = taskSummary(f.prompt.id);
    const rendered = JSON.stringify({ options: summary.options, history: summary.history });
    assert.ok(!rendered.includes(secret) && !rendered.includes("localhost") && !rendered.includes("abcdefghijklmnop"));
    assert.equal(summary.options![0]!.label, "Ship <b>red</b> with [redacted]", "markup characters stay literal");
    assert.ok(!summary.options![0]!.advantages[0]!.includes("\n"), "an option is one line");
    assert.ok(summary.history.previousAnswer!.text.includes("*bold*"));
  } finally {
    f.cleanup();
  }
});

test("S-L3-A2-06/07: history carries the runs, the block count and the previous answer, and says so plainly on a first run", () => {
  const f = fixture();
  try {
    assert.deepEqual(taskSummary(f.prompt.id).history, { runs: [], moreRuns: 0, blocks: 0, previousAnswer: null, morePreviousAnswers: 0 });
    blockWithStatus(f);
    workspaces.respondToBlockedPrompt(f.prompt.id, { content: "First answer" });
    blockWithStatus(f);
    workspaces.respondToBlockedPrompt(f.prompt.id, { content: "Second answer" });
    blockWithStatus(f);
    const { history } = taskSummary(f.prompt.id);
    assert.equal(history.runs.length, HISTORY_RUNS, "the phone gets the last three runs");
    assert.deepEqual(history.runs.map((run) => run.provider), ["grok", "grok", "grok"]);
    assert.ok(history.runs.every((run) => Date.parse(run.startedAt) > 0), "runs carry their times");
    assert.deepEqual(history.runs.map((run) => run.startedAt), [...history.runs.map((run) => run.startedAt)].sort().reverse(), "newest first");
    assert.equal(history.blocks, 3);
    assert.equal(history.previousAnswer!.text, "Second answer", "the most recent previous answer");
    assert.equal(history.morePreviousAnswers, 1, "and a count of the rest");
  } finally {
    f.cleanup();
  }
});

test("S-L3-A2-08: the flowchart position carries the next enabled step, and is absent off the flowchart", () => {
  const f = fixture({ steps: 5 });
  try {
    assert.equal(taskSummary(f.prompt.id).breadcrumb.nextStep, null, "no flowchart, no next step");
    for (const prompt of f.prompts) workspaces.addPipelineStep(prompt.id, { provider: "claude" });
    const onStep = taskSummary(f.prompt.id).breadcrumb;
    assert.deepEqual(onStep.step, { index: 1, total: 5 });
    assert.equal(onStep.nextStep, "Other step 1");
    workspaces.removePipelineStep(f.prompts[1]!.id);
    assert.equal(taskSummary(f.prompt.id).breadcrumb.nextStep, "Other step 2", "a disabled step is skipped");
    for (const prompt of f.prompts.slice(1)) workspaces.removePipelineStep(prompt.id);
    const last = taskSummary(f.prompt.id).breadcrumb;
    assert.deepEqual(last.step, { index: 1, total: 1 });
    assert.equal(last.nextStep, null, "the last enabled step has no next step");
  } finally {
    f.cleanup();
  }
});

test("S-L3-A2-13a (T0): the tag is project-scoped, hashtag-safe and stable, and two projects never share one", () => {
  const solo = fixture({ workspace: "Solo Project" });
  const first = fixture({ workspace: "Acme Reports" });
  const second = fixture({ workspace: "Acme-Reports" });
  const digits = fixture({ workspace: "123" });
  try {
    assert.match(taskSummary(solo.prompt.id).tag, /^#Solo_Project_t\d+$/);
    assert.equal(taskSummary(solo.prompt.id).tag, taskSummary(solo.prompt.id).tag, "the same task always produces the same tag");
    // Two project names that reduce to the same slug still get different tags.
    assert.notEqual(taskSummary(first.prompt.id).tag, taskSummary(second.prompt.id).tag);
    for (const summary of [taskSummary(solo.prompt.id), taskSummary(first.prompt.id), taskSummary(second.prompt.id), taskSummary(digits.prompt.id)]) {
      // Telegram only makes a hashtag of letters, digits and underscores, and only with a letter in it
      // (#123 is not a hashtag; see e2e/src/telegramEntities.test.ts).
      assert.match(summary.tag, /^#[A-Za-z0-9_]+$/, summary.tag);
      assert.match(summary.tag, /[A-Za-z]/, summary.tag);
      assert.ok(summary.tag.length <= 1 + TAG_SLUG_MAX + 10 + 2 + 12, summary.tag);
      assert.ok(summary.tag.endsWith(`_t${summary.promptId}`), "the task id, letter-prefixed because #123 is not a hashtag");
    }
    assert.equal(taskSummary(digits.prompt.id).tag.split("_")[0], "#123", "a digits-only project name keeps its digits; the id part carries the letter");
    assert.equal(taskSummary(solo.prompt.id).key, String(solo.prompt.id), "the identifier is what /task accepts");
  } finally {
    solo.cleanup();
    first.cleanup();
    second.cleanup();
    digits.cleanup();
  }
});
