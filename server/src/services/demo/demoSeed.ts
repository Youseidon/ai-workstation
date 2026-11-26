import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DemoSeedProgress, NormalizedEvent, ProviderId, TokenUsage } from "@hydra/shared";
import { DEMO_OWNER_MARKER, demoAccountDirectory } from "../../config/demo.ts";
import { updateSettings } from "../../config/settings.ts";
import { chatThreads, WorkspaceError, workspaces } from "../../repositories/workspaces.ts";
import { newId } from "../../utils/ids.ts";
import { refreshChangeCapture } from "../workspaces/gitChanges.ts";
import { materialize } from "../workspaces/workspaceInstructions.ts";
import { DARK_MODE_CHANGE, INITIAL_FILES, PAUSE_CHANGE, PRESETS_CHANGE, PROJECT_NAME, ROUNDING_CHANGE, WORKSPACE_INSTRUCTIONS, type ProjectChange, type ProjectFiles } from "./demoProject.ts";

// Demo accounts get a believable week of work: real files, real commits, and
// runs, threads and pipeline history written through the same repository
// calls a live agent's run uses. Nothing here starts a process: every run is
// already finished, so the scheduler and recovery code have nothing to resume.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// The run credential of a replayed run is born expired: no agent can ever
// authenticate as one of these runs.
const EXPIRED = new Date(0).toISOString();

