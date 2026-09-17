import { createHash } from "node:crypto";
import { isItemId, itemTag } from "./teamItems.ts";
import { sanitizeTelegramText } from "./taskControlRenderer.ts";

const REQUEST_ID_PATTERN = /^ttr_[a-f0-9]{24}$/;

export type TeamThreadRequestDecision = "confirm" | "decline";

export interface TeamThreadRequestIdentity {
  requestId: string;
  itemId: string;
}

export interface TeamThreadRequestActionContent extends TeamThreadRequestIdentity {
  kind: "team_thread_request_action";
  decision: TeamThreadRequestDecision;
  ownerBotId: string;
  ownerTelegramUserId: string;
  promptId: number;
}

export interface ParsedTeamThreadRequest {
  ownerBotUsername: string;
  promptId: number;
}

export function parseTeamThreadRequest(text: string): ParsedTeamThreadRequest | null {
  const match = /^\/discuss\s+@([A-Za-z0-9_]{5,32})\s+([1-9]\d*)\s*$/.exec(text);
  if (match === null) return null;
  const promptId = Number(match[2]);
  return Number.isSafeInteger(promptId) ? { ownerBotUsername: match[1]!.toLowerCase(), promptId } : null;
}

export function teamThreadRequestIdentity(input: {
  teamId: string;
  groupChatId: string;
  messageId: string;
  requesterTelegramUserId: string;
  ownerBotId: string;
  promptId: number;
}): TeamThreadRequestIdentity {
  const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return { requestId: `ttr_${digest.slice(0, 24)}`, itemId: `awi1_${digest.slice(24, 48)}` };
}

export function encodeTeamThreadRequestAction(content: TeamThreadRequestActionContent): string {
  return JSON.stringify(content);
}

export function decodeTeamThreadRequestAction(value: string | null): TeamThreadRequestActionContent | null {
  if (value === null) return null;
  try {
    const record = JSON.parse(value) as Record<string, unknown>;
    if (record.kind !== "team_thread_request_action") return null;
    if (record.decision !== "confirm" && record.decision !== "decline") return null;
    if (typeof record.requestId !== "string" || !REQUEST_ID_PATTERN.test(record.requestId)) return null;
    if (!isItemId(record.itemId)) return null;
    if (typeof record.ownerBotId !== "string" || record.ownerBotId === "") return null;
    if (typeof record.ownerTelegramUserId !== "string" || record.ownerTelegramUserId === "") return null;
    if (!Number.isSafeInteger(record.promptId) || Number(record.promptId) <= 0) return null;
    return record as unknown as TeamThreadRequestActionContent;
  } catch {
    return null;
  }
}

export function renderTeamThreadRequest(input: {
  requestId: string;
  itemId: string;
  requesterLabel: string;
  ownerLabel: string;
}) {
  return {
    kind: "team_thread_request",
    requestId: input.requestId,
    text: `Thread requested by ${sanitizeTelegramText(input.requesterLabel)} for an item owned by ${sanitizeTelegramText(input.ownerLabel)}. Waiting for the owner to confirm.\n${itemTag(input.itemId)}`,
  } as const;
}

export function renderTeamThreadConfirmation(input: {
  requestId: string;
  itemId: string;
  requesterLabel: string;
  title: string;
  expiresAt: string;
  actions: Array<{ ref: string; decision: TeamThreadRequestDecision }>;
}) {
  return {
    kind: "team_thread_confirmation",
    requestId: input.requestId,
    itemId: input.itemId,
    requesterLabel: sanitizeTelegramText(input.requesterLabel),
    title: sanitizeTelegramText(input.title),
    expiresAt: input.expiresAt,
    actions: input.actions,
  } as const;
}
