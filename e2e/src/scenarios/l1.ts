import { expect, type Page } from "@playwright/test";
import type { PhoneDriver } from "../drivers/phone.ts";
import { eventually, observeQuietPeriod, state } from "../drivers/state.ts";
import type { HarnessEnvironment } from "../env/orchestrator.ts";
import { webUrl } from "../env/orchestrator.ts";
import { telegramStatus, waitForTelegramState } from "../telegramFlows.ts";
import { waitForRunEnd } from "../scenarios.ts";
import { activityRevision, blockTask, isCardFor, isTaskCard, executeRuns, humanResponses, inboxDrained, outboxFor, questionCard, receipts, replyWithAnswer, tapAndReport, waitForPromptStatus, waitForRuns } from "./l1Flows.ts";

/*
 * L1 scenarios from docs/e2e-scenarios/l1.md, written once against PhoneDriver
 * so the T1 (fake) and T3 (real Telegram) specs run the same bodies.
 */

export interface L1Context {
  harness: HarnessEnvironment;
  phone: PhoneDriver;
  page: Page;
}

/** S-L1-15: how long before its actions expire the workstation goes offline; well inside Telegram's tap retention. */
const OFFLINE_BEFORE_EXPIRY_MS = 45_000;

let titles = 0;
const title = (base: string) => `${base} ${++titles}`;

/** S-L1-05: reply, Answer and resume, one run that uses the answer. */
export async function answerAndResume({ harness, phone }: L1Context): Promise<void> {
  const name = title("Pick the report colour");
  const { task, card } = await blockTask(harness, phone, { title: name, blocker: "The brand guide allows red or blue.", humanAction: "Pick the report colour.", later: [{ behavior: "consume-answer", expectInContext: "Red" }] });
  expect(card.text).toContain("The brand guide allows red or blue.");
  const answerCard = await replyWithAnswer(phone, card, "Red");
  expect(answerCard.buttons).toEqual(["Save answer", "Answer and resume"]);
  expect(answerCard.text).toContain("Your answer:\nRed");
  const { toast, result } = await tapAndReport(phone, answerCard, "Answer and resume", /^Done: Answer saved and resume requested\./);
  if (phone.backend === "fake") expect(toast).toBe("Answer saved and resume requested.");
  expect(result.buttons).toEqual([]);
  await waitForPromptStatus(task, "DONE");
  const applied = receipts(harness, task);
  expect(applied).toHaveLength(1);
  expect(applied[0]).toMatchObject({ state: "APPLIED", action: "answer_and_resume", started: 1 });
  expect(await humanResponses(task)).toEqual(["Red"]);
  const runs = await executeRuns(task);
  expect(runs).toHaveLength(2);
  expect(runs.map((run) => run.id)).toContain(applied[0]!.run_id);
}

/** S-L1-06: Save answer keeps waiting; Resume with saved answer later starts exactly one run. */
export async function saveThenResume({ harness, phone }: L1Context): Promise<void> {
  const name = title("Choose the release channel");
  const { task, card } = await blockTask(harness, phone, { title: name, later: [{ behavior: "consume-answer", expectInContext: "Blue" }] });
  const answerCard = await replyWithAnswer(phone, card, "Blue");
  const saved = await tapAndReport(phone, answerCard, "Save answer", /^Done: Answer saved; task remains waiting\./);
  if (phone.backend === "fake") expect(saved.toast).toBe("Answer saved; task remains waiting.");
  const resumeCard = await phone.waitForBotMessage("the saved-answer card", (message) => isCardFor(message, name) && message.buttons.includes("Resume with saved answer"), { afterId: saved.before });
  expect(resumeCard.text).toContain("Saved answer:\nBlue");
  // A saved answer holds the task: it is no longer blocked, but nothing runs until Resume.
  expect(await state.prompt(task)).toMatchObject({ status: "TODO", humanResponseHeld: true });
  expect(await executeRuns(task)).toHaveLength(1);
  expect(receipts(harness, task)).toMatchObject([{ state: "APPLIED", action: "save_human_response", started: 0, run_id: null }]);
  expect(await humanResponses(task)).toEqual(["Blue"]);

  await tapAndReport(phone, resumeCard, "Resume with saved answer", /^Done: Answer saved and resume requested\./);
  await waitForPromptStatus(task, "DONE");
  expect(await executeRuns(task)).toHaveLength(2);
  expect(await humanResponses(task)).toEqual(["Blue"]);
  const all = receipts(harness, task);
  expect(all.map((receipt) => [receipt.action, receipt.state, receipt.started])).toEqual([["save_human_response", "APPLIED", 0], ["answer_and_resume", "APPLIED", 1]]);
}

