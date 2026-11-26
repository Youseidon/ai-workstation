import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { openIdentityStore } from "../../src/repositories/identities.ts";

test("registration never claims existing data, credentials are hashed, and sessions survive restart and revoke", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hydra-identities-"));
  const path = join(dir, "identities.sqlite");
  let store = openIdentityStore(path);
  const password = "a strong test password";
  try {
    const results = await Promise.allSettled([
      store.register({ username: "first", password, ownsLegacyData: true }),
      store.register({ username: "second", password }),
    ]);
    const firstResult = results[0]; const secondResult = results[1];
    assert.ok(firstResult?.status === "fulfilled");
    assert.ok(secondResult?.status === "fulfilled");
    const first = firstResult.value; const second = secondResult.value;
    assert.equal(first.user.ownsLegacyData, false);
    assert.equal(second.user.ownsLegacyData, false);
    assert.equal(store.users().filter(user => user.ownsLegacyData).length, 0);
    await assert.rejects(store.register({ username: "SECOND", password }), /already in use/);
    await assert.rejects(store.login({ username: "missing", password }), /incorrect/);
    await assert.rejects(store.login({ username: "second", password: "wrong" }), /incorrect/);
    const login = await store.login({ username: "SECOND", password });
    assert.deepEqual(login.user, second.user);
    const raw = new Database(path);
    try {
      const rows = JSON.stringify(raw.prepare("SELECT * FROM identity_user").all());
      assert.equal(rows.includes(password), false);
      assert.equal(JSON.stringify(raw.prepare("SELECT * FROM identity_session").all()).includes(login.token), false);
      raw.prepare("UPDATE identity_session SET expires_at=0 WHERE user_id=?").run(second.user.id);
      assert.equal(store.authenticate(login.token), null);
    } finally { raw.close(); }
    store.close(); store = openIdentityStore(path);
    assert.equal(store.authenticate(first.token)?.user.id, first.user.id);
    assert.equal(store.authenticate("bad-token"), null);
    store.logout(first.token);
    assert.equal(store.authenticate(first.token), null);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("an existing owner's account and session keep their original data ownership after reopening", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hydra-existing-owner-"));
  const path = join(dir, "identities.sqlite");
  let store = openIdentityStore(path);
  const password = "existing owner password";
  try {
    const original = await store.register({ username: "owner", password });
    const fixture = new Database(path);
    try {
      fixture.prepare("UPDATE identity_user SET owns_legacy_data=1 WHERE id=?").run(original.user.id);
    } finally { fixture.close(); }
    store.close(); store = openIdentityStore(path);
    const session = store.authenticate(original.token);
    assert.equal(session?.user.id, original.user.id);
    assert.equal(session?.user.ownsLegacyData, true);
    const login = await store.login({ username: "owner", password });
    assert.deepEqual(login.user, session?.user);
    const additional = await store.register({ username: "additional", password, ownsLegacyData: true });
    assert.equal(additional.user.ownsLegacyData, false);
    assert.deepEqual(store.users().filter(user => user.ownsLegacyData), [login.user]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

async function withStore(run: (store: ReturnType<typeof openIdentityStore>, path: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "hydra-identity-recovery-"));
  const path = join(dir, "identities.sqlite");
  const store = openIdentityStore(path);
  try { await run(store, path); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("changing a password checks the current one and ends every session", async () => {
  await withStore(async store => {
    const first = await store.register({ username: "alice", password: "original password" });
    const second = await store.login({ username: "alice", password: "original password" });
    await assert.rejects(store.changePassword(first.user.id, { currentPassword: "wrong password!", newPassword: "replacement password" }), (error: Error & { status?: number }) => error.status === 403);
    await assert.rejects(store.changePassword(first.user.id, { currentPassword: "original password", newPassword: "short" }), /12–1024/);
    assert.ok(store.authenticate(first.token), "a refused change keeps sessions");
    const changed = await store.changePassword(first.user.id, { currentPassword: "original password", newPassword: "replacement password" });
    assert.equal(store.authenticate(first.token), null);
    assert.equal(store.authenticate(second.token), null);
    assert.equal(store.authenticate(changed.token)?.user.id, first.user.id);
    await assert.rejects(store.login({ username: "alice", password: "original password" }), /incorrect/);
    await store.login({ username: "alice", password: "replacement password" });
  });
});

test("an operator reset replaces the password and revokes sessions", async () => {
  await withStore(async store => {
    const session = await store.register({ username: "alice", password: "original password" });
    await assert.rejects(store.resetPassword("nobody", "replacement password"), /No account/);
    await assert.rejects(store.resetPassword("alice", "short"), /12–1024/);
    assert.equal((await store.resetPassword("ALICE", "replacement password")).username, "alice");
    assert.equal(store.authenticate(session.token), null);
    await store.login({ username: "alice", password: "replacement password" });
  });
});

test("reset codes need a linked Telegram chat and are single use, short lived and guess limited", async () => {
  await withStore(async (store, path) => {
    const alice = await store.register({ username: "alice", password: "original password" });
    await store.register({ username: "bob", password: "original password" });
    assert.equal(store.requestResetCode("alice"), null, "no bot configured");
    store.setTelegramBot({ token: "123456:abcdefghijklmnopqrstuvwxyz0123456789", botId: 123456, username: "hydra_bot" });
    assert.equal(store.requestResetCode("alice"), null, "no chat linked");
    const code = store.createTelegramLinkCode(alice.user.id);
    assert.equal(store.claimTelegramLink(code.code, { telegramUserId: 42, chatId: 42, telegramUsername: "alice_tg" })?.id, alice.user.id);
    assert.equal(store.requestResetCode("nobody"), null);
    const issued = store.requestResetCode("alice");
    assert.ok(issued);
    assert.equal(issued.chatId, 42);
    assert.match(issued.code, /^\d{8}$/);
    assert.equal(store.requestResetCode("alice"), null, "a second request within a minute keeps the first code");
    const raw = new Database(path);
    try { assert.equal(JSON.stringify(raw.prepare("SELECT * FROM identity_reset_code").all()).includes(issued.code), false); } finally { raw.close(); }
    const wrong = issued.code === "00000000" ? "11111111" : "00000000";
    await assert.rejects(store.resetWithCode({ username: "bob", code: issued.code, password: "replacement password" }), /invalid or has expired/);
    await assert.rejects(store.resetWithCode({ username: "alice", code: wrong, password: "replacement password" }), /invalid or has expired/);
    const session = await store.resetWithCode({ username: "alice", code: ` ${issued.code.slice(0, 4)} ${issued.code.slice(4)} `, password: "replacement password" });
    assert.equal(store.authenticate(alice.token), null);
    assert.equal(store.authenticate(session.token)?.user.id, alice.user.id);
    await assert.rejects(store.resetWithCode({ username: "alice", code: issued.code, password: "another password!!" }), /invalid or has expired/, "codes are single use");

    const fixture = new Database(path);
    try {
      fixture.prepare("DELETE FROM identity_reset_code").run();
      const again = store.requestResetCode("alice");
      assert.ok(again);
      const miss = again.code === "00000000" ? "11111111" : "00000000";
      for (let attempt = 0; attempt < 5; attempt++) await assert.rejects(store.resetWithCode({ username: "alice", code: miss, password: "replacement password" }));
      await assert.rejects(store.resetWithCode({ username: "alice", code: again.code, password: "replacement password" }), /invalid/, "five misses burn the code");
      fixture.prepare("DELETE FROM identity_reset_code").run();
      const expired = store.requestResetCode("alice");
      assert.ok(expired);
      fixture.prepare("UPDATE identity_reset_code SET expires_at=0").run();
      await assert.rejects(store.resetWithCode({ username: "alice", code: expired.code, password: "replacement password" }), /expired/);
    } finally { fixture.close(); }
  });
});

test("telegram links are claimed once, belong to one account each, and die with the bot", async () => {
  await withStore(async (store, path) => {
    const alice = await store.register({ username: "alice", password: "original password" });
    const bob = await store.register({ username: "bob", password: "original password" });
    store.setTelegramBot({ token: "123456:abcdefghijklmnopqrstuvwxyz0123456789", botId: 123456, username: "hydra_bot" });
    assert.equal(store.claimTelegramLink("not-a-code", { telegramUserId: 1, chatId: 1, telegramUsername: null }), null);
    const aliceCode = store.createTelegramLinkCode(alice.user.id);
    const replaced = store.createTelegramLinkCode(alice.user.id);
    assert.equal(store.claimTelegramLink(aliceCode.code, { telegramUserId: 7, chatId: 7, telegramUsername: null }), null, "a newer code replaces the older one");
    assert.equal(store.claimTelegramLink(replaced.code, { telegramUserId: 7, chatId: 7, telegramUsername: "a" })?.username, "alice");
    assert.equal(store.claimTelegramLink(replaced.code, { telegramUserId: 7, chatId: 7, telegramUsername: "a" }), null, "codes are single use");
    assert.equal(store.telegramLink(alice.user.id)?.access, "notify", "links start with notifications only");
    assert.throws(() => store.claimTelegramLink(store.createTelegramLinkCode(bob.user.id).code, { telegramUserId: 7, chatId: 7, telegramUsername: "a" }), /another Hydra account/);
    const expired = store.createTelegramLinkCode(bob.user.id);
    const fixture = new Database(path);
    try { fixture.prepare("UPDATE identity_telegram_code SET expires_at=0").run(); } finally { fixture.close(); }
    assert.equal(store.claimTelegramLink(expired.code, { telegramUserId: 8, chatId: 8, telegramUsername: null }), null);
    store.setTelegramAccess(alice.user.id, "control");
    assert.equal(store.telegramLinkFor(7)?.link.access, "control");
    assert.throws(() => store.setTelegramAccess(bob.user.id, "control"), /not connected/);
    store.setTelegramOffset(10); store.setTelegramOffset(4);
    assert.equal(store.telegramBot()?.updateOffset, 10, "the update offset never moves backwards");
    store.setTelegramBot({ token: "654321:abcdefghijklmnopqrstuvwxyz0123456789", botId: 654321, username: "other_bot" });
    assert.equal(store.telegramLink(alice.user.id), null, "a new bot revokes every link");
    assert.equal(store.telegramBot()?.updateOffset, 0);
    store.setTelegramBot(null);
    assert.equal(store.telegramBot(), null);
  });
});

test("the telegram audit keeps the newest entries per account", async () => {
  await withStore(async store => {
    const alice = await store.register({ username: "alice", password: "original password" });
    for (let index = 0; index < 205; index++) store.audit(alice.user.id, "play", `entry ${index}`);
    const entries = store.auditLog(alice.user.id, 500);
    assert.equal(entries.length, 200);
    assert.equal(entries[0]?.detail, "entry 204");
  });
});
