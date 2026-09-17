import { randomBytes } from "node:crypto";

const ITEM_ID_PREFIX = "awi1_";
const ITEM_ID_BYTES = 12;
const ITEM_ID_PATTERN = /^awi1_[a-f0-9]{24}$/;

/** A short, opaque Team item identity with 96 bits of local randomness. */
export function mintItemId(): string {
  return `${ITEM_ID_PREFIX}${randomBytes(ITEM_ID_BYTES).toString("hex")}`;
}

export function isItemId(value: unknown): value is string {
  return typeof value === "string" && ITEM_ID_PATTERN.test(value);
}

/**
 * A Team item tag uses only Telegram hashtag characters and carries the full
 * random portion of the item id, so both workstations render the same tag.
 */
export function itemTag(itemId: string): string {
  if (!isItemId(itemId)) throw new TypeError("Invalid Team item id");
  return `#item_${itemId.slice(ITEM_ID_PREFIX.length)}`;
}
