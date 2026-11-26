import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocket } from "ws";
import type { IdentitySession, TelegramAccountView } from "@hydra/shared";
import type { RemoteOverview } from "../../src/contracts/remote.ts";

test("passwords change and reset through the gateway, the shell reset works, and Telegram routes are owner- and session-scoped", { timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hydra-account-recovery-"));
  const database = join(dir, "legacy.sqlite");
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify(Object.fromEntries(["claude", "codex", "cursor", "grok", "copilot", "kilocode"].map(id => [`${id}.bin`, "/missing/hydra-test-provider"]))));
  const env = { ...process.env, HYDRA_DB: database, SETTINGS_FILE: settings, HYDRA_MODE: "serve", PORT: "0", HOST: "127.0.0.1", PATH: "/missing/hydra-test-bin", ALLOWED_ORIGINS: "http://localhost:3100" };
  const identities = fileURLToPath(new URL("../../src/repositories/identities.ts", import.meta.url));
  const seed = `import {openIdentityStore} from ${JSON.stringify(identities)};
    import Database from 'better-sqlite3';
    const store=openIdentityStore(${JSON.stringify(`${database}.identities.sqlite`)});
    const owner=await store.register({username:'owner',password:'owner password 1'});
    await store.register({username:'second',password:'second password 1'});
    store.close();
    const registry=new Database(${JSON.stringify(`${database}.identities.sqlite`)});
    registry.prepare('UPDATE identity_user SET owns_legacy_data=1 WHERE id=?').run(owner.user.id);
    registry.close();`;
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", seed], { env, stdio: "pipe" });
  const child = fork(fileURLToPath(new URL("../../src/index.ts", import.meta.url)), [], { env, execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  child.stdout?.on("data", chunk => { output += String(chunk); });
  child.stderr?.on("data", chunk => { output += String(chunk); });
  const opened: WebSocket[] = [];
  try {
    const ready = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => { throw new Error(`Gateway exited: ${output}`); }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error(`Gateway startup timeout: ${output}`)), 15_000); timer.unref(); }),
    ]);
    const base = `http://127.0.0.1:${(ready[0] as { port: number }).port}`;
    const call = (path: string, cookie = "", method = "GET", input?: unknown) => fetch(`${base}${path}`, {
      method, headers: { Origin: "http://localhost:3100", ...(cookie ? { Cookie: cookie } : {}), "Content-Type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const login = async (username: string, password: string) => {
      const response = await call("/api/auth/login", "", "POST", { username, password });
      assert.equal(response.status, 200, `${username} signs in`);
      const cookie = response.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie);
      return cookie;
    };

    assert.deepEqual(await (await call("/api/auth/recovery")).json(), { telegram: false });
    for (const username of ["owner", "nobody"]) {
      const response = await call("/api/auth/recovery/request", "", "POST", { username });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    }
    assert.equal((await call("/api/auth/recovery/reset", "", "POST", { username: "owner", code: "12345678", password: "a brand new password" })).status, 400);
    assert.equal((await call("/api/auth/telegram")).status, 401);

    const owner = await login("owner", "owner password 1");
    const second = await login("second", "second password 1");
    const ownerOther = await login("owner", "owner password 1");
    const ownerSocket = new WebSocket(`ws://127.0.0.1:${(ready[0] as { port: number }).port}/ws`, { origin: "http://localhost:3100", headers: { Cookie: ownerOther } });
    opened.push(ownerSocket);
    await once(ownerSocket, "open");

    const view = await (await call("/api/auth/telegram", owner)).json() as TelegramAccountView;
    assert.deepEqual(view, { isOwner: true, bot: null, link: null });
    assert.equal(((await (await call("/api/auth/telegram", second)).json()) as TelegramAccountView).isOwner, false);
    assert.equal((await call("/api/auth/telegram/bot", second, "PUT", { token: "123456:abcdefghijklmnopqrstuvwxyz0123456789" })).status, 403, "only the owner sets up the bot");
    assert.equal((await call("/api/auth/telegram/bot", owner, "PUT", { token: "not a token" })).status, 422);
    assert.equal((await call("/api/auth/telegram/link", owner, "POST", {})).status, 409, "no link before a bot exists");
    assert.equal((await call("/api/auth/telegram/link", owner, "PATCH", { access: "control" })).status, 404);
    assert.equal((await call("/api/auth/telegram/link", owner, "PATCH", { access: "root" })).status, 422);
    assert.deepEqual(await (await call("/api/auth/telegram/audit", owner)).json(), { entries: [] });

    const overview = await (await call("/api/remote/overview", second)).json() as RemoteOverview;
    assert.deepEqual(overview, { runs: [], pipelines: [], gates: [] });

    const wrong = await call("/api/auth/password", owner, "POST", { currentPassword: "not the password", newPassword: "owner password 2" });
    assert.equal(wrong.status, 403, "a wrong current password is not a 401, which would sign the tab out");
    const closed = once(ownerSocket, "close");
    const changed = await call("/api/auth/password", owner, "POST", { currentPassword: "owner password 1", newPassword: "owner password 2" });
    assert.equal(changed.status, 200);
    assert.equal(((await changed.json()) as IdentitySession).user?.username, "owner");
    const renewed = changed.headers.get("set-cookie")?.split(";")[0];
    assert.ok(renewed);
    await closed;
    assert.equal((await call("/api/workspaces", owner)).status, 401, "the session that changed it is replaced");
    assert.equal((await call("/api/workspaces", ownerOther)).status, 401, "other sessions are signed out");
    assert.equal((await call("/api/workspaces", renewed)).status, 200);
    assert.equal((await call("/api/workspaces", second)).status, 200, "other accounts are untouched");

    const script = fileURLToPath(new URL("../../../scripts/reset-password.mjs", import.meta.url));
    const result = execFileSync(process.execPath, ["--import", "tsx", script, "second"], { env, input: "shell set password\nshell set password\n", encoding: "utf8" });
    assert.match(result, /Password for second changed/);
    assert.equal((await call("/api/workspaces", second)).status, 401);
    assert.equal((await call("/api/auth/login", "", "POST", { username: "second", password: "second password 1" })).status, 401);
    await login("second", "shell set password");
    assert.throws(() => execFileSync(process.execPath, ["--import", "tsx", script, "second"], { env, input: "one password here\nanother password\n", stdio: "pipe" }), /do not match/);
  } finally {
    for (const socket of opened) socket.terminate();
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped; }
    rmSync(dir, { recursive: true, force: true });
  }
});
