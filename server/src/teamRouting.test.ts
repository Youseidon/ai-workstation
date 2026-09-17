import assert from "node:assert/strict";
import test from "node:test";
import { routeTeamItemMessage, type TeamItemRoute } from "./teamRouting.ts";

const itemA = "awi1_aaaaaaaaaaaaaaaaaaaaaaaa";
const itemB = "awi1_bbbbbbbbbbbbbbbbbbbbbbbb";
const unknown = "awi1_cccccccccccccccccccccccc";
const members = [
  { telegramUserId: "101", botId: "bot-a" },
  { telegramUserId: "202", botId: "bot-b" },
];

interface Case {
  name: string;
  bot: "a" | "b";
  sender?: string;
  text: string;
  replyItemId?: string | null;
  expected: TeamItemRoute;
}

const cases: Case[] = [
  { name: "owner handles anchor command", bot: "a", text: "/task", replyItemId: itemA, expected: { kind: "view", command: "task", itemId: itemA } },
  { name: "other workstation stays silent on anchor command", bot: "b", text: "/task", replyItemId: itemA, expected: { kind: "drop" } },
  { name: "roster teammate may read owner anchor", bot: "a", sender: "202", text: "/status", replyItemId: itemA, expected: { kind: "view", command: "status", itemId: itemA } },
  { name: "command addressed to another bot is ignored", bot: "a", text: "/access@harness_bot_b", replyItemId: itemA, expected: { kind: "drop" } },
  { name: "own addressed command works", bot: "a", text: "/help@harness_bot_a", replyItemId: itemA, expected: { kind: "view", command: "help", itemId: itemA } },
  { name: "named local item works without an anchor reply", bot: "b", sender: "101", text: `/task #item_${itemB.slice(5)}`, expected: { kind: "view", command: "task", itemId: itemB } },
  { name: "unknown item is answered by the typers workstation", bot: "a", text: `/status ${unknown}`, expected: { kind: "unknown_item" } },
  { name: "unknown item is silent on the other workstation", bot: "b", text: `/status ${unknown}`, expected: { kind: "drop" } },
  { name: "unknown item typed by B is answered only by B", bot: "b", sender: "202", text: `/status #item_${unknown.slice(5)}`, expected: { kind: "unknown_item" } },
  { name: "ordinary anchor discussion is dropped", bot: "a", text: "What do you think?", replyItemId: itemA, expected: { kind: "drop" } },
  { name: "unanchored discussion is dropped", bot: "a", text: "Morning", expected: { kind: "drop" } },
  { name: "bare unanchored item command is dropped", bot: "a", text: "/task", expected: { kind: "drop" } },
  { name: "non-roster sender is silent", bot: "a", sender: "303", text: `/task ${itemA}`, expected: { kind: "drop" } },
  { name: "personal fallback text is only discussion here", bot: "a", text: "That message is not a task question", replyItemId: itemA, expected: { kind: "drop" } },
];

test("TM-T0-1: group routing under broad administrator delivery", async (t) => {
  for (const row of cases) {
    await t.test(row.name, () => {
      const local = row.bot === "a" ? itemA : itemB;
      assert.deepEqual(routeTeamItemMessage({
        text: row.text,
        botUsername: `harness_bot_${row.bot}`,
        localBotId: `bot-${row.bot}`,
        senderTelegramUserId: row.sender ?? "101",
        members,
        replyItemId: row.replyItemId ?? null,
        localItemIds: new Set([local]),
      }), row.expected);
    });
  }
});
