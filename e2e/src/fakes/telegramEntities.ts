import { createRequire } from "node:module";

/*
 * Real Telegram adds entities of its own to every message a bot sends or edits, whatever entities the bot passed:
 * links, @mentions, #hashtags, $cashtags, emails and /commands found in the text. The fake adds the same so a
 * scenario that reads entities sees what the phone sees. The rules below follow what the test bot measured on
 * 2026-09-15 (fixtures in src/telegramEntities.test.ts); lengths or cases not measured are marked as guesses.
 */

export interface Entity {
  type: string;
  offset: number;
  length: number;
}

const TLDS = new Set((createRequire(import.meta.url)("tlds") as string[]).map((tld) => tld.toLowerCase()));

const URL_CHARS = String.raw`[^\s<>"'|\\]`;
const DOMAIN = String.raw`(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,63})`;
const IPV4 = String.raw`(?:\d{1,3}\.){3}\d{1,3}`;

function validHost(host: string): boolean {
  if (new RegExp(`^${IPV4}$`).test(host)) return true;
  const labels = host.toLowerCase().split(".");
  return labels.length >= 2 && TLDS.has(labels.at(-1)!);
}

/** A link never ends in sentence punctuation, or in a closing bracket it did not open. */
function trimLink(text: string): string {
  let result = text;
  for (;;) {
    const last = result.at(-1);
    if (last !== undefined && ".,;:!?".includes(last)) result = result.slice(0, -1);
    else if (last === ")" && result.split("(").length < result.split(")").length) result = result.slice(0, -1);
    else if (last === "]" && result.split("[").length < result.split("]").length) result = result.slice(0, -1);
    else return result;
  }
}

function matches(text: string, pattern: RegExp, type: string, accept: (match: RegExpExecArray) => { offset: number; value: string } | null = (match) => ({ offset: match.index, value: match[0] })): Entity[] {
  const found: Entity[] = [];
  for (const match of text.matchAll(pattern)) {
    const accepted = accept(match as RegExpExecArray);
    if (accepted && accepted.value.length > 0) found.push({ type, offset: accepted.offset, length: accepted.value.length });
  }
  return found;
}

/** The entities Telegram detects in a bot message's text, with UTF-16 offsets, sorted by offset. */
export function detectEntities(text: string): Entity[] {
  // Earlier groups win overlaps: an email is not also a link, and a link's "#fragment" is not a hashtag.
  const groups: Entity[][] = [
    matches(text, new RegExp(String.raw`(?<![\w.+-])[a-z0-9._%+-]+@${DOMAIN}(?![\w-])`, "giu"), "email", (match) => (TLDS.has(match[1]!.toLowerCase()) ? { offset: match.index, value: match[0] } : null)),
    matches(text, new RegExp(String.raw`(?<![\w])(?:https?|ftp):\/\/${URL_CHARS}+`, "giu"), "url", (match) => {
      const value = trimLink(match[0]);
      const host = /^[a-z]+:\/\/([^/:?#]+)/i.exec(value)?.[1] ?? "";
      return validHost(host) ? { offset: match.index, value } : null;
    }),
    matches(text, new RegExp(String.raw`(?<![\w])tg:\/\/${URL_CHARS}+`, "giu"), "url", (match) => ({ offset: match.index, value: trimLink(match[0]) })),
    matches(text, new RegExp(String.raw`(?<![\w@.\/:-])(?:${IPV4}|${DOMAIN})(?::\d{1,5})?(?:\/${URL_CHARS}*)?`, "giu"), "url", (match) => {
      const value = trimLink(match[0]);
      const host = /^[^/:]+/.exec(value)![0];
      return validHost(host) ? { offset: match.index, value } : null;
    }),
    matches(text, /(?<![\w@])@[a-z0-9_]{4,32}(?![\w])/giu, "mention"),
    matches(text, /(?<![\w#&])#[\p{L}\p{N}_]*\p{L}[\p{L}\p{N}_]*/gu, "hashtag"),
    // Measured: $AB and $ABCD; the 1 and 5-8 letter bounds are guesses.
    matches(text, /(?<![\w$])\$[A-Z]{1,8}(?![\w])/gu, "cashtag"),
    // A command starts the text or follows whitespace: "</b>", "word/help" and "/usr/local" hold none.
    matches(text, /(?<!\S)\/[a-z0-9_]{1,32}(?:@[a-z0-9_]{3,32})?(?![\w/@])/giu, "bot_command"),
  ];
  const accepted: Entity[] = [];
  for (const group of groups) {
    for (const entity of group) {
      if (!accepted.some((other) => entity.offset < other.offset + other.length && other.offset < entity.offset + entity.length)) accepted.push(entity);
    }
  }
  return accepted.sort((a, b) => a.offset - b.offset);
}

/** The entities a sent or edited bot message carries: the bot's own plus the detected ones, by offset, outer first. */
export function messageEntities(text: string, provided: Entity[] | undefined): Entity[] {
  return [...(provided ?? []), ...detectEntities(text)].sort((a, b) => a.offset - b.offset || b.length - a.length);
}
