import { createServer, request, type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { createHash } from "node:crypto";
import { config } from "../config/config.ts";
import { configuredDatabasePath } from "../config/statePaths.ts";
import { accountStateDirectory, createIdentityWorkers, type IdentityWorker } from "../infrastructure/identityWorkers.ts";
import { demoEnabled, demoLifetimeHours, removeDemoFolder } from "../config/demo.ts";
import { acquireInstanceLock } from "../infrastructure/instanceLock.ts";
import { IdentityError, openIdentityStore } from "../repositories/identities.ts";
import { createLogger } from "../utils/logger.ts";
import { createTelegramBot, type RuntimeCaller } from "../services/telegram/telegramBot.ts";
import type { DemoSeedProgress, TelegramAccountView, UserIdentity } from "@hydra/shared";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

const log = createLogger("identity");
const databasePath = configuredDatabasePath();
if (process.env.HYDRA_MODE !== "serve" && process.env.HYDRA_ALLOW_DEV_ON_LIVE !== "1" && !process.env.HYDRA_DB?.trim()) {
  throw new Error("Use npm run dev:sandbox to develop without opening live state.");
}
mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
const lock = acquireInstanceLock(`${databasePath}.identity.lock`);
const identities = openIdentityStore(`${databasePath}.identities.sqlite`);
const workers = createIdentityWorkers(databasePath, { onNotice: (user, notice) => telegram.notify(user, notice) });
const cookieName = `hydra.session.${createHash("sha256").update(databasePath).digest("hex").slice(0, 12)}`;
const sockets = new Map<string, Set<Duplex>>();
const attempts = new Map<string, { count: number; until: number }>();
let hashing = 0;

const runtime: RuntimeCaller = {
  async call(user, method, path, input) {
    const worker = await workers.get(user);
    const response = await fetch(`http://127.0.0.1:${worker.port}${path}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { "x-hydra-worker": worker.secret, ...(input ? { "Content-Type": "application/json" } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: response.status, body: parsed };
  },
};
const telegram = createTelegramBot({ identities, runtime, log: createLogger("telegram"), enabled: process.env.HYDRA_MODE === "serve" });

function sweepSockets(): void {
  for (const [token, active] of sockets) if (!identities.authenticate(token)) for (const socket of active) socket.destroy();
}
setInterval(sweepSockets, 30_000).unref();

let demosBeingMade = 0;
const DEMO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Deletes demo accounts past their expiry: sessions, runtime, private state and sample folder. */
async function sweepDemos(): Promise<void> {
  for (const user of identities.expiredDemos()) {
    try {
      identities.deleteDemo(user.id);
      sweepSockets();
      await workers.stop(user.id);
      const state = accountStateDirectory(databasePath, user.id);
      if (DEMO_UUID.test(user.id) && existsSync(state)) rmSync(state, { recursive: true, force: true });
      removeDemoFolder(user.username);
      log.info(`removed expired demo account ${user.username}`);
    } catch (error) { log.error(`could not remove demo account ${user.username}`, error); }
  }
}
setInterval(() => { void sweepDemos(); }, 10 * 60_000).unref();

/**
 * Creates a demo account and streams its preparation as NDJSON. The session
 * cookie goes out with the headers, before the seeding finishes, so a reload
 * mid-way still lands in the (partially filled) demo rather than nowhere.
 */
async function createDemo(res: ServerResponse, previousToken: string): Promise<void> {
  if (!demoEnabled()) throw new IdentityError(404, "The demo is turned off on this installation.");
  if (demosBeingMade >= 2) throw new IdentityError(429, "Another demo is being prepared. Try again in a moment.");
  demosBeingMade++;
  try {
    const created = await hashed(() => identities.createDemo(demoLifetimeHours() * 60 * 60_000));
    if (previousToken) { identities.logout(previousToken); for (const socket of sockets.get(previousToken) ?? []) socket.destroy(); }
    setCookie(res, created.token);
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
    const write = (line: DemoSeedProgress) => { if (!res.writableEnded) res.write(`${JSON.stringify(line)}\n`); };
    write({ step: "account", state: "done", detail: created.user.username });
    write({ step: "runtime", state: "active", detail: "Starting a private runtime" });
    const worker = await workers.get(created.user);
    write({ step: "runtime", state: "done", detail: "Private runtime is up" });
    const upstream = await fetch(`http://127.0.0.1:${worker.port}/api/demo/seed`, {
      method: "POST", signal: AbortSignal.timeout(120_000),
      headers: { "x-hydra-worker": worker.secret, "Content-Type": "application/json" },
      body: JSON.stringify({ username: created.user.username }),
    });
    if (!upstream.ok || !upstream.body) throw new Error(`seed request answered ${upstream.status}`);
    for await (const chunk of upstream.body) res.write(chunk);
  } catch (error) {
    if (!res.headersSent) throw error;
    log.error("demo preparation failed", error);
    res.write(`${JSON.stringify({ step: "ready", state: "error", detail: "The demo could not be prepared." } satisfies DemoSeedProgress)}\n`);
  } finally {
    demosBeingMade--;
    if (res.headersSent) res.end();
  }
}

