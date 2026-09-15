import assert from "node:assert/strict";
import test from "node:test";
import { cutUtf16, formatCard, TELEGRAM_TEXT_LIMIT } from "./integrations/telegram/card.ts";
import { formatTelegramMessage } from "./integrations/telegram/liveFormat.ts";
import { blockText, lineText, type TaskSummary } from "./telegramSummary.ts";

// Scenario IDs refer to docs/e2e-scenarios/l3-f3-a.md (slice A, RTC-23): the question card formatter.

const summary = (overrides: Partial<TaskSummary> = {}): TaskSummary => ({
  promptId: 1,
  source: "brief",
  breadcrumb: { workstation: "jd-laptop", workspace: "ai-workstation", program: "Telegram L1", suite: "Live setup", step: { index: 2, total: 3 } },
  title: "Add live bot credential storage",
  objective: "Store the live bot token outside the repository.",
  completedWork: ["Wrote the loader", "Added redaction", "Documented setup", "Fourth item"],
  verification: { passed: 41, failed: 0 },
  blockers: [{ description: "Which vault holds the token?\nThe team has two.", requiredAction: "Name the vault." }],
  decisions: ["Tokens never touch settings.json"],
  importantFiles: ["server/src/credentials.ts"],
  recommendation: "Wait for your decision.",
  ifYouWait: "This task and its pipeline stay paused; other workspaces continue.",
  ...overrides,
});
const hint = "Reply to this message with your answer.";
const utf16Slice = (text: string, offset: number, length: number) => text.slice(offset, offset + length);

test("S-L3-A-01 (T0): sections run general to specific and the details sit in one expandable blockquote", () => {
  const card = formatCard(summary(), { hint });
  const lines = card.text.split("\n");
  assert.equal(lines[0], "jd-laptop · ai-workstation · Telegram L1 / Live setup · pipeline step 2/3");
  assert.equal(lines[1], "Task: Add live bot credential storage");
  assert.equal(lines[2], "Goal: Store the live bot token outside the repository.");
  assert.equal(lines[3], "So far: Wrote the loader; Added redaction; Documented setup · verification 41 passed, 0 failed");
  assert.deepEqual(lines.slice(4, 8), ["Blocked on:", "Which vault holds the token?", "The team has two.", "Action: Name the vault."]);
  assert.equal(lines[8], "Agent recommends: Wait for your decision.");
  assert.equal(lines[9], "If you wait: This task and its pipeline stay paused; other workspaces continue.");
  assert.ok(card.text.includes(hint));
  assert.equal(card.entities.length, 1);
  const [entity] = card.entities;
  assert.equal(entity!.type, "expandable_blockquote");
  const details = utf16Slice(card.text, entity!.offset, entity!.length);
  assert.equal(details, "Decisions and assumptions:\n- Tokens never touch settings.json\n\nImportant files:\n- server/src/credentials.ts\n\nCompleted work:\n- Wrote the loader\n- Added redaction\n- Documented setup\n- Fourth item");
  assert.equal(entity!.offset + entity!.length, card.text.length);
});

test("S-L3-A-02/03 (T0): a remark-only or title-only summary has no empty sections and no details entity", () => {
  const remark = formatCard(summary({ source: "remark", objective: null, completedWork: null, verification: null, decisions: null, importantFiles: null, recommendation: null, blockers: [{ description: "Staging is down.\nAsk ops to restart it.", requiredAction: null }] }), { hint });
  assert.deepEqual(remark.entities, []);
  assert.match(remark.text, /Blocked on:\nStaging is down\.\nAsk ops to restart it\./);
  for (const label of ["Goal:", "So far:", "Agent recommends:", "Action:"]) assert.ok(!remark.text.includes(label), label);
  const title = formatCard(summary({ source: "title", objective: null, completedWork: null, verification: null, decisions: null, importantFiles: null, recommendation: null, blockers: null }), { hint });
  assert.deepEqual(title.text.split("\n"), ["jd-laptop · ai-workstation · Telegram L1 / Live setup · pipeline step 2/3", "Task: Add live bot credential storage", "If you wait: This task and its pipeline stay paused; other workspaces continue.", "", hint]);
});

