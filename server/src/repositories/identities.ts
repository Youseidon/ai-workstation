import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { UserIdentity } from "@hydra/shared";

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const derive = (password: string, salt: string): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
});

interface UserRow { id: string; username: string; password_hash: string; salt: string; owns_legacy_data: number }
const identity = (row: UserRow): UserIdentity => ({ id: row.id, username: row.username, ownsLegacyData: row.owns_legacy_data === 1 });

export class IdentityError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** The identity registry never opens or rewrites an orchestration database. */
export function openIdentityStore(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS identity_user (
      id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL, salt TEXT NOT NULL,
      owns_legacy_data INTEGER NOT NULL CHECK (owns_legacy_data IN (0,1))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS identity_one_legacy_owner ON identity_user(owns_legacy_data) WHERE owns_legacy_data=1;
    CREATE TABLE IF NOT EXISTS identity_session (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES identity_user(id), expires_at INTEGER NOT NULL
    );
  `);
  for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
  const users = () => (db.prepare("SELECT * FROM identity_user ORDER BY rowid").all() as UserRow[]).map(identity);
  const createSession = (user: UserIdentity) => {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + SESSION_MS;
    db.prepare("DELETE FROM identity_session WHERE expires_at<=?").run(Date.now());
    db.prepare("INSERT INTO identity_session VALUES (?,?,?)").run(digest(token), user.id, expiresAt);
    return { user, token, expiresAt };
  };
  return {
    users,
    async register(input: Record<string, unknown>) {
      const username = typeof input.username === "string" ? input.username.trim() : "";
      const password = typeof input.password === "string" ? input.password : "";
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/.test(username)) throw new IdentityError(422, "Use a username of 3–64 letters, numbers, dots, dashes or underscores.");
      if (password.length < 12 || password.length > 1024) throw new IdentityError(422, "Use a password of 12–1024 characters.");
      const salt = randomBytes(32).toString("hex");
      const hash = (await derive(password, salt)).toString("hex");
      const user = db.transaction(() => {
        if (db.prepare("SELECT 1 FROM identity_user WHERE username=?").get(username)) throw new IdentityError(409, "That username is already in use.");
        // Existing ownership is persisted; registration must never claim the
        // original database, even when the identity registry is empty.
        const result: UserIdentity = { id: randomUUID(), username, ownsLegacyData: false };
        db.prepare("INSERT INTO identity_user VALUES (?,?,?,?,0)").run(result.id, username, hash, salt);
        return result;
      })();
      return createSession(user);
    },
    async login(input: Record<string, unknown>) {
      const username = typeof input.username === "string" ? input.username.trim().slice(0, 64) : "";
      const password = typeof input.password === "string" && input.password.length <= 1024 ? input.password : "";
      const row = db.prepare("SELECT * FROM identity_user WHERE username=?").get(username) as UserRow | undefined;
      // A missing account still pays the same password hashing cost.
      const key = await derive(password, row?.salt ?? "hydra-invalid-account");
      if (row === undefined || !timingSafeEqual(key, Buffer.from(row.password_hash, "hex"))) throw new IdentityError(401, "Username or password is incorrect.");
      return createSession(identity(row));
    },
    authenticate(token: string) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const row = db.prepare(`SELECT u.*, s.expires_at FROM identity_session s JOIN identity_user u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(digest(token), Date.now()) as (UserRow & { expires_at: number }) | undefined;
      return row ? { user: identity(row), expiresAt: row.expires_at } : null;
    },
    logout(token: string) { db.prepare("DELETE FROM identity_session WHERE token_hash=?").run(digest(token)); },
    close() { db.close(); },
  };
}
