import { expect } from "@playwright/test";
import type { OperationsSnapshot } from "@agent-console/shared";
import type { PhoneMessage } from "../drivers/phone.ts";
import { eventually, observeQuietPeriod, state } from "../drivers/state.ts";
import { FakePhone } from "../drivers/phone.ts";
import { telegramStatus, waitForTelegramState } from "../telegramFlows.ts";
import type { L1Context } from "./l1.ts";
import { blockTask, executeRuns, humanResponses, inboxDrained, isCardFor, receipts, replyWithAnswer, tapAndReport, waitForPromptStatus } from "./l1Flows.ts";

/*
 * L3 slice B scenarios (docs/e2e-scenarios/l3-b.md): read-only status commands and navigation, observed on the
 * phone (one edited message per view), in Bot API calls, and in durable state (nothing changes).
 */

let sequence = 0;
const label = (base: string) => `${base} ${++sequence}`;

/** Sends a command and waits for the bot's reply whose text matches. */
export async function command({ phone }: L1Context, text: string, pattern: RegExp, options: { replyTo?: PhoneMessage } = {}): Promise<PhoneMessage> {
  const before = await phone.cursor();
  await phone.send(text, options);
  return phone.waitForBotMessage(`the reply to ${text}`, (message) => pattern.test(message.text), { afterId: before, timeoutMs: 30_000 });
}

/** Taps a navigation button and waits until the same message shows text matching `pattern`. */
async function navigate({ phone }: L1Context, message: PhoneMessage, button: string, pattern: RegExp): Promise<PhoneMessage> {
  const { toast } = await phone.tap(message, button);
  if (phone.backend === "fake") expect(toast ?? "").not.toMatch(/Not applied|Already applied/);
  return eventually(`message ${message.id} to show ${pattern}`, async () => (await phone.messages()).find((item) => item.id === message.id && pattern.test(item.text)), 30_000);
}

/** Durable counters that no view or navigation may change. */
function sideEffects(harness: L1Context["harness"]) {
  const count = (sql: string) => harness.query<{ n: number }>(sql)[0]!.n;
  return {
    actions: count("SELECT COUNT(*) n FROM task_control_action"),
    receipts: count("SELECT COUNT(*) n FROM task_control_receipt"),
    runs: count("SELECT COUNT(*) n FROM agent_run"),
    remarks: count("SELECT COUNT(*) n FROM prompt_remark"),
    intents: count("SELECT COUNT(*) n FROM workspace_start_intent"),
    statusEvents: count("SELECT COUNT(*) n FROM prompt_status_event"),
    spawns: harness.fakeProvider.log().filter((entry) => entry.event === "start").length,
  };
}

/** S-L3-B-02: /status counts match the local operations snapshot and change after a state change. */
export async function statusView(ctx: L1Context): Promise<void> {
  const { harness } = ctx;
  const title = label("Status blocked");
  await blockTask(harness, ctx.phone, { title });
  const before = sideEffects(harness);
  const view = await command(ctx, "/status", /^Status · /);
  const snapshot = await state.get<OperationsSnapshot>("/api/operations");
  const states = snapshot.suites.flatMap((suite) => suite.prompts.map((item) => item.operationalState));
  const count = (value: string) => states.filter((item) => item === value).length;
  expect(view.text).toContain(`Running ${count("WORKING")} · Blocked ${count("AWAITING_RESPONSE")} · Needs recovery ${count("RECOVERY_NEEDED")} · Failed ${count("FAILED")} · Ready ${count("READY")}`);
  expect(view.text).toMatch(/ · as of \d{2}:\d{2}/);
  expect(view.buttons).toEqual(expect.arrayContaining(["running", "blocked", "Pipelines", "Quota", "Refresh"]));
  expect(sideEffects(harness)).toEqual(before);
  await state.createSavedTask({ workDirectory: harness.createGitWorkspace(`status-ready-${sequence}`), title: label("Ready task"), content: "Later." });
  const after = await navigate(ctx, view, "Refresh", new RegExp(`Ready ${count("READY") + 1}`));
  expect(after.id).toBe(view.id);
}

/** S-L3-B-10: /help, plain text, an unknown command and a bare /start all get the help view; nothing is recorded. */
export async function helpEverywhere(ctx: L1Context): Promise<void> {
  const { harness } = ctx;
  const before = sideEffects(harness);
  for (const text of ["/help", "what's running?", "/foo", "/start"]) {
    const reply = await command(ctx, text, /^To answer a task, reply to its question message\./);
    expect(reply.text).toContain("\n/status - What the workstation is doing");
    expect(reply.buttons).toEqual([]);
  }
  await inboxDrained(harness);
  expect(sideEffects(harness)).toEqual(before);
}

/**
 * S-L3-B-12/14: /tasks blocked, into a task, Back, Refresh, into another task and Back all edit one message;
 * no new message is sent and nothing durable changes.
 */