/** S-L1-07: a double tap applies once and the replay says so without another message. */
export async function doubleTap({ harness, phone }: L1Context): Promise<void> {
  const name = title("Approve the migration window");
  const { task, card } = await blockTask(harness, phone, { title: name, later: [{ behavior: "consume-answer", expectInContext: "Sunday" }] });
  const answerCard = await replyWithAnswer(phone, card, "Sunday");
  const first = await tapAndReport(phone, answerCard, "Answer and resume", /^Done: /);
  const afterFirst = await phone.cursor();
  const second = await phone.tap(answerCard, "Answer and resume");
  if (phone.backend === "fake") expect(second.toast).toBe("Already applied.");
  await inboxDrained(harness);
  await observeQuietPeriod(3_000, "a second result message for the replayed tap");
  expect((await phone.messages()).filter((message) => message.fromBot && message.id > afterFirst && !isTaskCard(message))).toEqual([]);
  await waitForPromptStatus(task, "DONE");
  expect(await executeRuns(task)).toHaveLength(2);
  expect(receipts(harness, task).filter((receipt) => receipt.state === "APPLIED")).toHaveLength(1);
  expect(await humanResponses(task)).toEqual(["Sunday"]);
  expect(harness.fakeProvider.log().filter((entry) => entry.event === "start" && entry.behavior === "consume-answer" && entry.cwd === task.workDirectory)).toHaveLength(1);
  expect(first.result.text).toMatch(/resume requested/);
}

/** S-L1-09: two replies make two answer cards; only the first tap stands. */
export async function competingReplies({ harness, phone }: L1Context): Promise<void> {
  const name = title("Name the mascot");
  const { task, card } = await blockTask(harness, phone, { title: name, later: [{ behavior: "consume-answer", expectInContext: "Green" }] });
  const red = await replyWithAnswer(phone, card, "Red");
  const green = await replyWithAnswer(phone, card, "Green");
  await tapAndReport(phone, green, "Answer and resume", /^Done: Answer saved and resume requested\./);
  const rejected = await tapAndReport(phone, red, "Answer and resume", /^Not applied: /);
  expect(rejected.result.text).not.toMatch(/resume requested/);
  await waitForPromptStatus(task, "DONE");
  expect(await humanResponses(task)).toEqual(["Green"]);
  expect(await executeRuns(task)).toHaveLength(2);
  expect(receipts(harness, task).map((receipt) => receipt.state).sort()).toEqual(["APPLIED", "REJECTED"]);
}

/** S-L1-10: answering locally first makes the phone tap stale (case A resume, case B save only). */
export async function answeredLocallyFirst({ harness, phone }: L1Context, localCase: "resume" | "save"): Promise<void> {
  const name = title(`Decide the retry policy (${localCase})`);
  const { task, card } = await blockTask(harness, phone, { title: name, later: [{ behavior: "consume-answer", expectInContext: "Local" }] });
  const answerCard = await replyWithAnswer(phone, card, "Phone");
  const expectedRevision = await activityRevision(task);
  if (localCase === "resume") await state.post(`/api/prompts/${task.promptId}/respond-and-continue`, { content: "Local", expectedRevision, provider: "grok", model: null });
  else await state.post(`/api/prompts/${task.promptId}/save-human-response`, { content: "Local", expectedRevision });
  const { result } = await tapAndReport(phone, answerCard, "Answer and resume", /^Not applied: /);
  expect(result.text).not.toMatch(/resume requested/);
  if (localCase === "resume") await waitForPromptStatus(task, "DONE");
  await inboxDrained(harness);
  expect(await humanResponses(task)).toEqual(["Local"]);
  expect(await executeRuns(task)).toHaveLength(localCase === "resume" ? 2 : 1);
  expect(receipts(harness, task).map((receipt) => receipt.state)).toEqual(["REJECTED"]);
}

/** S-L1-11: after the agent blocks on a new question, taps and replies bound to the old one do nothing. */
export async function newQuestionMakesOldCardsStale({ harness, phone }: L1Context): Promise<void> {
  const name = title("Pick the database");
  const { task, card } = await blockTask(harness, phone, { title: name, blocker: "Postgres or SQLite?", later: [{ behavior: "block-on-decision", reason: "Which region hosts it?", humanAction: "Pick a region." }, { behavior: "consume-answer", expectInContext: "Frankfurt" }] });
  const oldAnswer = await replyWithAnswer(phone, card, "SQLite");
  const before = await phone.cursor();
  const expectedRevision = await activityRevision(task);
  await state.post(`/api/prompts/${task.promptId}/respond-and-continue`, { content: "Postgres", expectedRevision, provider: "grok", model: null });
  await waitForRuns(task, 2);
  await waitForRunEnd(task, (await executeRuns(task)).at(-1)!.id);
  const second = await phone.waitForBotMessage("the question 2 card", (message) => isCardFor(message, name) && message.text.includes("Which region hosts it?"), { afterId: before });
  await tapAndReport(phone, oldAnswer, "Answer and resume", /^Not applied: /);
  const beforeReply = await phone.cursor();
  await phone.send("Paris", { replyTo: card });
  await phone.waitForBotMessage("the changed-question notice", (message) => message.text.startsWith("Not recorded: that question has changed"), { afterId: beforeReply });
  await inboxDrained(harness);
  await observeQuietPeriod(2_000, "an answer card rebinding the old reply to the new question");
  expect((await phone.messages()).filter((message) => message.fromBot && message.id > beforeReply && message.buttons.includes("Save answer"))).toEqual([]);
  expect(await humanResponses(task)).toEqual(["Postgres"]);
  const current = await replyWithAnswer(phone, second, "Frankfurt");
  await tapAndReport(phone, current, "Answer and resume", /^Done: Answer saved and resume requested\./);
  await waitForPromptStatus(task, "DONE");
  expect(await humanResponses(task)).toEqual(["Frankfurt", "Postgres"]);
  expect(await executeRuns(task)).toHaveLength(3);
}

