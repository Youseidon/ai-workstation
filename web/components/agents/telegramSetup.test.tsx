import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { TelegramLiveStatus } from "@agent-console/shared";
import { workspaceApi } from "@/lib/workspacesApi";
import { telegramSetupStep } from "./TelegramSetupDialog";

function status(overrides: Partial<TelegramLiveStatus> = {}): TelegramLiveStatus {
  return {
    state: "polling",
    reason: "Connected",
    tokenConfigured: true,
    bot: { id: "7000000001", username: "workstation_bot" },
    lastPollAt: null,
    lastError: null,
    nextRetryAt: null,
    outbox: { queued: 0, retrying: 0, failed: 0 },
    topics: { available: false, note: "No topics" },
    pairing: null,
    actors: [],
    ...overrides,
  };
}

test("Telegram setup advances from token to phone confirmation and ready", () => {
  assert.equal(telegramSetupStep(null), "bot");
  assert.equal(telegramSetupStep(status({ state: "missing_token", tokenConfigured: false, bot: null })), "bot");
  assert.equal(telegramSetupStep(status({ state: "disabled" })), "connecting");
  assert.equal(telegramSetupStep(status()), "phone");
  assert.equal(telegramSetupStep(status({ pairing: {
    code: "pair-code",
    deepLink: "https://t.me/workstation_bot?start=pair-code",
    expiresAt: "2099-01-01T00:00:00.000Z",
    observed: { transportUserId: "42", chatId: "42", label: "Teammate", username: "team", observedAt: "2099-01-01T00:00:00.000Z" },
  } })), "confirm");
  assert.equal(telegramSetupStep(status({ actors: [{ id: "actor", label: "Teammate", transportUserId: "42", chatId: "42", createdAt: "2099-01-01T00:00:00.000Z" }] })), "ready");
  assert.equal(telegramSetupStep(status({ actors: [{ id: "actor", label: "Teammate", transportUserId: "42", chatId: "42", createdAt: "2099-01-01T00:00:00.000Z" }] }), false), "enable");
});

test("a connected bot goes back to the token step only when the operator asks for a different one", () => {
  const paired = status({ actors: [{ id: "actor", label: "Owner", transportUserId: "42", chatId: "42", createdAt: "2099-01-01T00:00:00.000Z" }] });
  assert.equal(telegramSetupStep(paired, true, false), "ready");
  assert.equal(telegramSetupStep(paired, true, true), "bot");
  assert.equal(telegramSetupStep(status(), true, true), "bot", "also before a phone is paired");
});

test("the client sends a write-only token to the dedicated local credential route", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify({ status: status() }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    await workspaceApi.configureTelegram("http://127.0.0.1:4000", "secret-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url.pathname, "/api/task-control/telegram/credential");
  assert.equal(call.init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(call.init?.body)), { token: "secret-token" });
});

test("the setup modal keeps bot creation, hidden token entry and per-workstation guidance in the UI", () => {
  const source = readFileSync(fileURLToPath(new URL("./TelegramSetupDialog.tsx", import.meta.url)), "utf8");
  assert.match(source, /https:\/\/t\.me\/BotFather/);
  assert.match(source, /type=\{showToken \? "text" : "password"\}/);
  assert.match(source, /different bot on their workstation/);
  assert.match(source, /never returns it to the browser or passes it to agents/);
});
