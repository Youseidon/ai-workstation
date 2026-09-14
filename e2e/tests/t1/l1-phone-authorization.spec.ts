import { expect, test } from "../../src/fixtures.ts";
import { state } from "../../src/drivers/state.ts";
import * as l1 from "../../src/scenarios/l1.ts";
import { pairThroughApi, telegramStatus } from "../../src/telegramFlows.ts";

// L1 fake-backend-only scenarios: pairing authorization, duplicates, faults, strangers, secrets.
test.use({ harnessOptions: { fakeProvider: "live", telegram: { backend: "fake" } } });

const covers = (ids: string) => ({ annotation: { type: "covers", description: ids } });
type Fixtures = Parameters<Parameters<typeof test>[2]>[0];
const ctx = ({ harness, page }: Pick<Fixtures, "harness" | "page">) => ({ harness, page, phone: harness.phone! });
const ensurePaired = async (harness: Fixtures["harness"]) => {
  if ((await telegramStatus()).actors.length === 0) await pairThroughApi(harness.phone!);
};

test("S-L1-03: the phone pairs from the Agents page and the next blocked task's card arrives there", covers("RTC-18, H-L1-04, B02"), async ({ harness, page }) => {
  await l1.pairThenFirstCard(ctx({ harness, page }));
  for (const actor of (await telegramStatus()).actors) await state.delete(`/api/task-control/telegram/actors/${actor.id}`);
});
test("S-L1-04: pairing refuses group chats, cancelled codes and a code already used", covers("RTC-18, H-L1-04, T05, B02"), async ({ harness, page }) => {
  for (const actor of (await telegramStatus()).actors) await state.delete(`/api/task-control/telegram/actors/${actor.id}`);
  expect((await telegramStatus()).actors).toEqual([]);
  await l1.pairingAuthorization(ctx({ harness, page }), () => pairThroughApi(harness.phone!));
});
test("S-L1-08: duplicated message and callback updates apply once", covers("RTC-17, B23, I08"), async ({ harness, page }) => {
  await ensurePaired(harness);
  await l1.duplicateUpdates(ctx({ harness, page }));
});
for (const fault of ["outage", "5xx", "429"] as const) {
  test(`S-L1-16 (${fault}): a card queued during a Telegram fault is delivered exactly once`, covers("RTC-17, RTC-19, H-L1-11, T07, B07"), async ({ harness, page }) => {
    await ensurePaired(harness);
    await l1.faultsWhileQueued(ctx({ harness, page }), fault);
  });
}
test("S-L1-22: strangers and other chats cannot act on the operator's task", covers("H-L1-14, T03, B02, B09"), async ({ harness, page }) => {
  await ensurePaired(harness);
  await l1.strangersCannotAct(ctx({ harness, page }));
});
test("S-L1-28: the bot token never appears in DTOs, the database or agent environments", covers("RTC-18, H-L1-02, H-L1-17, I10"), async ({ harness, page }) => {
  await ensurePaired(harness);
  await l1.tokenNeverExposed(ctx({ harness, page }));
});

test("S-L1-18: a card whose send response was lost still yields one answer and one run", covers("protocol 7, B07, I08"), async ({ harness, page }) => {
  await ensurePaired(harness);
  await l1.lostSendResponse(ctx({ harness, page }));
});
test("S-L1-29: blocker text is redacted and replies are stored literally", covers("I10, H-M1-04"), async ({ harness, page }) => {
  await ensurePaired(harness);
  await l1.redactionAndLiteralReplies(ctx({ harness, page }));
});
test("S-L1-27: two paired chats keep actions bound to their own chat", covers("B02, B11, protocol 7"), async ({ harness, page }, testInfo) => {
  await ensurePaired(harness);
  const { cardsInSecondChat } = await l1.twoPairedChats(ctx({ harness, page }));
  testInfo.annotations.push({ type: "observed", description: `question cards fan out to every paired chat: ${cardsInSecondChat === 1 ? "yes" : "no"}` });
});