/** S-L1-12: plain text and replies to non-question messages record nothing and offer no buttons. */
export async function strayMessagesRecordNothing({ harness, phone }: L1Context): Promise<void> {
  const name = title("Confirm the budget");
  const { task } = await blockTask(harness, phone, { title: name });
  const notice = (await phone.messages()).filter((message) => message.fromBot && message.text.startsWith("Paired with this workstation")).at(-1)!;
  const before = await phone.cursor();
  await phone.send("hello there");
  await phone.send("Approve it", { replyTo: notice });
  await inboxDrained(harness);
  await observeQuietPeriod(2_000, "an answer card or buttons for stray messages");
  const replies = (await phone.messages()).filter((message) => message.fromBot && message.id > before);
  expect(replies.every((message) => message.buttons.length === 0)).toBe(true);
  expect(await humanResponses(task)).toEqual([]);
  expect(receipts(harness, task)).toEqual([]);
  expect(await executeRuns(task)).toHaveLength(1);
  expect((await state.prompt(task)).status).toBe("BLOCKED");
}

/**
 * S-L1-33: a reply or tap that reaches the server before its card's sendMessage response (so before the server knows
 * the card's message id and has bound the card's buttons to it) still acts on that card. Fake only: real Telegram
 * shows this race by chance (S-L1-32 and S-L1-31 hit it), not on demand.
 */
export async function actBeforeCardSendReturns({ harness, phone }: L1Context): Promise<void> {
  const name = title("Answer the card in flight");
  const server = harness.telegramServer!;
  server.delayNextResponse("sendMessage", 4_000);
  const { task, card } = await blockTask(harness, phone, { title: name, later: [{ behavior: "consume-answer", expectInContext: "Teal" }] });
  const before = await phone.cursor();
  // The reply goes out while the question card's response is still held; then the answer card's response is held too.
  server.delayNextResponse("sendMessage", 4_000);
  const answerCard = await replyWithAnswer(phone, card, "Teal");
  const { result } = await tapAndReport(phone, answerCard, "Answer and resume", /^(Done|Not applied): /);
  const replies = (await phone.messages()).filter((message) => message.fromBot && message.id > before);
  expect(replies.map((message) => message.text).filter((text) => text.startsWith("That message is not a task question"))).toEqual([]);
  expect(result.text).toMatch(/^Done: Answer saved and resume requested\./);
  await waitForPromptStatus(task, "DONE");
  expect(await humanResponses(task)).toEqual(["Teal"]);
  expect(await executeRuns(task)).toHaveLength(2);
}

/** S-L1-13: once the task is done locally, the old card and reply change nothing. */
export async function doneTaskIgnoresOldCards({ harness, phone }: L1Context): Promise<void> {
  const name = title("Pick the font");
  const { task, card } = await blockTask(harness, phone, { title: name, later: [{ behavior: "consume-answer", expectInContext: "Inter" }] });
  const answerCard = await replyWithAnswer(phone, card, "Roboto");
  await state.post(`/api/prompts/${task.promptId}/respond-and-continue`, { content: "Inter", expectedRevision: await activityRevision(task), provider: "grok", model: null });
  await waitForPromptStatus(task, "DONE");
  await tapAndReport(phone, answerCard, "Answer and resume", /^Not applied: /);
  const before = await phone.cursor();
  await phone.send("Arial", { replyTo: card });
  await inboxDrained(harness);
  await observeQuietPeriod(2_000, "an answer card for a finished task");
  expect((await phone.messages()).filter((message) => message.fromBot && message.id > before && message.buttons.length > 0)).toEqual([]);
  expect(await humanResponses(task)).toEqual(["Inter"]);
  expect((await state.prompt(task)).status).toBe("DONE");
  expect(await executeRuns(task)).toHaveLength(2);
}

/** S-L1-23: Remote actions off rejects taps, turning them back on does not replay them. */
export async function remoteActionsOffThenOn({ harness, phone }: L1Context): Promise<void> {
  const name = title("Choose the backup schedule");
  const { task, card } = await blockTask(harness, phone, { title: name, later: [{ behavior: "consume-answer", expectInContext: "Nightly" }] });
  const answerCard = await replyWithAnswer(phone, card, "Nightly");
  await state.updateSettings({ "taskControl.remoteActionsEnabled": false });
  const { toast } = await phone.tap(answerCard, "Answer and resume");
  if (phone.backend === "fake") expect(toast ?? "").toMatch(/disabled|off/i);
  await inboxDrained(harness);
  expect(await humanResponses(task)).toEqual([]);
  expect(await executeRuns(task)).toHaveLength(1);
  await state.updateSettings({ "taskControl.remoteActionsEnabled": true });
  await observeQuietPeriod(3_000, "the rejected tap being replayed after Remote actions came back on");
  expect(await humanResponses(task)).toEqual([]);
  expect(await executeRuns(task)).toHaveLength(1);
  const before = await phone.cursor();
  const fresh = await replyWithAnswer(phone, card, "Nightly").catch(async () => {
    const reissued = await questionCard(phone, name, before);
    return replyWithAnswer(phone, reissued, "Nightly");
  });
  await tapAndReport(phone, fresh, "Answer and resume", /^Done: Answer saved and resume requested\./);
  await waitForPromptStatus(task, "DONE");
  expect(await executeRuns(task)).toHaveLength(2);
}