export async function drillDownInOneMessage(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const first = label("Drill blocked A");
  const second = label("Drill blocked B");
  await blockTask(harness, phone, { title: first });
  await blockTask(harness, phone, { title: second });
  const before = sideEffects(harness);
  const list = await command(ctx, "/tasks blocked", /^Blocked tasks · /);
  const cursor = await phone.cursor();
  const sendsBefore = harness.telegramCalls().filter((call) => call.method === "sendMessage").length;
  const taskButton = (name: string) => list.buttons.find((button) => button.endsWith(name))!;
  expect(taskButton(first)).toBeTruthy();
  let view = await navigate(ctx, list, taskButton(first), new RegExp(`\\nTask: ${first}\\n`));
  expect(view.buttons).toEqual(["Back", "Refresh"]);
  view = await navigate(ctx, view, "Back", /^Blocked tasks · /);
  view = await navigate(ctx, view, "Refresh", /^Blocked tasks · /);
  view = await navigate(ctx, view, taskButton(second), new RegExp(`\\nTask: ${second}\\n`));
  view = await navigate(ctx, view, "Back", /^Blocked tasks · /);
  expect(view.id).toBe(list.id);
  expect((await phone.messages()).filter((message) => message.fromBot && message.id > cursor)).toEqual([]);
  expect(harness.telegramCalls().filter((call) => call.method === "sendMessage").length).toBe(sendsBefore);
  await inboxDrained(harness);
  expect(sideEffects(harness)).toEqual(before);
}

/** S-L3-B-15/20: views and card actions coexist; a command sent as a reply is a view, other replies are answers. */
export async function viewsBesideCards(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const title = label("Views beside cards");
  const { task, card } = await blockTask(harness, phone, { title, later: [{ behavior: "consume-answer", expectInContext: "/usr/local is fine" }] });
  const status = await command(ctx, "/status", /^Status · /, { replyTo: card });
  expect(status.buttons).not.toContain("Save answer");
  const answerCard = await replyWithAnswer(phone, card, "/usr/local is fine");
  expect(answerCard.text).toContain("Your answer:\n/usr/local is fine");
  const view = await command(ctx, "/blocked", /^Blocked tasks · /);
  await navigate(ctx, view, view.buttons.find((button) => button.endsWith(title))!, new RegExp(`\\nTask: ${title}\\n`));
  await tapAndReport(phone, answerCard, "Answer and resume", /^Done: Answer saved and resume requested\./);
  await waitForPromptStatus(task, "DONE");
  const again = await phone.tap(answerCard, "Answer and resume");
  if (phone.backend === "fake") expect(again.toast).toBe("Already applied.");
  await navigate(ctx, view, "Back", /^Tasks · |^Blocked tasks · /);
  expect(receipts(harness, task).filter((receipt) => receipt.state === "APPLIED")).toHaveLength(1);
  expect(await executeRuns(task)).toHaveLength(2);
}

/** S-L3-B-18 (fake): a crafted navigation tap on a question card neither overwrites it nor reaches task control. */
export async function craftedNavigationOnCard(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const server = harness.telegramServer!;
  const bot = harness.telegramBot!;
  const title = label("Crafted target");
  const { task, card } = await blockTask(harness, phone, { title, later: [{ behavior: "consume-answer", expectInContext: "Green" }] });
  const receiptsBefore = receipts(harness, task).length;
  const chat = (phone as FakePhone).chat;
  const query = server.userTapsButton(bot, (phone as FakePhone).user, chat, card.id, "nv_s");
  const answered = await eventually("the crafted tap to be answered", async () => server.callbackAnswer(query), 15_000);
  expect(answered.text).toBe("That button does not open a view.");
  await inboxDrained(harness);
  await observeQuietPeriod(2_000, "an edit of the question card");
  const unchanged = (await phone.messages()).find((message) => message.id === card.id)!;
  expect(unchanged.text).toBe(card.text);
  expect(unchanged.edited).toBe(false);
  expect(receipts(harness, task)).toHaveLength(receiptsBefore);
  const answerCard = await replyWithAnswer(phone, card, "Green");
  await tapAndReport(phone, answerCard, "Answer and resume", /^Done: Answer saved and resume requested\./);
  await waitForPromptStatus(task, "DONE");
}

/** S-L3-B-21: commands addressed to this bot work like plain ones; commands for another bot are ignored. */
export async function botAddressedCommands(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const username = harness.telegramIdentity().username;
  await command(ctx, `/status@${username}`, /^Status · /);
  await command(ctx, `/tasks@${username} blocked`, /^(Blocked tasks|No blocked tasks)/);
  const before = await phone.cursor();
  await phone.send("/status@SomeOtherBot");
  await inboxDrained(harness);
  await observeQuietPeriod(2_000, "a reply to a command for another bot");
  expect((await phone.messages()).filter((message) => message.fromBot && message.id > before)).toEqual([]);
}

