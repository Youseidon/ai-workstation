import { inspect } from "node:util";
import "../../config.ts"; // Loads .env into process.env before the token is read.

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

/** Read once at boot. Changing the token requires a server restart. */
export const bootTelegramCredential: TelegramCredential = takeTelegramCredential();
