import assert from "node:assert/strict";
import test from "node:test";
import { FakeTelegramServer, type FakeBot, type FakeChat, type FakeUser } from "./fakes/telegramServer.ts";

test("S-TM0-03/04/05: group roster, administrator operations, one-use invites and broad delivery", async () => {
  const fake = new FakeTelegramServer();
  const botA: FakeBot = { id: 710_000_001, username: "bot_a", token: "a-token" };
  const botB: FakeBot = { id: 710_000_002, username: "bot_b", token: "b-token" };
  const userA: FakeUser = { id: 5_550_101, firstName: "A" };
  const userB: FakeUser = { id: 5_550_202, firstName: "B" };
  const group: FakeChat = { id: -100_555_000_333, type: "supergroup", title: "Team" };
  fake.addBot(botA);
  fake.addBot(botB);
  fake.addChatMember(group, userA);
  fake.addChatMember(group, userB);
  fake.addChatMember(group, botA, { administrator: true, canPinMessages: true, canInviteUsers: true });
  fake.addChatMember(group, botB, { administrator: true, canPinMessages: true, canInviteUsers: true });
  await fake.listen();
  try {
    const admin = await api(fake, botA, "getChatMember", { chat_id: group.id, user_id: botB.id });
    assert.equal(admin.status, "administrator");
    assert.equal(admin.can_pin_messages, true);
    assert.equal((await api(fake, botA, "getChatMember", { chat_id: group.id, user_id: userA.id })).status, "member");

    const sent = await api(fake, botA, "sendMessage", { chat_id: group.id, text: "Anchor" });
    assert.equal(await api(fake, botA, "pinChatMessage", { chat_id: group.id, message_id: sent.message_id }), true);
    assert.equal(fake.pinnedMessageId(group.id), sent.message_id);
    const invite = await api(fake, botA, "createChatInviteLink", { chat_id: group.id, member_limit: 1 });
    fake.removeChatMember(group.id, userB.id);
    await fake.joinChatByInvite(userB, String(invite.invite_link));
    await assert.rejects(() => fake.joinChatByInvite(userB, String(invite.invite_link)), /invite link expired/);

    fake.userSendsMessage(botA, userA, group, "/status");
    assert.equal((await api(fake, botA, "getUpdates", { timeout: 0 })).length, 1);
    assert.equal((await api(fake, botB, "getUpdates", { timeout: 0 })).length, 1);
  } finally {
    await fake.close();
  }
});

async function api(fake: FakeTelegramServer, bot: FakeBot, method: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${fake.url}/bot${bot.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json() as { ok: boolean; result?: unknown; description?: string };
  if (!payload.ok) throw new Error(payload.description);
  return payload.result;
}
