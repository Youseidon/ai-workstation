#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    console.error(`${name} must be set to verify live handover evidence.`);
    process.exit(2);
  }
  return value;
}

const EXPECTED_REMOTE = requiredEnvironment("TEAM_HANDOVER_EXPECTED_REMOTE");
const EXPECTED_GROUP = requiredEnvironment("TEAM_HANDOVER_TELEGRAM_GROUP_ID");
const EXPECTED_BOTS = requiredEnvironment("TEAM_HANDOVER_TELEGRAM_BOTS").split(",").map((value) => value.trim()).filter(Boolean);

const { positionals } = parseArgs({ allowPositionals: true });
const path = positionals[0];

if (path === undefined) {
  console.error("Usage: node scripts/verify-live-two-workstation-roundtrip.mjs <evidence-json>");
  process.exit(2);
}

const evidence = JSON.parse(readFileSync(path, "utf8"));
const failures = [];

function requireEqual(actual, expected, label) {
  if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function requireString(value, label, pattern = /.+/) {
  if (typeof value !== "string" || !pattern.test(value)) failures.push(`${label}: missing or invalid string`);
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    failures.push(`${label}: missing object`);
    return false;
  }
  return true;
}

function refSha(line, label, pattern) {
  requireString(line, label, pattern);
  return typeof line === "string" ? line.slice(0, 40) : null;
}

function requireDelivery(delivery, label, cardKind) {
  if (!requireObject(delivery, label)) return;
  requireEqual(delivery.chatId, EXPECTED_GROUP, `${label} chat`);
  requireString(delivery.botId, `${label} bot id`);
  requireString(String(delivery.outboxId), `${label} outbox id`, /^\d+$/);
  requireString(delivery.messageId, `${label} Telegram message id`, /^\d+$/);
  requireString(delivery.deliveredAt, `${label} deliveredAt`);
  requireEqual(delivery.cardKind, cardKind, `${label} card kind`);
  requireEqual(delivery.itemId, evidence.itemId, `${label} item id`);
  requireString(delivery.actionRef, `${label} action ref`, /^tc_[A-Za-z0-9_-]+$/);
  if (!Number.isSafeInteger(delivery.matchingSentCards) || delivery.matchingSentCards < 1) {
    failures.push(`${label} matching sent cards: expected at least one, got ${JSON.stringify(delivery.matchingSentCards)}`);
  }
}

function requireAction(action, label, expectedAction, expectedRoute, delivery) {
  if (!requireObject(action, label)) return;
  requireEqual(action.action, expectedAction, `${label} action`);
  requireEqual(action.receiptState, "APPLIED", `${label} receipt state`);
  requireString(action.commandId, `${label} command id`);
  requireString(action.receiptCreatedAt, `${label} receipt createdAt`);
  requireEqual(action.actionRef, delivery?.actionRef, `${label} delivered action ref`);
  if (action.invocation === "web_route") {
    requireEqual(action.route, expectedRoute, `${label} web route`);
    requireString(action.commandId, `${label} web command id`, /^web-/);
  } else if (action.invocation === "telegram_callback") {
    if (requireObject(action.callback, `${label} callback`)) {
      requireString(String(action.callback.updateId), `${label} callback update id`, /^\d+$/);
      requireString(action.callback.callbackQueryId, `${label} callback query id`);
      requireEqual(action.callback.callbackData, action.actionRef, `${label} callback action ref`);
      requireString(action.callback.processedAt, `${label} callback processedAt`);
    }
  } else {
    failures.push(`${label} invocation: neither a proved web route nor a recorded Telegram callback`);
  }
}

requireEqual(evidence.dryRun, false, "dryRun");
requireString(evidence.startedAt, "startedAt");
requireString(evidence.finishedAt, "finishedAt");
requireString(evidence.title, "title", /^WI_REAL_HANDOVER_/);
requireString(evidence.fileName, "fileName", /^handover-real-.+\.txt$/);
requireString(evidence.exactLine, "exactLine", /^Team handover real round trip /);
requireEqual(evidence.requester?.fileContent, evidence.exactLine, "applied file content");

// Configuration says where the run intended to go. It is checked but does not
// count as transport proof; only the durable delivery records below do.
requireEqual(evidence.telegram?.configured?.groupId, EXPECTED_GROUP, "configured Telegram group");
requireEqual(JSON.stringify(evidence.telegram?.configured?.bots), JSON.stringify(EXPECTED_BOTS), "configured Telegram bots");
requireString(evidence.telegram?.databaseSources?.requester, "requester Telegram evidence database");
requireString(evidence.telegram?.databaseSources?.receiver, "receiver Telegram evidence database");

