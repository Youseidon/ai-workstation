import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocket } from "ws";
import type { IdentitySession, ServerMessage, WorkspaceRecord } from "@hydra/shared";

test("accounts isolate stored data, guessed IDs, settings and live broadcasts while preserving legacy data", { timeout: 90_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hydra-identity-flow-"));
  const database = join(dir, "legacy.sqlite");
  const settings = join(dir, "legacy-settings.json");
  const workDirectory = join(dir, "project");
  mkdirSync(workDirectory);
  writeFileSync(settings, JSON.stringify({ "budget.maxSpendUsd": 42, ...Object.fromEntries(["claude", "codex", "cursor", "grok", "copilot", "kilocode"].map(id => [`${id}.bin`, "/missing/hydra-test-provider"])) }));
  const env = { ...process.env, HYDRA_DB: database, SETTINGS_FILE: settings, HYDRA_MODE: "serve", PORT: "0", HOST: "127.0.0.1", PATH: "/missing/hydra-test-bin", ALLOWED_ORIGINS: "http://localhost:3100" };
  const repository = fileURLToPath(new URL("../../src/repositories/workspaces.ts", import.meta.url));
  const identities = fileURLToPath(new URL("../../src/repositories/identities.ts", import.meta.url));
  const seed = `import {workspaces} from ${JSON.stringify(repository)};
    import {openIdentityStore} from ${JSON.stringify(identities)};
    import Database from 'better-sqlite3';
    const workspace=workspaces.create({name:'Original workspace',workDirectory:${JSON.stringify(workDirectory)}});
    workspaces.createPipeline({workspaceId:workspace.id,name:'Original pipeline'});
    workspaces.beginCustomExecuteRun({runId:'original-run',workspaceId:workspace.id,provider:'claude',model:null,tokenHash:'test',expiresAt:'2099-01-01',displayText:'Original private conversation',threadId:'original-thread'});
    workspaces.close();
    const store=openIdentityStore(${JSON.stringify(`${database}.identities.sqlite`)});
    const owner=await store.register({username:'owner',password:'valid test password'});
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
    const port = (ready[0] as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    assert.doesNotMatch(output, /setup code/i);
    const call = (path: string, cookie = "", method = "GET", input?: unknown, origin = "http://localhost:3100") => fetch(`${base}${path}`, {
      method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), "Content-Type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    for (const path of ["/api/workspaces", "/api/settings", "/api/sessions", "/api/operations", "/api/pipelines", "/api/report", "/api/providers"]) assert.equal((await call(path)).status, 401);
    assert.deepEqual(await (await call("/api/auth/session")).json(), { user: null });
    const registered = await call("/api/auth/login", "", "POST", { username: "owner", password: "valid test password" });
    assert.equal(registered.status, 200);
    const ownerCookie = registered.headers.get("set-cookie")?.split(";")[0];
    assert.ok(ownerCookie);
    assert.match(registered.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict/);
    assert.equal(((await registered.json()) as IdentitySession).user?.ownsLegacyData, true);
    const legacy = await (await call("/api/workspaces", ownerCookie)).json() as { workspaces: WorkspaceRecord[] };
    const original = legacy.workspaces[0]; assert.ok(original);
    assert.equal(original.name, "Original workspace");
    assert.match(JSON.stringify(await (await call("/api/pipelines", ownerCookie)).json()), /Original pipeline/);
    assert.match(JSON.stringify(await (await call("/api/sessions", ownerCookie)).json()), /Original private conversation/);
    const snapshot = await (await call("/api/settings", ownerCookie)).text();
    assert.match(snapshot, /"budget.maxSpendUsd"/);
    assert.match(snapshot, /"value":42/);
    const newAccount = await call("/api/auth/register", "", "POST", { username: "second", password: "another valid password" });
    assert.equal(newAccount.status, 200);
    assert.equal(((await newAccount.json()) as IdentitySession).user?.ownsLegacyData, false);
    const secondCookie = newAccount.headers.get("set-cookie")?.split(";")[0]; assert.ok(secondCookie);
    assert.deepEqual(await (await call("/api/workspaces", secondCookie)).json(), { workspaces: [] });
    assert.equal((await call(`/api/workspaces/${original.id}`, secondCookie)).status, 404);
    assert.equal((await call(`/api/workspaces/${original.id}`, secondCookie, "DELETE")).status, 404);
    assert.equal((await call("/api/sessions/original-run", secondCookie)).status, 404);
    assert.doesNotMatch(await (await call("/api/pipelines", secondCookie)).text(), /Original pipeline/);
    assert.doesNotMatch(await (await call("/api/sessions", secondCookie)).text(), /Original private conversation/);
    assert.doesNotMatch(await (await call("/api/settings", secondCookie)).text(), /"value":42/);
    assert.equal((await call(`/api/workspaces/${original.id}/threads/original-thread/history`, secondCookie)).status, 404);
    const secondDirectory = join(dir, "second-project"); mkdirSync(secondDirectory);
    const created = await call("/api/workspaces", secondCookie, "POST", { name: "Second private workspace", workDirectory: secondDirectory });
    assert.equal(created.status, 201);
    assert.doesNotMatch(await (await call("/api/workspaces", ownerCookie)).text(), /Second private workspace/);
    assert.doesNotMatch(await (await call(`/api/workspaces/${original.id}/threads`, secondCookie)).text(), /original-thread/);
    assert.equal((await call("/api/settings", secondCookie, "PUT", { "budget.maxSpendUsd": 37 })).status, 200);
    assert.match(await (await call("/api/settings", ownerCookie)).text(), /"value":42/);
    assert.match(await (await call("/api/settings", secondCookie)).text(), /"value":37/);
    assert.equal((await call("/api/settings", ownerCookie, "PUT", {}, "http://evil.example")).status, 403);
    assert.equal((await call("/api/settings", ownerCookie, "PUT", {}, "")).status, 403);

    const open = async (cookie: string) => {
      const messages: ServerMessage[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: "http://localhost:3100", headers: { Cookie: cookie } });
      opened.push(ws); ws.on("message", raw => messages.push(JSON.parse(String(raw)) as ServerMessage));
      await once(ws, "open");
      while (!messages.some(message => message.kind === "hello")) await once(ws, "message");
      return { ws, messages };
    };
    const ownerSocket = await open(ownerCookie);
    const secondSocket = await open(secondCookie);
    const secondCount = secondSocket.messages.length;
    const changed = once(ownerSocket.ws, "message");
    const updated = await call(`/api/workspaces/${original.id}`, ownerCookie, "PATCH", { description: "owner only update" });
    assert.equal(updated.status, 200);
    await changed;
    assert.equal(secondSocket.messages.length, secondCount, "another account receives no operations broadcast");
    const workerPort = /http\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1];
    assert.ok(workerPort);
    assert.equal((await fetch(`http://127.0.0.1:${workerPort}/api/workspaces`)).status, 401);
    const unauthorized = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: "http://localhost:3100" });
    opened.push(unauthorized);
    const [failure] = await once(unauthorized, "error");
    assert.match(String(failure), /401/);
    const closed = once(ownerSocket.ws, "close");
    assert.equal((await call("/api/auth/logout", ownerCookie, "POST", {})).status, 200);
    await closed;
    assert.equal((await call("/api/workspaces", ownerCookie)).status, 401);
    assert.equal((await call("/api/workspaces", secondCookie)).status, 200);
  } finally {
    for (const socket of opened) socket.terminate();
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill("SIGTERM"); await stopped; }
    rmSync(dir, { recursive: true, force: true });
  }
});