test("S-L3-A-04 (T0): answer and saved-answer cards keep the summary, show the answer in full and keep L1's buttons", () => {
  const payload = { kind: "personal_question", promptId: 1, title: "x", execution: "blocked", decision: "awaiting response", receipt: "", question: "q", summary: summary(), actions: [{ ref: "tc_save", action: "save_human_response" }, { ref: "tc_resume", action: "answer_and_resume" }] };
  const long = `${"Line with emoji 😀 and more text.\n".repeat(110)}end`;
  const answerCard = formatTelegramMessage(payload, () => long);
  assert.ok(answerCard.text.length <= TELEGRAM_TEXT_LIMIT);
  assert.ok(answerCard.text.includes("Blocked on:"));
  assert.ok(answerCard.text.includes("Your answer:"));
  assert.deepEqual(answerCard.replyMarkup!.inline_keyboard.flat().map((button) => button.text), ["Save answer", "Answer and resume"]);
  if (!answerCard.text.includes(long)) assert.match(answerCard.text, /\[shortened; the buttons submit your full answer\]/);
  const red = formatTelegramMessage(payload, () => "Red");
  assert.match(red.text, /Your answer:\nRed/);
  const savedCard = formatTelegramMessage({ ...payload, actions: [{ ref: "tc_resume", action: "answer_and_resume" }] }, () => "Blue");
  assert.match(savedCard.text, /Saved answer:\nBlue/);
  assert.deepEqual(savedCard.replyMarkup!.inline_keyboard.flat().map((button) => button.text), ["Resume with saved answer"]);
  const legacy = formatTelegramMessage({ ...payload, summary: undefined }, () => null);
  assert.match(legacy.text, /^Task needs input: x/, "rows queued before slice A keep the L1 layout");
});

test("S-L3-A-05: the card never exceeds 4096 UTF-16 units and shrinks sections strictly in priority order", () => {
  const sizes = [0, 100, 1000, 4000, 20000];
  const sections = ["decisions", "objective", "completedWork", "recommendation"] as const;
  for (const section of sections) {
    for (const size of sizes) {
      const big = "w".repeat(size);
      const value = section === "objective" || section === "recommendation" ? big || null : size === 0 ? null : [big];
      const input = summary({ [section]: value } as Partial<TaskSummary>);
      const card = formatCard(input, { hint });
      assert.ok(card.text.length <= TELEGRAM_TEXT_LIMIT, `${section} ${size}: ${card.text.length}`);
      assert.ok(card.text.startsWith("jd-laptop · ai-workstation · Telegram L1 / Live setup · pipeline step 2/3\nTask: Add live bot credential storage\n"));
      assert.ok(card.text.includes("Which vault holds the token?\nThe team has two.\nAction: Name the vault."), "blocker and action are whole");
      assert.ok(card.text.includes(input.ifYouWait) && card.text.includes(hint));
      if (size >= 4000) assert.match(card.text, /Shortened for the phone: /);
    }
  }
  const fitting = formatCard(summary(), { hint });
  assert.ok(!fitting.text.includes("Shortened"), "a card that fits is not shortened");
  // Exact-limit behaviour: pad the objective so the untouched card is 4095, 4096 and 4097 units long.
  const base = formatCard(summary({ objective: "o" }), { hint }).text.length;
  for (const target of [4095, 4096, 4097]) {
    const card = formatCard(summary({ objective: "o".repeat(1 + target - base) }), { hint });
    assert.ok(card.text.length <= TELEGRAM_TEXT_LIMIT);
    assert.equal(card.text.includes("Shortened"), target > 4096, `target ${target}`);
  }
  // A larger lower-priority section never takes content from a higher one.
  const withBigDetails = formatCard(summary({ decisions: ["d".repeat(20000)], objective: "keep me whole" }), { hint });
  assert.ok(withBigDetails.text.includes("Goal: keep me whole"));
});