/** S-L1-24: after unpairing, old buttons stay dead and no cards arrive; re-pairing gets new cards only. */
export async function unpairStopsControl({ harness, phone }: L1Context, repair: () => Promise<void>): Promise<void> {
  const name = title("Choose the log retention");
  const { task, card } = await blockTask(harness, phone, { title: name });
  const answerCard = await replyWithAnswer(phone, card, "30 days");
  const actor = (await telegramStatus()).actors[0]!;
  await state.delete(`/api/task-control/telegram/actors/${actor.id}`);
  await phone.waitForBotMessage("the unpaired notice", (message) => message.text.startsWith("This chat was unpaired"), { afterId: card.id });
  const second = title("Choose the alert channel");
  const before = await phone.cursor();
  const blocked = await blockTask(harness, phone, { title: second }).then(() => null, (error: Error) => error);
  expect(blocked?.message ?? "").toMatch(/timed out/);
  await phone.tap(answerCard, "Answer and resume");
  await phone.send("60 days", { replyTo: card });
  await inboxDrained(harness);
  expect((await phone.messages()).filter((message) => message.fromBot && message.id > before)).toEqual([]);
  expect(await humanResponses(task)).toEqual([]);
  expect(await executeRuns(task)).toHaveLength(1);
  expect((await telegramStatus()).actors).toEqual([]);
  await repair();
  await questionCard(phone, second, before, 30_000);
  const stale = await phone.tap(answerCard, "Answer and resume");
  await inboxDrained(harness);
  if (phone.backend === "fake") expect(stale.toast ?? "").toMatch(/^Not applied/);
  expect(await humanResponses(task)).toEqual([]);
}

/** S-L1-25: resume cannot start while the provider is disabled; the saved answer resumes later. */
export async function resumeCannotStart({ harness, phone }: L1Context): Promise<void> {
  const name = title("Approve the vendor");
  const { task, card } = await blockTask(harness, phone, { title: name, later: [{ behavior: "consume-answer", expectInContext: "Yes" }] });
  const answerCard = await replyWithAnswer(phone, card, "Yes");
  await state.updateSettings({ "grok.enabled": false });
  const { result, before } = await tapAndReport(phone, answerCard, "Answer and resume", /^Answer saved, but resume did not start: /);
  expect(result.text.length).toBeGreaterThan("Answer saved, but resume did not start: ".length + 5);
  expect(await humanResponses(task)).toEqual(["Yes"]);
  expect(await executeRuns(task)).toHaveLength(1);
  expect(await state.prompt(task)).toMatchObject({ status: "TODO", humanResponseHeld: true });
  expect(receipts(harness, task)).toMatchObject([{ state: "APPLIED", started: 0, error_code: "resume_failed" }]);
  await state.updateSettings({ "grok.enabled": true });
  const resumeCard = await phone.waitForBotMessage("the saved-answer card", (message) => message.buttons.includes("Resume with saved answer"), { afterId: before, timeoutMs: 30_000 });
  await tapAndReport(phone, resumeCard, "Resume with saved answer", /^Done: Answer saved and resume requested\./);
  await waitForPromptStatus(task, "DONE");
  expect(await executeRuns(task)).toHaveLength(2);
  expect(await humanResponses(task)).toEqual(["Yes"]);
}

/** S-L1-14: taps and replies made while the workstation is offline are processed once when it returns. */
export async function offlineShortGap({ harness, phone }: L1Context, offlineCase: "tap" | "reply"): Promise<void> {
  const name = title(`Confirm the rollout (${offlineCase})`);
  const { task, card } = await blockTask(harness, phone, { title: name, later: [{ behavior: "consume-answer", expectInContext: "Go" }] });
  const answerCard = offlineCase === "tap" ? await replyWithAnswer(phone, card, "Go") : null;
  await harness.stopServer();
  const before = await phone.cursor();
  if (answerCard) await phone.tap(answerCard, "Answer and resume");
  else await phone.send("Go", { replyTo: card });
  await harness.startServer();
  await waitForTelegramState("polling");
  if (answerCard) {
    await phone.waitForBotMessage("the result of the offline tap", (message) => /^Done: Answer saved and resume requested\./.test(message.text), { afterId: before, timeoutMs: 60_000 });
  } else {
    const late = await phone.waitForBotMessage("the answer card for the offline reply", (message) => message.buttons.includes("Save answer") && message.text.includes("Go"), { afterId: before, timeoutMs: 60_000 });
    await tapAndReport(phone, late, "Answer and resume", /^Done: Answer saved and resume requested\./);
  }
  await waitForPromptStatus(task, "DONE");
  expect(await humanResponses(task)).toEqual(["Go"]);
  expect(await executeRuns(task)).toHaveLength(2);
  expect(receipts(harness, task).filter((receipt) => receipt.state === "APPLIED")).toHaveLength(1);
}

