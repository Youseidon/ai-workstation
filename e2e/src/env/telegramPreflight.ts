/*
 * Checks a harness bot before any harness server polls it, the same way on
 * both backends, and clears what earlier runs left behind
 * (docs/e2e-scenarios/h6.md S-H6-18, S-H6-20, S-H6-21, S-H6-24).
 * Messages name ids and conditions only, never the token. On the real
 * backend the orchestrator reports a failure as blocked on setup.
 */

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

export interface PreflightOptions {
  /** Bot API base URL without a trailing slash: the fake server, or https://api.telegram.org. */
  baseUrl: string;
  token: string;
  expectedBotId: string;
  /** Real backend only: the operator's private chat, which the bot must be allowed to message. */
  operatorChatId?: string;
  /**
   * Seconds to hold a long poll looking for a competing poller. A new getUpdates call ends the
   * older one with 409, so a zero-timeout probe cannot see a poller that is looping; holding a
   * poll lets that poller come back and end ours with 409 instead. 0 skips the probe.
   */
  conflictProbeSeconds?: number;
}

interface Envelope {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
}

async function call(options: PreflightOptions, method: string, body: Record<string, unknown>, timeoutMs = 20_000): Promise<Envelope> {
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}/bot${options.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new PreflightError(`Telegram could not be reached for ${method} (${error instanceof Error ? error.name : "network error"})`);
  }
  return (await response.json().catch(() => ({ ok: false, error_code: response.status }))) as Envelope;
}

export async function preflightBot(options: PreflightOptions): Promise<{ id: string; username: string }> {
  const me = await call(options, "getMe", {});
  if (!me.ok) {
    if (me.error_code === 401 || me.error_code === 404) throw new PreflightError("Telegram rejected the test bot token (getMe returned 401); fix E2E_TELEGRAM_TEST_BOT_TOKEN");
    throw new PreflightError(`getMe for the test bot failed with ${me.error_code ?? "no status"}`);
  }
  const bot = me.result as { id: number; username: string };
  if (String(bot.id) !== options.expectedBotId) throw new PreflightError(`the bot token belongs to bot ${bot.id}, not the registered test bot ${options.expectedBotId}`);

  const webhook = await call(options, "getWebhookInfo", {});
  if (webhook.ok && typeof (webhook.result as { url?: string }).url === "string" && (webhook.result as { url: string }).url !== "") {
    throw new PreflightError("a webhook is set on the test bot, so it cannot be long polled; remove it with deleteWebhook");
  }

  if (options.operatorChatId !== undefined) {
    const reach = await call(options, "sendChatAction", { chat_id: options.operatorChatId, action: "typing" });
    if (!reach.ok && (reach.error_code === 403 || reach.error_code === 400)) throw new PreflightError("the test bot cannot message your account; open the test bot in Telegram and press Start, or rerun npm run e2e:live:login");
  }

  // Updates left by earlier runs (old taps, replies, /start codes) must never act in this run.
  const dropped = await call(options, "deleteWebhook", { drop_pending_updates: true });
  if (!dropped.ok) throw new PreflightError(`clearing the test bot's pending updates failed with ${dropped.error_code ?? "no status"}`);

  if ((options.conflictProbeSeconds ?? 0) > 0) {
    // A zero offset never confirms anything, so the probe cannot consume an update that arrives meanwhile.
    const probe = await call(options, "getUpdates", { timeout: options.conflictProbeSeconds, limit: 1, allowed_updates: ["message", "callback_query"] }, (options.conflictProbeSeconds! + 15) * 1000);
    if (!probe.ok && probe.error_code === 409) throw new PreflightError("another process is polling the test bot (an earlier harness run still alive?); stop it and rerun");
  }
  return { id: String(bot.id), username: bot.username };
}