function limitAttempt(req: IncomingMessage): void {
  const key = req.socket.remoteAddress ?? "local";
  const now = Date.now();
  for (const [address, value] of attempts) if (value.until <= now) attempts.delete(address);
  const attempt = attempts.get(key) ?? { count: 0, until: now + 15 * 60_000 };
  attempts.set(key, attempt);
  if (++attempt.count > 20 || hashing >= 4) throw new IdentityError(429, "Too many attempts. Try again later.");
}

async function hashed<T>(work: () => Promise<T>): Promise<T> {
  hashing++;
  try { return await work(); } finally { hashing--; }
}

function telegramView(user: UserIdentity): TelegramAccountView {
  const link = identities.telegramLink(user.id);
  return {
    isOwner: user.ownsLegacyData,
    bot: telegram.status(),
    link: link ? { telegramUsername: link.telegramUsername, access: link.access, linkedAt: link.linkedAt } : null,
  };
}

const PASSWORD_CHANGED = "🔐 Your Hydra password was just changed and every other session was signed out. If this was not you, reset it from the machine running Hydra: <code>npm run reset-password -- &lt;username&gt;</code>";

function tokenFrom(req: IncomingMessage): string {
  const cookie = req.headers.cookie?.split(";").map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`));
  return cookie?.slice(cookieName.length + 1) ?? "";
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  req.setTimeout(10_000, () => req.destroy());
  let raw = "";
  for await (const chunk of req) {
    raw += String(chunk);
    if (Buffer.byteLength(raw) > 8192) throw new IdentityError(413, "Request is too large.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new IdentityError(400, "Expected a JSON object."); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new IdentityError(400, "Expected a JSON object.");
  return parsed as Record<string, unknown>;
}

function setCookie(res: ServerResponse, token: string): void {
  const secure = process.env.HYDRA_SECURE_COOKIES === "1";
  res.setHeader("Set-Cookie", `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? 604800 : 0}${secure ? "; Secure" : ""}`);
}

function workerHeaders(req: IncomingMessage, worker: IdentityWorker): OutgoingHttpHeaders {
  const { cookie: _cookie, "x-hydra-worker": _secret, ...headers } = req.headers;
  return { ...headers, host: `127.0.0.1:${worker.port}`, "x-hydra-worker": worker.secret };
}

function permittedOrigin(req: IncomingMessage): boolean {
  return req.headers.origin !== undefined && config.allowedOrigins.includes(req.headers.origin);
}

const server = createServer((req, res) => {
  void (async () => {
    const origin = req.headers.origin;
    if (origin && !permittedOrigin(req)) throw new IdentityError(403, "Origin is not allowed.");
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method !== "GET" && req.method !== "HEAD" && !permittedOrigin(req)) throw new IdentityError(403, "A trusted browser origin is required.");
    if (path === "/api/health") { json(res, 200, { ok: true }); return; }
    const token = tokenFrom(req);
    const session = identities.authenticate(token);
    if (path === "/api/auth/session" && req.method === "GET") {
      json(res, 200, { user: session?.user ?? null }); return;
    }
    if ((path === "/api/auth/login" || path === "/api/auth/register") && req.method === "POST") {
      limitAttempt(req);
      await hashed(async () => {
        const input = await body(req);
        const result = path.endsWith("register") ? await identities.register(input) : await identities.login(input);
        if (token) { identities.logout(token); for (const socket of sockets.get(token) ?? []) socket.destroy(); }
        setCookie(res, result.token);
        json(res, 200, { user: result.user });
      });
      return;
    }
    if (path === "/api/auth/demo" && req.method === "GET") {
      json(res, 200, { available: demoEnabled(), lifetimeHours: demoLifetimeHours() }); return;
    }
    if (path === "/api/auth/demo" && req.method === "POST") {
      limitAttempt(req);
      await createDemo(res, token);
      return;
    }
    if (path === "/api/auth/recovery" && req.method === "GET") {
      json(res, 200, { telegram: telegram.status() !== null }); return;
    }
    if (path === "/api/auth/recovery/request" && req.method === "POST") {
      limitAttempt(req);
      const issued = identities.requestResetCode((await body(req)).username);
      if (issued) {
        identities.audit(issued.user.id, "reset_requested", "password reset code sent");
        void telegram.sendToChat(issued.chatId, `🔑 Your Hydra password reset code is <code>${issued.code}</code>\n\nIt expires in 10 minutes. If you did not ask for it, ignore this message: your password stays the same.`);
      }
      json(res, 200, { ok: true }); return;
    }
    if (path === "/api/auth/recovery/reset" && req.method === "POST") {
      limitAttempt(req);
      await hashed(async () => {
        const result = await identities.resetWithCode(await body(req));
        sweepSockets();
        if (token) identities.logout(token);
        identities.audit(result.user.id, "password_reset", "password reset with a Telegram code");
        void telegram.sendToUser(result.user.id, PASSWORD_CHANGED);
        setCookie(res, result.token);
        json(res, 200, { user: result.user });
      });
      return;
    }
    if (path === "/api/auth/logout" && req.method === "POST") {
      identities.logout(token);
      for (const socket of sockets.get(token) ?? []) socket.destroy();
      setCookie(res, "");
      json(res, 200, { ok: true }); return;
    }
    if (!session) throw new IdentityError(401, "Sign in to use Hydra.");
    if (path === "/api/auth/password" && req.method === "POST") {
      limitAttempt(req);
      await hashed(async () => {
        const result = await identities.changePassword(session.user.id, await body(req));
        sweepSockets();
        void telegram.sendToUser(session.user.id, PASSWORD_CHANGED);
        setCookie(res, result.token);
        json(res, 200, { user: result.user });
      });
      return;
    }
    if (path === "/api/auth/telegram" && req.method === "GET") { json(res, 200, telegramView(session.user)); return; }
    if (path === "/api/auth/telegram/audit" && req.method === "GET") { json(res, 200, { entries: identities.auditLog(session.user.id) }); return; }
    if (path === "/api/auth/telegram/bot" && (req.method === "PUT" || req.method === "DELETE")) {
      if (!session.user.ownsLegacyData) throw new IdentityError(403, "Only the installation owner can set up the Telegram bot.");
      if (req.method === "DELETE") await telegram.configure(null);
      else {
        const input = await body(req);
        if (typeof input.token !== "string" || input.token.trim() === "") throw new IdentityError(422, "Paste the bot token from @BotFather.");
        await telegram.configure(input.token);
      }
      json(res, 200, telegramView(session.user)); return;
    }
    if (path.startsWith("/api/auth/telegram") && req.method !== "GET" && session.user.demo === true) throw new IdentityError(403, "Demo accounts cannot connect Telegram.");
    if (path === "/api/auth/telegram/link" && req.method === "POST") {
      const code = identities.telegramBot() ? identities.createTelegramLinkCode(session.user.id) : null;
      const url = code ? telegram.linkUrl(code.code) : null;
      if (code === null || url === null) throw new IdentityError(409, "Telegram is not set up on this installation yet.");
      json(res, 200, { url, code: code.code, expiresAt: new Date(code.expiresAt).toISOString() }); return;
    }
    if (path === "/api/auth/telegram/link" && req.method === "PATCH") {
      const access = (await body(req)).access;
      if (access !== "notify" && access !== "control") throw new IdentityError(422, "Choose notifications only or full control.");
      identities.setTelegramAccess(session.user.id, access);
      identities.audit(session.user.id, "access_changed", access === "control" ? "full control allowed" : "notifications only");
      void telegram.sendToUser(session.user.id, access === "control"
        ? "🔓 Full control is now allowed from this chat: it can start and stop agents and answer questions. Turn it off on Hydra's Account page."
        : "🔒 This chat is now notifications only.");
      json(res, 200, telegramView(session.user)); return;
    }
    if (path === "/api/auth/telegram/link" && req.method === "DELETE") {
      const link = identities.telegramLink(session.user.id);
      identities.unlinkTelegram(session.user.id);
      if (link) {
        identities.audit(session.user.id, "unlinked", "Telegram disconnected");
        void telegram.sendToChat(link.chatId, "Disconnected from Hydra. This chat no longer receives notices or controls anything.");
      }
      json(res, 200, telegramView(session.user)); return;
    }
    if (path.startsWith("/api/auth/")) throw new IdentityError(404, "Not found.");
    if (path.startsWith("/api/agent/")) throw new IdentityError(403, "Agent callbacks use their run-scoped endpoint.");
    // Seeding is the gateway's own call to a demo runtime, never a browser's.
    if (path.startsWith("/api/demo/")) throw new IdentityError(404, "Not found.");
    if (/^\/api\/providers\/[^/]+\/(?:update|install)$/.test(path) && !session.user.ownsLegacyData) throw new IdentityError(403, "Only the installation owner can install or update provider executables.");
    const update = /^\/api\/providers\/([^/]+)\/(?:update|install)$/.exec(path);
    const provider = update?.[1];
    if (provider && provider !== "claude" && workers.providerInUse(provider)) throw new IdentityError(409, "This provider is running. Install or update it after its runs have finished.");
    const worker = await workers.get(session.user);
    if (!identities.authenticate(token)) throw new IdentityError(401, "Session expired. Sign in again.");
    const upstream = request({ host: "127.0.0.1", port: worker.port, path: req.url, method: req.method, headers: workerHeaders(req, worker) }, response => {
      const { "set-cookie": _cookie, ...headers } = response.headers;
      res.writeHead(response.statusCode ?? 502, { ...headers, "Cache-Control": "no-store" });
      response.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) json(res, 502, { error: { message: "Account runtime is unavailable." } }); else res.destroy(); });
    req.on("aborted", () => upstream.destroy());
    req.pipe(upstream);
  })().catch((error: unknown) => {
    if (res.headersSent || res.destroyed) return;
    const status = error instanceof IdentityError ? error.status : 503;
    if (!(error instanceof IdentityError)) log.error("identity request failed", error);
    json(res, status, { error: { message: error instanceof IdentityError ? error.message : "Account runtime is unavailable." } });
  });
});

server.on("upgrade", (req, socket, head) => {
  void (async () => {
    if (req.url !== "/ws" || !permittedOrigin(req)) throw new IdentityError(403, "Forbidden");
    const token = tokenFrom(req);
    const session = identities.authenticate(token);
    if (!session) throw new IdentityError(401, "Unauthorized");
    const worker = await workers.get(session.user);
    if (socket.destroyed) return;
    if (!identities.authenticate(token)) throw new IdentityError(401, "Unauthorized");
    const active = sockets.get(token) ?? new Set<Duplex>();
    active.add(socket); sockets.set(token, active);
    const expiry = setTimeout(() => socket.destroy(), Math.max(1, session.expiresAt - Date.now()));
    const upstream = connect(worker.port, "127.0.0.1", () => {
      const headers = workerHeaders(req, worker);
      const lines = Object.entries(headers).filter(([, value]) => value !== undefined).map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
      upstream.write(`GET /ws HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.once("close", () => { clearTimeout(expiry); upstream.destroy(); active.delete(socket); if (!active.size) sockets.delete(token); });
  })().catch((error: unknown) => {
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${error instanceof IdentityError ? error.status : 503} Unauthorized\r\nConnection: close\r\n\r\n`);
  });
});

server.listen(config.port, config.host, () => {
  log.info(`login gateway http://${config.host}:${(server.address() as { port: number }).port}`);
  void telegram.start().catch(error => log.error("telegram bot did not start", error));
  void sweepDemos().finally(() => {
    for (const user of identities.users()) void workers.get(user).catch(error => log.error(`could not restore account ${user.username}`, error));
  });
  process.send?.({ port: (server.address() as { port: number }).port });
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  for (const active of sockets.values()) for (const socket of active) socket.destroy();
  await telegram.stop();
  await workers.close();
  identities.close(); lock.release();
  process.exit(0);
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
process.on("exit", () => lock.release());
server.on("error", error => { log.error("login gateway failed", error); void shutdown(); });