/** S-L3-B-23 (fake): a stranger gets no view, and tapping the operator's view button from another user changes nothing. */
export async function strangerGetsNothing(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const server = harness.telegramServer!;
  const bot = harness.telegramBot!;
  const view = await command(ctx, "/status", /^Status · /);
  const stranger = new FakePhone(server, bot, { id: 5_553_333, firstName: "Stranger" }, { id: 5_553_333, type: "private" });
  for (const text of ["/status", "/tasks blocked", "/help", "/quota"]) await stranger.send(text);
  const data = server.transcript(Number(phone.chatId)).find((message) => message.message_id === view.id)!.reply_markup!.inline_keyboard.flat().find((button) => button.text === "blocked")!.callback_data!;
  const query = server.userTapsButton(bot, stranger.user, (phone as FakePhone).chat, view.id, data);
  await inboxDrained(harness);
  await observeQuietPeriod(2_000, "a reply or edit for the stranger");
  expect((await stranger.messages()).filter((message) => message.fromBot)).toEqual([]);
  expect(server.callbackAnswer(query)?.text ?? "").toBe("");
  expect((await phone.messages()).find((message) => message.id === view.id)!.text).toBe(view.text);
}

/** S-L3-B-29: the command menu registered at connect equals the /help list. */
export async function commandMenuRegistered(ctx: L1Context): Promise<void> {
  const { harness } = ctx;
  const registered = await eventually("setMyCommands to be called", async () => harness.telegramCalls().filter((call) => call.method === "setMyCommands").at(-1), 30_000);
  const commands = registered.body.commands as Array<{ command: string; description: string }>;
  const help = await command(ctx, "/help", /^To answer a task/);
  expect(help.text.split("\n").filter((line) => line.startsWith("/"))).toEqual(commands.map((entry) => `/${entry.command} - ${entry.description}`));
  for (const entry of commands) expect(entry.command).toMatch(/^[a-z0-9_]{1,32}$/);
  expect(commands.map((entry) => entry.command)).not.toContain("ready");
}

/** S-L3-B-26 (T1 part): a long list pages inside one message, every task once. */
export async function pagedList(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const titles: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    const title = label("Paged ready");
    titles.push(title);
    await state.createSavedTask({ workDirectory: harness.createGitWorkspace(`paged-${sequence}`), title, content: "Later." });
  }
  let view = await command(ctx, "/tasks ready", /^Ready tasks · .* · page 1\/\d+/);
  const seen = new Set<string>();
  const cursor = await phone.cursor();
  for (;;) {
    for (const button of view.buttons) if (titles.some((title) => button.endsWith(title))) seen.add(button);
    if (!view.buttons.includes("Next")) break;
    const page = Number(/page (\d+)\//.exec(view.text)![1]);
    view = await navigate(ctx, view, "Next", new RegExp(`page ${page + 1}/`));
  }
  expect(titles.every((title) => [...seen].some((button) => button.endsWith(title)))).toBe(true);
  expect((await phone.messages()).filter((message) => message.fromBot && message.id > cursor)).toEqual([]);
}

/** S-L3-B-32: a view sent before a restart still navigates afterwards, by editing the same message. */
export async function navigationAfterRestart(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const view = await command(ctx, "/tasks", /^Tasks · /);
  await harness.restartServer();
  await waitForTelegramState("polling", 60_000);
  const cursor = await phone.cursor();
  const edited = await navigate(ctx, view, "blocked", /^(Blocked tasks|No blocked tasks)|^Blocked tasks/);
  expect(edited.id).toBe(view.id);
  await observeQuietPeriod(2_000, "a duplicate view after restart");
  expect((await phone.messages()).filter((message) => message.fromBot && message.id > cursor)).toEqual([]);
  expect((await telegramStatus()).outbox.retrying).toBe(0);
}

/** S-L3-B-37 (T1 part): using every command and a navigation tap starts nothing and records nothing. */
export async function viewsChangeNothing(ctx: L1Context): Promise<void> {
  const { harness } = ctx;
  const title = label("Untouched");
  const { task } = await blockTask(harness, ctx.phone, { title });
  const before = sideEffects(harness);
  const promptBefore = await state.prompt(task);
  for (const text of ["/status", "/tasks", "/running", "/blocked", "/pipelines", "/quota", `/task ${task.promptId}`, "/help"]) await command(ctx, text, /./);
  const list = await command(ctx, "/blocked", /^Blocked tasks · /);
  await navigate(ctx, list, list.buttons.find((button) => button.endsWith(title))!, new RegExp(`\\nTask: ${title}\\n`));
  await inboxDrained(harness);
  expect(sideEffects(harness)).toEqual(before);
  expect(await state.prompt(task)).toMatchObject({ status: promptBefore.status });
  expect(await humanResponses(task)).toEqual([]);
  expect(isCardFor(list, title)).toBe(false);
}
