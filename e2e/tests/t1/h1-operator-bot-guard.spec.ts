import { expect, test } from "../../src/fixtures.ts";
import { eventually } from "../../src/drivers/state.ts";
import { telegramStatus } from "../../src/telegramFlows.ts";

// S-H1-04: a bot registered as the operator's own is refused before any getUpdates call.
const OPERATOR_BOT_ID = 700_424_242;
test.use({ harnessOptions: { telegram: { backend: "fake", botId: OPERATOR_BOT_ID }, serverEnv: { AGENT_CONSOLE_HARNESS_FORBIDDEN_BOT_IDS: `123,${OPERATOR_BOT_ID}` } } });

test("S-H1-04, S-H6-17 (fake): the harness server refuses to poll the operator's bot", async ({ harness }) => {
  const status = await eventually("the guard to refuse the bot", async () => {
    const current = await telegramStatus();
    return current.state === "auth_failed" ? current : undefined;
  });
  expect(status.reason).toContain(String(OPERATOR_BOT_ID));
  expect(status.reason).not.toContain(harness.telegramBot!.token);
  const methods = harness.telegramServer!.calls.map((call) => call.method);
  expect(methods).toContain("getMe");
  expect(methods).not.toContain("getUpdates");
});
