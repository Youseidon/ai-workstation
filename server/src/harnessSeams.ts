import { HARNESS_GUARD_EXIT_CODE, HarnessGuardError, assertLoopbackUrl, isHarnessMode } from "./harnessGuard.ts";

/*
 * Values the end-to-end harness may override. Outside harness mode every
 * field is null, whatever the environment says, so production defaults are
 * unreachable from these variables (docs/e2e-harness-plan.md 4.1 and 4.5).
 */

export interface HarnessSeams {
  /** Loopback base URL for the Bot API (fake server or route proxy). */
  telegramApiBaseUrl: string | null;
  /** Bot ids the harness must never poll: the operator's own bot. */
  forbiddenBotIds: string | null;
  actionTtlMs: number | null;
  pairingTtlMs: number | null;
  quotaFreshnessMs: number | null;
  telegramPollTimeoutSeconds: number | null;
}

const NONE: HarnessSeams = { telegramApiBaseUrl: null, forbiddenBotIds: null, actionTtlMs: null, pairingTtlMs: null, quotaFreshnessMs: null, telegramPollTimeoutSeconds: null };

function bounded(env: NodeJS.ProcessEnv, name: string, min: number, max: number): number | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HarnessGuardError("harness_invalid_override", `${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function readHarnessSeams(env: NodeJS.ProcessEnv = process.env): HarnessSeams {
  if (!isHarnessMode(env)) return NONE;
  const baseUrl = env.AGENT_CONSOLE_HARNESS_TELEGRAM_API_BASE_URL?.trim();
  return {
    telegramApiBaseUrl: baseUrl ? assertLoopbackUrl("AGENT_CONSOLE_HARNESS_TELEGRAM_API_BASE_URL", baseUrl).toString().replace(/\/+$/, "") : null,
    forbiddenBotIds: env.AGENT_CONSOLE_HARNESS_FORBIDDEN_BOT_IDS?.trim() || null,
    actionTtlMs: bounded(env, "AGENT_CONSOLE_HARNESS_ACTION_TTL_MS", 500, 24 * 60 * 60_000),
    pairingTtlMs: bounded(env, "AGENT_CONSOLE_HARNESS_PAIRING_TTL_MS", 500, 24 * 60 * 60_000),
    quotaFreshnessMs: bounded(env, "AGENT_CONSOLE_HARNESS_QUOTA_FRESHNESS_MS", 500, 24 * 60 * 60_000),
    telegramPollTimeoutSeconds: bounded(env, "AGENT_CONSOLE_HARNESS_TELEGRAM_POLL_TIMEOUT_SECONDS", 1, 50),
  };
}

function load(): HarnessSeams {
  try {
    return readHarnessSeams();
  } catch (error) {
    console.error(`${error instanceof HarnessGuardError ? error.code : "harness_guard"}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(HARNESS_GUARD_EXIT_CODE);
  }
}

export const harnessSeams: HarnessSeams = load();
