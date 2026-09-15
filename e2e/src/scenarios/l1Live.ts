import { expect } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eventually, observeQuietPeriod, state, type SavedTask } from "../drivers/state.ts";
import { openApp } from "../fixtures.ts";
import { runSavedTask, waitForRunEnd } from "../scenarios.ts";
import { telegramStatus, waitForTelegramState } from "../telegramFlows.ts";
import type { L1Context } from "./l1.ts";
import { executeRuns, humanResponses, isCardFor, questionCard, receipts, replyWithAnswer, tapAndReport, waitForPromptStatus } from "./l1Flows.ts";

/*
 * L1 scenarios that need more than PhoneDriver: the route proxy (S-L1-17),
 * Bot API call inspection on either backend (S-L1-02) and real providers
 * (S-L1-31, S-L1-32). Written once for both backends where the table allows.
 */

let titles = 0;
const title = (base: string) => `${base} (live ${++titles})`;

/** S-L1-02: connecting reaches polling with the bot identity and the production 25s window. */
export async function connectReachesPolling({ harness, page }: L1Context): Promise<void> {
  await state.updateSettings({ "taskControl.enabled": true, "taskControl.transport": "telegram" });
  const status = await waitForTelegramState("polling", 60_000);
  const bot = harness.telegramIdentity();
  expect(status.bot).toEqual({ id: bot.id, username: bot.username });
  expect(status.reason).toBe("Long polling Telegram (25s window).");
  const poll = await eventually("a getUpdates call", async () => harness.telegramCalls().filter((call) => call.method === "getUpdates").at(-1));
  expect(poll.body.timeout).toBe(25);
  await openApp(page, "/agents");
  const panel = page.locator("div.rounded-md").filter({ has: page.getByRole("heading", { name: "Live Telegram", exact: true }) });
  await expect(panel.getByText("connected", { exact: true })).toBeVisible();
  await expect(panel.getByText(`@${bot.username}`)).toBeVisible();
}

/**
 * S-L1-17: the server loses its route to Telegram while a task blocks; the
 * panel reports retrying with a sanitized error, and after the route returns
 * the queued card arrives exactly once and a tap on it applies once.
 */
export async function routeCutWhileQueued({ harness, phone, page }: L1Context, holdMs: number): Promise<void> {
  const name = title("Approve the rollback");
  const before = await phone.cursor();
  harness.network.cutTelegram("refuse");
  const cutAt = Date.now();
  const { task, runId } = await runSavedTask(harness, { title: name, scenarios: [{ behavior: "block-on-decision" }, { behavior: "consume-answer", expectInContext: "Roll back" }] });
  await waitForRunEnd(task, runId);
  const retrying = await eventually("the transport to report retrying", async () => {
    const status = await telegramStatus();
    return status.state === "backoff" ? status : undefined;
  }, 90_000);
  expect(retrying.lastError ?? "").not.toContain(harness.telegramToken());
  expect(retrying.lastError ?? "").not.toContain(harness.telegramToken().split(":")[1]!);
  await openApp(page, "/agents");
  const panel = page.locator("div.rounded-md").filter({ has: page.getByRole("heading", { name: "Live Telegram", exact: true }) });
  await expect(panel.getByText("connected", { exact: true })).toHaveCount(0);
  expect((await state.prompt(task)).status).toBe("BLOCKED");
  expect((await phone.messages()).filter((message) => message.fromBot && message.id > before)).toEqual([]);
  const remaining = holdMs - (Date.now() - cutAt);
  if (remaining > 0) await observeQuietPeriod(remaining, "the card reaching the phone while the route is cut");
  expect((await phone.messages()).filter((message) => message.fromBot && message.id > before)).toEqual([]);

  harness.network.restoreTelegram();
  await waitForTelegramState("polling", 120_000);
  await expect(panel.getByText("connected", { exact: true })).toBeVisible({ timeout: 30_000 });
  const card = await questionCard(phone, name, before, 120_000);
  await eventually("outbox counts to clear", async () => {
    const { outbox } = await telegramStatus();
    return outbox.queued + outbox.retrying + outbox.failed === 0 ? true : undefined;
  }, 60_000);
  await observeQuietPeriod(5_000, "the queued card being delivered twice");
  expect((await phone.messages()).filter((message) => message.fromBot && isCardFor(message, name))).toEqual([card]);
  const answerCard = await replyWithAnswer(phone, card, "Roll back");
  await tapAndReport(phone, answerCard, "Answer and resume", /^Done: Answer saved and resume requested\./);
  await waitForPromptStatus(task, "DONE");
  expect(receipts(harness, task).filter((receipt) => receipt.state === "APPLIED")).toHaveLength(1);
  expect(await executeRuns(task)).toHaveLength(2);
}

