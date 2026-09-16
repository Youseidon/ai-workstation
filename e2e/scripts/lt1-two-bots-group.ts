#!/usr/bin/env -S node --import tsx
/*
 * LT-1: live Telegram delivery check for two bots in one group.
 *
 * Reads credentials only from ~/.config/ai-workstation/e2e-live.env:
 * - existing harness test bot keys handled by loadLiveConfig()
 * - E2E_TELEGRAM_SECOND_BOT_TOKEN for the throwaway teammate bot
 *
 * The script prints only sanitized labels and booleans/counts. It never prints
 * tokens, session strings, bot ids/usernames, group ids, message ids, or invite links.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import bigInt from "big-integer";
import { loadLiveConfig, LIVE_ENV_PATH, parseEnvFile, LiveSetupError, type LiveConfig } from "../src/env/liveConfig.ts";
import { allowSlowConnects } from "../src/env/network.ts";

allowSlowConnects();

type BotLabel = "test-bot" | "second-bot";

interface BotConfig {
  label: BotLabel;
  token: string;
  id: string;
  username: string;
}

interface BotUpdate {
  update_id: number;
  message?: {
    text?: string;
    reply_to_message?: { from?: { id?: number } };
  };
}

interface BotCallResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface DeliveryResult {
  "test-bot": boolean;
  "second-bot": boolean;
}

interface ProbeSummary {
  getMe: Record<BotLabel, { canReadAllGroupMessages: boolean | null }>;
  membership: Record<BotLabel, { status: string; canPinMessages: boolean | null; canInviteUsers: boolean | null }>;
  setup: {
    temporaryGroupCreated: boolean;
    bothBotsAdded: boolean;
    bothBotsPromotedByUserClient: boolean;
    pinSucceeded: Record<BotLabel, boolean>;
    oneUseInviteCreated: boolean;
    oneUseInviteRejoinSucceeded: boolean;
  };
  delivery: {
    plainCommand: DeliveryResult;
    addressedToTestBot: DeliveryResult;
    addressedToSecondBot: DeliveryResult;
    replyToTestBotMessage: DeliveryResult;
    replyToSecondBotMessage: DeliveryResult;
    unanchoredDiscussion: DeliveryResult;
  };
  assumptions: Record<string, "confirmed" | "disproved">;
}

function fail(message: string): never {
  console.error(`LT-1 blocked: ${message}`);
  process.exit(2);
}

function assertLiveFile(): Record<string, string> {
  if (!existsSync(LIVE_ENV_PATH)) throw new LiveSetupError(`${LIVE_ENV_PATH} does not exist`);
  const mode = statSync(LIVE_ENV_PATH).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new LiveSetupError(`${LIVE_ENV_PATH} is readable by other users (mode ${mode.toString(8)}); run chmod 600 on it`);
  return parseEnvFile(readFileSync(LIVE_ENV_PATH, "utf8"));
}

async function botCall<T>(bot: BotConfig, method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${bot.token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json()) as BotCallResult<T>;
  if (!parsed.ok) throw new Error(`${bot.label} ${method} failed: ${parsed.description ?? `HTTP ${response.status}`}`);
  return parsed.result as T;
}

async function optionalBotCall<T>(bot: BotConfig, method: string, body: Record<string, unknown>): Promise<T | null> {
  try {
    return await botCall<T>(bot, method, body);
  } catch {
    return null;
  }
}

async function identifyBot(label: BotLabel, token: string): Promise<BotConfig> {
  const bot = { label, token, id: token.split(":")[0] ?? "", username: "" };
  const me = await botCall<{ id: number; username?: string } & Record<string, unknown>>(bot, "getMe", {});
  if (String(me.id) !== bot.id) fail(`${label} token did not match its own Bot API identity`);
  if (!me.username) fail(`${label} has no username`);
  return { ...bot, username: me.username };
}

function peerBotApiChatId(chat: Api.TypeChat): string {
  if (chat instanceof Api.Chat) return `-${String(chat.id)}`;
  if (chat instanceof Api.Channel) return `-100${String(chat.id)}`;
  fail("created chat had an unsupported Telegram peer type");
}

async function connectUser(config: LiveConfig): Promise<TelegramClient> {
  const client = new TelegramClient(new StringSession(config.userSession), config.apiId, config.apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
    floodSleepThreshold: 5,
  });
  client.setLogLevel("error" as never);
  await client.connect();
  if (!(await client.checkAuthorization())) throw new LiveSetupError("the saved Telegram user session is revoked or no longer authorized; run npm run e2e:live:login again");
  const me = await client.getMe();
  if (String(me.id) !== config.operatorUserId) throw new LiveSetupError("the saved Telegram user session belongs to a different account than E2E_TELEGRAM_OPERATOR_USER_ID");
  return client;
}

async function drain(bot: BotConfig): Promise<number> {
  const updates = await botCall<BotUpdate[]>(bot, "getUpdates", { timeout: 0, limit: 100, allowed_updates: ["message", "callback_query", "my_chat_member"] });
  const max = Math.max(0, ...updates.map((update) => update.update_id));
  if (max > 0) await botCall<BotUpdate[]>(bot, "getUpdates", { offset: max + 1, timeout: 0, limit: 1 });
  return max + 1;
}

async function poll(bot: BotConfig, offset: number, marker: string): Promise<{ delivered: boolean; nextOffset: number }> {
  const deadline = Date.now() + 18_000;
  let nextOffset = offset;
  let delivered = false;
  while (Date.now() < deadline) {
    const updates = await botCall<BotUpdate[]>(bot, "getUpdates", { offset: nextOffset, timeout: 2, limit: 100, allowed_updates: ["message"] });
    for (const update of updates) {
      nextOffset = Math.max(nextOffset, update.update_id + 1);
      if (update.message?.text?.includes(marker)) delivered = true;
    }
    if (delivered) break;
  }
  return { delivered, nextOffset };
}

async function pollBoth(
  bots: [BotConfig, BotConfig],
  offsets: Record<BotLabel, number>,
  marker: string,
): Promise<{ result: DeliveryResult; offsets: Record<BotLabel, number> }> {
  const [first, second] = await Promise.all([poll(bots[0], offsets[bots[0].label], marker), poll(bots[1], offsets[bots[1].label], marker)]);
  return {
    result: { "test-bot": first.delivered, "second-bot": second.delivered },
    offsets: { "test-bot": first.nextOffset, "second-bot": second.nextOffset },
  };
}

async function findUserSideMessage(client: TelegramClient, peer: Api.TypeInputPeer, text: string): Promise<Api.Message> {
  const deadline = Date.now() + 18_000;
  while (Date.now() < deadline) {
    const messages = await client.getMessages(peer, { limit: 30 });
    const found = messages.find((message): message is Api.Message => message instanceof Api.Message && message.message === text);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("timed out waiting for a bot message in user-side group history");
}

function inviteHash(link: string): string {
  const match = link.match(/(?:t\.me\/\+|joinchat\/)([A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error("Telegram returned an invite link in an unrecognised shape");
  return match[1];
}

function rights(member: Record<string, unknown>): { status: string; canPinMessages: boolean | null; canInviteUsers: boolean | null } {
  return {
    status: typeof member.status === "string" ? member.status : "unknown",
    canPinMessages: typeof member.can_pin_messages === "boolean" ? member.can_pin_messages : null,
    canInviteUsers: typeof member.can_invite_users === "boolean" ? member.can_invite_users : null,
  };
}

function delivery(reaches: { result: DeliveryResult; offsets: Record<BotLabel, number> }, offsets: Record<BotLabel, number>): DeliveryResult {
  offsets["test-bot"] = reaches.offsets["test-bot"];
  offsets["second-bot"] = reaches.offsets["second-bot"];
  return reaches.result;
}

async function main(): Promise<void> {
  const config = loadLiveConfig();
  const env = assertLiveFile();
  const secondToken = env.E2E_TELEGRAM_SECOND_BOT_TOKEN;
  if (!secondToken) fail(`${LIVE_ENV_PATH} is missing E2E_TELEGRAM_SECOND_BOT_TOKEN`);

  const bots: [BotConfig, BotConfig] = [
    await identifyBot("test-bot", config.testBotToken),
    await identifyBot("second-bot", secondToken),
  ];
  if (bots[0].id === bots[1].id) fail("the second bot token points at the same bot as the harness test bot");

  await Promise.all(bots.map((bot) => optionalBotCall(bot, "deleteWebhook", { drop_pending_updates: true })));
  const offsets: Record<BotLabel, number> = { "test-bot": await drain(bots[0]), "second-bot": await drain(bots[1]) };

  const client = await connectUser(config);
  try {
    const inputUsers = await Promise.all(bots.map((bot) => client.getInputEntity(bot.username)));
    const title = `AW LT-1 ${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
    const created = await client.invoke(new Api.messages.CreateChat({ users: inputUsers, title }));
    const chats = ((created as unknown as { chats?: Api.TypeChat[] }).chats ?? []).filter((chat) => chat instanceof Api.Chat || chat instanceof Api.Channel);
    let chat = chats.find((candidate) => "title" in candidate && candidate.title === title) ?? chats[0];
    if (!chat) {
      const dialogs = await client.getDialogs({ limit: 20 });
      const dialog = dialogs.find((item) => item.title === title);
      if (dialog?.entity instanceof Api.Chat || dialog?.entity instanceof Api.Channel) chat = dialog.entity;
    }
    if (!chat) fail("Telegram did not return the created group");
    const botApiChatId = peerBotApiChatId(chat);
    const peer = await client.getInputEntity(chat);

    for (const [index, bot] of bots.entries()) {
      await client.invoke(new Api.messages.EditChatAdmin({ chatId: bigInt(String((chat as Api.Chat).id)), userId: inputUsers[index]!, isAdmin: true })).catch(() => undefined);
      await optionalBotCall(bot, "promoteChatMember", {
        chat_id: botApiChatId,
        user_id: Number(bot.id),
        can_pin_messages: true,
        can_invite_users: true,
        can_manage_chat: true,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    offsets["test-bot"] = await drain(bots[0]);
    offsets["second-bot"] = await drain(bots[1]);

    const getMe = {
      "test-bot": { canReadAllGroupMessages: Boolean((await botCall<Record<string, unknown>>(bots[0], "getMe", {})).can_read_all_group_messages) },
      "second-bot": { canReadAllGroupMessages: Boolean((await botCall<Record<string, unknown>>(bots[1], "getMe", {})).can_read_all_group_messages) },
    };
    const membership = {
      "test-bot": rights(await botCall<Record<string, unknown>>(bots[0], "getChatMember", { chat_id: botApiChatId, user_id: Number(bots[0].id) })),
      "second-bot": rights(await botCall<Record<string, unknown>>(bots[1], "getChatMember", { chat_id: botApiChatId, user_id: Number(bots[1].id) })),
    };

    const pinSucceeded: Record<BotLabel, boolean> = { "test-bot": false, "second-bot": false };
    for (const bot of bots) {
      const sent = await optionalBotCall<{ message_id: number }>(bot, "sendMessage", { chat_id: botApiChatId, text: `LT-1 setup ${bot.label}` });
      if (sent) pinSucceeded[bot.label] = (await optionalBotCall<boolean>(bot, "pinChatMessage", { chat_id: botApiChatId, message_id: sent.message_id, disable_notification: true })) !== null;
    }

    const run = Math.random().toString(36).slice(2, 8);
    const plainMarker = `lt1-${run}-plain`;
    await client.sendMessage(peer, { message: `/status ${plainMarker}`, formattingEntities: [] });
    const plainCommand = delivery(await pollBoth(bots, offsets, plainMarker), offsets);

    const addressedTestMarker = `lt1-${run}-addr-test`;
    await client.sendMessage(peer, { message: `/status@${bots[0].username} ${addressedTestMarker}`, formattingEntities: [] });
    const addressedToTestBot = delivery(await pollBoth(bots, offsets, addressedTestMarker), offsets);

    const addressedSecondMarker = `lt1-${run}-addr-second`;
    await client.sendMessage(peer, { message: `/status@${bots[1].username} ${addressedSecondMarker}`, formattingEntities: [] });
    const addressedToSecondBot = delivery(await pollBoth(bots, offsets, addressedSecondMarker), offsets);

    const botOneAnchorText = `LT-1 anchor test ${run}`;
    await botCall<{ message_id: number }>(bots[0], "sendMessage", { chat_id: botApiChatId, text: botOneAnchorText });
    const botOneAnchor = await findUserSideMessage(client, peer, botOneAnchorText);
    const replyOneMarker = `lt1-${run}-reply-test`;
    await client.sendMessage(peer, { message: `discussion ${replyOneMarker}`, formattingEntities: [], replyTo: botOneAnchor.id });
    const replyToTestBotMessage = delivery(await pollBoth(bots, offsets, replyOneMarker), offsets);

    const botTwoAnchorText = `LT-1 anchor second ${run}`;
    await botCall<{ message_id: number }>(bots[1], "sendMessage", { chat_id: botApiChatId, text: botTwoAnchorText });
    const botTwoAnchor = await findUserSideMessage(client, peer, botTwoAnchorText);
    const replyTwoMarker = `lt1-${run}-reply-second`;
    await client.sendMessage(peer, { message: `discussion ${replyTwoMarker}`, formattingEntities: [], replyTo: botTwoAnchor.id });
    const replyToSecondBotMessage = delivery(await pollBoth(bots, offsets, replyTwoMarker), offsets);

    const unanchoredMarker = `lt1-${run}-unanchored`;
    await client.sendMessage(peer, { message: `ordinary discussion ${unanchoredMarker}`, formattingEntities: [] });
    const unanchoredDiscussion = delivery(await pollBoth(bots, offsets, unanchoredMarker), offsets);

    const invite = await optionalBotCall<{ invite_link?: string }>(bots[0], "createChatInviteLink", {
      chat_id: botApiChatId,
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 3600,
      name: "LT-1 one-use",
    });
    let oneUseInviteRejoinSucceeded = false;
    if (invite?.invite_link) {
      await client.invoke(new Api.messages.DeleteChatUser({ chatId: bigInt(String((chat as Api.Chat).id)), userId: await client.getInputEntity("me"), revokeHistory: false })).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await client.invoke(new Api.messages.ImportChatInvite({ hash: inviteHash(invite.invite_link) }));
      oneUseInviteRejoinSucceeded = true;
    }

    const summary: ProbeSummary = {
      getMe,
      membership,
      setup: {
        temporaryGroupCreated: true,
        bothBotsAdded: true,
        bothBotsPromotedByUserClient: membership["test-bot"].status === "administrator" && membership["second-bot"].status === "administrator",
        pinSucceeded,
        oneUseInviteCreated: Boolean(invite?.invite_link),
        oneUseInviteRejoinSucceeded,
      },
      delivery: {
        plainCommand,
        addressedToTestBot,
        addressedToSecondBot,
        replyToTestBotMessage,
        replyToSecondBotMessage,
        unanchoredDiscussion,
      },
      assumptions: {
        "plain command reaches both admin bots": plainCommand["test-bot"] && plainCommand["second-bot"] ? "confirmed" : "disproved",
        "addressed command reaches at least the named admin bot": addressedToTestBot["test-bot"] && addressedToSecondBot["second-bot"] ? "confirmed" : "disproved",
        "reply to an admin bot message reaches both admin bots": replyToTestBotMessage["test-bot"] && replyToTestBotMessage["second-bot"] && replyToSecondBotMessage["test-bot"] && replyToSecondBotMessage["second-bot"] ? "confirmed" : "disproved",
        "unanchored discussion reaches both admin bots": unanchoredDiscussion["test-bot"] && unanchoredDiscussion["second-bot"] ? "confirmed" : "disproved",
      },
    };

    console.log(JSON.stringify(summary, null, 2));
    if (Object.values(summary.assumptions).includes("disproved")) process.exitCode = 3;
  } finally {
    await client.disconnect().catch(() => undefined);
    await client.destroy().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const value of [assertLiveFile().E2E_TELEGRAM_TEST_BOT_TOKEN, assertLiveFile().E2E_TELEGRAM_SECOND_BOT_TOKEN, assertLiveFile().E2E_TELEGRAM_API_HASH, assertLiveFile().E2E_TELEGRAM_USER_SESSION].filter(Boolean)) {
    if (value && text.includes(value)) fail("Telegram returned an error containing a secret; refusing to print it");
  }
  console.error(`LT-1 failed: ${text}`);
  process.exit(1);
});
