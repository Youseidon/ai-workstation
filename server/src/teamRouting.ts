import { itemIdFromReference } from "./teamItems.ts";
import { parseTeamItemCommand, type TeamItemCommand } from "./teamItemViews.ts";

export interface TeamRouteMember {
  telegramUserId: string;
  botId: string;
}

export type TeamItemRoute =
  | { kind: "drop" }
  | { kind: "unknown_item" }
  | { kind: "view"; command: TeamItemCommand; itemId: string };

export function routeTeamItemMessage(input: {
  text: string;
  botUsername: string | null;
  localBotId: string;
  senderTelegramUserId: string;
  members: readonly TeamRouteMember[];
  replyItemId: string | null;
  localItemIds: ReadonlySet<string>;
}): TeamItemRoute {
  const sender = input.members.find(member => member.telegramUserId === input.senderTelegramUserId);
  if (sender === undefined) return { kind: "drop" };

  const parsed = parseTeamItemCommand(input.text, input.botUsername);
  if (parsed === null || parsed === "other_bot") return { kind: "drop" };

  const namedItemId = parsed.itemReference === null ? null : itemIdFromReference(parsed.itemReference);
  const itemId = namedItemId ?? input.replyItemId;
  if (itemId !== null && input.localItemIds.has(itemId)) {
    return { kind: "view", command: parsed.command, itemId };
  }

  if (namedItemId !== null && sender.botId === input.localBotId) return { kind: "unknown_item" };
  return { kind: "drop" };
}
