#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

function envText(name, fallback) {
  const value = process.env[name]?.trim() || fallback;
  if (value === undefined || value === "") throw new Error(`${name} must be set for the live handover run.`);
  return value;
}

function envPositiveInteger(name, fallback) {
  const value = Number.parseInt(envText(name, String(fallback)), 10);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

const A_API = envText("TEAM_HANDOVER_REQUESTER_API", "http://127.0.0.1:4100");
const B_API = envText("TEAM_HANDOVER_RECEIVER_API", "http://127.0.0.1:4200");
const A_WEB = envText("TEAM_HANDOVER_REQUESTER_WEB", "http://localhost:3100");
const B_WEB = envText("TEAM_HANDOVER_RECEIVER_WEB", "http://localhost:3200");
const A_WORKSPACE_ID = envPositiveInteger("TEAM_HANDOVER_REQUESTER_WORKSPACE_ID", 1);
const B_WORKSPACE_ID = envPositiveInteger("TEAM_HANDOVER_RECEIVER_WORKSPACE_ID", 1);
const SUITE_ID = envPositiveInteger("TEAM_HANDOVER_SUITE_ID", 3);
const PROVIDER = envText("TEAM_HANDOVER_PROVIDER", "codex");
const TELEGRAM_GROUP_ID = envText("TEAM_HANDOVER_TELEGRAM_GROUP_ID");
const TELEGRAM_BOTS = envText("TEAM_HANDOVER_TELEGRAM_BOTS").split(",").map((value) => value.trim()).filter(Boolean);
const EXPECTED_REMOTE = envText("TEAM_HANDOVER_EXPECTED_REMOTE");
if (TELEGRAM_BOTS.length < 2) throw new Error("TEAM_HANDOVER_TELEGRAM_BOTS must contain at least two comma-separated bot usernames.");

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    "artifact-dir": { type: "string" },
    "evidence-out": { type: "string" },
    "requester-db": { type: "string" },
    "receiver-db": { type: "string" },
    suffix: { type: "string" },
  },
});

