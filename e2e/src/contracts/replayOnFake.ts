import { randomBytes } from "node:crypto";
import { FakePhone } from "../drivers/phone.ts";
import { FakeTelegramServer, type FakeBot } from "../fakes/telegramServer.ts";
import { AUTO_ENTITIES_QUOTE, AUTO_ENTITIES_TEXT, MISSING_MESSAGE_ID } from "./telegramShape.ts";

/*
 * Replays the steps of scripts/record-telegram-contracts.ts against the fake server, so
 * T0 can compare each response with the real recording (docs/e2e-scenarios/h6.md S-H6-30).
 * Step names must match the recorder's. `omittable` lists JSON paths real Telegram sends
 * that the fake deliberately leaves out because the app never reads them.
 */

/** The user's names on a private chat and their app language: the fake does not know them when the bot speaks first. */
const USER_PROFILE_ON_MESSAGE = ["$.result.chat.first_name", "$.result.chat.username"];
const LANGUAGE = (path: string) => [`${path}.from.language_code`];

export type Replayed = Record<string, { status: number; body: unknown; omittable: string[] }>;

export async function replayOnFake(): Promise<Replayed> {
  const server = new FakeTelegramServer();
  await server.listen();
  const bot: FakeBot = { id: 700_444_555, username: "harness_test_bot", token: `700444555:${randomBytes(27).toString("base64url")}` };
  server.addBot(bot);
  const user = { id: 918_000_001, firstName: "Operator", username: "operator" };
  const chat = { id: user.id, type: "private" as const };
  const phone = new FakePhone(server, bot, user, chat);
  const steps: Replayed = {};
  const call = async (step: string, method: string, body: Record<string, unknown>, token = bot.token, omittable: string[] = []) => {
    const response = await fetch(`${server.url}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const parsed = (await response.json()) as { ok: boolean; result?: unknown };
    steps[step] = { status: response.status, body: parsed, omittable };
    return parsed;
  };
  try {
    await call("getUpdates.probe", "getUpdates", { timeout: 0, limit: 1 });
    await call("deleteWebhook.dropPending", "deleteWebhook", { drop_pending_updates: true });
    await call("getMe", "getMe", {});
    const chatId = String(user.id);
    const sent = await call("sendMessage.withKeyboard", "sendMessage", { chat_id: chatId, text: "Contract recording: question card", link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[{ text: "Record tap", callback_data: "tc_contractrecording00000" }]] } }, bot.token, USER_PROFILE_ON_MESSAGE);
    const botMessageId = (sent.result as { message_id: number }).message_id;
    await call("sendMessage.plain", "sendMessage", { chat_id: chatId, text: "Contract recording: plain", link_preview_options: { is_disabled: true } }, bot.token, USER_PROFILE_ON_MESSAGE);
    await call("sendMessage.autoEntities", "sendMessage", { chat_id: chatId, text: AUTO_ENTITIES_TEXT, link_preview_options: { is_disabled: true }, entities: [AUTO_ENTITIES_QUOTE] }, bot.token, USER_PROFILE_ON_MESSAGE);
    const card = await phone.waitForBotMessage("the recording card", (message) => message.text === "Contract recording: question card");
    await phone.send("Contract recording: reply", { replyTo: card });
    await phone.send("Contract recording: plain text");
    const tapId = server.userTapsButton(bot, user, chat, card.id, "tc_contractrecording00000");
    const polled = await call("getUpdates.longPoll", "getUpdates", { offset: 0, timeout: 1, allowed_updates: ["message", "callback_query"] });
    const updates = polled.result as Array<{ update_id: number; message?: { message_id: number; reply_to_message?: unknown }; callback_query?: unknown }>;
    const at = (predicate: (update: (typeof updates)[number]) => boolean) => updates.find(predicate);
    steps["update.messageReply"] = { status: 200, body: at((update) => Boolean(update.message?.reply_to_message)), omittable: [...LANGUAGE("$.message"), "$.message.reply_to_message.chat.first_name", "$.message.reply_to_message.chat.username"] };
    steps["update.messagePlain"] = { status: 200, body: at((update) => Boolean(update.message) && !update.message?.reply_to_message), omittable: LANGUAGE("$.message") };
    steps["update.callbackQuery"] = { status: 200, body: at((update) => Boolean(update.callback_query)), omittable: LANGUAGE("$.callback_query") };
    // The recorder's long poll can return an empty batch first; the recorded step is its last response.
    steps["getUpdates.longPoll"] = { status: 200, body: { ok: true, result: [] }, omittable: [] };
    const offset = Math.max(...updates.map((update) => update.update_id)) + 1;
    await call("getUpdates.confirm", "getUpdates", { offset, timeout: 0 });
    const held = call("getUpdates.conflict", "getUpdates", { offset, timeout: 10 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    await call("getUpdates.displacing", "getUpdates", { offset, timeout: 0 });
    await held;
    await call("answerCallbackQuery", "answerCallbackQuery", { callback_query_id: tapId, text: "Recorded." });
    await call("answerCallbackQuery.twice", "answerCallbackQuery", { callback_query_id: tapId, text: "Again." });
    await call("editMessageText", "editMessageText", { chat_id: chatId, message_id: botMessageId, text: "Contract recording: edited", link_preview_options: { is_disabled: true } }, bot.token, USER_PROFILE_ON_MESSAGE);
    await call("editMessageText.notModified", "editMessageText", { chat_id: chatId, message_id: botMessageId, text: "Contract recording: edited", link_preview_options: { is_disabled: true } });
    const replyMessageId = at((update) => Boolean(update.message?.reply_to_message))!.message!.message_id;
    await call("editMessageText.notBotsMessage", "editMessageText", { chat_id: chatId, message_id: replyMessageId, text: "Contract recording: not mine" });
    await call("editMessageText.missingMessage", "editMessageText", { chat_id: chatId, message_id: MISSING_MESSAGE_ID, text: "Contract recording: gone" });
    await call("sendMessage.unknownChat", "sendMessage", { chat_id: "1", text: "Contract recording: nobody" });
    await call("sendMessage.emptyText", "sendMessage", { chat_id: chatId, text: "" });
    await call("setMyCommands", "setMyCommands", { commands: [{ command: "help", description: "Show help" }] });
    await call("createForumTopic.privateChat", "createForumTopic", { chat_id: chatId, name: "Contract recording" });
    await call("getMe.badToken", "getMe", {}, `${bot.id}:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
    await call("unknownMethod", "noSuchMethod", {});
    return steps;
  } finally {
    await server.close();
  }
}
