#!/usr/bin/env -S node --import tsx
/*
 * Re-records the Bot API response shapes the fake Telegram server must match
 * (docs/e2e-harness-plan.md 4.2 and H6), from the dedicated test bot and the
 * operator's automated client. Run by `npm run e2e:live:record-contracts`.
 *
 * Writes e2e/contracts/telegram-bot-api.json: one sanitized sample per step.
 * The token is never written or printed; identities and names are replaced by
 * placeholders (src/contracts/telegramShape.ts). Refuses to run while another
 * process is polling the test bot, so a harness run is never disturbed.
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TelegramUserPhone } from "../src/drivers/telegramUserPhone.ts";
import { loadLiveConfig } from "../src/env/liveConfig.ts";
import { sanitizeRecording } from "../src/contracts/telegramShape.ts";

const config = loadLiveConfig();
const out = resolve(import.meta.dirname, "../contracts/telegram-bot-api.json");
const steps: Record<string, { status: number; body: unknown }> = {};

async function call(step: string, method: string, body: Record<string, unknown>, token = config.testBotToken): Promise<{ status: number; body: { ok: boolean; result?: unknown; description?: string } }> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const parsed = (await response.json()) as { ok: boolean; result?: unknown; description?: string };
  steps[step] = { status: response.status, body: parsed };
  return { status: response.status, body: parsed };
}

function fail(message: string): never {
  console.error(`record-telegram-contracts: ${message}`);
  process.exit(1);
}

const phone = new TelegramUserPhone(config);
try {
  const probe = await call("getUpdates.probe", "getUpdates", { timeout: 0, limit: 1 });
  if (probe.status === 409) fail("another process is polling the test bot (a harness run?); stop it and retry");
  await call("deleteWebhook.dropPending", "deleteWebhook", { drop_pending_updates: true });
  await call("getMe", "getMe", {});
  await phone.connect();
  const chatId = config.operatorUserId;

  const sent = await call("sendMessage.withKeyboard", "sendMessage", {
    chat_id: chatId,
    text: "Contract recording: question card",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[{ text: "Record tap", callback_data: "tc_contractrecording00000" }]] },
  });
  const botMessageId = (sent.body.result as { message_id: number }).message_id;
  await call("sendMessage.plain", "sendMessage", { chat_id: chatId, text: "Contract recording: plain", link_preview_options: { is_disabled: true } });

  const card = await phone.waitForBotMessage("the recording card", (message) => message.text === "Contract recording: question card");
  await phone.send("Contract recording: reply", { replyTo: card });
  await phone.send("Contract recording: plain text");
  const tap = phone.tap(card, "Record tap");

  const updates: Array<{ update_id: number; message?: unknown; callback_query?: { id: string } }> = [];
  const deadline = Date.now() + 60_000;
  let offset = 0;
  while (Date.now() < deadline && !(updates.some((u) => u.callback_query) && updates.filter((u) => u.message).length >= 2)) {
    const polled = await call("getUpdates.longPoll", "getUpdates", { offset, timeout: 10, allowed_updates: ["message", "callback_query"] });
    for (const update of (polled.body.result as typeof updates) ?? []) {
      updates.push(update);
      offset = update.update_id + 1;
    }
  }
  const reply = updates.find((u) => (u.message as { reply_to_message?: unknown } | undefined)?.reply_to_message);
  const plain = updates.find((u) => u.message && !(u.message as { reply_to_message?: unknown }).reply_to_message);
  const callback = updates.find((u) => u.callback_query);
  if (!reply || !plain || !callback) fail("did not receive the reply, plain message and callback updates within 60s");
  steps["update.messageReply"] = { status: 200, body: reply };
  steps["update.messagePlain"] = { status: 200, body: plain };
  steps["update.callbackQuery"] = { status: 200, body: callback };
  await call("getUpdates.confirm", "getUpdates", { offset, timeout: 0 });
  // A second poller ends the held one with 409, which is what a competing process sees.
  const held = call("getUpdates.conflict", "getUpdates", { offset, timeout: 10 });
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
  await call("getUpdates.displacing", "getUpdates", { offset, timeout: 0 });
  await held;

  await call("answerCallbackQuery", "answerCallbackQuery", { callback_query_id: callback.callback_query!.id, text: "Recorded." });
  await tap;
  await call("answerCallbackQuery.twice", "answerCallbackQuery", { callback_query_id: callback.callback_query!.id, text: "Again." });
  await call("editMessageText", "editMessageText", { chat_id: chatId, message_id: botMessageId, text: "Contract recording: edited", link_preview_options: { is_disabled: true } });
  await call("editMessageText.notModified", "editMessageText", { chat_id: chatId, message_id: botMessageId, text: "Contract recording: edited", link_preview_options: { is_disabled: true } });
  await call("editMessageText.missingMessage", "editMessageText", { chat_id: chatId, message_id: 1, text: "Contract recording: gone" });
  await call("sendMessage.unknownChat", "sendMessage", { chat_id: "1", text: "Contract recording: nobody" });
  await call("sendMessage.emptyText", "sendMessage", { chat_id: chatId, text: "" });
  await call("setMyCommands", "setMyCommands", { commands: [{ command: "help", description: "Show help" }] });
  await call("createForumTopic.privateChat", "createForumTopic", { chat_id: chatId, name: "Contract recording" });
  await call("getMe.badToken", "getMe", {}, `${config.testBotId}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
  await call("unknownMethod", "noSuchMethod", {});

  let fixture;
  try {
    fixture = sanitizeRecording(steps, [config.testBotToken, config.testBotToken.split(":")[1]!, config.apiHash, config.userSession, config.operatorUserId, config.testBotId, config.testBotUsername, config.operatorBotId, ...phone.identityValues()]);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  writeFileSync(out, `${JSON.stringify({ recordedAt: new Date().toISOString().slice(0, 10), source: "api.telegram.org via the harness test bot", steps: fixture }, null, 2)}\n`);
  console.log(`recorded ${Object.keys(steps).length} steps to ${join("e2e/contracts", "telegram-bot-api.json")}`);
} finally {
  await phone.disconnect().catch(() => undefined);
}
