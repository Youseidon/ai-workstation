import assert from "node:assert/strict";
import test from "node:test";
import { ACCESS_OPTIONS, auditLabel, botStatusLabel, minutesLeft } from "../../../features/account/lib/telegram";

test("access options name both levels, safest first", () => {
  assert.deepEqual(ACCESS_OPTIONS.map(option => option.value), ["notify", "control"]);
});

test("bot status shows the server's error text when polling fails", () => {
  assert.equal(botStatusLabel({ username: "b", status: "polling", error: null }), "Connected");
  assert.equal(botStatusLabel({ username: "b", status: "error", error: "Telegram rejected the bot token." }), "Telegram rejected the bot token.");
  assert.equal(botStatusLabel({ username: "b", status: "error", error: null }), "Not working");
});

test("audit actions read as sentences, failures included", () => {
  assert.equal(auditLabel("stop_run"), "Stopped an agent");
  assert.equal(auditLabel("pause_failed"), "Paused a pipeline (failed)");
  assert.equal(auditLabel("something_new"), "something_new");
});

test("link codes count down in whole minutes and never go negative", () => {
  const now = Date.parse("2026-11-26T10:00:00Z");
  assert.equal(minutesLeft("2026-11-26T10:09:30Z", now), 10);
  assert.equal(minutesLeft("2026-11-26T10:00:00Z", now), 0);
  assert.equal(minutesLeft("2026-11-26T09:00:00Z", now), 0);
});
