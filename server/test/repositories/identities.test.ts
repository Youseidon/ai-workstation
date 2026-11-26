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
      // Reproduce the persisted owner created before bootstrap removal.
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
