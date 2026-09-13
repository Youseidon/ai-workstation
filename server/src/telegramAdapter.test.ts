import assert from "node:assert/strict";
import test from "node:test";
import { TelegramAdapter } from "./integrations/telegram/adapter.ts";
import { FakeTelegramBotApi } from "./integrations/telegram/fakeBotApi.ts";
import { workspaces } from "./workspaces.ts";

test("fake Telegram polling persists updates before advancing the offset and ignores duplicates", async () => {
  const botId = `fake-poll-${Date.now()}`;
  const api = new FakeTelegramBotApi();
  const adapter = new TelegramAdapter(botId, api);
  try {
    api.pushUpdate({ updateId: 10, payload: { message: "first" } });
    api.pushUpdate({ updateId: 11, payload: { message: "second" } });

    const first = await adapter.pollOnce();
    assert.equal(first.fetched, 2);
    assert.equal(first.saved, 2);
    assert.equal(first.nextOffset, 12);
    assert.equal(workspaces.telegramCursor(botId), 12);
    assert.deepEqual(workspaces.telegramInbox(botId).map(update => update.updateId), [10, 11]);

    workspaces.advanceTelegramCursor(botId, 10);
    const duplicate = await adapter.pollOnce();
    assert.equal(duplicate.fetched, 2);
    assert.equal(duplicate.saved, 0);
    assert.equal(workspaces.telegramCursor(botId), 12);
    assert.equal(workspaces.telegramInbox(botId).length, 2);
  } finally {
    workspaces.removeTelegramRecordsForBot(botId);
  }
});

test("fake Telegram outbox send failure is durable and retry can later mark sent", async () => {
  const botId = `fake-send-${Date.now()}`;
  const api = new FakeTelegramBotApi();
  const adapter = new TelegramAdapter(botId, api);
  try {
    const outboxId = workspaces.enqueueTelegramOutbox({
      botId,
      chatId: "chat-1",
      topicId: "topic-1",
      payload: { text: "question" },
    });

    api.failNextSend("fake timeout");
    assert.equal(await adapter.sendOutbox(outboxId), "FAILED");
    let row = workspaces.telegramOutbox().find(entry => entry.id === outboxId)!;
    assert.equal(row.state, "FAILED");
    assert.equal(row.attemptCount, 1);
    assert.equal(row.lastError, "fake timeout");

    assert.equal(await adapter.sendOutbox(outboxId), "SENT");
    row = workspaces.telegramOutbox().find(entry => entry.id === outboxId)!;
    assert.equal(row.state, "SENT");
    assert.equal(row.attemptCount, 2);
    assert.equal(api.sent.length, 1);
  } finally {
    workspaces.removeTelegramRecordsForBot(botId);
  }
});
