import type { PhoneDriver, PhoneMessage } from "./phone.ts";

/*
 * One PhoneDriver contract script (docs/e2e-scenarios/h6.md S-H6-08): the bot side calls
 * the Bot API directly, the phone side uses the driver, and every step yields a normalized
 * observation with ids masked. Running it on FakePhone and on TelegramUserPhone and
 * comparing the observations is the fake's primary fidelity check (plan 3, principle 3).
 * No other process may poll the bot while it runs.
 */

export interface BotProbe {
  /** Base URL without trailing slash and the bot token; requests go to `${baseUrl}/bot${token}/${method}`. */
  baseUrl: string;
  token: string;
  chatId: string;
}

export interface Observation {
  step: string;
  value: unknown;
}

type Envelope<T> = { ok: boolean; result: T; error_code?: number; description?: string };

async function call<T>(probe: BotProbe, method: string, body: Record<string, unknown>): Promise<Envelope<T>> {
  const response = await fetch(`${probe.baseUrl}/bot${probe.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await response.json()) as Envelope<T>;
}

type Update = { update_id: number; message?: { text?: string; reply_to_message?: { text?: string } }; callback_query?: { id: string; data?: string; message?: { text?: string } } };

class ProbeUpdates {
  private offset = 0;
  constructor(private readonly probe: BotProbe) {}

  /** Polls until `count` updates matching `predicate` arrived, confirming everything it reads. */
  async take(count: number, predicate: (update: Update) => boolean, timeoutMs = 30_000): Promise<Update[]> {
    const found: Update[] = [];
    const deadline = Date.now() + timeoutMs;
    while (found.length < count && Date.now() < deadline) {
      const polled = await call<Update[]>(this.probe, "getUpdates", { offset: this.offset, timeout: 2, allowed_updates: ["message", "callback_query"] });
      for (const update of polled.result ?? []) {
        this.offset = update.update_id + 1;
        if (predicate(update)) found.push(update);
      }
    }
    return found;
  }

  /** Every update still pending, confirmed. */
  drain(): Promise<Update[]> {
    return this.take(Number.MAX_SAFE_INTEGER, () => true, 3_000);
  }
}

const view = (message: PhoneMessage, index: (id: number | null) => string | null) => ({ text: message.text, buttons: message.buttons, fromBot: message.fromBot, edited: message.edited, replyTo: index(message.replyToId) });

export async function runPhoneContract(phone: PhoneDriver, probe: BotProbe, nonce: string): Promise<Observation[]> {
  const observations: Observation[] = [];
  const observe = (step: string, value: unknown) => observations.push({ step, value: JSON.parse(JSON.stringify(value).replaceAll(nonce, "<nonce>")) as unknown });
  const updates = new ProbeUpdates(probe);
  await updates.drain();
  const known: number[] = [];
  const index = (id: number | null) => (id === null ? null : known.includes(id) ? `message ${known.indexOf(id) + 1}` : "unknown message");
  const start = await phone.cursor();
  observe("no messages of this run yet", (await phone.messages()).filter((message) => message.id > start).length);

  const keyboard = { inline_keyboard: [[{ text: "Save answer", callback_data: `ct_save_${nonce}` }, { text: "Answer and resume", callback_data: `ct_resume_${nonce}` }]] };
  await call(probe, "sendMessage", { chat_id: probe.chatId, text: `contract ${nonce}: card`, reply_markup: keyboard });
  await call(probe, "sendMessage", { chat_id: probe.chatId, text: `contract ${nonce}: second` });
  const card = await phone.waitForBotMessage("the contract card", (message) => message.text.startsWith(`contract ${nonce}:`), { afterId: start });
  known.push(card.id);
  observe("first matching message after the cursor is the older one", view(card, index));

  const reply = await phone.send(`contract ${nonce}: *reply* <b>literal</b>`, { replyTo: card });
  known.push(reply.id);
  observe("reply as returned by send", view(reply, index));
  const [replyUpdate] = await updates.take(1, (update) => update.message?.text?.startsWith(`contract ${nonce}: *reply*`) === true);
  observe("reply as the bot receives it", { text: replyUpdate?.message?.text ?? null, replyToText: replyUpdate?.message?.reply_to_message?.text ?? null });

  const answered = phone.tap(card, "Save answer");
  const [tapUpdate] = await updates.take(1, (update) => update.callback_query?.data === `ct_save_${nonce}`);
  if (tapUpdate?.callback_query) await call(probe, "answerCallbackQuery", { callback_query_id: tapUpdate.callback_query.id, text: "Saved." });
  observe("tap answered by the bot", { toast: (await answered).toast, data: tapUpdate?.callback_query?.data ?? null, cardText: tapUpdate?.callback_query?.message?.text ?? null });

  const unanswered = await phone.tap(card, "Answer and resume");
  const late = await updates.take(1, (update) => update.callback_query?.data === `ct_resume_${nonce}`);
  observe("tap nobody answers", { toast: unanswered.toast, callbacksDeliveredLater: late.length });

  const missing = await phone.tap(card, "Missing").then(() => "resolved", (error: Error) => error.message.replace(/message \d+/, "message N"));
  observe("tap on a label the card does not have", missing);

  const cardMessageId = (await call<{ message_id: number }>(probe, "sendMessage", { chat_id: probe.chatId, text: `contract ${nonce}: editable`, reply_markup: keyboard })).result.message_id;
  const editable = await phone.waitForBotMessage("the editable card", (message) => message.text === `contract ${nonce}: editable`, { afterId: reply.id });
  known.push(editable.id);
  await call(probe, "editMessageText", { chat_id: probe.chatId, message_id: cardMessageId, text: `contract ${nonce}: edited once`, reply_markup: { inline_keyboard: [[keyboard.inline_keyboard[0]![1]!]] } });
  const once = await phone.waitForBotMessage("the first edit", (message) => message.id === editable.id && message.text.endsWith("edited once"), { afterId: reply.id });
  observe("edit that keeps one button", view(once, index));
  const notModified = await call(probe, "editMessageText", { chat_id: probe.chatId, message_id: cardMessageId, text: `contract ${nonce}: edited once`, reply_markup: { inline_keyboard: [[keyboard.inline_keyboard[0]![1]!]] } });
  observe("identical edit", { ok: notModified.ok, code: notModified.error_code ?? null, description: notModified.description?.split(":").slice(0, 2).join(":") ?? null });
  await call(probe, "editMessageText", { chat_id: probe.chatId, message_id: cardMessageId, text: `contract ${nonce}: edited twice` });
  const twice = await phone.waitForBotMessage("the second edit", (message) => message.id === editable.id && message.text.endsWith("edited twice"), { afterId: reply.id });
  observe("edit without markup removes the buttons", view(twice, index));

  const timeoutStarted = Date.now();
  const timeout = await phone.waitForBotMessage("a message that never comes", () => false, { afterId: start, timeoutMs: 1_500 }).then(() => "resolved", (error: Error) => error.message);
  observe("wait that times out", { message: timeout, withinBound: Date.now() - timeoutStarted < 1_500 + 5_000 });

  const all = (await phone.messages()).filter((message) => message.id > start);
  observe("messages of this run", all.map((message) => view(message, index)).map(({ text, fromBot }) => ({ text, fromBot })));
  observe("ids increase", all.every((message, i) => i === 0 || message.id > all[i - 1]!.id));
  await updates.drain();
  return observations;
}

/** Step-by-step differences between two runs of the contract; empty when the backends agree. */
export function observationDifferences(expected: Observation[], actual: Observation[]): string[] {
  const differences: string[] = [];
  for (let i = 0; i < Math.max(expected.length, actual.length); i += 1) {
    const left = expected[i];
    const right = actual[i];
    if (!left || !right || left.step !== right.step) {
      differences.push(`step ${i + 1}: expected "${left?.step ?? "(none)"}", got "${right?.step ?? "(none)"}"`);
      continue;
    }
    if (JSON.stringify(left.value) !== JSON.stringify(right.value)) differences.push(`${left.step}: expected ${JSON.stringify(left.value)}, got ${JSON.stringify(right.value)}`);
  }
  return differences;
}