/* ----------------------------- real providers ----------------------------- */

const COLOUR_TASK = [
  "This task needs a decision from the owner before any work can be done.",
  "",
  "Goal: create a file named colour.txt in the working directory containing exactly one lowercase word: the report colour the owner chose, red or blue.",
  "",
  "If your task context does not contain the owner's answer, you do not know the colour. Do not guess and do not create any file.",
  "Instead report that you are blocked, with the blocker \"The owner must choose the report colour: red or blue.\" and the required human action \"Reply red or blue.\", and stop.",
  "",
  "If your task context contains the owner's answer, create colour.txt with that one word and report the task done.",
].join("\n");

export const REAL_PROVIDER_RUN_TIMEOUT_MS = 6 * 60_000;

async function blockWithRealProvider({ harness, phone }: L1Context, provider: "claude" | "codex", name: string) {
  const before = await phone.cursor();
  const workDirectory = harness.createGitWorkspace(`real-${provider}-${titles}`);
  const task = await state.createSavedTask({ workDirectory, name: `real-${provider}-${titles}`, title: name, content: COLOUR_TASK });
  const started = await state.startSavedTask(task, provider);
  if ("error" in started) throw new Error(`${provider} run did not start: ${started.error}`);
  const first = await waitForRunEnd(task, started.runId, REAL_PROVIDER_RUN_TIMEOUT_MS);
  const blocked = (await state.history(task)).events.find((event) => event.newStatus === "BLOCKED");
  const lastError = first.events.filter((event) => event.type === "error").map((event) => JSON.stringify(event.payload)).at(-1);
  // The SYSTEM fallback also marks a failed run BLOCKED; only a block the agent posted proves the scenario.
  expect(blocked?.actorType, `the ${provider} run ended ${first.state} without posting a block${lastError ? `; last error ${lastError}` : ""}`).toBe("AGENT");
  const card = await questionCard(phone, name, before, 60_000);
  return { task, card };
}

/** Keeps the full event log of every run of the task, for the agent-behaviour spot check (harness plan 7 and 10.4). */
export async function keepRunLog(task: SavedTask, outputDir: string, provider: string): Promise<string> {
  mkdirSync(outputDir, { recursive: true });
  const file = join(outputDir, `${provider}-run-events.json`);
  writeFileSync(file, `${JSON.stringify(await state.sessionsFor(task), null, 2)}\n`);
  return file;
}

function colourFile(task: SavedTask): string | null {
  const file = join(task.workDirectory, "colour.txt");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}

type RunEvents = Awaited<ReturnType<typeof executeRuns>>[number]["events"];
const toolNames = (events: RunEvents) => events.filter((event) => event.type === "tool_use").map((event) => String((event.payload as { name?: string }).name ?? ""));

/** S-CLT-27: the tool path never shells out to curl and no tool call is refused for permissions. */
export function expectNoShellOrPermissionRefusal(events: RunEvents): void {
  const tools = toolNames(events);
  expect(tools.filter((tool) => /^bash$/i.test(tool)), `Claude used a shell: ${tools.join(", ")}`).toEqual([]);
  const refusals = events.filter((event) => event.type === "tool_result" && (event.payload as { isError?: boolean }).isError === true && /permission|not allowed|denied/i.test(JSON.stringify(event.payload)));
  expect(refusals, "a tool call was refused for permissions").toEqual([]);
}

/** S-CLT-02: real Claude on the cheapest model finishes a trivial task through the typed tools. */
export async function realClaudeTrivialDone({ harness, page }: L1Context, outputDir: string): Promise<void> {
  const name = title("Write the greeting with Claude");
  const workDirectory = harness.createGitWorkspace(`real-claude-trivial-${titles}`);
  const task = await state.createSavedTask({ workDirectory, name: `real-claude-trivial-${titles}`, title: name, content: "Create a file named hello.txt in the working directory containing exactly the word hello. Post a short progress remark when you start, then report the task done with a one-line verification summary." });
  try {
    const started = await state.startSavedTask(task, "claude");
    if ("error" in started) throw new Error(`claude run did not start: ${started.error}`);
    const run = await waitForRunEnd(task, started.runId, REAL_PROVIDER_RUN_TIMEOUT_MS);
    expect((await state.prompt(task)).status, `the Claude run ended ${run.state}`).toBe("DONE");
    const tools = toolNames(run.events);
    for (const tool of ["get_context", "post_remark", "post_status"]) expect(tools.some((name) => name.endsWith(tool)), `tools used: ${tools.join(", ")}`).toBe(true);
    expectNoShellOrPermissionRefusal(run.events);
    const history = await state.history(task);
    expect(history.remarks.some((remark) => remark.kind === "PROGRESS" && remark.actorType === "AGENT")).toBe(true);
    expect(history.remarks.some((remark) => remark.kind === "COMPLETION" && remark.runId === started.runId)).toBe(true);
    const done = history.events.find((event) => event.newStatus === "DONE")!;
    expect(done).toMatchObject({ actorType: "AGENT", runId: started.runId });
    expect(done.verificationSummary.length).toBeGreaterThan(0);
    expect(readFileSync(join(workDirectory, "hello.txt"), "utf8").trim()).toBe("hello");
    await openApp(page, "/tasks");
    await expect(page.getByText(name).first()).toBeVisible();
  } finally {
    await keepRunLog(task, outputDir, "claude-trivial");
  }
}

