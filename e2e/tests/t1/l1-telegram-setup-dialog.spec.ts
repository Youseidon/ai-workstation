import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, openApp, test } from "../../src/fixtures.ts";
import { pairThroughApi, telegramStatus, waitForTelegramState } from "../../src/telegramFlows.ts";

// The setup dialog's "Use a different bot" path, on the real Agents page against the fake Telegram backend.
test.use({ harnessOptions: { fakeProvider: "live", telegram: { backend: "fake" } } });
test.describe.configure({ mode: "serial" });
// The second scenario types the bot token into the page, as the operator does.
// A trace would record that keystroke and the request that carries it, and the
// harness's end-of-run sweep rightly refuses a token in any artifact, so this
// file keeps no trace rather than the sweep being told to look away.
test.use({ trace: "off" });

/** Screenshots for a human to look at; `E2E_DIALOG_SHOTS` names the directory, and without it none are taken. */
async function shot(page: import("@playwright/test").Page, name: string): Promise<void> {
  const dir = process.env.E2E_DIALOG_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.getByRole("dialog").screenshot({ path: join(dir, `${name}.png`) });
}

async function openDialog(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /^(Manage|Set up) Telegram$/ }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Set up Telegram" })).toBeVisible();
  return dialog;
}

test("a connected bot can be swapped from the dialog, with a way back, and closing abandons a half-entered change", async ({ harness, page }) => {
  const bot = `@${harness.telegramBot!.username}`;
  await waitForTelegramState("polling");
  await openApp(page, "/agents");
  let dialog = await openDialog(page);

  // Connected, nobody paired: the pairing step, with the way to another bot beside the bot's name.
  await expect(dialog.getByText("connected", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Pair your Telegram account" })).toBeVisible();
  await shot(page, "1-connected");
  await dialog.getByRole("button", { name: "Use a different bot" }).click();

  // The token step, saying which bot is being replaced rather than how to create a first one.
  await expect(dialog.getByRole("heading", { name: "Use a different bot" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Create your personal bot" })).toHaveCount(0);
  await expect(dialog.getByText(`instead of ${bot}`)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save bot and continue" })).toBeDisabled();
  await shot(page, "2-different-bot");
  await dialog.getByRole("button", { name: `Keep ${bot}` }).click();
  await expect(dialog.getByRole("heading", { name: "Pair your Telegram account" })).toBeVisible();
  await expect(dialog.getByLabel("Bot token")).toHaveCount(0);

  // A token typed and then abandoned by closing is not there when the dialog comes back.
  await dialog.getByRole("button", { name: "Use a different bot" }).click();
  await dialog.getByLabel("Bot token").fill("123456:half-a-token");
  await dialog.getByRole("button", { name: "Finish later" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  dialog = await openDialog(page);
  await expect(dialog.getByRole("heading", { name: "Pair your Telegram account" })).toBeVisible();
  await expect(dialog.getByLabel("Bot token")).toHaveCount(0);
  expect((await telegramStatus()).bot?.username).toBe(harness.telegramBot!.username);
});

test("a paired workstation still offers a different bot, and saving a token for the same bot keeps the phone", async ({ harness, page }) => {
  const bot = `@${harness.telegramBot!.username}`;
  await pairThroughApi(harness.phone!);
  expect((await telegramStatus()).actors).toHaveLength(1);
  await openApp(page, "/agents");
  const dialog = await openDialog(page);

  // Paired: the dialog is on its ready or enable step, and either one offers the change.
  await expect(dialog.getByText(/^(ready|paired)$/)).toBeVisible();
  await shot(page, "3-paired");
  await dialog.getByRole("button", { name: "Use a different bot" }).click();
  await expect(dialog.getByText(`A phone paired with ${bot} is unpaired`)).toBeVisible();

  // The same bot's token is a rotation, not a change of bot: the phone stays.
  await dialog.getByLabel("Bot token").fill(harness.telegramBot!.token);
  await dialog.getByRole("button", { name: "Save bot and continue" }).click();
  await expect(dialog.getByText(/^(ready|paired)$/)).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole("heading", { name: "Use a different bot" })).toHaveCount(0);
  await waitForTelegramState("polling");
  const status = await telegramStatus();
  expect(status.bot?.username).toBe(harness.telegramBot!.username);
  expect(status.actors).toHaveLength(1);
  expect(status.pairing).toBeNull();
});
