import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

/*
 * Real-Telegram (T3) credentials live outside the repository in
 * ~/.config/ai-workstation/e2e-live.env, written by the one-time sign-in
 * (docs/e2e-live-setup.md). Values are returned to the harness but never
 * printed; errors name missing keys only.
 */

export const LIVE_ENV_PATH = join(homedir(), ".config/ai-workstation/e2e-live.env");
const REPO_ROOT = join(import.meta.dirname, "../../..");

export interface LiveConfig {
  testBotToken: string;
  testBotId: string;
  testBotUsername: string;
  apiId: number;
  apiHash: string;
  userSession: string;
  operatorUserId: string;
  /** The operator's own bot id (never its token); empty when the operator has no bot configured. */
  operatorBotId: string;
}

export class LiveSetupError extends Error {
  constructor(detail: string) {
    super(`T3 blocked on setup: ${detail}. Follow docs/e2e-live-setup.md, then rerun npm run e2e:live.`);
    this.name = "LiveSetupError";
  }
}

const REQUIRED = {
  E2E_TELEGRAM_TEST_BOT_TOKEN: "the test bot token from BotFather",
  E2E_TELEGRAM_API_ID: "api_id from my.telegram.org",
  E2E_TELEGRAM_API_HASH: "api_hash from my.telegram.org",
  E2E_TELEGRAM_USER_SESSION: "the user client session (run npm run e2e:live:login)",
  E2E_TELEGRAM_TEST_BOT_ID: "the test bot id (run npm run e2e:live:login)",
  E2E_TELEGRAM_TEST_BOT_USERNAME: "the test bot username (run npm run e2e:live:login)",
  E2E_TELEGRAM_OPERATOR_USER_ID: "your Telegram user id (run npm run e2e:live:login)",
} as const;

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
  }
  return values;
}

export function loadLiveConfig(path = LIVE_ENV_PATH, repoRoot = REPO_ROOT): LiveConfig {
  if (!existsSync(path)) throw new LiveSetupError(`${path} does not exist`);
  const inRepo = relative(realpathSync(repoRoot), realpathSync(path));
  if (!inRepo.startsWith("..") && !isAbsolute(inRepo)) throw new LiveSetupError(`${path} resolves inside the repository; keep live secrets in ~/.config/ai-workstation`);
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new LiveSetupError(`${path} is readable by other users (mode ${mode.toString(8)}); run chmod 600 on it`);
  const values = parseEnvFile(readFileSync(path, "utf8"));
  const missing = Object.entries(REQUIRED).filter(([key]) => !values[key]).map(([key, meaning]) => `${key} (${meaning})`);
  if (missing.length > 0) throw new LiveSetupError(`${path} is missing ${missing.join(", ")}`);
  const tokenBotId = values.E2E_TELEGRAM_TEST_BOT_TOKEN!.split(":")[0];
  if (tokenBotId !== values.E2E_TELEGRAM_TEST_BOT_ID) throw new LiveSetupError("E2E_TELEGRAM_TEST_BOT_TOKEN does not belong to E2E_TELEGRAM_TEST_BOT_ID; rerun npm run e2e:live:login");
  const operatorBotId = values.E2E_TELEGRAM_OPERATOR_BOT_ID ?? "";
  const repoEnv = join(repoRoot, ".env");
  const operatorHasBot = existsSync(repoEnv) && /^\s*TELEGRAM_BOT_TOKEN\s*=\s*["']?\d+:/m.test(readFileSync(repoEnv, "utf8"));
  // Without the operator's bot id the guard has nothing to refuse; that is only acceptable when no operator bot exists.
  if (operatorBotId === "" && operatorHasBot) throw new LiveSetupError("E2E_TELEGRAM_OPERATOR_BOT_ID is empty although the repository .env has a bot token; rerun npm run e2e:live:login");
  if (operatorBotId !== "" && operatorBotId === values.E2E_TELEGRAM_TEST_BOT_ID) throw new LiveSetupError("the test bot is the operator's own bot; create a separate bot with BotFather");
  const apiId = Number(values.E2E_TELEGRAM_API_ID);
  if (!Number.isInteger(apiId) || apiId <= 0) throw new LiveSetupError("E2E_TELEGRAM_API_ID is not a positive integer");
  return {
    testBotToken: values.E2E_TELEGRAM_TEST_BOT_TOKEN!,
    testBotId: values.E2E_TELEGRAM_TEST_BOT_ID!,
    testBotUsername: values.E2E_TELEGRAM_TEST_BOT_USERNAME!,
    apiId,
    apiHash: values.E2E_TELEGRAM_API_HASH!,
    userSession: values.E2E_TELEGRAM_USER_SESSION!,
    operatorUserId: values.E2E_TELEGRAM_OPERATOR_USER_ID!,
    operatorBotId,
  };
}
