import { itemIdFromReference } from "./teamItems.ts";
import { parseTeamItemCommand, parseTeamItemGrantedCommand, type TeamItemCommand, type TeamItemGrantedCommand } from "./teamItemViews.ts";

export interface TeamRouteMember {
  telegramUserId: string;
  botId: string;
}

export type TeamItemRoute =
  | { kind: "drop" }
  | { kind: "unknown_item" }
  | { kind: "view"; command: TeamItemCommand; itemId: string }
  | { kind: "command"; command: TeamItemGrantedCommand; itemId: string };

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
  const granted = parsed === null ? parseTeamItemGrantedCommand(input.text, input.botUsername) : null;
  if (parsed === "other_bot" || granted === "other_bot") return { kind: "drop" };
  if (parsed === null && granted === null) return { kind: "drop" };

  const namedItemId = parsed === null || parsed.itemReference === null ? null : itemIdFromReference(parsed.itemReference);
  const itemId = namedItemId ?? input.replyItemId;
  if (itemId !== null && input.localItemIds.has(itemId)) {
    return parsed === null
      ? { kind: "command", command: granted as TeamItemGrantedCommand, itemId }
      : { kind: "view", command: parsed.command, itemId };
  }

  if (namedItemId !== null && sender.botId === input.localBotId) return { kind: "unknown_item" };
  return { kind: "drop" };
}
