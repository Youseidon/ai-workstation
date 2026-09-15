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
import QRCode from "qrcode";
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
await client.connect();
if (!(await client.checkAuthorization())) {
  const method = (await rl.question("Sign in by (q) scanning a QR code with the Telegram app on your phone, or (c) a login code? [q]: ")).trim().toLowerCase();
  if (method === "c") await signIn();
  else await signInWithQr();
}
rl.close();

// QR login needs no code delivery: the phone's Telegram app, already signed in, approves this client.
async function signInWithQr() {
  const apiCredentials = { apiId: Number(env.E2E_TELEGRAM_API_ID), apiHash: env.E2E_TELEGRAM_API_HASH };
  console.log("\nOn your phone: Telegram > Settings > Devices > Link Desktop Device, then scan the code below.");
  console.log("The code renews about every 30 seconds until you scan it.\n");
  await client.signInUserWithQrCode(apiCredentials, {
    qrCode: async ({ token }) => {
      const url = `tg://login?token=${Buffer.from(token).toString("base64url")}`;
      console.log(await QRCode.toString(url, { type: "utf8", errorCorrectionLevel: "L" }));
    },
    password: async (hint) => rl.question(`Two-step verification password${hint ? ` (hint: ${hint})` : ""}: `),
    onError: async (err) => {
      console.error("Sign-in error:", err.errorMessage ?? err.message);
      return (err.errorMessage ?? "") !== "PASSWORD_HASH_INVALID";
    },
  });
}

// Where Telegram delivers a code, in the operator's words. client.start hides this, and "no SMS arrived"
// is almost always a code sent as an in-app message from the "Telegram" account instead.
// `type` is an auth.SentCodeType*; `nextType` (the resend method) is the shorter auth.CodeType*.
function describeDelivery(type) {
  switch (type?.className.replace(/^auth\.(Sent)?CodeType/, "")) {
    case "App":
      return 'as a message from the official "Telegram" account in your Telegram app (on a device already signed in), not by SMS';
    case "Sms":
    case "SmsWord":
    case "SmsPhrase":
      return "by SMS";
    case "Call":
      return "by a phone call that reads out the code";
    case "FlashCall":
    case "MissedCall":
      return "as a missed call: the code is the last digits of the calling number";
    case "EmailCode":
      return `by email to ${type.emailPattern}`;
    case "FragmentSms":
      return "through Fragment (fragment.com), for an anonymous number";
    case "FirebaseSms":
      return "by SMS through a verification channel only official apps can use";
    default:
      return `by an unrecognised method (${type?.className ?? "none"})`;
  }
}

function explainSent(sent) {
  const digits = sent.type?.length ? `a ${sent.type.length}-digit code` : "the code";
  console.log(`Telegram sent ${digits} ${describeDelivery(sent.type)}.`);
  if (sent.nextType) {
    const wait = sent.timeout ? ` after ${sent.timeout}s` : "";
    console.log(`Not arriving? Enter r to have it resent ${describeDelivery(sent.nextType)}${wait}.`);
  } else if (sent.type?.className === "auth.SentCodeTypeApp") {
    console.log('Telegram offers no other method for this account. Look for the "Telegram" chat (check Archived chats) on any device signed in to this number.');
  }
}

async function signIn() {
  const apiCredentials = { apiId: Number(env.E2E_TELEGRAM_API_ID), apiHash: env.E2E_TELEGRAM_API_HASH };
  const phoneNumber = (await rl.question("Phone number (international format, e.g. +44...): ")).replace(/[\s-]/g, "");
  let sent;
  try {
    sent = await client.invoke(new Api.auth.SendCode({ phoneNumber, ...apiCredentials, settings: new Api.CodeSettings({}) }));
  } catch (err) {
    // FLOOD_WAIT_n / PHONE_NUMBER_FLOOD mean too many code requests: wait before retrying.
    console.error("Telegram refused to send a code:", err.errorMessage ?? err.message, err.seconds ? `(retry in ${err.seconds}s)` : "");
    process.exit(1);
  }
  if (sent instanceof Api.auth.SentCodeSuccess) return;
  if (sent.type instanceof Api.auth.SentCodeTypeSetUpEmailRequired) {
    console.error("Telegram requires a login email for this account before third-party sign-in. Set one up in Telegram (Settings > Privacy and Security), then rerun.");
    process.exit(1);
  }
  explainSent(sent);

  for (;;) {
    const answer = (await rl.question(sent.nextType ? "Login code (or r to resend): " : "Login code: ")).trim();
    if (answer.toLowerCase() === "r" && !sent.nextType) {
      console.error("Telegram offers no resend method for this code; enter the code from the Telegram app.");
      continue;
    }
    if (answer.toLowerCase() === "r") {
      try {
        sent = await client.invoke(new Api.auth.ResendCode({ phoneNumber, phoneCodeHash: sent.phoneCodeHash }));
        if (sent instanceof Api.auth.SentCodeSuccess) return;
        explainSent(sent);
      } catch (err) {
        const code = err.errorMessage ?? err.message;
        const hint = code.startsWith("FLOOD")
          ? " (too soon: wait for the timeout above, then try r again)"
          : code === "SEND_CODE_UNAVAILABLE"
            ? " (no other delivery method; the code you already have is still valid)"
            : "";
        console.error(`Resend refused: ${code}${hint}`);
      }
      continue;
    }
    if (!answer) continue;
    try {
      const result = await client.invoke(new Api.auth.SignIn({ phoneNumber, phoneCodeHash: sent.phoneCodeHash, phoneCode: answer }));
      if (result instanceof Api.auth.AuthorizationSignUpRequired) {
        console.error("This number has no Telegram account. Sign up in a Telegram app first.");
        process.exit(1);
      }
      return;
    } catch (err) {
      const code = err.errorMessage ?? err.message;
      if (code === "PHONE_CODE_INVALID") {
        console.error("That code is wrong. Try again.");
        continue;
      }
      if (code === "SESSION_PASSWORD_NEEDED") {
        await client.signInWithPassword(apiCredentials, {
          password: async (hint) => rl.question(`Two-step verification password${hint ? ` (hint: ${hint})` : ""}: `),
          onError: async (passwordErr) => {
            console.error("Password error:", passwordErr.errorMessage ?? passwordErr.message);
            return (passwordErr.errorMessage ?? "") !== "PASSWORD_HASH_INVALID";
          },
        });
        return;
      }
      console.error(`Sign-in error: ${code}${code === "PHONE_CODE_EXPIRED" ? " (rerun npm run e2e:live:login for a new code)" : ""}`);
      process.exit(1);
    }
  }
}

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
