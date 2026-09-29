import { inspect } from "node:util";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config } from "../../config.ts"; // Loads .env into process.env before the token is read.

export const TELEGRAM_TOKEN_ENV = "TELEGRAM_BOT_TOKEN";

const REDACTED = "[redacted-token]";
const TOKEN_FORMAT = /^(\d{5,}):[A-Za-z0-9_-]{30,}$/;

/**
 * A Bot API token that cannot leak by accident: it stringifies, serializes and
 * inspects as a placeholder, so it is safe to pass through loggers and DTOs.
 * Only `reveal()` returns the secret, and only the HTTP client calls it.
 */
export class BotToken {
  readonly #value: string;
  readonly botId: string;

  private constructor(value: string, botId: string) {
    this.#value = value;
    this.botId = botId;
  }

  static parse(raw: string | undefined | null): BotToken | null {
    const value = raw?.trim() ?? "";
    const match = TOKEN_FORMAT.exec(value);
    return match ? new BotToken(value, match[1]!) : null;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `BotToken(${REDACTED})`;
  }
}

export interface TelegramCredential {
  token: BotToken | null;
  /** Set when a value was supplied but is not a Bot API token. Never contains the value. */
  problem: string | null;
}

/**
 * The UI-managed token lives beside other checkout-local runtime state, but in
 * its own 0600 file: settings snapshots and API responses must never contain it.
 * Once this file exists it wins over an env token, so a token replaced through
 * the setup UI stays replaced after restart. Existing env-only deployments keep
 * working unchanged.
 */
export const TELEGRAM_CREDENTIAL_PATH = resolve(
  config.repoRoot,
  process.env.TELEGRAM_CREDENTIAL_FILE?.trim() || ".agent-console/telegram-token",
);

/**
 * Takes the token out of the environment. Provider CLIs are spawned with a copy
 * of `process.env`, so leaving it there would hand the bot token to every agent
 * task (protocol I10).
 */
export function takeTelegramCredential(env: NodeJS.ProcessEnv = process.env): TelegramCredential {
  const raw = env[TELEGRAM_TOKEN_ENV];
  delete env[TELEGRAM_TOKEN_ENV];
  if (raw === undefined || raw.trim() === "") return { token: null, problem: null };
  const token = BotToken.parse(raw);
  return token
    ? { token, problem: null }
    : { token: null, problem: `${TELEGRAM_TOKEN_ENV} is set but is not a Bot API token (expected <digits>:<secret>).` };
}

export function readStoredTelegramCredential(path = TELEGRAM_CREDENTIAL_PATH): TelegramCredential {
  if (!existsSync(path)) return { token: null, problem: null };
  try {
    const token = BotToken.parse(readFileSync(path, "utf8"));
    return token === null
      ? { token: null, problem: "The saved Telegram credential is not a Bot API token. Replace it from the Telegram setup screen." }
      : { token, problem: null };
  } catch {
    return { token: null, problem: "The saved Telegram credential could not be read. Replace it from the Telegram setup screen." };
  }
}

/** Atomic, owner-only persistence for a token already validated with getMe. */
export function persistTelegramCredential(token: BotToken, path = TELEGRAM_CREDENTIAL_PATH): void {
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporary, `${token.reveal()}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

const environmentCredential = takeTelegramCredential();
const storedCredential = readStoredTelegramCredential();

/** Mutable in memory only so a validated UI credential can take effect without a restart. */
export const bootTelegramCredential: TelegramCredential =
  storedCredential.token !== null || storedCredential.problem !== null
    ? storedCredential
    : environmentCredential;