const suffix = values.suffix ?? process.env.LIVE_HANDOVER_SUFFIX ?? new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const fileName = `handover-real-${suffix}.txt`;
const exactLine = `Team handover real round trip ${suffix}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(base, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const value = text === "" ? null : JSON.parse(text);
  if (!response.ok) {
    const message = value?.error?.message ?? value?.message ?? text;
    throw new Error(`${method} ${base}${path} failed (${response.status}): ${message}`);
  }
  return value;
}

async function eventually(label, fn, timeoutMs = 600_000, intervalMs = 2_500) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function requireDatabasePath(name) {
  const path = values[name];
  if (typeof path !== "string" || path === "") {
    throw new Error(`--${name} is required for a live run so Telegram delivery/action evidence can be read from the correct workstation database.`);
  }
  if (!existsSync(path)) throw new Error(`--${name} does not exist: ${path}`);
  return path;
}

function remoteRef(cwd, ref) {
  return git(cwd, "ls-remote", "origin", ref);
}

function gitStage(cwd, itemId, branch) {
  return {
    handoverRef: remoteRef(cwd, `refs/heads/${branch}`),
    controlRef: remoteRef(cwd, `refs/aw/items/${itemId}/control`),
  };
}

function actionRows(database, itemId, action) {
  return database.prepare(`
    SELECT a.ref,a.action,a.bot_id botId,a.chat_id chatId,a.created_at createdAt,
      a.expires_at expiresAt,a.applied_command_id appliedCommandId,
      json_extract(a.payload_json,'$.epoch') epoch,
      r.state receiptState,r.command_id commandId,r.created_at receiptCreatedAt
    FROM task_control_action a
    LEFT JOIN task_control_receipt r ON r.action_ref=a.ref AND r.state='APPLIED'
    WHERE a.action=? AND json_extract(a.payload_json,'$.itemId')=?
    ORDER BY a.created_at DESC`).all(action, itemId);
}

function telegramDelivery(database, itemId, action) {
  const actions = actionRows(database, itemId, action);
  const refs = actions.map((row) => row.ref);
  const sent = database.prepare(`
    SELECT id,bot_id botId,chat_id chatId,topic_id topicId,sent_message_id messageId,
      created_at createdAt,updated_at deliveredAt,payload_json payload
    FROM telegram_outbox
    WHERE operation='send' AND state='SENT' AND sent_message_id IS NOT NULL
    ORDER BY id DESC`).all();
  const matching = sent.filter((row) => refs.some((ref) => row.payload.includes(ref)));
  const latest = matching[0];
  if (latest === undefined) return null;
  const payload = JSON.parse(latest.payload);
  return {
    outboxId: latest.id,
    botId: latest.botId,
    chatId: latest.chatId,
    topicId: latest.topicId,
    messageId: latest.messageId,
    createdAt: latest.createdAt,
    deliveredAt: latest.deliveredAt,
    cardKind: payload.kind,
    itemId: payload.itemId,
    actionRef: refs.find((ref) => latest.payload.includes(ref)) ?? null,
    matchingSentCards: matching.length,
  };
}

function appliedAction(database, itemId, action) {
  const row = actionRows(database, itemId, action).find((candidate) => candidate.receiptState === "APPLIED");
  if (row === undefined) return null;
  const commandId = row.commandId;
  const callback = database.prepare(`
    SELECT update_id updateId,
      json_extract(payload_json,'$.callback_query.id') callbackQueryId,
      json_extract(payload_json,'$.callback_query.data') callbackData,
      processed_at processedAt
    FROM telegram_inbox
    WHERE instr(payload_json,?)>0 AND json_extract(payload_json,'$.callback_query.id') IS NOT NULL
    ORDER BY update_id DESC LIMIT 1`).get(row.ref);
  const webAction = commandId.startsWith("web-");
  return {
    actionRef: row.ref,
    action: row.action,
    botId: row.botId,
    chatId: row.chatId,
    epoch: row.epoch,
    actionCreatedAt: row.createdAt,
    expiresAt: row.expiresAt,
    receiptState: row.receiptState,
    commandId,
    receiptCreatedAt: row.receiptCreatedAt,
    invocation: webAction ? "web_route" : callback === undefined ? "unknown" : "telegram_callback",
    route: webAction ? `/api/task-control/team/handovers/${itemId}/${action === "accept_offer" ? "accept" : action === "return_work" ? "return" : action}` : null,
    callback: callback === undefined ? null : callback,
  };
}

function writeEvidence() {
  if (values["evidence-out"] === undefined) return;
  writeFileSync(values["evidence-out"], `${JSON.stringify(evidence, null, 2)}\n`);
}

async function captureFailureScreenshot(page, name) {
  if (values["artifact-dir"] === undefined || page === undefined) return null;
  mkdirSync(values["artifact-dir"], { recursive: true });
  const path = join(values["artifact-dir"], `${name}-${suffix}.png`);
  try {
    await page.screenshot({ path, fullPage: true, timeout: 5_000 });
    return path;
  } catch {
    return null;
  }
}

async function currentHandover(base, itemId) {
  const { handovers } = await api(base, "GET", "/api/task-control/team/handovers");
  return handovers.find((item) => item.itemId === itemId) ?? null;
}

function findPromptInTree(workspace, title) {
  for (const program of workspace.programs ?? []) {
    for (const suite of program.suites ?? []) {
      for (const prompt of suite.prompts ?? []) {
        if (prompt.title === title) return prompt;
      }
    }
  }
  return null;
}

const evidence = {
  startedAt: new Date().toISOString(),
  dryRun: values["dry-run"],
  title: `WI_REAL_HANDOVER_${suffix}`,
  fileName,
  exactLine,
  telegram: {
    configured: { groupId: TELEGRAM_GROUP_ID, bots: TELEGRAM_BOTS },
    deliveries: {},
    actions: {},
  },
  requester: {},
  receiver: {},
  github: {},
};

const aWorkspace = (await api(A_API, "GET", `/api/workspaces/${A_WORKSPACE_ID}`)).workspace;
const bWorkspace = (await api(B_API, "GET", `/api/workspaces/${B_WORKSPACE_ID}`)).workspace;
evidence.requester.workspace = aWorkspace.workDirectory;
evidence.receiver.workspace = bWorkspace.workDirectory;
evidence.requester.beforeStatus = git(aWorkspace.workDirectory, "status", "--short", "--branch");
evidence.receiver.beforeStatus = git(bWorkspace.workDirectory, "status", "--short", "--branch");
evidence.github.remote = git(aWorkspace.workDirectory, "remote", "get-url", "origin");
if (evidence.github.remote !== EXPECTED_REMOTE) {
  throw new Error(`Unexpected requester remote: ${evidence.github.remote}`);
}

const promptBody = [
  `Create a file named ${fileName} in the repository root containing exactly this single line:`,
  exactLine,
  "",
  "Verify the file content, then report DONE with the verification evidence.",
  "",
  "## Verify",
  "```sh",
  `test "$(cat ${fileName})" = "${exactLine}"`,
  "```",
].join("\n");
evidence.promptBody = promptBody;

