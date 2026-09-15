# Live Telegram setup for the end-to-end harness (T3)

Parent: [End-to-end harness plan](e2e-harness-plan.md), sections 4.2, 7 and 10.

The T3 tier runs the phone scenarios on real Telegram.
It needs two things only you can create: a dedicated test bot, and a signed-in Telegram client on your account.
Both are one-time steps, about 10 minutes in total.
Until they exist, `npm run e2e:live` fails with "T3 blocked on setup" and names what is missing.

## What gets stored, and where

Everything lives in `~/.config/ai-workstation/e2e-live.env`, outside the repository, readable only by you (mode 600).
The harness refuses to run if other users can read the file.

| Key | Written by | Meaning |
| --- | --- | --- |
| `E2E_TELEGRAM_TEST_BOT_TOKEN` | You | Token of the test bot. Never your own app's bot. |
| `E2E_TELEGRAM_API_ID` | You | Telegram API id for the user client. |
| `E2E_TELEGRAM_API_HASH` | You | Telegram API hash for the user client. |
| `E2E_TELEGRAM_USER_SESSION` | Sign-in tool | Session of the automated client. It gives full access to your Telegram account while it exists. |
| `E2E_TELEGRAM_TEST_BOT_ID`, `E2E_TELEGRAM_TEST_BOT_USERNAME` | Sign-in tool | Identity of the test bot, used by the guard. |
| `E2E_TELEGRAM_OPERATOR_BOT_ID` | Sign-in tool | Id (not token) of your own app's bot, read once from the repository `.env`, so the harness can refuse it. |
| `E2E_TELEGRAM_OPERATOR_USER_ID` | Sign-in tool | Your Telegram user id; the phone driver checks the session belongs to it. |

The harness never prints these values, and every run ends with a token sweep that fails if the bot token, API hash or session appears in any log, trace, artifact or database copy.

## Steps

1. Create the test bot.
   In Telegram, open @BotFather, send `/newbot`, and give it a name such as "Workstation harness" and a username ending in `bot`.
   Copy the token it returns.
   Do not reuse the bot your app already uses: two processes cannot poll one bot, so a shared bot would break your running app.
2. Create API credentials for the automated client.
   Sign in at https://my.telegram.org, open "API development tools", and create an application (any title, platform "Desktop").
   Copy `api_id` and `api_hash`.
3. Create the file with those three values:

   ```bash
   mkdir -p ~/.config/ai-workstation
   install -m 600 /dev/null ~/.config/ai-workstation/e2e-live.env
   cat >> ~/.config/ai-workstation/e2e-live.env <<'EOF'
   E2E_TELEGRAM_TEST_BOT_TOKEN=<token from BotFather>
   E2E_TELEGRAM_API_ID=<api_id>
   E2E_TELEGRAM_API_HASH=<api_hash>
   EOF
   ```

4. Sign in the automated client:

   ```bash
   cd ~/ai-workstation/e2e && npm run e2e:live:login
   ```

   By default it shows a QR code: on your phone open Telegram > Settings > Devices > Link Desktop Device and scan it.
   It then asks for your two-step verification password if you have one.
   Choose `c` instead to sign in with your phone number and a login code.
   Telegram usually sends that code as a message from the "Telegram" account in an app already signed in to your number, not by SMS, and the script prints where it went.
   It checks the token with Telegram, refuses a test bot that is your own app's bot, sends `/start` to the test bot from your account, and writes the remaining keys.
5. Check the setup:

   ```bash
   cd ~/ai-workstation/e2e && npm run e2e:live -- -g "S-H6"
   ```

## Revoking access

- The client session: Telegram, Settings, Devices, terminate the session named after the harness application; then delete `E2E_TELEGRAM_USER_SESSION` from the file.
- The test bot: @BotFather, `/deletebot`.
- Everything: delete `~/.config/ai-workstation/e2e-live.env`.

## Later, for L3 slice C0 only

C0 checks forum topics in the private chat with the test bot.
It needs topics enabled for the test bot in @BotFather (bot settings); the rest of C0 is scripted.
