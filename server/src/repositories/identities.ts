import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { TelegramAccess, TelegramAuditEntry, UserIdentity } from "@hydra/shared";

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const TELEGRAM_LINK_MS = 10 * 60 * 1000;
const RESET_CODE_MS = 10 * 60 * 1000;
const RESET_CODE_ATTEMPTS = 5;
const RESET_CODE_RESEND_MS = 60 * 1000;
const AUDIT_KEEP = 200;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const derive = (password: string, salt: string): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
});
const sameDigest = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

interface UserRow { id: string; username: string; password_hash: string; salt: string; owns_legacy_data: number }
interface LinkRow { user_id: string; telegram_user_id: number; chat_id: number; telegram_username: string | null; access: TelegramAccess; linked_at: number }
interface BotRow { token: string; bot_id: number; username: string; update_offset: number }
const identity = (row: UserRow): UserIdentity => ({ id: row.id, username: row.username, ownsLegacyData: row.owns_legacy_data === 1 });

export interface TelegramLink { userId: string; telegramUserId: number; chatId: number; telegramUsername: string | null; access: TelegramAccess; linkedAt: string }
export interface TelegramBotRecord { token: string; botId: number; username: string; updateOffset: number }
const link = (row: LinkRow): TelegramLink => ({ userId: row.user_id, telegramUserId: row.telegram_user_id, chatId: row.chat_id, telegramUsername: row.telegram_username, access: row.access, linkedAt: new Date(row.linked_at).toISOString() });

