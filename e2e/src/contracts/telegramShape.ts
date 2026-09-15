/*
 * Real Bot API responses recorded from the test bot (scripts/record-telegram-contracts.ts)
 * are the reference the fake Telegram server is checked against in T0. Recordings
 * are sanitized before they are written: identities, names and times are replaced
 * by placeholders of the same type, so the fixture keeps Telegram's shapes without
 * the operator's personal data.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Inputs shared by the recorder and the fake replay, so both run the same steps. */
export const AUTO_ENTITIES_TEXT = "Contract recording: entities\nDetails: https://example.com /help @someone #tag";
export const AUTO_ENTITIES_QUOTE = { type: "expandable_blockquote", offset: AUTO_ENTITIES_TEXT.indexOf("Details:"), length: AUTO_ENTITIES_TEXT.length - AUTO_ENTITIES_TEXT.indexOf("Details:") };
/** A message id no chat reaches. */
export const MISSING_MESSAGE_ID = 2_000_000_000;

const NUMERIC_IDENTITY = new Set(["id", "message_id", "update_id", "date", "edit_date", "message_thread_id", "retry_after"]);
const TEXT_IDENTITY = new Set(["first_name", "last_name", "username", "title", "language_code", "id", "chat_instance"]);

export interface Sanitizer {
  numbers: Map<number, number>;
  strings: Map<string, string>;
}

export function newSanitizer(): Sanitizer {
  return { numbers: new Map(), strings: new Map() };
}

/** Replaces identities consistently (the same real id always maps to the same placeholder) so relations between fields survive. */
export function sanitize(value: unknown, sanitizer: Sanitizer, key = ""): Json {
  if (Array.isArray(value)) return value.map((item) => sanitize(item, sanitizer));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, child]) => [name, sanitize(child, sanitizer, name)]));
  }
  if (typeof value === "number" && NUMERIC_IDENTITY.has(key)) {
    const known = sanitizer.numbers.get(value);
    if (known !== undefined) return known;
    const placeholder = (value < 0 ? -1 : 1) * (1000 + sanitizer.numbers.size);
    sanitizer.numbers.set(value, placeholder);
    return placeholder;
  }
  if (typeof value === "string" && TEXT_IDENTITY.has(key)) {
    const known = sanitizer.strings.get(value);
    if (known !== undefined) return known;
    const placeholder = `${key}_${sanitizer.strings.size + 1}`;
    sanitizer.strings.set(value, placeholder);
    return placeholder;
  }
  return (value ?? null) as Json;
}

/**
 * Sanitizes a whole recording. Identities found under identity fields (ids, names,
 * usernames) are replaced everywhere, including inside text fields such as `text` and
 * `description`. `mustNotRemain` lists every value the caller knows is secret or
 * identifying (tokens, api hash, session, the operator's ids); if any survives, the
 * recording is refused so nothing is written.
 */
export function sanitizeRecording(raw: unknown, mustNotRemain: string[]): Json {
  const sanitizer = newSanitizer();
  const structured = sanitize(raw, sanitizer);
  const discovered: Array<[string, string]> = [
    ...[...sanitizer.strings.entries()],
    ...[...sanitizer.numbers.entries()].filter(([value]) => Math.abs(value) >= 10_000).map(([value, placeholder]): [string, string] => [String(value), String(placeholder)]),
  ].filter(([value]) => value.length >= 3).sort((a, b) => b[0].length - a[0].length);
  const scrub = (value: Json): Json => {
    if (typeof value === "string") return discovered.reduce((text, [identity, placeholder]) => text.split(identity).join(placeholder), value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, scrub(child)]));
    return value;
  };
  const result = scrub(structured);
  const text = JSON.stringify(result);
  const remaining = mustNotRemain.filter((value) => value.length >= 3 && text.includes(value));
  if (remaining.length > 0) throw new Error(`sanitization left ${remaining.length} secret or identifying value(s) in the recording; nothing was written`);
  return result;
}

export type Shape = "null" | "boolean" | "number" | "string" | { array: Shape | "empty" } | { object: Record<string, Shape> };

export function shapeOf(value: unknown): Shape {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return { array: value.length === 0 ? "empty" : shapeOf(value[0]) };
  if (typeof value === "object") return { object: Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, shapeOf(child)])) };
  return typeof value as "boolean" | "number" | "string";
}

/**
 * Differences between a fake response and the real one at the same step.
 * The fake may omit fields listed in `omittable` (fields the app never reads);
 * it must never add a field real Telegram does not send, or change a type.
 */
export function shapeDifferences(real: Shape, fake: Shape, omittable: ReadonlySet<string> = new Set(), path = "$"): string[] {
  if (typeof real === "string" || typeof fake === "string") {
    return real === fake ? [] : [`${path}: real is ${describe(real)}, fake is ${describe(fake)}`];
  }
  if ("array" in real || "array" in fake) {
    if (!("array" in real) || !("array" in fake)) return [`${path}: real is ${describe(real)}, fake is ${describe(fake)}`];
    if (real.array === "empty" || fake.array === "empty") return [];
    return shapeDifferences(real.array, fake.array, omittable, `${path}[]`);
  }
  const differences: string[] = [];
  for (const [key, child] of Object.entries(fake.object)) {
    if (!(key in real.object)) differences.push(`${path}.${key}: the fake sends a field real Telegram does not`);
    else differences.push(...shapeDifferences(real.object[key]!, child, omittable, `${path}.${key}`));
  }
  for (const key of Object.keys(real.object)) {
    if (!(key in fake.object) && !omittable.has(`${path}.${key}`)) differences.push(`${path}.${key}: real Telegram sends it, the fake does not`);
  }
  return differences;
}

function describe(shape: Shape): string {
  if (typeof shape === "string") return shape;
  return "array" in shape ? "array" : "object";
}
