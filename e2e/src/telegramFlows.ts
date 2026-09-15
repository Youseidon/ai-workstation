import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { TelegramLiveStatus } from "@agent-console/shared";
import type { HarnessEnvironment } from "./env/orchestrator.ts";
import { webUrl } from "./env/orchestrator.ts";
import type { PhoneDriver } from "./drivers/phone.ts";
import { eventually, state } from "./drivers/state.ts";
import { isCardFor } from "./scenarios/l1Flows.ts";

export const telegramStatus = async () => (await state.get<{ status: TelegramLiveStatus }>("/api/task-control/telegram")).status;

export async function waitForTelegramState(expected: TelegramLiveStatus["state"], timeoutMs = 30_000): Promise<TelegramLiveStatus> {
  return eventually(`Telegram state ${expected}`, async () => {
    const status = await telegramStatus();
    return status.state === expected ? status : undefined;
  }, timeoutMs);
}

/** Pairs the phone the way the operator does: from the Agents page, sending /start <code> from the phone, then confirming. */
export async function pairThroughAgentsPage(page: Page, phone: PhoneDriver): Promise<void> {
  await waitForTelegramState("polling");
  await page.goto(`${webUrl}/agents`);
  const panel = page.locator("div.rounded-md").filter({ has: page.getByRole("heading", { name: "Live Telegram", exact: true }) });
  await expect(panel).toHaveCount(1);
  await expect(panel.getByText("connected", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: /Pair (a|another) phone/ }).click();
  const command = await panel.locator("code").filter({ hasText: "/start " }).textContent();
  expect(command).toMatch(/^\/start [A-Za-z0-9_-]+$/);
  const before = await phone.cursor();
  await phone.send(command!);
  await expect(panel.getByRole("button", { name: "Confirm pairing" })).toBeVisible({ timeout: 20_000 });
  await panel.getByRole("button", { name: "Confirm pairing" }).click();
  await phone.waitForBotMessage("the paired confirmation", (message) => message.text.startsWith("Paired with this workstation"), { afterId: before });
  await expect(panel.getByRole("button", { name: "Unpair" })).toBeVisible();
}

export function outboxRows(harness: HarnessEnvironment) {
  return harness.query<{ id: number; state: string; attempt_count: number; sent_message_id: string | null; payload_json: string }>("SELECT id, state, attempt_count, sent_message_id, payload_json FROM telegram_outbox ORDER BY id");
}

/** Pairs through the local API (same runtime path as the page) for scenarios that are not about pairing. */
export async function pairThroughApi(phone: PhoneDriver): Promise<void> {
  await waitForTelegramState("polling");
  const { pairing } = await state.post<{ pairing: { code: string } }>("/api/task-control/telegram/pairing");
  const before = await phone.cursor();
  await phone.send(`/start ${pairing.code}`);
  await eventually("the pairing code to be observed", async () => (await telegramStatus()).pairing?.observed ?? undefined);
  await state.post("/api/task-control/telegram/pairing/confirm", { code: pairing.code });
  await phone.waitForBotMessage("the paired confirmation", (message) => message.text.startsWith("Paired with this workstation"), { afterId: before });
}

/** Blocks a saved task through the fake agent and waits for its question card on the phone. */
export async function blockedTaskCard(harness: HarnessEnvironment, phone: PhoneDriver, title: string, extra: { reason?: string; humanAction?: string } = {}) {
  const { runSavedTask, waitForRunEnd } = await import("./scenarios.ts");
  const before = await phone.cursor();
  const { task, runId } = await runSavedTask(harness, { title, scenarios: [{ behavior: "block-on-decision", reason: extra.reason ?? "Two names fit.", humanAction: extra.humanAction ?? "Pick Aurora or Borealis." }] });
  await waitForRunEnd(task, runId);
  const card = await phone.waitForBotMessage(`the question card for ${title}`, (message) => isCardFor(message, title), { afterId: before });
  return { task, card };
}
