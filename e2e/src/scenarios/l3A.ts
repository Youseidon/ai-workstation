import { expect } from "@playwright/test";
import type { PhoneMessage } from "../drivers/phone.ts";
import type { FakeScenario } from "../drivers/fakeProvider.ts";
import { eventually, observeQuietPeriod, state, type SavedTask } from "../drivers/state.ts";
import { openApp } from "../fixtures.ts";
import { runSavedTask, waitForRunEnd } from "../scenarios.ts";
import { telegramStatus, waitForTelegramState } from "../telegramFlows.ts";
import type { L1Context } from "./l1.ts";
import { executeRuns, humanResponses, inboxDrained, isCardFor, outboxFor, questionCard, receipts, replyWithAnswer, tapAndReport, waitForPromptStatus } from "./l1Flows.ts";

/*
 * L3 slice A scenarios (docs/e2e-scenarios/l3-f3-a.md): context-rich question cards rendered from the
 * task summary, observed on the phone (text, buttons, entities), in the Bot API request and in durable state.
 */

let sequence = 0;
const label = (base: string) => `${base} ${++sequence}`;

export const BRIEF = {
  originalObjective: "Produce the quarterly report in the brand colour.",
  terminationReason: "Needs an owner decision",
  completedWork: ["Collected the figures", "Built the charts", "Drafted the summary"],
  pendingWork: ["Apply the colour"],
  verificationPassed: Array.from({ length: 25 }, (_, index) => `check ${index}`),
  verificationFailed: [],
  blockers: [{ description: "The brand guide allows red or blue.\nMarketing has not chosen.", requiresHuman: true, requiredAction: "Pick red or blue." }, { description: "CI cache is cold", requiresHuman: false, requiredAction: null }],
  importantFiles: ["report/colours.ts"],
  decisionsAndAssumptions: ["Charts use the existing palette", "The summary stays one page"],
  recommendation: "WAIT_FOR_HUMAN",
  successorInstructions: "Apply the chosen colour.",
};

const sendCallFor = (harness: L1Context["harness"], title: string) => harness.telegramCalls().filter((call) => call.method === "sendMessage" && String(call.body.text).split("\n")[1] === `Task: ${title}`);

/** Blocks a task, then runs a read-only handoff through the fake agent so a READY brief exists, and returns the brief card. */
export async function blockWithBrief({ harness, phone }: L1Context, title: string, brief: object = BRIEF, later: FakeScenario[] = [], options?: FakeScenario["options"]): Promise<{ task: SavedTask; card: PhoneMessage; firstCard: PhoneMessage }> {
  const before = await phone.cursor();
  const { task, runId } = await runSavedTask(harness, { title, scenarios: [{ behavior: "block-on-decision", reason: "The brand guide allows red or blue.", humanAction: "Pick red or blue.", ...(options ? { options } : {}) }] });
  await waitForRunEnd(task, runId);
  const firstCard = await questionCard(phone, title, before);
  harness.fakeProvider.queue({ behavior: "done", text: JSON.stringify(brief) }, ...later);
  const afterFirst = firstCard.id;
  await state.post(`/api/prompts/${task.promptId}/handoff`, { handoffProvider: "grok", successorProvider: "grok" });
  await eventually("the handoff to be READY", async () => {
    const handoffs = await state.get<{ handoffs?: Array<{ state: string }> }>(`/api/prompts/${task.promptId}/activity`);
    return handoffs.handoffs?.some((handoff) => handoff.state === "READY") ? true : undefined;
  }, 60_000);
  // The brief makes a new question revision, so its card is the next card for this task (sections may be shortened away).
  const card = await phone.waitForBotMessage("the brief card", (message) => isCardFor(message, title) && message.buttons.length === 0, { afterId: afterFirst, timeoutMs: 60_000 });
  return { task, card, firstCard };
}