function git(cwd: string, args: string[], at?: Date, author = { name: "Demo Operator", email: "demo@hydra.local" }): string {
  const stamp = at?.toISOString();
  const result = spawnSync("git", args, {
    cwd, encoding: "utf8", timeout: 15_000,
    env: {
      // Git runs no hooks in a fresh repository, but Hydra's state and gateway
      // credential still have no business in a child environment.
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HYDRA_") && key !== "SETTINGS_FILE")),
      GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
      ...(stamp ? { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } : {}),
      // The operator's own hooks and signing config belong to their repos, not this sample.
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (result.error || result.status !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.error?.message || "").trim()}`);
  return result.stdout.trim();
}

function writeFiles(root: string, files: ProjectFiles): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

function usage(input: number, output: number, cached = Math.round(input * 0.6)): TokenUsage {
  return { inputTokens: input, outputTokens: output, cachedInputTokens: cached, reasoningOutputTokens: Math.round(output * 0.2), totalTokens: input + output };
}

interface ToolStep { name: string; summary: string; input: unknown; output: string; isError?: boolean }
interface RunStory {
  provider: ProviderId;
  model: string;
  startedAt: Date;
  durationMs: number;
  thinking?: string;
  tools?: ToolStep[];
  reply: string;
  usage: TokenUsage;
  state?: "done" | "error";
  error?: string;
}

/** Replays a finished run as the stream a provider adapter would have produced. */
function replayEvents(runId: string, story: RunStory): { metrics: Parameters<typeof workspaces.finishAgentRun>[3]; endedAt: Date } {
  const tools = story.tools ?? [];
  const beats = 2 + tools.length * 2;
  let beat = 0;
  const at = () => new Date(story.startedAt.getTime() + Math.round((story.durationMs * ++beat) / (beats + 1))).toISOString();
  const base = (type: string) => ({ id: newId("evt"), runId, provider: story.provider, model: story.model, timestamp: at(), type });
  const record = (event: unknown) => workspaces.recordAgentEvent(runId, event as NormalizedEvent);
  if (story.thinking) record({ ...base("assistant_text"), payload: { blockId: newId("blk"), delta: false, text: story.thinking, kind: "thinking" } });
  for (const tool of tools) {
    const toolUseId = newId("tool");
    record({ ...base("tool_use"), payload: { toolUseId, name: tool.name, summary: tool.summary, input: tool.input } });
    record({ ...base("tool_result"), payload: { toolUseId, name: tool.name, isError: tool.isError === true, summary: tool.output.split("\n")[0]?.slice(0, 160) ?? "", output: tool.output, exitCode: tool.name.toLowerCase().includes("bash") || tool.name === "shell" ? (tool.isError ? 1 : 0) : null } });
  }
  const state = story.state ?? "done";
  if (state === "error" && story.error) record({ ...base("error"), payload: { message: story.error, fatal: true, detail: null } });
  else record({ ...base("assistant_text"), payload: { blockId: newId("blk"), delta: false, text: story.reply, kind: "message" } });
  const endedAt = new Date(story.startedAt.getTime() + story.durationMs);
  // A crashed provider reports no stop reason: any reason at all is read as a
  // budget stop (statusTransition.endOfRunReason), which would mislabel the crash.
  record({ id: newId("evt"), runId, provider: story.provider, model: story.model, timestamp: endedAt.toISOString(), type: "result",
    payload: { state, elapsedMs: story.durationMs, usage: story.usage, text: state === "done" ? story.reply : null, exitCode: state === "done" ? 0 : 1, stopReason: state === "done" ? "end_turn" : null } });
  return {
    endedAt,
    metrics: { usage: story.usage, toolCalls: tools.length, toolOutputBytes: tools.reduce((sum, tool) => sum + tool.output.length, 0), stopReason: state === "done" ? "end_turn" : null, processStarted: true, peakMemoryBytes: 180 * 1024 * 1024 },
  };
}

function commitChange(root: string, change: ProjectChange, runId: string, provider: ProviderId, model: string, at: Date): void {
  writeFiles(root, change.files);
  git(root, ["add", "-A"], at);
  const label = provider[0]!.toUpperCase() + provider.slice(1);
  // Same author and trailers as gitChanges.commitWorkingTree, so the sample
  // history looks exactly like a checkpoint a real agent leaves.
  git(root, ["commit", "-q", "-m", change.subject, "-m", [`Agent-Run: ${runId}`, `Agent-Provider: ${provider}`, `Agent-Model: ${model}`].join("\n")], at, { name: `${label} via Hydra`, email: "agent@hydra.local" });
}

export interface DemoSeedResult { workspaceId: number; workDirectory: string }

export async function seedDemoAccount(username: string, emit: (progress: DemoSeedProgress) => void): Promise<DemoSeedResult> {
  if (workspaces.list().length > 0) throw new WorkspaceError(409, "demo_already_seeded", "This demo account already has its sample data.");
  const step = async <T>(id: DemoSeedProgress["step"], detail: string, work: () => T): Promise<T> => {
    emit({ step: id, state: "active", detail });
    const value = work();
    emit({ step: id, state: "done", detail });
    // Let the stream flush between steps so the browser animates each one as it lands.
    await new Promise(resolvePromise => setImmediate(resolvePromise));
    return value;
  };
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms);
  const accountDirectory = demoAccountDirectory(username);
  const root = join(accountDirectory, PROJECT_NAME);

  await step("folder", `${root}`, () => {
    if (existsSync(root) && readdirSync(root).length > 0) throw new WorkspaceError(409, "demo_folder_exists", `${root} already exists`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(accountDirectory, DEMO_OWNER_MARKER), `${username}\n`, "utf8");
    writeFiles(root, INITIAL_FILES);
  });

  await step("git", "kettle · main · first commit", () => {
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["add", "-A"], ago(6 * DAY));
    git(root, ["commit", "-q", "-m", "Kettle: a tiny tea timer"], ago(6 * DAY));
  });

  const workspace = await step("workspace", "Kettle", () => {
    const created = workspaces.create({
      name: "Kettle",
      workDirectory: root,
      description: "A tiny, dependency-free tea timer used by the Hydra demo. Pick a brew, press start, get tea.",
    });
    const updated = workspaces.update(created.id, { agentsMd: WORKSPACE_INSTRUCTIONS, reason: "Demo setup" });
    materialize(updated);
    return updated;
  });

  const prompts = await step("library", "1 program · 2 suites · 6 work items", () => {
    const tree = workspaces.importProgram(workspace.id, {
      key: "KETTLE", name: "Kettle v1.0", overview: "Everything between today's prototype and a timer people keep open in a tab.",
      workspaceDescription: workspace.description,
      suites: [
        { key: "S1", name: "Core timer", prompts: [
          { key: "K-1", title: "Fix 1:60 in the countdown", content: "The clock sometimes shows `1:60`. Find the cause in `formatRemaining`, fix it so users only ever see whole seconds, and add a regression test.", status: "TODO", completedAt: null, result: "", isGate: false },
          { key: "K-2", title: "Add oolong and rooibos presets", content: "Add Oolong (3½ min, 90 °C) and Rooibos (6 min, 100 °C) to `src/brews.js`, and test that every brew has a unique id and a sane steep time.", status: "TODO", completedAt: null, result: "", isGate: false },
          { key: "K-3", title: "Show the water temperature", content: "Show the selected brew's water temperature under the clock, in °C, with °F in a tooltip.", status: "TODO", completedAt: null, result: "", isGate: false },
        ] },
        { key: "S2", name: "Polish", prompts: [
          { key: "K-4", title: "Chime when the tea is ready", content: "Play a short chime when the countdown reaches zero. Respect the system's reduced-motion and the tab's mute state.", status: "TODO", completedAt: null, result: "", isGate: false },
          { key: "K-5", title: "Keyboard shortcuts", content: "Space starts or pauses, R resets, 1–6 pick a brew. Show the shortcuts in a small footer.", status: "TODO", completedAt: null, result: "", isGate: false },
          { key: "K-6", title: "Accessibility pass", content: "Audit focus order, contrast and announcements. Fix what you find and list what you checked.", status: "TODO", completedAt: null, result: "", isGate: false },
        ] },
      ],
      dependencies: [{ promptKey: "K-6", dependsOnKey: "K-5" }],
      gates: [],
      warnings: [],
    });
    const byKey = new Map<string, number>();
    for (const program of tree.programs) for (const suite of program.suites) for (const prompt of suite.prompts) if (prompt.externalKey) byKey.set(prompt.externalKey, prompt.id);
    const suites = tree.programs[0]!.suites.map(suite => suite.id);
    return { byKey, suites };
  });
  const promptId = (key: string) => {
    const value = prompts.byKey.get(key);
    if (value === undefined) throw new Error(`demo work item ${key} is missing`);
    return value;
  };

  const pipelines = await step("pipelines", "Ship Kettle v1 · Nightly polish", () => {
    const ship = workspaces.createPipeline({ workspaceId: workspace.id, name: "Ship Kettle v1", description: "Core timer first, then polish. Each station hands its notes to the next.", suiteIds: prompts.suites, autoReassign: true });
    const plan: Array<[string, ProviderId, string]> = [["K-1", "codex", "gpt-5.5"], ["K-2", "cursor", "composer-2.5"], ["K-3", "copilot", "claude-sonnet-5"], ["K-4", "claude", "claude-sonnet-5"], ["K-5", "claude", "claude-haiku-4-5"], ["K-6", "codex", "gpt-5.5"]];
    for (const [key, provider, model] of plan) workspaces.addNamedPipelineStep(ship.id, promptId(key), { provider, model });
    const nightly = workspaces.createPipeline({ workspaceId: workspace.id, name: "Nightly polish", description: "Runs only the Polish suite, one cheap model at a time.", suiteIds: [prompts.suites[1]!] });
    for (const key of ["K-4", "K-5", "K-6"]) workspaces.addNamedPipelineStep(nightly.id, promptId(key), { provider: "claude", model: "claude-haiku-4-5" });
    return { ship: ship.id };
  });

  await step("chats", "4 conversations · 2 agent commits", () => {
    const ask = (threadId: string, text: string, story: RunStory, read = true) => {
      const runId = newId("run");
      workspaces.beginConsultRun({ runId, workspaceId: workspace.id, promptId: null, provider: story.provider, model: story.model, tokenHash: "demo", expiresAt: EXPIRED, displayText: text, threadId });
      workspaces.markAgentRunRunning(runId);
      const { metrics, endedAt } = replayEvents(runId, story);
      workspaces.finishAgentRun(runId, story.state ?? "done", "", metrics);
      workspaces.backdateFinishedRun(runId, story.startedAt.toISOString(), endedAt.toISOString());
      if (read) markRead(threadId, endedAt);
      return runId;
    };
    const run = (threadId: string, text: string, story: RunStory, change: ProjectChange | null, read = true) => {
      const runId = newId("run");
      workspaces.beginCustomExecuteRun({ runId, workspaceId: workspace.id, provider: story.provider, model: story.model, tokenHash: "demo", expiresAt: EXPIRED, displayText: text, threadId });
      workspaces.markAgentRunRunning(runId);
      workspaces.beginRunChangeSet({ runId, workspaceId: workspace.id, repositoryRoot: root, branch: "main", baseCommit: git(root, ["rev-parse", "HEAD"]) });
      const { metrics, endedAt } = replayEvents(runId, story);
      if (change) commitChange(root, change, runId, story.provider, story.model, new Date(endedAt.getTime() - 4000));
      refreshChangeCapture(runId);
      workspaces.finishAgentRun(runId, story.state ?? "done", "", metrics);
      workspaces.backdateFinishedRun(runId, story.startedAt.toISOString(), endedAt.toISOString());
      if (read) markRead(threadId, endedAt);
      return runId;
    };
    const markRead = (threadId: string, at: Date) => { chatThreads.patch(workspace.id, threadId, { readAt: new Date(Math.min(Date.now(), at.getTime() + 1000)).toISOString() }); };

    const explain = newId("thread");
    ask(explain, "How does the timer keep time? Walk me through it.", {
      provider: "claude", model: "claude-sonnet-5", startedAt: ago(5 * DAY + 3 * HOUR), durationMs: 41_000,
      thinking: "Start from the page, follow the Start button into src/app.js, then into createTimer.",
      tools: [
        { name: "Read", summary: "src/app.js", input: { file_path: "src/app.js" }, output: INITIAL_FILES["src/app.js"]! },
        { name: "Read", summary: "src/timer.js", input: { file_path: "src/timer.js" }, output: INITIAL_FILES["src/timer.js"]! },
      ],
      reply: [
        "Kettle never counts ticks — it measures **elapsed wall-clock time**, which is why it stays accurate even when the tab sleeps.",
        "",
        "1. `createTimer(totalSeconds)` in `src/timer.js` remembers *when* you pressed Start (`startedAt`).",
        "2. `remaining()` computes `totalSeconds − (now − startedAt) / 1000`, clamped at zero.",
        "3. `src/app.js` re-renders every 250 ms with `formatRemaining()`; the interval only refreshes the display, it does not keep time.",
        "",
        "One thing worth fixing: `formatRemaining` rounds the *seconds* part on its own, so `119.6` renders as **`1:60`**. Rounding the total first would fix it.",
      ].join("\n"),
      usage: usage(18_400, 920),
    });
    chatThreads.patch(workspace.id, explain, { pinned: true });

    const pause = newId("thread");
    run(pause, "Add pause and resume to the timer. Keep it dependency-free and add a test.", {
      provider: "claude", model: "claude-sonnet-5", startedAt: ago(5 * DAY + 2 * HOUR), durationMs: 3 * MINUTE + 12_000,
      thinking: "Pausing has to bank the elapsed time, otherwise resuming would jump. Add pause(), isRunning(), and keep remaining() pure.",
      tools: [
        { name: "Read", summary: "src/timer.js", input: { file_path: "src/timer.js" }, output: INITIAL_FILES["src/timer.js"]! },
        { name: "Edit", summary: "src/timer.js — bank elapsed time on pause", input: { file_path: "src/timer.js" }, output: "Applied 1 edit to src/timer.js" },
        { name: "Edit", summary: "src/app.js — Start button toggles Pause / Resume", input: { file_path: "src/app.js" }, output: "Applied 2 edits to src/app.js" },
        { name: "Edit", summary: "test/timer.test.js — pause banks elapsed time", input: { file_path: "test/timer.test.js" }, output: "Applied 1 edit to test/timer.test.js" },
        { name: "Bash", summary: "npm test", input: { command: "npm test" }, output: "▶ formats whole minutes\n▶ counts down with the clock\n▶ never goes below zero\n▶ pausing banks the elapsed time\nℹ tests 4\nℹ pass 4\nℹ fail 0" },
        { name: "Bash", summary: "agent-step checkpoint \"Add pause and resume to the timer\"", input: { command: "agent-step checkpoint \"Add pause and resume to the timer\"" }, output: "Committed 3 files to main." },
      ],
      reply: "Done. **Start** now toggles between *Pause* and *Resume*, and **Reset** puts it back to *Start*.\n\n- `createTimer` banks the elapsed seconds on `pause()` so resuming continues where you left off.\n- New test: *pausing banks the elapsed time*.\n- `npm test`: **4/4 passing**. Committed as “Add pause and resume to the timer”.",
      usage: usage(46_200, 3_850),
    }, PAUSE_CHANGE);
    ask(pause, "Does a paused timer survive switching brews?", {
      provider: "claude", model: "claude-sonnet-5", startedAt: ago(5 * DAY + 2 * HOUR - 6 * MINUTE), durationMs: 18_000,
      tools: [{ name: "Grep", summary: "createTimer( in src/", input: { pattern: "createTimer(", path: "src" }, output: "src/app.js:7:let timer = createTimer(brew.seconds);\nsrc/app.js:22:    timer = createTimer(brew.seconds);" }],
      reply: "No — picking a brew calls `createTimer(brew.seconds)` again, which deliberately starts fresh. That matches how a kettle works (new tea, new steep), but the button still reads *Resume*. Worth a follow-up: reset the button label when the brew changes.",
      usage: usage(21_000, 410),
    });

    const dark = newId("thread");
    run(dark, "Make Kettle follow the system dark mode.", {
      provider: "codex", model: "gpt-5.5", startedAt: ago(DAY + 5 * HOUR), durationMs: 2 * MINUTE + 4_000,
      tools: [
        { name: "shell", summary: "rg -n \"#fdf8f0|#2b2118\" styles.css", input: { command: ["rg", "-n", "#fdf8f0|#2b2118", "styles.css"] }, output: "7:  background: #fdf8f0;\n8:  color: #2b2118;\n12:.brews button[aria-checked=\"true\"] { background: #2b2118; color: #fdf8f0; }" },
        { name: "apply_patch", summary: "styles.css — colour tokens + prefers-color-scheme", input: { path: "styles.css" }, output: "Success. Updated styles.css" },
        { name: "shell", summary: "npm test", input: { command: ["npm", "test"] }, output: "ℹ tests 4\nℹ pass 4\nℹ fail 0" },
      ],
      reply: "Kettle now follows the system colour scheme. I replaced the two hard-coded colours with `--paper` / `--ink` tokens and flipped them under `prefers-color-scheme: dark`; `color-scheme: light dark` makes form controls match too. Tests still pass (4/4).",
      usage: usage(31_500, 2_100, 12_000),
    }, DARK_MODE_CHANGE, false);

    const ideas = newId("thread");
    ask(ideas, "What would make Kettle feel finished? Give me three ideas, smallest first.", {
      provider: "cursor", model: "composer-2.5", startedAt: ago(3 * HOUR), durationMs: 26_000,
      reply: "1. **Remember the last brew** — one `localStorage` key, five lines, and the app opens the way you left it.\n2. **Tab title countdown** — `document.title = \"2:41 · Kettle\"` lets people work in another tab and still see the tea.\n3. **A gentle chime** — already on your Polish board as K-4; it is waiting for you to choose a sound.",
      usage: usage(12_300, 640),
    }, false);
  });

  await step("stations", "Ship Kettle v1 · 4 station runs", () => {
    const station = (key: string, story: RunStory, outcome: { done?: string; blocked?: { reason: string; action: string }; change?: ProjectChange }) => {
      const runId = newId("run");
      const id = promptId(key);
      workspaces.beginAgentRun({ runId, workspaceId: workspace.id, promptId: id, provider: story.provider, model: story.model, tokenHash: "demo", expiresAt: EXPIRED });
      workspaces.markAgentRunRunning(runId);
      workspaces.beginRunChangeSet({ runId, workspaceId: workspace.id, repositoryRoot: root, branch: "main", baseCommit: git(root, ["rev-parse", "HEAD"]) });
      const { metrics, endedAt } = replayEvents(runId, story);
      if (outcome.change) commitChange(root, outcome.change, runId, story.provider, story.model, new Date(endedAt.getTime() - 4000));
      refreshChangeCapture(runId);
      if (outcome.done) workspaces.updateAgentStatus(runId, { requestId: newId("req").replace(/_/g, "-"), expectedStatus: "IN_PROGRESS", status: "DONE", reason: "Work complete.", verificationSummary: outcome.done });
      if (outcome.blocked) {
        workspaces.addAgentRemark(runId, { requestId: newId("req").replace(/_/g, "-"), kind: "FINDING", content: "The repository has no audio assets and no licence file for third-party sounds." });
        workspaces.updateAgentStatus(runId, { requestId: newId("req").replace(/_/g, "-"), expectedStatus: "IN_PROGRESS", status: "BLOCKED", reason: outcome.blocked.reason, verificationSummary: outcome.blocked.action });
      }
      workspaces.finishAgentRun(runId, story.state ?? "done", story.reply, metrics);
      workspaces.backdateFinishedRun(runId, story.startedAt.toISOString(), endedAt.toISOString());
      return endedAt;
    };
    const runId = newId("pipeline");
    workspaces.createNamedPipelineRun({ id: runId, pipelineId: pipelines.ship, workspaceId: workspace.id, playProvider: null, playModel: null });
    const started = ago(3 * DAY + 4 * HOUR);
    station("K-1", {
      provider: "codex", model: "gpt-5.5", startedAt: started, durationMs: 2 * MINUTE + 40_000,
      tools: [
        { name: "shell", summary: "node -e 'formatRemaining(119.6)'", input: { command: ["node", "-e", "import('./src/timer.js').then(m=>console.log(m.formatRemaining(119.6)))"] }, output: "1:60" },
        { name: "apply_patch", summary: "src/timer.js — round the total up before splitting", input: { path: "src/timer.js" }, output: "Success. Updated src/timer.js" },
        { name: "apply_patch", summary: "test/timer.test.js — never shows sixty seconds", input: { path: "test/timer.test.js" }, output: "Success. Updated test/timer.test.js" },
        { name: "shell", summary: "npm test", input: { command: ["npm", "test"] }, output: "ℹ tests 5\nℹ pass 5\nℹ fail 0" },
      ],
      reply: "Reproduced `1:60` for 119.6 s. `formatRemaining` now rounds the total up once before splitting minutes and seconds. Regression test added; 5/5 passing.",
      usage: usage(38_900, 2_750),
    }, { change: ROUNDING_CHANGE, done: "npm test: 5/5 passing, including the new “never shows sixty seconds” regression test. Reproduced 1:60 before the fix and 2:00 after." });
    station("K-2", {
      provider: "cursor", model: "composer-2.5", startedAt: new Date(started.getTime() + 4 * MINUTE), durationMs: MINUTE + 55_000,
      tools: [
        { name: "read_file", summary: "src/brews.js", input: { path: "src/brews.js" }, output: INITIAL_FILES["src/brews.js"]! },
        { name: "edit_file", summary: "src/brews.js — Oolong and Rooibos", input: { path: "src/brews.js" }, output: "Edited src/brews.js (+2)" },
        { name: "edit_file", summary: "test/brews.test.js — unique ids and steep times", input: { path: "test/brews.test.js" }, output: "Created test/brews.test.js" },
        { name: "run_terminal_cmd", summary: "npm test", input: { command: "npm test" }, output: "ℹ tests 7\nℹ pass 7\nℹ fail 0" },
      ],
      reply: "Added Oolong (210 s, 90 °C) and Rooibos (360 s, 100 °C), with a new brews test. 7/7 passing.",
      usage: usage(22_700, 1_480),
    }, { change: PRESETS_CHANGE, done: "npm test: 7/7 passing. New test/brews.test.js checks unique ids, a 1–10 minute steep range, and the unknown-id fallback." });
    const stoppedAt = station("K-3", {
      provider: "copilot", model: "claude-sonnet-5", startedAt: new Date(started.getTime() + 8 * MINUTE), durationMs: 21_000,
      tools: [{ name: "view", summary: "index.html", input: { path: "index.html" }, output: INITIAL_FILES["index.html"]! }],
      reply: "", state: "error", error: "Copilot returned 429: the monthly premium request allowance is used up.",
      usage: usage(6_100, 120),
    }, {});
    workspaces.updateNamedPipelineRun(runId, { state: "STOPPED", endedAt: stoppedAt.toISOString(), stopReason: "Copilot ran out of premium requests on K-3. Pick another agent for the station and press Play to continue." });
    workspaces.backdatePipelineRun(runId, started.toISOString(), stoppedAt.toISOString());

    station("K-4", {
      provider: "claude", model: "claude-sonnet-5", startedAt: ago(2 * DAY + 6 * HOUR), durationMs: MINUTE + 30_000,
      thinking: "A chime needs a sound. There is no audio in the repo, and choosing or licensing one is not something I should guess.",
      tools: [{ name: "Bash", summary: "git ls-files | grep -Ei '\\.(mp3|wav|ogg)$'", input: { command: "git ls-files | grep -Ei '\\.(mp3|wav|ogg)$'" }, output: "", isError: true }],
      reply: "Blocked: I need you to choose the chime sound.",
      usage: usage(15_800, 760),
    }, { blocked: {
      reason: "Kettle has no audio assets, and picking a third-party sound means accepting its licence on your behalf.",
      action: "Choose the chime: reply “synth” to let me generate a soft tone with the Web Audio API (no asset, no licence), or attach a sound file you have the rights to.",
    } });
  });

  await step("settings", "Budgets, permissions and two agents switched off", () => {
    // A demo account should be cheap to explore: a small spend cap, a short
    // clock, and the two agents the sample pipeline never uses turned off so
    // the Agents page shows both a configured and a disabled provider.
    const result = updateSettings({
      "budget.maxSpendUsd": 5,
      "budget.maxWallClockMinutes": 15,
      "models.reasoningEffort": "medium",
      "grok.enabled": false,
      "kilocode.enabled": false,
    } as never);
    if (!result.ok) throw new Error(`demo settings were rejected: ${result.errors.join("; ")}`);
  });

  return { workspaceId: workspace.id, workDirectory: root };
}