export class IdentityError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function requirePassword(value: unknown): string {
  const password = typeof value === "string" ? value : "";
  if (password.length < 12 || password.length > 1024) throw new IdentityError(422, "Use a password of 12–1024 characters.");
  return password;
}

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
    CREATE TABLE IF NOT EXISTS identity_telegram_bot (
      id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, bot_id INTEGER NOT NULL, username TEXT NOT NULL,
      update_offset INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS identity_telegram_link (
      user_id TEXT PRIMARY KEY REFERENCES identity_user(id) ON DELETE CASCADE,
      telegram_user_id INTEGER NOT NULL UNIQUE, chat_id INTEGER NOT NULL, telegram_username TEXT,
      access TEXT NOT NULL CHECK (access IN ('notify','control')), linked_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS identity_telegram_code (
      code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES identity_user(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS identity_reset_code (
      user_id TEXT PRIMARY KEY REFERENCES identity_user(id) ON DELETE CASCADE, code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS identity_telegram_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES identity_user(id) ON DELETE CASCADE,
      at INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL
    );
  `);
  for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
  const users = () => (db.prepare("SELECT * FROM identity_user ORDER BY rowid").all() as UserRow[]).map(identity);
  const userByName = (value: unknown) => {
    const username = typeof value === "string" ? value.trim().slice(0, 64) : "";
    return db.prepare("SELECT * FROM identity_user WHERE username=?").get(username) as UserRow | undefined;
  };
  const createSession = (user: UserIdentity) => {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + SESSION_MS;
    db.prepare("DELETE FROM identity_session WHERE expires_at<=?").run(Date.now());
    db.prepare("INSERT INTO identity_session VALUES (?,?,?)").run(digest(token), user.id, expiresAt);
    return { user, token, expiresAt };
  };
  const replacePassword = async (userId: string, password: string) => {
    const salt = randomBytes(32).toString("hex");
    const hash = (await derive(password, salt)).toString("hex");
    db.transaction(() => {
      db.prepare("UPDATE identity_user SET password_hash=?, salt=? WHERE id=?").run(hash, salt, userId);
      db.prepare("DELETE FROM identity_session WHERE user_id=?").run(userId);
      db.prepare("DELETE FROM identity_reset_code WHERE user_id=?").run(userId);
    })();
  };
  const verifyPassword = async (row: UserRow | undefined, value: unknown) => {
    const password = typeof value === "string" && value.length <= 1024 ? value : "";
    const key = await derive(password, row?.salt ?? "hydra-invalid-account");
    return row !== undefined && timingSafeEqual(key, Buffer.from(row.password_hash, "hex"));
  };
  return {
    users,
    async register(input: Record<string, unknown>) {
      const username = typeof input.username === "string" ? input.username.trim() : "";
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,63}$/.test(username)) throw new IdentityError(422, "Use a username of 3–64 letters, numbers, dots, dashes or underscores.");
      const password = requirePassword(input.password);
      const salt = randomBytes(32).toString("hex");
      const hash = (await derive(password, salt)).toString("hex");
      const user = db.transaction(() => {
        if (db.prepare("SELECT 1 FROM identity_user WHERE username=?").get(username)) throw new IdentityError(409, "That username is already in use.");
        const result: UserIdentity = { id: randomUUID(), username, ownsLegacyData: false };
        db.prepare("INSERT INTO identity_user VALUES (?,?,?,?,0)").run(result.id, username, hash, salt);
        return result;
      })();
      return createSession(user);
    },
    async login(input: Record<string, unknown>) {
      const row = userByName(input.username);
      if (!await verifyPassword(row, input.password) || row === undefined) throw new IdentityError(401, "Username or password is incorrect.");
      return createSession(identity(row));
    },
    authenticate(token: string) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const row = db.prepare(`SELECT u.*, s.expires_at FROM identity_session s JOIN identity_user u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(digest(token), Date.now()) as (UserRow & { expires_at: number }) | undefined;
      return row ? { user: identity(row), expiresAt: row.expires_at } : null;
    },
    logout(token: string) { db.prepare("DELETE FROM identity_session WHERE token_hash=?").run(digest(token)); },

    async changePassword(userId: string, input: Record<string, unknown>) {
      const row = db.prepare("SELECT * FROM identity_user WHERE id=?").get(userId) as UserRow | undefined;
      const password = requirePassword(input.newPassword);
      if (!await verifyPassword(row, input.currentPassword) || row === undefined) throw new IdentityError(403, "Current password is incorrect.");
      await replacePassword(row.id, password);
      return createSession(identity(row));
    },
    async resetPassword(username: string, password: string): Promise<UserIdentity> {
      const row = userByName(username);
      if (row === undefined) throw new IdentityError(404, `No account is named ${username}.`);
      await replacePassword(row.id, requirePassword(password));
      return identity(row);
    },
    requestResetCode(username: unknown): { user: UserIdentity; chatId: number; code: string } | null {
      const row = userByName(username);
      if (row === undefined || !db.prepare("SELECT 1 FROM identity_telegram_bot").get()) return null;
      const linked = db.prepare("SELECT * FROM identity_telegram_link WHERE user_id=?").get(row.id) as LinkRow | undefined;
      if (linked === undefined) return null;
      const now = Date.now();
      const existing = db.prepare("SELECT expires_at FROM identity_reset_code WHERE user_id=?").get(row.id) as { expires_at: number } | undefined;
      if (existing && existing.expires_at - RESET_CODE_MS + RESET_CODE_RESEND_MS > now) return null;
      const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
      db.prepare("INSERT OR REPLACE INTO identity_reset_code VALUES (?,?,?,0)").run(row.id, digest(code), now + RESET_CODE_MS);
      return { user: identity(row), chatId: linked.chat_id, code };
    },
    async resetWithCode(input: Record<string, unknown>) {
      const row = userByName(input.username);
      const password = requirePassword(input.password);
      const code = typeof input.code === "string" ? input.code.replace(/\s+/g, "") : "";
      const invalid = new IdentityError(400, "That code is invalid or has expired. Request a new one.");
      if (row === undefined) throw invalid;
      const accepted = db.transaction(() => {
        const reset = db.prepare("SELECT * FROM identity_reset_code WHERE user_id=?").get(row.id) as { code_hash: string; expires_at: number; attempts: number } | undefined;
        if (reset === undefined) return false;
        if (reset.expires_at <= Date.now() || reset.attempts >= RESET_CODE_ATTEMPTS) {
          db.prepare("DELETE FROM identity_reset_code WHERE user_id=?").run(row.id);
          return false;
        }
        if (!/^\d{8}$/.test(code) || !sameDigest(digest(code), reset.code_hash)) {
          db.prepare("UPDATE identity_reset_code SET attempts=attempts+1 WHERE user_id=?").run(row.id);
          return false;
        }
        db.prepare("DELETE FROM identity_reset_code WHERE user_id=?").run(row.id);
        return true;
      })();
      if (!accepted) throw invalid;
      await replacePassword(row.id, password);
      return createSession(identity(row));
    },

    telegramBot(): TelegramBotRecord | null {
      const row = db.prepare("SELECT token, bot_id, username, update_offset FROM identity_telegram_bot").get() as BotRow | undefined;
      return row ? { token: row.token, botId: row.bot_id, username: row.username, updateOffset: row.update_offset } : null;
    },
    setTelegramBot(bot: { token: string; botId: number; username: string } | null) {
      db.transaction(() => {
        db.prepare("DELETE FROM identity_telegram_link").run();
        db.prepare("DELETE FROM identity_telegram_code").run();
        db.prepare("DELETE FROM identity_reset_code").run();
        db.prepare("DELETE FROM identity_telegram_bot").run();
        if (bot) db.prepare("INSERT INTO identity_telegram_bot VALUES (1,?,?,?,0,?)").run(bot.token, bot.botId, bot.username, Date.now());
      })();
    },
    setTelegramOffset(offset: number) { db.prepare("UPDATE identity_telegram_bot SET update_offset=? WHERE update_offset<?").run(offset, offset); },
    createTelegramLinkCode(userId: string) {
      const code = randomBytes(18).toString("base64url");
      const expiresAt = Date.now() + TELEGRAM_LINK_MS;
      db.transaction(() => {
        db.prepare("DELETE FROM identity_telegram_code WHERE user_id=? OR expires_at<=?").run(userId, Date.now());
        db.prepare("INSERT INTO identity_telegram_code VALUES (?,?,?)").run(digest(code), userId, expiresAt);
      })();
      return { code, expiresAt };
    },
    claimTelegramLink(code: string, from: { telegramUserId: number; chatId: number; telegramUsername: string | null }): UserIdentity | null {
      if (!/^[A-Za-z0-9_-]{24}$/.test(code)) return null;
      return db.transaction(() => {
        const claim = db.prepare("SELECT user_id FROM identity_telegram_code WHERE code_hash=? AND expires_at>?").get(digest(code), Date.now()) as { user_id: string } | undefined;
        if (claim === undefined) return null;
        db.prepare("DELETE FROM identity_telegram_code WHERE user_id=?").run(claim.user_id);
        const other = db.prepare("SELECT user_id FROM identity_telegram_link WHERE telegram_user_id=? AND user_id<>?").get(from.telegramUserId, claim.user_id) as { user_id: string } | undefined;
        if (other !== undefined) throw new IdentityError(409, "This Telegram account is already connected to another Hydra account.");
        db.prepare("DELETE FROM identity_telegram_link WHERE user_id=?").run(claim.user_id);
        db.prepare("INSERT INTO identity_telegram_link VALUES (?,?,?,?,'notify',?)").run(claim.user_id, from.telegramUserId, from.chatId, from.telegramUsername, Date.now());
        const row = db.prepare("SELECT * FROM identity_user WHERE id=?").get(claim.user_id) as UserRow;
        return identity(row);
      })();
    },
    telegramLink(userId: string): TelegramLink | null {
      const row = db.prepare("SELECT * FROM identity_telegram_link WHERE user_id=?").get(userId) as LinkRow | undefined;
      return row ? link(row) : null;
    },
    telegramLinkFor(telegramUserId: number): { link: TelegramLink; user: UserIdentity } | null {
      const row = db.prepare("SELECT l.*, u.id, u.username, u.password_hash, u.salt, u.owns_legacy_data FROM identity_telegram_link l JOIN identity_user u ON u.id=l.user_id WHERE l.telegram_user_id=?").get(telegramUserId) as (LinkRow & UserRow) | undefined;
      return row ? { link: link(row), user: identity(row) } : null;
    },
    setTelegramAccess(userId: string, access: TelegramAccess) {
      if (db.prepare("UPDATE identity_telegram_link SET access=? WHERE user_id=?").run(access, userId).changes === 0) throw new IdentityError(404, "Telegram is not connected.");
    },
    unlinkTelegram(userId: string) {
      db.prepare("DELETE FROM identity_telegram_link WHERE user_id=?").run(userId);
      db.prepare("DELETE FROM identity_telegram_code WHERE user_id=?").run(userId);
    },
    audit(userId: string, action: string, detail: string) {
      db.prepare("INSERT INTO identity_telegram_audit(user_id, at, action, detail) VALUES (?,?,?,?)").run(userId, Date.now(), action.slice(0, 80), detail.slice(0, 500));
      db.prepare("DELETE FROM identity_telegram_audit WHERE user_id=? AND id NOT IN (SELECT id FROM identity_telegram_audit WHERE user_id=? ORDER BY id DESC LIMIT ?)").run(userId, userId, AUDIT_KEEP);
    },
    auditLog(userId: string, limit = 50): TelegramAuditEntry[] {
      return (db.prepare("SELECT at, action, detail FROM identity_telegram_audit WHERE user_id=? ORDER BY id DESC LIMIT ?").all(userId, limit) as Array<{ at: number; action: string; detail: string }>)
        .map(row => ({ at: new Date(row.at).toISOString(), action: row.action, detail: row.detail }));
    },
    close() { db.close(); },
  };
}

export type IdentityStore = ReturnType<typeof openIdentityStore>;