/** S-L1-31 (and S-CLT-03): real Claude on the typed tool path blocks, the phone answers and resumes, Claude reads the answer and finishes. */
export async function realClaudeAnswerAndResume(ctx: L1Context, outputDir: string): Promise<void> {
  const name = title("Choose the report colour with Claude");
  const { task, card } = await blockWithRealProvider(ctx, "claude", name);
  try {
    expect(card.text).toMatch(/colou?r/i);
    const [firstRun] = await executeRuns(task);
    const firstTools = toolNames(firstRun!.events);
    expect(firstTools.some((tool) => tool.endsWith("post_status")), `first Claude run tools: ${firstTools.join(", ")}`).toBe(true);
    expectNoShellOrPermissionRefusal(firstRun!.events);
    const blockedEvent = (await state.history(task)).events.find((event) => event.newStatus === "BLOCKED")!;
    expect(blockedEvent.actorType, "the block came from the agent, not the SYSTEM fallback").toBe("AGENT");
    expect(colourFile(task)).toBeNull();

    const answerCard = await replyWithAnswer(ctx.phone, card, "Blue");
    await tapAndReport(ctx.phone, answerCard, "Answer and resume", /^Done: Answer saved and resume requested\./);
    await waitForPromptStatus(task, "DONE", REAL_PROVIDER_RUN_TIMEOUT_MS);
    const applied = receipts(ctx.harness, task);
    expect(applied.filter((receipt) => receipt.state === "APPLIED")).toHaveLength(1);
    const runs = await executeRuns(task);
    expect(runs).toHaveLength(2);
    const resumed = runs.find((run) => run.id === applied[0]!.run_id)!;
    const resumedTools = toolNames(resumed.events);
    expectNoShellOrPermissionRefusal(resumed.events);
    expect(resumedTools.some((tool) => tool.endsWith("get_context")), `resumed Claude run tools: ${resumedTools.join(", ")}`).toBe(true);
    expect(await humanResponses(task)).toEqual(["Blue"]);
    expect(colourFile(task)).toBe("blue");
    await openApp(ctx.page, "/tasks");
    await expect(ctx.page.getByText(name).first()).toBeVisible();
  } finally {
    await keepRunLog(task, outputDir, "claude");
  }
}

/** S-L1-32: real Codex with Host access on blocks; Save answer starts nothing; Resume with saved answer starts one run that finishes the task. */
export async function realCodexSaveThenResume(ctx: L1Context, outputDir: string): Promise<void> {
  const name = title("Choose the report colour with Codex");
  const { task, card } = await blockWithRealProvider(ctx, "codex", name);
  try {
    const answerCard = await replyWithAnswer(ctx.phone, card, "Red");
    const saved = await tapAndReport(ctx.phone, answerCard, "Save answer", /^Done: Answer saved; task remains waiting\./);
    const resumeCard = await ctx.phone.waitForBotMessage("the saved-answer card", (message) => isCardFor(message, name) && message.buttons.includes("Resume with saved answer"), { afterId: saved.before, timeoutMs: 60_000 });
    await observeQuietPeriod(5_000, "a run starting after Save answer");
    expect(await executeRuns(task)).toHaveLength(1);
    expect(colourFile(task)).toBeNull();

    await tapAndReport(ctx.phone, resumeCard, "Resume with saved answer", /^Done: Answer saved and resume requested\./);
    await waitForPromptStatus(task, "DONE", REAL_PROVIDER_RUN_TIMEOUT_MS);
    expect(await executeRuns(task)).toHaveLength(2);
    expect(await humanResponses(task)).toEqual(["Red"]);
    expect(colourFile(task)).toBe("red");
  } finally {
    await keepRunLog(task, outputDir, "codex");
  }
}