/** S-L3-A-01: the brief card runs general to specific with one collapsed details entity and no parse_mode. */
export async function briefCard(ctx: L1Context): Promise<void> {
  const { harness } = ctx;
  const title = label("Choose the report colour");
  const { card } = await blockWithBrief(ctx, title);
  const lines = card.text.split("\n");
  // A2 header: the task tag, the title, then the age and the breadcrumb.
  expect(lines[0]).toMatch(/^#[A-Za-z0-9_]*[A-Za-z][A-Za-z0-9_]*$/);
  expect(lines[1]).toBe(`Task: ${title}`);
  expect(lines[2]).toMatch(/^blocked [^·]+ · .+ · .+ \/ .+$/);
  expect(lines.slice(3, 7)).toEqual(["Blocked on:", "The brand guide allows red or blue.", "Marketing has not chosen.", "Action: Pick red or blue."]);
  expect(lines[7]).toBe("Agent recommends: Wait for your decision.");
  expect(lines[8]).toMatch(/^If you wait: /);
  expect(card.text).toContain("Reply to this message with your answer.");
  expect(card.text).not.toContain("CI cache is cold");
  expect(card.buttons).toEqual([]);
  // Telegram makes the A2 tag a hashtag entity of its own; the bot still sends exactly one entity.
  expect(card.entities.map((item) => item.type)).toEqual(["hashtag", "expandable_blockquote"]);
  const entity = card.entities.find((item) => item.type === "expandable_blockquote");
  expect(card.text.slice(card.entities[0]!.offset, card.entities[0]!.length)).toBe(lines[0]);
  const details = card.text.slice(entity!.offset, entity!.offset + entity!.length);
  expect(details).toContain("Goal: Produce the quarterly report in the brand colour.");
  expect(details).toContain("So far: Collected the figures; Built the charts; Drafted the summary · verification 25 passed, 0 failed");
  expect(details).toContain("History:");
  expect(details).toContain("Decisions and assumptions:\n- Charts use the existing palette");
  expect(details).toContain("Important files:\n- report/colours.ts");
  const request = sendCallFor(harness, title).at(-1)!;
  expect(request.body.parse_mode).toBeUndefined();
  expect(request.body.entities).toEqual([{ type: "expandable_blockquote", offset: entity!.offset, length: entity!.length }]);
}

/** S-L3-A-02: a remark-only card keeps the blocker's line breaks, has no empty sections or details, and still applies once. */
export async function remarkCard(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const title = label("Restart staging");
  const before = await phone.cursor();
  const { task, runId } = await runSavedTask(harness, { title, scenarios: [{ behavior: "block-on-decision", remarkKind: "BLOCKER", reason: "Staging is down.\nAsk ops to restart it.", humanAction: "Say when ops restarted it." }, { behavior: "consume-answer", expectInContext: "Restarted" }] });
  await waitForRunEnd(task, runId);
  const card = await questionCard(phone, title, before);
  // A BLOCKED status records its reason and required action as the latest blocker remark.
  expect(card.text).toMatch(/Blocked on:\nStaging is down\.\nAsk ops to restart it\.\n\n?Required human action: Say when ops restarted it\./);
  for (const labelText of ["Goal:", "So far:", "Agent recommends:", "Options:"]) expect(card.text).not.toContain(labelText);
  // A2: context and history are collapsed into the one blockquote; nothing else is.
  const quote = card.entities.find((item) => item.type === "expandable_blockquote")!;
  expect(card.entities.map((item) => item.type)).toEqual(["hashtag", "expandable_blockquote"]);
  const collapsed = card.text.slice(quote.offset, quote.offset + quote.length);
  expect(collapsed).toContain("History:");
  expect(card.text.slice(0, quote.offset)).not.toContain("History:");
  const answerCard = await replyWithAnswer(phone, card, "Restarted");
  await tapAndReport(phone, answerCard, "Answer and resume", /^Done: Answer saved and resume requested\./);
  await waitForPromptStatus(task, "DONE");
  expect(receipts(harness, task).filter((receipt) => receipt.state === "APPLIED")).toHaveLength(1);
}

/** S-L3-A-04: answer and saved-answer cards carry the summary plus the answer; Save starts nothing and Resume starts one run. */
export async function answerCards(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const title = label("Colour answer cards");
  const { task, card } = await blockWithBrief(ctx, title, BRIEF, [{ behavior: "consume-answer", expectInContext: "Red" }]);
  const long = `${"A long answer line with emoji 😀 and detail.\n".repeat(90)}Red`;
  const longCard = await phone.send(long, { replyTo: card }).then(() => phone.waitForBotMessage("the long answer card", (message) => isCardFor(message, title) && message.buttons.includes("Save answer") && message.text.includes("A long answer line"), { afterId: card.id }));
  expect(longCard.text.length).toBeLessThanOrEqual(4096);
  expect(longCard.text).toContain("Blocked on:");
  if (!longCard.text.includes(long)) expect(longCard.text).toContain("[shortened; the buttons submit your full answer]");
  const redCard = await replyWithAnswer(phone, card, "Red");
  expect(redCard.text).toContain("Your answer:\nRed");
  expect(redCard.text).toContain("Goal: Produce the quarterly report in the brand colour.");
  expect(redCard.buttons).toEqual(["Save answer", "Answer and resume"]);
  const saved = await tapAndReport(phone, redCard, "Save answer", /^Done: Answer saved; task remains waiting\./);
  const savedCard = await phone.waitForBotMessage("the saved-answer card", (message) => isCardFor(message, title) && message.buttons.includes("Resume with saved answer"), { afterId: saved.before });
  expect(savedCard.text).toContain("Saved answer:\nRed");
  expect(await executeRuns(task)).toHaveLength(1);
  await tapAndReport(phone, savedCard, "Resume with saved answer", /^Done: Answer saved and resume requested\./);
  await waitForPromptStatus(task, "DONE");
  expect(await executeRuns(task)).toHaveLength(2);
  expect(await humanResponses(task)).toEqual(["Red"]);
}

/** S-L3-A-06: an oversized brief is one accepted card within the limit; a reply to it applies once. */
export async function oversizedBriefCard(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const title = label("Oversized brief");
  const brief = { ...BRIEF, blockers: Array.from({ length: 20 }, (_, index) => ({ description: `Blocker ${index} ${"b".repeat(400)}`, requiresHuman: true, requiredAction: `Action ${index} ${"a".repeat(200)}` })) };
  const { task, card } = await blockWithBrief(ctx, title, brief, [{ behavior: "consume-answer", expectInContext: "Proceed" }]);
  expect(card.text.length).toBeLessThanOrEqual(4096);
  expect(card.text).toMatch(/and \d+ more blockers in the local app/);
  const { outbox } = await telegramStatus();
  expect(outbox.retrying + outbox.queued).toBe(0);
  expect(outboxFor(harness, task).every((row) => row.state === "SENT")).toBe(true);
  const answerCard = await replyWithAnswer(phone, card, "Proceed");
  await tapAndReport(phone, answerCard, "Answer and resume", /^Done: Answer saved and resume requested\./);
  await waitForPromptStatus(task, "DONE");
  expect(receipts(harness, task).filter((receipt) => receipt.state === "APPLIED")).toHaveLength(1);
}

/** S-L3-A-07 (T1 part): the phone reports the same UTF-16 entity bounds as the formatter, with emoji, CJK and combining marks ahead. */
export async function entityOffsetsOnPhone(ctx: L1Context): Promise<void> {
  const title = label("Offsets 😀");
  const brief = { ...BRIEF, originalObjective: "Ship 👨\u200d👩\u200d👧 🇦🇺 中文 مرحبا é today.", decisionsAndAssumptions: ["Keep 😀 in the details"] };
  const { card } = await blockWithBrief(ctx, title, brief);
  const request = sendCallFor(ctx.harness, title).at(-1)!;
  expect(card.text).toBe(request.body.text);
  // The phone also shows the hashtag entity Telegram adds for the A2 tag; the bot's own entity is unchanged.
  expect(card.entities.filter((item) => item.type === "expandable_blockquote")).toEqual(request.body.entities);
  const entity = card.entities.find((item) => item.type === "expandable_blockquote");
  const collapsed = card.text.slice(entity!.offset, entity!.offset + entity!.length);
  expect(collapsed).toContain("Decisions and assumptions:\n- Keep 😀 in the details");
}

/** S-L3-A-10/11: markup characters stay literal and secrets are redacted inside and outside the details. */
export async function literalAndRedactedCard(ctx: L1Context): Promise<void> {
  const title = label("Literal markup");
  const secret = "sk-live-4f9a8b7c6d5e4f3a2b1c";
  const markup = "<b>x</b> *bold* _it_ [click](https://example.com) `code` ||spoiler|| /help @someone #tag";
  const brief = { ...BRIEF, originalObjective: `${markup} with ${secret}`, decisionsAndAssumptions: [`Bearer abcdefghijklmnop and http://localhost:4000/admin ${secret}`] };
  const { card } = await blockWithBrief(ctx, title, brief);
  expect(card.text).toContain(`Goal: ${markup} with [redacted]`);
  expect(card.text).not.toContain(secret);
  expect(card.text).not.toContain("localhost");
  const request = sendCallFor(ctx.harness, title).at(-1)!;
  expect(request.body.parse_mode).toBeUndefined();
  expect((request.body.entities as Array<{ type: string }>).map((entity) => entity.type)).toEqual(["expandable_blockquote"]);
  // Telegram adds its own link, command, mention and hashtag entities for the literal markup, so pick the details.
  const entity = card.entities.find((item) => item.type === "expandable_blockquote");
  expect(card.text.slice(entity!.offset, entity!.offset + entity!.length)).toContain("- [redacted] and [redacted] [redacted]");
}

/** S-L3-A-12: a brief arriving changes the revision; the old answer card is rejected and a brief card is reissued. */
export async function briefChangesRevision(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const title = label("Revision after brief");
  const before = await phone.cursor();
  const { task, runId } = await runSavedTask(harness, { title, scenarios: [{ behavior: "block-on-decision", remarkKind: "BLOCKER", remark: "Pick a shade." }] });
  await waitForRunEnd(task, runId);
  const remarkCard = await questionCard(phone, title, before);
  const oldAnswer = await replyWithAnswer(phone, remarkCard, "Blue");
  harness.fakeProvider.queue({ behavior: "done", text: JSON.stringify(BRIEF) }, { behavior: "consume-answer", expectInContext: "Red" });
  await state.post(`/api/prompts/${task.promptId}/handoff`, { handoffProvider: "grok", successorProvider: "grok" });
  const briefCardMessage = await phone.waitForBotMessage("the brief card", (message) => isCardFor(message, title) && message.text.includes("\nGoal: ") && message.buttons.length === 0, { afterId: oldAnswer.id, timeoutMs: 60_000 });
  const { result } = await tapAndReport(phone, oldAnswer, "Answer and resume", /^Not applied: /);
  expect(result.text).not.toMatch(/resume requested/);
  await inboxDrained(harness);
  expect(await humanResponses(task)).toEqual([]);
  expect(await executeRuns(task)).toHaveLength(1);
  expect(receipts(harness, task).map((receipt) => receipt.state)).toEqual(["REJECTED"]);
  const fresh = await replyWithAnswer(phone, briefCardMessage, "Red");
  expect(fresh.text).toContain("Goal: ");
  await tapAndReport(phone, fresh, "Answer and resume", /^Done: Answer saved and resume requested\./);
  await waitForPromptStatus(task, "DONE");
  expect(receipts(harness, task).filter((receipt) => receipt.state === "APPLIED")).toHaveLength(1);
}

/** S-L3-A-13: a blocked pipeline step shows its position and the waiting line; answering resumes it and the next step runs once. */
export async function pipelineCard(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const name = label("Pipeline card");
  const workDirectory = harness.createGitWorkspace(`pipeline-card-${sequence}`);
  const { workspace } = await state.post<{ workspace: { id: number } }>("/api/workspaces", { name: `pipeline-card-${sequence}`, description: "", workDirectory });
  const { program } = await state.post<{ program: { id: number } }>(`/api/workspaces/${workspace.id}/programs`, { name: "Program", overview: "" });
  const { suite } = await state.post<{ suite: { id: number } }>(`/api/programs/${program.id}/suites`, { name: "Suite", overview: "" });
  const steps: Array<{ id: number }> = [];
  for (const [index, title] of [`${name} one`, name, `${name} three`].entries()) {
    const { prompt } = await state.post<{ prompt: { id: number } }>(`/api/suites/${suite.id}/prompts`, { title, content: `Step ${index + 1}.` });
    steps.push(prompt);
  }
  await state.patch(`/api/suites/${suite.id}/pipeline`, { defaultProvider: "grok", defaultModel: null });
  for (const step of steps) await state.post(`/api/suites/${suite.id}/pipeline/steps`, { promptId: step.id });
  harness.fakeProvider.queue({ behavior: "done" }, { behavior: "block-on-decision", reason: "Which environment?" }, { behavior: "consume-answer", expectInContext: "Staging" }, { behavior: "done" });
  const before = await phone.cursor();
  await state.post(`/api/suites/${suite.id}/play`, {});
  const card = await questionCard(phone, name, before, 90_000);
  expect(card.text.split("\n")[2]).toMatch(/ · pipeline step 2\/3$/);
  expect(card.text).toContain("If you wait: This task and its pipeline stay paused; other workspaces continue.");
  // S-L3-A2-08 on the phone: the collapsed context names the suite, the position and the next enabled step.
  const fits = card.text.slice(card.entities.find((item) => item.type === "expandable_blockquote")!.offset).split("\n")[0];
  expect(fits).toMatch(new RegExp(`^Where it fits: Suite, step 2/3; next: ${name} three$`));
  const answerCard = await replyWithAnswer(phone, card, "Staging");
  await tapAndReport(phone, answerCard, "Answer and resume", /^Done: Answer saved and resume requested\./);
  const task = (id: number) => ({ workspaceId: workspace.id, promptId: id, workDirectory });
  await waitForPromptStatus(task(steps[1]!.id), "DONE", 90_000);
  await waitForPromptStatus(task(steps[2]!.id), "DONE", 90_000);
  expect(await executeRuns(task(steps[1]!.id))).toHaveLength(2);
  expect(await executeRuns(task(steps[2]!.id))).toHaveLength(1);
}

/** S-L3-A-14: a label saved on the Agents page appears on the next card; resetting it returns the hostname; old cards are not edited. */
export async function labelOnCards(ctx: L1Context): Promise<void> {
  const { harness, phone, page } = ctx;
  const first = label("Label default");
  let before = await phone.cursor();
  let run = await runSavedTask(harness, { title: first, scenarios: [{ behavior: "block-on-decision" }] });
  await waitForRunEnd(run.task, run.runId);
  const defaultCard = await questionCard(phone, first, before);
  const crumb = (message: PhoneMessage) => message.text.split("\n")[2]!.replace(/^blocked [^·]+· /, "");
  const hostLabel = crumb(defaultCard).split(" · ")[0]!;
  await openApp(page, "/agents");
  await page.getByLabel("Workstation label", { exact: true }).fill("bench-01");
  await page.getByRole("button", { name: /^Save \d+$/ }).click();
  await expect(page.getByText(/Saved 1 setting/)).toBeVisible();
  const second = label("Label bench");
  before = await phone.cursor();
  run = await runSavedTask(harness, { title: second, scenarios: [{ behavior: "block-on-decision" }] });
  await waitForRunEnd(run.task, run.runId);
  expect(crumb(await questionCard(phone, second, before)).startsWith("bench-01 · ")).toBe(true);
  await state.post("/api/settings/reset", { keys: ["taskControl.workstationLabel"] });
  const third = label("Label reset");
  before = await phone.cursor();
  run = await runSavedTask(harness, { title: third, scenarios: [{ behavior: "block-on-decision" }] });
  await waitForRunEnd(run.task, run.runId);
  expect(crumb(await questionCard(phone, third, before)).startsWith(`${hostLabel} · `)).toBe(true);
  const unchanged = (await phone.messages()).find((message) => message.id === defaultCard.id)!;
  expect(unchanged.text).toBe(defaultCard.text);
  expect(harness.telegramCalls().filter((call) => call.method === "editMessageText")).toEqual([]);
}

/** S-L3-A-15 (a): a rich card queued during an outage is sent once after a restart with the text and entities it was queued with. */
export async function queuedCardSurvivesRestart(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const server = harness.telegramServer!;
  const title = label("Queued rich card");
  const { card, task } = await blockWithBrief(ctx, title);
  server.setOutage("refuse");
  await eventually("the transport to back off", async () => ((await telegramStatus()).state === "backoff" ? true : undefined), 30_000);
  const before = await phone.cursor();
  const answerRow = outboxFor(harness, task).length;
  await phone.send("Red", { replyTo: card });
  await harness.restartServer();
  server.setOutage(null);
  await waitForTelegramState("polling", 60_000);
  const answerCard = await phone.waitForBotMessage("the answer card after restart", (message) => isCardFor(message, title) && message.buttons.includes("Save answer"), { afterId: before, timeoutMs: 60_000 });
  expect(answerCard.text).toContain("Goal: ");
  await observeQuietPeriod(3_000, "a duplicate card");
  expect((await phone.messages()).filter((message) => message.id > before && isCardFor(message, title))).toEqual([answerCard]);
  expect(outboxFor(harness, task).length).toBe(answerRow + 1);
}