const offerDelivery = evidence.telegram?.deliveries?.offer;
const returnPromptDelivery = evidence.telegram?.deliveries?.returnPrompt;
requireDelivery(offerDelivery, "Telegram offer delivery", "handover_offer");
requireDelivery(returnPromptDelivery, "Telegram return-work delivery", "team_item_action");
requireDelivery(evidence.telegram?.deliveries?.returned, "Telegram returned-work delivery", "handover_review");
requireAction(evidence.telegram?.actions?.accept, "receiver accept action", "accept_offer", `/api/task-control/team/handovers/${evidence.itemId}/accept`, offerDelivery);
requireAction(evidence.telegram?.actions?.return, "receiver return action", "return_work", `/api/task-control/team/handovers/${evidence.itemId}/return`, returnPromptDelivery);

requireEqual(evidence.github?.remote, EXPECTED_REMOTE, "GitHub remote");
const branchPattern = /^[0-9a-f]{40}\trefs\/heads\/aw\/handover\/awi1_/;
const controlPattern = /^[0-9a-f]{40}\trefs\/aw\/items\/awi1_[^/]+\/control$/;
const offeredBranchSha = refSha(evidence.github?.offered?.handoverRef, "offered GitHub handover ref", branchPattern);
const offeredControlSha = refSha(evidence.github?.offered?.controlRef, "offered GitHub control ref", controlPattern);
const returnedBranchSha = refSha(evidence.github?.returned?.handoverRef, "returned GitHub handover ref", branchPattern);
const returnedControlSha = refSha(evidence.github?.returned?.controlRef, "returned GitHub control ref", controlPattern);
requireEqual(evidence.github?.completed?.handoverRef, "", "completed handover ref cleanup");
const completedControlSha = refSha(evidence.github?.completed?.controlRef, "completed GitHub control ref", controlPattern);
if (offeredControlSha !== null && returnedControlSha !== null && offeredControlSha === returnedControlSha) failures.push("GitHub reverse trip: returned control ref did not advance from the offered ref");
if (returnedControlSha !== null && completedControlSha !== null && returnedControlSha === completedControlSha) failures.push("GitHub apply: completed control ref did not advance from the returned ref");
if (offeredBranchSha !== null && returnedBranchSha !== null && offeredBranchSha === returnedBranchSha) failures.push("GitHub reverse trip: returned result ref did not advance from the offered package ref");

requireString(evidence.promptId === undefined ? undefined : String(evidence.promptId), "promptId", /^\d+$/);
requireString(evidence.itemId, "itemId", /^awi1_/);
requireObject(evidence.requester?.offered, "requester offered record");
requireEqual(evidence.requester?.offered?.state, "OFFERED", "requester offered state");
requireString(evidence.requester?.offered?.branch, "requester offered branch", /^aw\/handover\/awi1_/);

requireObject(evidence.receiver?.accepted, "receiver accepted record");
if (!["CLAIMED", "RUNNING", "WAITING_INPUT", "RETURNABLE", "RETURNED", "COMPLETED"].includes(evidence.receiver?.accepted?.state)) failures.push(`receiver accepted state: got ${JSON.stringify(evidence.receiver?.accepted?.state)}`);

requireObject(evidence.receiver?.finished, "receiver finished record");
requireEqual(evidence.receiver?.finished?.localTask?.runState, "DONE", "receiver run state");
requireString(evidence.receiver?.finished?.localTask?.runId, "receiver run id", /^run_/);

requireObject(evidence.requester?.returned, "requester returned record");
if (!["RETURNED", "COMPLETED"].includes(evidence.requester?.returned?.state)) failures.push(`requester returned state: got ${JSON.stringify(evidence.requester?.returned?.state)}`);
requireObject(evidence.requester?.completed, "requester completed record");
requireEqual(evidence.requester?.completed?.state, "COMPLETED", "requester completed state");
requireEqual(evidence.requester?.completed?.resultLabel, "full", "requester completed result label");
requireString(evidence.requester?.reviewText, "requester review text", /full|merges cleanly/i);
requireString(evidence.requester?.head, "requester HEAD", /^[0-9a-f]{40}$/);
if (returnedBranchSha !== null) requireEqual(evidence.requester?.head, returnedBranchSha, "applied requester HEAD versus returned result ref");

if (evidence.error !== undefined) failures.push(`unexpected error in evidence: ${JSON.stringify(evidence.error)}`);

if (failures.length > 0) {
  console.error(`FAIL: ${path} does not prove the live two-workstation round trip.`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`PASS: ${path} proves Telegram delivery and action, Git control/result refs, reverse return, and requester apply for ${evidence.itemId}.`);
