import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(fileURLToPath(new URL("./AgentsView.tsx", import.meta.url)), "utf8");

test("missing Telegram token uses the warning badge label, not configured", () => {
  const match = source.match(/telegram_missing_token:\s*\{\s*label:\s*"([^"]+)"/);
  assert.equal(match?.[1], "Telegram token missing");
  assert.doesNotMatch(match?.[0] ?? "", /Telegram configured/);
});