/** S-L1-15: a tap made offline and processed after the action TTL is expired and the question reissued. */
export async function offlineLongGap({ harness, phone }: L1Context, ttlMs: number): Promise<void> {
  const name = title("Confirm the freeze");
  const { task, card } = await blockTask(harness, phone, { title: name, later: [{ behavior: "consume-answer", expectInContext: "Freeze" }] });
  const answerCard = await replyWithAnswer(phone, card, "Freeze");
  const refs = harness.query<{ expires_at: string }>("SELECT expires_at FROM task_control_action WHERE prompt_id = ?", task.promptId);
  // Telegram drops a tap the bot has not collected about 2.5 minutes after it is made (callbackUpdateRetentionMs), so
  // the workstation goes offline shortly before the actions expire: the tap still arrives, but after the TTL.
  const lastExpiry = Math.max(...refs.map((ref) => Date.parse(ref.expires_at)));
  await eventually("the actions to be about to expire", async () => Date.now() >= lastExpiry - OFFLINE_BEFORE_EXPIRY_MS, ttlMs + 60_000);
  await harness.stopServer();
  const before = await phone.cursor();
  await phone.tap(answerCard, "Answer and resume");
  await eventually("the action TTL to pass while offline", async () => refs.every((ref) => Date.parse(ref.expires_at) < Date.now()), ttlMs + 60_000);
  await harness.startServer();
  await waitForTelegramState("polling");
  await phone.waitForBotMessage("the expiry notice", (message) => /^Not applied: This action expired/.test(message.text), { afterId: before, timeoutMs: 60_000 });
  const reissued = await questionCard(phone, name, before, 60_000);
  await inboxDrained(harness);
  expect(await humanResponses(task)).toEqual([]);
  expect(await executeRuns(task)).toHaveLength(1);
  expect((await state.prompt(task)).status).toBe("BLOCKED");
  expect(receipts(harness, task)).toMatchObject([{ state: "REJECTED", error_code: "action_expired" }]);
  const fresh = await replyWithAnswer(phone, reissued, "Freeze");
  await tapAndReport(phone, fresh, "Answer and resume", /^Done: Answer saved and resume requested\./);
  await waitForPromptStatus(task, "DONE");
  expect(await executeRuns(task)).toHaveLength(2);
}

/** S-L1-19: a restart while a card is pending sends no duplicate and the old card still works. */
export async function restartWhileWaiting({ harness, phone }: L1Context, pending: "question" | "answer"): Promise<void> {
  const name = title(`Pick the icon (${pending})`);
  const { task, card } = await blockTask(harness, phone, { title: name, later: [{ behavior: "consume-answer", expectInContext: "Star" }] });
  const answerCard = pending === "answer" ? await replyWithAnswer(phone, card, "Star") : null;
  const rows = outboxFor(harness, task).length;
  const before = await phone.cursor();
  await harness.restartServer();
  await waitForTelegramState("polling");
  await observeQuietPeriod(7_000, "a duplicate card after restart (notify interval is 5s)");
  expect((await phone.messages()).filter((message) => message.fromBot && message.id > before)).toEqual([]);
  expect(outboxFor(harness, task)).toHaveLength(rows);
  const tapTarget = answerCard ?? (await replyWithAnswer(phone, card, "Star"));
  await tapAndReport(phone, tapTarget, "Answer and resume", /^Done: Answer saved and resume requested\./);
  await waitForPromptStatus(task, "DONE");
  expect(await executeRuns(task)).toHaveLength(2);
}

/** S-L1-21: answering a blocked pipeline step resumes it and the pipeline continues to the next step exactly once. */
export async function pipelineStep({ harness, phone }: L1Context): Promise<void> {
  const name = title("Pipeline step one");
  const workDirectory = harness.createGitWorkspace(`pipeline-${titles}`);
  const { workspace } = await state.post<{ workspace: { id: number } }>("/api/workspaces", { name: `pipeline-${titles}`, description: "", workDirectory });
  const { program } = await state.post<{ program: { id: number } }>(`/api/workspaces/${workspace.id}/programs`, { name: "Program", overview: "" });
  const { suite } = await state.post<{ suite: { id: number } }>(`/api/programs/${program.id}/suites`, { name: "Suite", overview: "" });
  const { prompt: first } = await state.post<{ prompt: { id: number } }>(`/api/suites/${suite.id}/prompts`, { title: name, content: "Step one." });
  const { prompt: second } = await state.post<{ prompt: { id: number } }>(`/api/suites/${suite.id}/prompts`, { title: `${name} two`, content: "Step two." });
  await state.patch(`/api/suites/${suite.id}/pipeline`, { defaultProvider: "grok", defaultModel: null });
  await state.post(`/api/suites/${suite.id}/pipeline/steps`, { promptId: first.id });
  await state.post(`/api/suites/${suite.id}/pipeline/steps`, { promptId: second.id });
  harness.fakeProvider.queue({ behavior: "block-on-decision", reason: "Which environment?", humanAction: "Pick one." }, { behavior: "consume-answer", expectInContext: "Staging" }, { behavior: "done" });
  const before = await phone.cursor();
  await state.post(`/api/suites/${suite.id}/play`, {});
  const card = await questionCard(phone, name, before, 60_000);
  const taskOne = { workspaceId: workspace.id, promptId: first.id, workDirectory };
  const taskTwo = { workspaceId: workspace.id, promptId: second.id, workDirectory };
  const answerCard = await replyWithAnswer(phone, card, "Staging");
  await tapAndReport(phone, answerCard, "Answer and resume", /^Done: Answer saved and resume requested\./);
  await waitForPromptStatus(taskOne, "DONE");
  await waitForPromptStatus(taskTwo, "DONE");
  expect(await executeRuns(taskOne)).toHaveLength(2);
  expect(await executeRuns(taskTwo)).toHaveLength(1);
}