if (values["dry-run"]) {
  evidence.existingPrompt = findPromptInTree((await api(A_API, "GET", `/api/workspaces/${A_WORKSPACE_ID}/tree`)).workspace, evidence.title);
  evidence.plannedExternalEffects = [
    `Create prompt ${evidence.title} in requester suite ${SUITE_ID}.`,
    `Requester UI at ${A_WEB}/tasks will prepare and publish a Team handover offer.`,
    `The configured Team transport may post handover cards to Telegram group ${TELEGRAM_GROUP_ID} using ${TELEGRAM_BOTS.join(" and ")}.`,
    `The handover capture/return/apply flow may push/fetch handover refs in ${EXPECTED_REMOTE}.`,
    `Receiver UI at ${B_WEB}/tasks will accept, run, and return the handover.`,
    `Requester UI will review and apply the returned result.`,
  ];
  writeEvidence();
  console.log(JSON.stringify(evidence, null, 2));
  process.exit(0);
}

const requesterDatabasePath = requireDatabasePath("requester-db");
const receiverDatabasePath = requireDatabasePath("receiver-db");
const requesterDatabase = new DatabaseSync(requesterDatabasePath, { readOnly: true });
const receiverDatabase = new DatabaseSync(receiverDatabasePath, { readOnly: true });
evidence.telegram.databaseSources = {
  requester: requesterDatabasePath,
  receiver: receiverDatabasePath,
};

const existingPrompt = findPromptInTree((await api(A_API, "GET", `/api/workspaces/${A_WORKSPACE_ID}/tree`)).workspace, evidence.title);
const prompt = existingPrompt ?? (await api(A_API, "POST", `/api/suites/${SUITE_ID}/prompts`, {
  title: evidence.title,
  content: promptBody,
})).prompt;
evidence.promptId = prompt.id;
evidence.promptCreated = existingPrompt === null;
const linked = await api(A_API, "GET", `/api/task-control/team/items?promptId=${prompt.id}`);
if (linked.item !== null) evidence.itemId = linked.item.itemId;

