import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { state } from "../../src/drivers/state.ts";
import { TelegramUserPhone } from "../../src/drivers/telegramUserPhone.ts";
import { LIVE_ENV_PATH, loadLiveConfig, type LiveConfig } from "../../src/env/liveConfig.ts";
import { HarnessEnvironment, knownSecrets } from "../../src/env/orchestrator.ts";
import { sweep } from "../../src/env/sweep.ts";
import { PreflightError, preflightBot } from "../../src/env/telegramPreflight.ts";
import { TelegramRouteProxy } from "../../src/env/telegramRouteProxy.ts";
import { blockedTaskCard, pairThroughAgentsPage, telegramStatus, waitForTelegramState } from "../../src/telegramFlows.ts";
import { inboxDrained } from "../../src/scenarios/l1Flows.ts";

/*
 * Guard, leftovers, secrets and contract recording on the real test bot (docs/e2e-scenarios/h6.md S-H6-18, 20,
 * 21, 22, 26, 27, 28, 31). Environments are created inside the tests, because S-H6-21 must seed the bot
 * before a harness server boots.
 */

test.describe.configure({ mode: "serial" });

const e2eDir = resolve(import.meta.dirname, "../..");
const REAL = "https://api.telegram.org";
let config: LiveConfig;
let phone: TelegramUserPhone;
let sessionsAtStart = 0;