/** S-L1-03 (browser part lives in the H3 pairing flow): used by T3 to pair through the page. */
export async function pairFromPage({ page, phone }: L1Context): Promise<void> {
  const { pairThroughAgentsPage } = await import("../telegramFlows.ts");
  await pairThroughAgentsPage(page, phone);
  await page.goto(`${webUrl}/agents`);
}

/** S-L1-04: pairing refuses a group chat, a cancelled code and a replay from another user. */
export async function pairingAuthorization({ harness }: L1Context, repair: () => Promise<void>): Promise<void> {
  const server = harness.telegramServer!;
  const bot = harness.telegramBot!;
  const { FakePhone } = await import("../drivers/phone.ts");
  const operator = harness.phone!;
  const group = new FakePhone(server, bot, { id: 5_550_001, firstName: "Operator" }, { id: -100_777, type: "supergroup", title: "Team" });
  const other = new FakePhone(server, bot, { id: 5_550_321, firstName: "Other" }, { id: 5_550_321, type: "private" });

  const { pairing } = await state.post<{ pairing: { code: string } }>("/api/task-control/telegram/pairing");
  await group.send(`/start ${pairing.code}`);
  await group.waitForBotMessage("the group refusal", (message) => message.text.startsWith("Pair from a private chat"));
  expect((await telegramStatus()).pairing?.observed).toBeNull();
  await state.delete("/api/task-control/telegram/pairing");
  await operator.send(`/start ${pairing.code}`);
  await inboxDrained(harness);
  expect((await telegramStatus()).pairing).toBeNull();
  expect((await telegramStatus()).actors).toEqual([]);

  await repair();
  const actorsBefore = (await telegramStatus()).actors;
  const second = await state.post<{ pairing: { code: string } }>("/api/task-control/telegram/pairing");
  await operator.send(`/start ${second.pairing.code}`);
  await eventually("the operator's second code to be observed", async () => (await telegramStatus()).pairing?.observed ?? undefined);
  await other.send(`/start ${second.pairing.code}`);
  await other.waitForBotMessage("the already-used notice", (message) => message.text.startsWith("This pairing code was already used"));
  expect((await telegramStatus()).pairing?.observed?.transportUserId).toBe(String(5_550_001));
  await state.delete("/api/task-control/telegram/pairing");
  expect((await telegramStatus()).actors).toEqual(actorsBefore);
}

/** S-L1-08: the same message and callback updates delivered twice are applied once. */
export async function duplicateUpdates({ harness, phone }: L1Context): Promise<void> {
  const server = harness.telegramServer!;
  const name = title("Choose the cache size");
  const { task, card } = await blockTask(harness, phone, { title: name, later: [{ behavior: "consume-answer", expectInContext: "256MB" }] });
  const before = await phone.cursor();
  server.duplicateNextDelivery();
  await phone.send("256MB", { replyTo: card });
  const answerCard = await phone.waitForBotMessage("the answer card", (message) => message.buttons.includes("Save answer"), { afterId: before });
  await inboxDrained(harness);
  await observeQuietPeriod(2_000, "a second answer card from the duplicated reply update");
  expect((await phone.messages()).filter((message) => message.fromBot && message.id > before && message.buttons.includes("Save answer"))).toHaveLength(1);
  server.duplicateNextDelivery();
  await tapAndReport(phone, answerCard, "Answer and resume", /^Done: Answer saved and resume requested\./);
  await waitForPromptStatus(task, "DONE");
  await observeQuietPeriod(2_000, "a second result from the duplicated callback update");
  expect(receipts(harness, task)).toHaveLength(1);
  expect(await executeRuns(task)).toHaveLength(2);
  const updateIds = harness.query<{ update_id: number }>("SELECT update_id FROM telegram_inbox ORDER BY update_id").map((row) => row.update_id);
  expect(new Set(updateIds).size).toBe(updateIds.length);
}

