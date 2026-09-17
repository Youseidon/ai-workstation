import { randomBytes } from "node:crypto";

const ITEM_ID_PREFIX = "awi1_";
const ITEM_ID_BYTES = 12;
const ITEM_ID_PATTERN = /^awi1_[a-f0-9]{24}$/;
const ITEM_TAG_PATTERN = /^#item_([a-f0-9]{24})$/i;

/** A short, opaque Team item identity with 96 bits of local randomness. */
export function mintItemId(): string {
  return `${ITEM_ID_PREFIX}${randomBytes(ITEM_ID_BYTES).toString("hex")}`;
}

export function isItemId(value: unknown): value is string {
  return typeof value === "string" && ITEM_ID_PATTERN.test(value);
}

export function itemIdFromReference(value: string): string | null {
  const normalized = value.toLowerCase();
  if (isItemId(normalized)) return normalized;
  const tag = ITEM_TAG_PATTERN.exec(value);
  return tag === null ? null : `${ITEM_ID_PREFIX}${tag[1]!.toLowerCase()}`;
}

/**
 * A Team item tag uses only Telegram hashtag characters and carries the full
 * random portion of the item id, so both workstations render the same tag.
 */
export function itemTag(itemId: string): string {
  if (!isItemId(itemId)) throw new TypeError("Invalid Team item id");
  return `#item_${itemId.slice(ITEM_ID_PREFIX.length)}`;
}
