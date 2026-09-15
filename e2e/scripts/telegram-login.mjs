#!/usr/bin/env node
// One-time sign-in for the e2e harness's real-Telegram user client (TelegramUserPhone),
// run by the operator as `npm run e2e:live:login` (docs/e2e-live-setup.md).
// Reads ~/.config/ai-workstation/e2e-live.env, signs in interactively, writes the session
// string and bot ids back to that file (mode 600). Never prints secrets.
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

// Same slow-connect allowance as src/env/network.ts (this script is plain JS and cannot import it):
// without it, fetch to api.telegram.org fails with ETIMEDOUT where IPv6 has no route and IPv4 connects slowly.
setDefaultAutoSelectFamilyAttemptTimeout(2500);

const envPath = join(homedir(), ".config/ai-workstation/e2e-live.env");
const repoEnvPath = fileURLToPath(new URL("../../.env", import.meta.url));

function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

if (!existsSync(envPath)) {
  console.error(`Missing ${envPath}. Create it first (docs/e2e-live-setup.md).`);
  process.exit(1);
}
const env = parseEnv(readFileSync(envPath, "utf8"));
for (const key of ["E2E_TELEGRAM_TEST_BOT_TOKEN", "E2E_TELEGRAM_API_ID", "E2E_TELEGRAM_API_HASH"]) {
  if (!env[key]) {
    console.error(`Missing ${key} in ${envPath}`);
    process.exit(1);
  }
}

const testBotId = env.E2E_TELEGRAM_TEST_BOT_TOKEN.split(":")[0];
const me = await fetch(`https://api.telegram.org/bot${env.E2E_TELEGRAM_TEST_BOT_TOKEN}/getMe`).then((r) => r.json());
if (!me.ok) {
  console.error("Test bot token rejected by Telegram (getMe failed). Check the token.");
  process.exit(1);
}
const testBotUsername = me.result.username;

let operatorBotId = "";
if (existsSync(repoEnvPath)) {
  const repoToken = parseEnv(readFileSync(repoEnvPath, "utf8")).TELEGRAM_BOT_TOKEN ?? "";
  operatorBotId = repoToken.split(":")[0] ?? "";
}
if (operatorBotId && operatorBotId === testBotId) {
  console.error("The test bot is the same bot as your own app's bot. Create a separate bot with BotFather.");
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const client = new TelegramClient(new StringSession(env.E2E_TELEGRAM_USER_SESSION ?? ""), Number(env.E2E_TELEGRAM_API_ID), env.E2E_TELEGRAM_API_HASH, {
  connectionRetries: 3,
});
client.setLogLevel("error");
await client.start({
  phoneNumber: async () => rl.question("Phone number (international format, e.g. +44...): "),
  phoneCode: async () => rl.question("Login code Telegram just sent you: "),
  password: async () => rl.question("Two-step verification password (if set): "),
  onError: (err) => console.error("Sign-in error:", err.message),
});
rl.close();

const self = await client.getMe();
await client.sendMessage(testBotUsername, { message: "/start" });
await client.invoke(new Api.messages.ReadHistory({ peer: testBotUsername, maxId: 0 }));

const next = {
  ...env,
  E2E_TELEGRAM_USER_SESSION: client.session.save(),
  E2E_TELEGRAM_TEST_BOT_ID: testBotId,
  E2E_TELEGRAM_TEST_BOT_USERNAME: testBotUsername,
  E2E_TELEGRAM_OPERATOR_BOT_ID: operatorBotId,
  E2E_TELEGRAM_OPERATOR_USER_ID: String(self.id),
};
writeFileSync(envPath, Object.entries(next).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
chmodSync(envPath, 0o600);
await client.disconnect();
console.log(`Signed in. Test bot @${testBotUsername} (id ${testBotId}) started from your account. Session saved to ${envPath}.`);
process.exit(0);