/** S-L1-16: outage, 5xx and 429 while a card is queued; the card is delivered exactly once afterwards. */
export async function faultsWhileQueued({ harness, phone }: L1Context, fault: "outage" | "5xx" | "429"): Promise<void> {
  const server = harness.telegramServer!;
  const name = title(`Approve the certificate (${fault})`);
  const before = await phone.cursor();
  if (fault === "outage") server.setOutage("refuse");
  else if (fault === "5xx") server.failNext("*", 502, { count: 6 });
  else server.failNext("*", 429, { count: 3, retryAfter: 2, description: "Too Many Requests: retry after 2" });
  const { runSavedTask } = await import("../scenarios.ts");
  const { task, runId } = await runSavedTask(harness, { title: name, scenarios: [{ behavior: "block-on-decision" }] });
  await waitForRunEnd(task, runId);
  const retrying = await eventually("the panel to report retrying", async () => {
    const status = await telegramStatus();
    return status.state === "backoff" ? status : undefined;
  }, 40_000);
  expect(retrying.lastError ?? "").not.toContain(harness.telegramBot!.token);
  expect((await state.prompt(task)).status).toBe("BLOCKED");
  if (fault === "outage") server.setOutage(null);
  await waitForTelegramState("polling", 90_000);
  const card = await questionCard(phone, name, before, 90_000);
  await observeQuietPeriod(3_000, "the queued card being delivered twice");
  expect((await phone.messages()).filter((message) => message.fromBot && isCardFor(message, name))).toEqual([card]);
  await eventually("outbox counts to clear", async () => {
    const { outbox } = await telegramStatus();
    return outbox.queued + outbox.retrying + outbox.failed === 0 ? true : undefined;
  }, 30_000);
}

/** S-L1-22: a stranger's taps, replies and codes, and the operator tapping from another chat, change nothing. */
export async function strangersCannotAct({ harness, phone }: L1Context): Promise<void> {
  const server = harness.telegramServer!;
  const bot = harness.telegramBot!;
  const { FakePhone } = await import("../drivers/phone.ts");
  const stranger = new FakePhone(server, bot, { id: 5_551_111, firstName: "Stranger" }, { id: 5_551_111, type: "private" });
  const name = title("Choose the owner");
  const { task, card } = await blockTask(harness, phone, { title: name, later: [{ behavior: "consume-answer", expectInContext: "Alice" }] });
  const answerCard = await replyWithAnswer(phone, card, "Alice");
  const data = server.transcript(Number(phone.chatId)).find((message) => message.message_id === answerCard.id)!.reply_markup!.inline_keyboard.flat().find((button) => button.text === "Answer and resume")!.callback_data!;
  await stranger.send("hello");
  await stranger.send("/start guessed-code-123");
  const strangerTap = server.userTapsButton(bot, stranger.user, phone instanceof FakePhone ? phone.chat : { id: Number(phone.chatId), type: "private" }, answerCard.id, data);
  server.registerChat({ id: -100_555, type: "group", title: "Elsewhere" });
  const wrongChat = server.userTapsButton(bot, { id: Number(phone.userId), firstName: "Operator" }, { id: -100_555, type: "group", title: "Elsewhere" }, answerCard.id, data, { messageChatId: Number(phone.chatId) });
  await inboxDrained(harness);
  await eventually("both taps to be answered", async () => server.callbackAnswer(strangerTap) && server.callbackAnswer(wrongChat) ? true : undefined).catch(() => undefined);
  expect((await stranger.messages()).filter((message) => message.fromBot)).toEqual([]);
  expect(await humanResponses(task)).toEqual([]);
  expect(await executeRuns(task)).toHaveLength(1);
  expect(receipts(harness, task).filter((receipt) => receipt.state === "APPLIED")).toEqual([]);
  await tapAndReport(phone, answerCard, "Answer and resume", /^Done: Answer saved and resume requested\./);
  await waitForPromptStatus(task, "DONE");
}

/** S-L1-28: no token in DTOs, settings, operations, logs, database or the agent process environment. */
export async function tokenNeverExposed({ harness, phone }: L1Context): Promise<void> {
  const token = harness.telegramToken();
  await blockTask(harness, phone, { title: title("Sweep fixture") });
  for (const path of ["/api/task-control/telegram", "/api/task-control/capability", "/api/settings", "/api/operations", "/api/sessions"]) {
    const body = JSON.stringify(await state.get(path));
    expect(body.includes(token), `${path} leaked the token`).toBe(false);
    expect(body.includes(token.split(":")[1]!), `${path} leaked the token secret`).toBe(false);
  }
  const status = await telegramStatus();
  expect(status.tokenConfigured).toBe(true);
  expect(status.bot?.id).toBe(harness.telegramIdentity().id);
  const starts = harness.fakeProvider.log().filter((entry) => entry.event === "start");
  expect(starts.length).toBeGreaterThan(0);
  for (const start of starts) expect(start.inheritedSecrets as string[]).not.toContain("TELEGRAM_BOT_TOKEN");
  const dump = harness.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map((table) => JSON.stringify(harness.query(`SELECT * FROM "${table.name}"`))).join("\n");
  expect(dump.length).toBeGreaterThan(1000);
  expect(dump.includes(token)).toBe(false);
  // Logs, artifacts and trace archives are swept automatically when the environment is disposed.
}

/** S-L1-03: pairing through the Agents page, then the first blocked task's card arrives in that chat. */
export async function pairThenFirstCard({ harness, phone, page }: L1Context): Promise<void> {
  const { pairThroughAgentsPage } = await import("../telegramFlows.ts");
  await pairThroughAgentsPage(page, phone);
  const actors = (await telegramStatus()).actors;
  expect(actors).toHaveLength(1);
  expect(actors[0]).toMatchObject({ transportUserId: phone.userId, chatId: phone.chatId });
  expect((await telegramStatus()).pairing).toBeNull();
  const { card } = await blockTask(harness, phone, { title: title("First card after pairing") });
  expect(card.text).toContain("Reply to this message with your answer.");
}