test("S-L3-A-06 (T0): twenty long blockers still yield one card within the limit that declares what it left out", () => {
  const blockers = Array.from({ length: 20 }, (_, index) => ({ description: `Blocker ${index} ${"b".repeat(400)}`, requiredAction: `Action ${index} ${"a".repeat(200)}` }));
  const card = formatCard(summary({ blockers, breadcrumb: { ...summary().breadcrumb, workspace: "w".repeat(120) } }), { hint });
  assert.ok(card.text.length <= TELEGRAM_TEXT_LIMIT);
  assert.ok(card.text.startsWith(`jd-laptop · ${"w".repeat(120)} ·`), "the breadcrumb is whole");
  const kept = blockers.filter((blocker) => card.text.includes(blocker.description));
  assert.ok(kept.length > 0);
  for (const blocker of kept) assert.ok(card.text.includes(`Action: ${blocker.requiredAction}`), "a kept blocker keeps its action");
  assert.match(card.text, new RegExp(`and ${20 - kept.length} more blockers in the local app`));
  const answered = formatCard(summary({ blockers }), { hint, answer: { label: "Your answer", text: "Proceed" } });
  assert.ok(answered.text.length <= TELEGRAM_TEXT_LIMIT);
  assert.match(answered.text, /Your answer:\nProceed\n/, "a short answer survives many blockers");
  assert.ok(answered.text.includes(blockers[0]!.description), "the first blocker is always kept");
});

test("S-L3-A-07/08: entity offsets are UTF-16 indices and cuts never split surrogates, ZWJ sequences or combining marks", () => {
  for (const sample of ["😀 emoji", "👨\u200d👩\u200d👧 family", "🇦🇺 flag", "中文 CJK", "مرحبا Arabic", "é combining"]) {
    const card = formatCard(summary({ objective: sample, decisions: [sample] }), { hint });
    const [entity] = card.entities;
    assert.ok(entity!.offset + entity!.length <= card.text.length);
    assert.ok(utf16Slice(card.text, entity!.offset, entity!.length).startsWith("Decisions and assumptions:\n- "));
    assert.ok(utf16Slice(card.text, entity!.offset, entity!.length).includes(sample));
  }
  assert.equal(cutUtf16("ab😀", 3), "ab");
  assert.equal(cutUtf16("abéx", 3), "ab");
  assert.equal(cutUtf16("a👨\u200d👩", 4), "a👨");
  for (let size = 3900; size < 4200; size += 7) {
    const card = formatCard(summary({ objective: `${"😀".repeat(size / 2)}`, decisions: ["é".repeat(3000)] }), { hint });
    assert.ok(card.text.length <= TELEGRAM_TEXT_LIMIT);
    assert.doesNotMatch(card.text, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, `lone surrogate at size ${size}`);
    for (const entity of card.entities) assert.ok(entity.offset + entity.length <= card.text.length);
    assert.ok(JSON.parse(JSON.stringify(card.text)) === card.text);
  }
});

test("S-L3-A-10/11 (T0): markup characters stay literal and redaction happens before entity offsets are computed", () => {
  const markup = "<b>x</b> *bold* _it_ [click](https://example.com) `code` ||spoiler|| **>expandable &lt;b&gt; \\ /help @someone #tag";
  const card = formatTelegramMessage({ kind: "personal_question", promptId: 1, title: "t", execution: "", decision: "", receipt: "", question: "", actions: [], summary: summary({ title: lineText(markup), decisions: [blockText(markup)] }) }, () => null);
  assert.ok(card.text.includes(lineText(markup)));
  assert.deepEqual(card.entities.map((entity) => entity.type), ["expandable_blockquote"]);
  const secret = "sk-live-4f9a8b7c6d5e4f3a2b1c";
  const redacted = formatCard(summary({ objective: blockText(`before ${secret} http://localhost:4000/admin`), decisions: [blockText(`inside ${secret} and Bearer abcdefghijklmnop`)] }), { hint });
  assert.ok(!redacted.text.includes(secret) && !redacted.text.includes("localhost"));
  const [entity] = redacted.entities;
  assert.equal(utf16Slice(redacted.text, entity!.offset, entity!.length).split("\n")[1], "- inside [redacted] and [redacted]");
});
