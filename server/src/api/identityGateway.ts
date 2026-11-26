import { createServer, request, type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { createHash } from "node:crypto";
import { config } from "../config/config.ts";
import { configuredDatabasePath } from "../config/statePaths.ts";
import { createIdentityWorkers, type IdentityWorker } from "../infrastructure/identityWorkers.ts";
import { acquireInstanceLock } from "../infrastructure/instanceLock.ts";
import { IdentityError, openIdentityStore } from "../repositories/identities.ts";
import { createLogger } from "../utils/logger.ts";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const log = createLogger("identity");
const databasePath = configuredDatabasePath();
if (process.env.HYDRA_MODE !== "serve" && process.env.HYDRA_ALLOW_DEV_ON_LIVE !== "1" && !process.env.HYDRA_DB?.trim()) {
  throw new Error("Use npm run dev:sandbox to develop without opening live state.");
}
mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
const lock = acquireInstanceLock(`${databasePath}.identity.lock`);
const identities = openIdentityStore(`${databasePath}.identities.sqlite`);
const workers = createIdentityWorkers(databasePath);
const cookieName = `hydra.session.${createHash("sha256").update(databasePath).digest("hex").slice(0, 12)}`;
const sockets = new Map<string, Set<Duplex>>();
const attempts = new Map<string, { count: number; until: number }>();
let hashing = 0;

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
  // Do not pass identity cookies or user-supplied routing credentials into a runtime.
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
      const key = req.socket.remoteAddress ?? "local";
      const now = Date.now();
      for (const [address, value] of attempts) if (value.until <= now) attempts.delete(address);
      const attempt = attempts.get(key) ?? { count: 0, until: now + 15 * 60_000 };
      attempts.set(key, attempt);
      if (++attempt.count > 20 || hashing >= 4) throw new IdentityError(429, "Too many attempts. Try again later.");
      hashing++;
      try {
        const input = await body(req);
        const result = path.endsWith("register") ? await identities.register(input) : await identities.login(input);
        if (token) { identities.logout(token); for (const socket of sockets.get(token) ?? []) socket.destroy(); }
        setCookie(res, result.token);
        json(res, 200, { user: result.user });
      } finally { hashing--; }
      return;
    }
    if (path === "/api/auth/logout" && req.method === "POST") {
      identities.logout(token);
      for (const socket of sockets.get(token) ?? []) socket.destroy();
      setCookie(res, "");
      json(res, 200, { ok: true }); return;
    }
    if (!session) throw new IdentityError(401, "Sign in to use Hydra.");
    if (path.startsWith("/api/auth/")) throw new IdentityError(404, "Not found.");
    if (path.startsWith("/api/agent/")) throw new IdentityError(403, "Agent callbacks use their run-scoped endpoint.");
    // CLI installation changes affect the host, so only the original operator
    // can update shared executables through the app.
    if (/^\/api\/providers\/[^/]+\/update$/.test(path) && !session.user.ownsLegacyData) throw new IdentityError(403, "Only the installation owner can update provider executables.");
    const update = /^\/api\/providers\/([^/]+)\/update$/.exec(path);
    const provider = update?.[1];
    if (provider && provider !== "claude" && workers.providerInUse(provider)) throw new IdentityError(409, "This provider is running. Update it after its runs have finished.");
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
  // Resume all users' pipelines even before their next browser login.
  for (const user of identities.users()) void workers.get(user).catch(error => log.error(`could not restore account ${user.username}`, error));
  process.send?.({ port: (server.address() as { port: number }).port });
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  for (const active of sockets.values()) for (const socket of active) socket.destroy();
  await workers.close();
  identities.close(); lock.release();
  process.exit(0);
}
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
process.on("exit", () => lock.release());
server.on("error", error => { log.error("login gateway failed", error); void shutdown(); });