/** S-L1-18: a sent card whose response was lost may arrive twice, but one answer and one run stand. */
export async function lostSendResponse({ harness, phone }: L1Context): Promise<void> {
  const name = title("Pick the region");
  harness.telegramServer!.dropNextResponse("sendMessage");
  const before = await phone.cursor();
  const { runSavedTask } = await import("../scenarios.ts");
  const { task, runId } = await runSavedTask(harness, { title: name, scenarios: [{ behavior: "block-on-decision" }, { behavior: "consume-answer", expectInContext: "eu-west" }] });
  await waitForRunEnd(task, runId);
  await eventually("the card to be delivered after the lost response", async () => (outboxFor(harness, task).some((row) => row.state === "SENT") ? true : undefined), 60_000);
  const copies = (await phone.messages()).filter((message) => message.fromBot && message.id > before && isCardFor(message, name));
  expect(copies.length).toBeGreaterThanOrEqual(1);
  expect(copies.length).toBeLessThanOrEqual(2);
  expect(outboxFor(harness, task).filter((row) => row.payload_json.includes("personal_question"))).toHaveLength(1);
  // The copy whose send response was lost has no recorded message id, so a reply to it is
  // answered "not a task question" and records nothing; the recorded copy works normally.
  const answers = [];
  for (const copy of copies) {
    const recorded = outboxFor(harness, task).some((row) => row.sent_message_id === String(copy.id));
    if (recorded) {
      answers.push(await replyWithAnswer(phone, copy, "eu-west"));
    } else {
      const beforeOrphan = await phone.cursor();
      await phone.send("eu-west", { replyTo: copy });
      await phone.waitForBotMessage("the not-a-question notice for the unrecorded copy", (message) => message.text.startsWith("That message is not a task question"), { afterId: beforeOrphan });
    }
  }
  expect(answers).toHaveLength(1);
  await tapAndReport(phone, answers[0]!, "Answer and resume", /^Done: Answer saved and resume requested\./);
  await waitForPromptStatus(task, "DONE");
  await inboxDrained(harness);
  expect(receipts(harness, task).filter((receipt) => receipt.state === "APPLIED")).toHaveLength(1);
  expect(await humanResponses(task)).toEqual(["eu-west"]);
  expect(await executeRuns(task)).toHaveLength(2);
}

/** S-L1-27: with two paired chats, actions stay bound to their chat and one answer stands. Records fan-out. */
export async function twoPairedChats({ harness, phone }: L1Context): Promise<{ cardsInSecondChat: number }> {
  const { FakePhone } = await import("../drivers/phone.ts");
  const { pairThroughApi } = await import("../telegramFlows.ts");
  const second = new FakePhone(harness.telegramServer!, harness.telegramBot!, { id: 5_552_222, firstName: "Operator tablet" }, { id: 5_552_222, type: "private" });
  await pairThroughApi(second);
  const name = title("Pick the theme");
  const beforeSecond = await second.cursor();
  const { task, card } = await blockTask(harness, phone, { title: name, later: [{ behavior: "consume-answer", expectInContext: "Dark" }] });
  const secondCard = await questionCard(second, name, beforeSecond).catch(() => null);
  const answerA = await replyWithAnswer(phone, card, "Dark");
  const answerB = secondCard ? await replyWithAnswer(second, secondCard, "Light") : null;
  await tapAndReport(phone, answerA, "Answer and resume", /^Done: Answer saved and resume requested\./);
  if (answerB) await tapAndReport(second, answerB, "Answer and resume", /^Not applied: /);
  await waitForPromptStatus(task, "DONE");
  expect(receipts(harness, task).filter((receipt) => receipt.state === "APPLIED")).toHaveLength(1);
  expect(await humanResponses(task)).toEqual(["Dark"]);
  expect(await executeRuns(task)).toHaveLength(2);
  const actors = (await telegramStatus()).actors;
  await state.delete(`/api/task-control/telegram/actors/${actors.find((actor) => actor.chatId === second.chatId)!.id}`);
  return { cardsInSecondChat: secondCard ? 1 : 0 };
}

/** S-L1-29: blocker text is redacted on the card and the reply is stored and shown literally. */
export async function redactionAndLiteralReplies({ harness, phone }: L1Context): Promise<void> {
  const name = title("Rotate the key");
  const secretLike = "sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c";
  const { task, card } = await blockTask(harness, phone, { title: name, blocker: `The admin page http://localhost:4000/admin rejected key ${secretLike}.`, humanAction: "Say whether to rotate." });
  expect(card.text).not.toContain(secretLike);
  expect(card.text).not.toContain("http://localhost:4000/admin");
  const reply = "*Yes* <b>rotate</b> _now_ [link](http://x)";
  const answerCard = await replyWithAnswer(phone, card, reply);
  expect(answerCard.text).toContain(reply);
  await tapAndReport(phone, answerCard, "Save answer", /^Done: Answer saved; task remains waiting\./);
  expect(await humanResponses(task)).toEqual([reply]);
}