async function bot<T = unknown>(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result: T; error_code?: number; description?: string }> {
  const response = await fetch(`${REAL}/bot${config.testBotToken}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.json() as Promise<{ ok: boolean; result: T; error_code?: number; description?: string }>;
}

const refused = (promise: Promise<unknown>) => promise.then(() => "", (error: unknown) => {
  expect(error).toBeInstanceOf(PreflightError);
  const message = (error as Error).message;
  for (const secret of [config.testBotToken, config.testBotToken.split(":")[1]!]) expect(message.includes(secret)).toBe(false);
  return message;
});

test.beforeAll(async () => {
  config = loadLiveConfig();
  phone = new TelegramUserPhone(config);
  await phone.connect();
  sessionsAtStart = await phone.activeSessionCount();
});

test.afterAll(async () => {
  await phone?.disconnect().catch(() => undefined);
});

test("S-H6-18 (real): a live file naming another bot id is refused before anything polls, and pending updates are not consumed", async () => {
  await bot("deleteWebhook", { drop_pending_updates: true });
  await phone.send(`h6 pending ${randomBytes(3).toString("hex")}`);
  const wrongId = String(Number(config.testBotId) + 1);
  const message = await refused(preflightBot({ baseUrl: REAL, token: config.testBotToken, expectedBotId: wrongId }));
  expect(message).toBe(`the bot token belongs to bot ${config.testBotId}, not the registered test bot ${wrongId}`);
  const info = await bot<{ pending_update_count: number }>("getWebhookInfo", {});
  expect(info.result.pending_update_count).toBeGreaterThanOrEqual(1);
});

test("S-H6-20 (real): another poller or a webhook on the test bot stops the run with a named reason; removing them lets it poll", async () => {
  const proxy = new TelegramRouteProxy(REAL);
  await proxy.listen();
  let polling = true;
  const other = (async () => {
    while (polling) {
      await fetch(`${proxy.url}/bot${config.testBotToken}/getUpdates`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timeout: 2 }) }).catch(() => undefined);
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
  })();
  try {
    await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    expect(await refused(preflightBot({ baseUrl: REAL, token: config.testBotToken, expectedBotId: config.testBotId, conflictProbeSeconds: 10 }))).toMatch(/another process is polling the test bot/);
  } finally {
    polling = false;
    await other;
    await proxy.close();
  }
  const set = await bot("setWebhook", { url: "https://example.com/harness-h6-never-called", drop_pending_updates: false });
  try {
    if (set.ok) expect(await refused(preflightBot({ baseUrl: REAL, token: config.testBotToken, expectedBotId: config.testBotId }))).toMatch(/a webhook is set on the test bot/);
    else test.info().annotations.push({ type: "webhook case not recordable", description: set.description ?? "setWebhook refused" });
  } finally {
    await bot("deleteWebhook", {});
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
  await preflightBot({ baseUrl: REAL, token: config.testBotToken, expectedBotId: config.testBotId, conflictProbeSeconds: 5 });
});

test("S-H6-21/22 (real): an earlier run's pending updates and live buttons act on nothing in a new environment", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const oldCard = await bot<{ message_id: number }>("sendMessage", { chat_id: config.operatorUserId, text: "Your answer:\nOld answer", reply_markup: { inline_keyboard: [[{ text: "Answer and resume", callback_data: `tc_${"C".repeat(24)}` }]] } });
  const oldQuestion = await bot<{ message_id: number }>("sendMessage", { chat_id: config.operatorUserId, text: "Task needs input: Earlier run task\n\nReply to this message with your answer." });
  const leftovers = await phone.messages();
  const card = leftovers.find((message) => message.text === "Your answer:\nOld answer")!;
  const question = leftovers.find((message) => message.text.startsWith("Task needs input: Earlier run task"))!;
  expect(oldCard.ok && oldQuestion.ok).toBe(true);
  await phone.send("hello from an earlier run");
  await phone.send("Old reply", { replyTo: question });
  await phone.tap(card, "Answer and resume");
  await phone.send("/start oldpairingcode1234");
  expect((await bot<{ pending_update_count: number }>("getWebhookInfo", {})).result.pending_update_count).toBeGreaterThanOrEqual(4);

  const harness = new HarnessEnvironment({ fakeProvider: "live", telegram: { backend: "real" } });
  try {
    await harness.start();
    await waitForTelegramState("polling", 60_000);
    await state.post("/api/task-control/telegram/pairing");
    await new Promise((resolveWait) => setTimeout(resolveWait, 30_000));
    expect((await telegramStatus()).pairing?.observed).toBeNull();
    expect(harness.query<{ n: number }>("SELECT COUNT(*) n FROM telegram_inbox")[0]!.n).toBe(0);
    expect((await telegramStatus()).state).toBe("polling");
    await state.delete("/api/task-control/telegram/pairing");
    await pairThroughAgentsPage(page, harness.phone!);
    const { task } = await blockedTaskCard(harness, harness.phone!, "First card after real leftovers");

    await phone.tap(card, "Answer and resume");
    await phone.send("Old reply again", { replyTo: question });
    await inboxDrained(harness);
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
    await inboxDrained(harness);
    expect(harness.query<{ n: number }>("SELECT COUNT(*) n FROM task_control_receipt WHERE state = 'APPLIED'")[0]!.n).toBe(0);
    expect((await state.sessionsFor(task)).filter((session) => session.role === "execute")).toHaveLength(1);
    expect((await state.prompt(task)).status).toBe("BLOCKED");
  } finally {
    await harness.dispose([test.info().outputDir]);
  }
});

test("S-H6-24 (real): a token Telegram rejects and an unauthorized session are blocked on setup with their own reasons", async () => {
  const rejected = await refused(preflightBot({ baseUrl: REAL, token: `${config.testBotId}:${"A".repeat(35)}`, expectedBotId: config.testBotId }));
  expect(rejected).toMatch(/Telegram rejected the test bot token/);
  const signedOut = new TelegramUserPhone({ ...config, userSession: "" });
  const message = await signedOut.connect().then(() => "", (error: Error) => `${error.name}: ${error.message}`);
  await signedOut.disconnect().catch(() => undefined);
  expect(message).toMatch(/^LiveSetupError: T3 blocked on setup: the saved Telegram user session is revoked or no longer authorized/);
  for (const secret of [config.userSession, config.apiHash, config.testBotToken]) expect(message.includes(secret)).toBe(false);
});

test("S-H6-16 (real), S-H6-26: the proxy to api.telegram.org and forced driver failures leave no live secret in logs, errors, attachments or test-results", async () => {
  const errors: string[] = [];
  errors.push(await phone.send("never sent", { replyTo: { id: 2_000_000_000, text: "", buttons: [], fromBot: true, edited: false, replyToId: null, topicId: null } }).then(() => "", (error: Error) => error.message));
  const proxy = new TelegramRouteProxy(REAL, join(test.info().outputDir, "telegram-proxy.log"));
  await proxy.listen();
  const through = await fetch(`${proxy.url}/bot${config.testBotToken}/getMe`).then((response) => response.json() as Promise<{ ok: boolean }>);
  expect(through.ok).toBe(true);
  errors.push(await fetch(`${proxy.url}/bot${encodeURIComponent(config.testBotToken)}/getMe`).then((response) => response.text()));
  proxy.cutRoute("refuse");
  errors.push(await fetch(`${proxy.url}/bot${config.testBotToken}/getMe`).then(() => "", (error: Error) => `${error.name}: ${error.message} ${String((error as { cause?: unknown }).cause)}`));
  await proxy.close();
  expect(errors.every(Boolean)).toBe(true);
  for (const form of [config.testBotToken, config.testBotToken.split(":")[1]!, encodeURIComponent(config.testBotToken)]) expect(errors.join("\n").includes(form)).toBe(false);
  await test.info().attach("forced-errors.txt", { body: errors.join("\n"), contentType: "text/plain" });
  writeFileSync(join(test.info().outputDir, "forced-errors.txt"), errors.join("\n"));
  const findings = sweep([join(e2eDir, "test-results")], knownSecrets().filter((secret) => secret.label.startsWith("live:")));
  expect(findings.map((finding) => `${finding.secretLabel} in ${finding.file}`)).toEqual([]);
});

test("S-H6-27 (real): the saved session is reused across connections, the live file stays private, and no repository file holds a live secret", async () => {
  for (let run = 0; run < 2; run += 1) {
    const again = new TelegramUserPhone(config);
    await again.connect();
    await again.disconnect();
  }
  expect(await phone.activeSessionCount()).toBe(sessionsAtStart);
  expect(statSync(LIVE_ENV_PATH).mode & 0o777).toBe(0o600);
  const repoRoot = resolve(e2eDir, "..");
  const listed = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: repoRoot, encoding: "utf8" }).stdout.split("\n").filter(Boolean).map((file) => join(repoRoot, file)).filter((file) => existsSync(file));
  const findings = sweep([...listed, join(e2eDir, "test-results"), join(e2eDir, "coverage")], knownSecrets().filter((secret) => secret.label.startsWith("live:")));
  expect(findings.map((finding) => `${finding.secretLabel} in ${finding.file}`)).toEqual([]);
});

test("S-H6-28/31: re-recording the Bot API contract writes sanitized fixtures to the working tree and never commits them", async () => {
  test.setTimeout(5 * 60_000);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: e2eDir, encoding: "utf8" }).stdout.trim();
  const result = spawnSync("npm", ["run", "e2e:live:record-contracts"], { cwd: e2eDir, encoding: "utf8", timeout: 4 * 60_000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  const fixturePath = join(e2eDir, "contracts/telegram-bot-api.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { recordedAt: string; steps: Record<string, { status: number }> };
  expect(fixture.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  for (const step of ["getMe", "update.messageReply", "update.callbackQuery", "sendMessage.withKeyboard", "editMessageText", "editMessageText.notModified", "answerCallbackQuery", "setMyCommands", "getMe.badToken", "createForumTopic.privateChat"]) expect(Object.keys(fixture.steps)).toContain(step);
  expect(fixture.steps["getMe.badToken"]!.status).toBe(401);
  const text = readFileSync(fixturePath, "utf8");
  for (const value of [config.testBotToken, config.testBotToken.split(":")[1]!, config.operatorUserId, config.testBotId, config.testBotUsername, ...phone.identityValues()]) expect(text.includes(value)).toBe(false);
  expect(spawnSync("git", ["rev-parse", "HEAD"], { cwd: e2eDir, encoding: "utf8" }).stdout.trim()).toBe(head);
});
