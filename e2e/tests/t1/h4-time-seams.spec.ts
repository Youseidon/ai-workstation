import { expect, test } from "../../src/fixtures.ts";
import { eventually, state } from "../../src/drivers/state.ts";
import { blockedTaskCard, pairThroughApi, telegramStatus, waitForTelegramState } from "../../src/telegramFlows.ts";

// Scenario IDs refer to docs/e2e-scenarios/h0-h4.md. Short TTLs through harness-only overrides.
const TTL_MS = 3000;
test.use({
  harnessOptions: {
    fakeProvider: "live",
    telegram: { backend: "fake" },
    serverEnv: { AGENT_CONSOLE_HARNESS_ACTION_TTL_MS: String(TTL_MS), AGENT_CONSOLE_HARNESS_PAIRING_TTL_MS: String(TTL_MS) },
  },
});
test.describe.configure({ mode: "serial" });

const expired = (harness: { query<T>(sql: string, ...params: unknown[]): T[] }, promptId: number) =>
  harness.query<{ ref: string; expires_at: string }>("SELECT ref, expires_at FROM task_control_action WHERE prompt_id = ? ORDER BY created_at DESC", promptId);

test("S-H4-03: a pairing code sent after the pairing TTL is rejected; a fresh one works", async ({ harness }) => {
  const phone = harness.phone!;
  await waitForTelegramState("polling");
  const { pairing } = await state.post<{ pairing: { code: string; expiresAt: string } }>("/api/task-control/telegram/pairing");
  const lifetime = Date.parse(pairing.expiresAt) - Date.now();
  expect(lifetime).toBeLessThanOrEqual(TTL_MS);
  expect(lifetime).toBeGreaterThan(TTL_MS - 2000);
  await eventually("the pairing code to expire", async () => (await telegramStatus()).pairing === null, TTL_MS + 5000);
  await phone.send(`/start ${pairing.code}`);
  await eventually("the late code to be processed", async () => harness.query<{ n: number }>("SELECT COUNT(*) n FROM telegram_inbox WHERE processed_at IS NULL")[0]!.n === 0 && harness.telegramServer!.pendingUpdateCount(harness.telegramBot!.id) === 0);
  expect((await telegramStatus()).actors).toEqual([]);
  expect((await phone.messages()).filter((message) => message.fromBot)).toEqual([]);
  await pairThroughApi(phone);
  expect((await telegramStatus()).actors).toHaveLength(1);
});

test("S-H4-02: within the action TTL a tap applies exactly once", async ({ harness }) => {
  const phone = harness.phone!;
  const { task, card } = await blockedTaskCard(harness, phone, "Name the release");
  const before = await phone.cursor();
  await phone.send("Aurora", { replyTo: card });
  const answerCard = await phone.waitForBotMessage("the answer card", (message) => message.buttons.includes("Save answer"), { afterId: before });
  const { toast } = await phone.tap(answerCard, "Save answer");
  expect(toast).not.toMatch(/^Not applied/);
  await eventually("the answer to be saved", async () => (await state.prompt(task)).humanResponseHeld === true || (await state.history(task)).remarks.some((remark) => remark.kind === "HUMAN_RESPONSE" && remark.content === "Aurora"));
  expect((await state.history(task)).remarks.filter((remark) => remark.kind === "HUMAN_RESPONSE")).toHaveLength(1);
  expect(await state.sessionsFor(task)).toHaveLength(1);
});

test("S-H4-01: after the action TTL a tap is answered 'expired', a fresh card is issued and nothing changes", async ({ harness }) => {
  const phone = harness.phone!;
  const { task, card } = await blockedTaskCard(harness, phone, "Pick a licence");
  const before = await phone.cursor();
  await phone.send("MIT", { replyTo: card });
  const answerCard = await phone.waitForBotMessage("the answer card", (message) => message.buttons.includes("Save answer"), { afterId: before });
  const actions = expired(harness, task.promptId);
  await eventually("the answer card's actions to expire", async () => actions.every((action) => Date.parse(action.expires_at) < Date.now()), TTL_MS + 5000);
  const remarksBefore = (await state.history(task)).remarks.length;
  const afterTap = await phone.cursor();
  const { toast } = await phone.tap(answerCard, "Save answer");
  expect(toast).toMatch(/^Not applied: .*expired/i);
  await phone.waitForBotMessage("the rejection notice", (message) => /^Not applied: .*expired/i.test(message.text), { afterId: afterTap });
  const reissued = await phone.waitForBotMessage("the reissued question card", (message) => message.text.startsWith("Task needs input: Pick a licence"), { afterId: afterTap });
  expect(reissued.id).toBeGreaterThan(answerCard.id);
  expect((await state.prompt(task)).status).toBe("BLOCKED");
  expect((await state.history(task)).remarks.length).toBe(remarksBefore);
  expect(await state.sessionsFor(task)).toHaveLength(1);
});