const browser = await chromium.launch();
let aPage;
let bPage;
try {
  aPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  bPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  aPage.setDefaultTimeout(120_000);
  bPage.setDefaultTimeout(120_000);

  if (evidence.itemId === undefined) {
    await aPage.goto(`${A_WEB}/tasks?workspace=${A_WORKSPACE_ID}&prompt=${prompt.id}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    const handoverControl = aPage.getByLabel("Hand over to the team");
    await handoverControl.waitFor({ timeout: 60_000 });
    const reason = handoverControl.getByTestId("handover-reason");
    if ((await reason.count()) > 0) throw new Error(`Requester handover disabled: ${await reason.textContent()}`);
    await handoverControl.getByLabel("Handover agent").selectOption(PROVIDER);
    await handoverControl.getByRole("button", { name: "Prepare handover" }).click();
    await handoverControl.getByTestId("handover-preview").waitFor({ timeout: 180_000 });

    const { item } = await api(A_API, "GET", `/api/task-control/team/items?promptId=${prompt.id}`);
    evidence.itemId = item.itemId;

    await handoverControl.getByRole("button", { name: "Publish offer" }).click();
    await handoverControl.getByTestId("handover-offer").waitFor({ timeout: 180_000 });
  }

  const offeredA = await eventually("requester has published record", async () => {
    const handover = await currentHandover(A_API, evidence.itemId);
    return handover && ["OFFERED", "CLAIMED", "RUNNING", "WAITING_INPUT", "RETURNABLE", "RETURNED", "COMPLETED"].includes(handover.state)
      ? handover
      : null;
  }, 180_000);
  evidence.requester.offered = offeredA;

  await bPage.goto(`${B_WEB}/tasks?workspace=${B_WORKSPACE_ID}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await bPage.getByRole("button", { name: "Team handovers" }).click();
  const receiverCard = bPage.locator("article").filter({ hasText: evidence.itemId });
  await receiverCard.waitFor({ timeout: 180_000 });
  await receiverCard.scrollIntoViewIfNeeded();
  evidence.github.offered = gitStage(aWorkspace.workDirectory, evidence.itemId, offeredA.branch);
  evidence.telegram.deliveries.offer = await eventually("Telegram offer card delivery", async () => {
    const delivery = telegramDelivery(receiverDatabase, evidence.itemId, "accept_offer");
    return delivery?.chatId === TELEGRAM_GROUP_ID ? delivery : null;
  }, 180_000);
  const beforeAcceptB = await currentHandover(B_API, evidence.itemId);
  if (beforeAcceptB?.state === "OFFERED") {
    await receiverCard.getByRole("button", { name: "Accept" }).click({ timeout: 60_000 });
  }

  const acceptedB = await eventually("receiver claimed handover", async () => {
    const handover = await currentHandover(B_API, evidence.itemId);
    return handover && ["CLAIMED", "RUNNING", "WAITING_INPUT", "RETURNABLE", "RETURNED"].includes(handover.state)
      ? handover
      : null;
  }, 180_000);
  evidence.receiver.accepted = acceptedB;
  evidence.telegram.actions.accept = await eventually("applied Accept action evidence", async () =>
    appliedAction(receiverDatabase, evidence.itemId, "accept_offer"), 30_000, 250);

  const completedRunB = await eventually("receiver run to finish", async () => {
    const handover = await currentHandover(B_API, evidence.itemId);
    const runState = handover?.localTask?.runState ?? null;
    return runState === "DONE" || runState === "FAILED" || runState === "BLOCKED" ? handover : null;
  }, 900_000, 5_000);
  evidence.receiver.finished = completedRunB;
  if (completedRunB.localTask?.runState !== "DONE") {
    throw new Error(`Receiver run did not finish DONE: ${completedRunB.localTask?.runState ?? "unknown"}`);
  }

  await bPage.getByRole("button", { name: "Refresh" }).click();
  const returnButton = receiverCard.getByRole("button", { name: "Return work" });
  await returnButton.waitFor({ timeout: 180_000 });
  evidence.telegram.deliveries.returnPrompt = await eventually("Telegram return-work card delivery", async () => {
    const delivery = telegramDelivery(receiverDatabase, evidence.itemId, "return_work");
    return delivery?.chatId === TELEGRAM_GROUP_ID ? delivery : null;
  }, 180_000);
  await returnButton.click();

  const returnedA = await eventually("requester sees RETURNED", async () => {
    const handover = await currentHandover(A_API, evidence.itemId);
    return handover?.state === "RETURNED" ? handover : null;
  }, 180_000);
  evidence.requester.returned = returnedA;
  evidence.github.returned = gitStage(aWorkspace.workDirectory, evidence.itemId, returnedA.branch);
  evidence.telegram.actions.return = await eventually("applied Return action evidence", async () =>
    appliedAction(receiverDatabase, evidence.itemId, "return_work"), 30_000, 250);
  evidence.telegram.deliveries.returned = await eventually("Telegram returned-work review card delivery", async () => {
    const delivery = telegramDelivery(requesterDatabase, evidence.itemId, "apply_result");
    return delivery?.chatId === TELEGRAM_GROUP_ID ? delivery : null;
  }, 180_000);

  await aPage.goto(`${A_WEB}/tasks?workspace=${A_WORKSPACE_ID}&prompt=${prompt.id}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  const reviewControl = aPage.getByLabel("Review returned work");
  await reviewControl.waitFor({ timeout: 60_000 });
  await reviewControl.getByRole("button", { name: "Check for returned work" }).click();
  const review = reviewControl.getByTestId("handover-review");
  await review.waitFor({ timeout: 180_000 });
  evidence.requester.reviewText = (await review.textContent())?.replace(/\s+/g, " ").trim();
  await reviewControl.getByTestId("handover-acceptance").locator("input[type=checkbox]").check();
  await reviewControl.getByRole("button", { name: "Apply result" }).click();
  await reviewControl.getByTestId("handover-applied").waitFor({ timeout: 180_000 });

  const completedA = await eventually("requester COMPLETED record", async () => {
    const handover = await currentHandover(A_API, evidence.itemId);
    return handover?.state === "COMPLETED" ? handover : null;
  }, 180_000);
  evidence.requester.completed = completedA;
} catch (error) {
  evidence.error = {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
  };
  evidence.artifacts = {
    requesterScreenshot: await captureFailureScreenshot(aPage, "requester-failure"),
    receiverScreenshot: await captureFailureScreenshot(bPage, "receiver-failure"),
  };
  writeEvidence();
  throw error;
} finally {
  await browser.close();
}

evidence.requester.afterStatus = git(aWorkspace.workDirectory, "status", "--short", "--branch");
evidence.requester.head = git(aWorkspace.workDirectory, "rev-parse", "HEAD");
evidence.requester.fileContent = readFileSync(`${aWorkspace.workDirectory}/${fileName}`, "utf8").trim();
if (evidence.requester.fileContent !== exactLine) {
  throw new Error(`Applied file content mismatch: ${evidence.requester.fileContent}`);
}

const branch = evidence.requester.completed.branch;
evidence.github.completed = gitStage(aWorkspace.workDirectory, evidence.itemId, branch);
evidence.finishedAt = new Date().toISOString();
writeEvidence();

requesterDatabase.close();
receiverDatabase.close();

console.log(JSON.stringify(evidence, null, 2));
