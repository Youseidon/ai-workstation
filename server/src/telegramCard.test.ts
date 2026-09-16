import assert from "node:assert/strict";
import test from "node:test";
import { cutUtf16, formatCard, TELEGRAM_TEXT_LIMIT } from "./integrations/telegram/card.ts";
import { formatTelegramMessage } from "./integrations/telegram/liveFormat.ts";
import { blockText, lineText, type TaskSummary } from "./telegramSummary.ts";

// Scenario IDs refer to docs/e2e-scenarios/l3-f3-a.md (slice A, RTC-23) and l3-a2.md (slice A2): the question card formatter.

const NOW = new Date("2026-09-16T14:16:00.000Z");
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

const summary = (overrides: Partial<TaskSummary> = {}): TaskSummary => ({
  promptId: 142,
  key: "142",
  tag: "#acme_t142",
  source: "brief",
  breadcrumb: { workstation: "jd-laptop", workspace: "ai-workstation", program: "Telegram L1", suite: "Live setup", step: { index: 2, total: 3 }, nextStep: "Pair the phone" },
  title: "Add live bot credential storage",
  blockedAt: at(14),
  options: null,
  optionsOmitted: 0,
  history: { runs: [{ provider: "grok", startedAt: at(20), state: "DONE" }], moreRuns: 0, blocks: 1, previousAnswer: null, morePreviousAnswers: 0 },
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
const card = (input: TaskSummary, options: { answer?: { label: "Your answer" | "Saved answer"; text: string } | null } = {}) => formatCard(input, { hint, now: NOW, ...options });
const utf16Slice = (text: string, offset: number, length: number) => text.slice(offset, offset + length);
const collapsed = (rendered: { text: string; entities: Array<{ offset: number; length: number }> }) => (rendered.entities[0] ? utf16Slice(rendered.text, rendered.entities[0].offset, rendered.entities[0].length) : "");

test("S-L3-A-01, S-L3-A2-09 (T0): sections run identifier, question, options, recommendation, then one collapsed blockquote", () => {
  const rendered = card(summary({ options: [{ label: "Red", advantages: ["On brand"], disadvantages: ["Clashes with the charts"] }, { label: "Blue", advantages: [], disadvantages: [] }] }));
  const lines = rendered.text.split("\n");
  assert.equal(lines[0], "#acme_t142");
  assert.equal(lines[1], "Task: Add live bot credential storage");
  assert.equal(lines[2], "blocked 14 min ago · jd-laptop · ai-workstation · Telegram L1 / Live setup · pipeline step 2/3");
  assert.deepEqual(lines.slice(3, 7), ["Blocked on:", "Which vault holds the token?", "The team has two.", "Action: Name the vault."]);
  assert.deepEqual(lines.slice(7, 11), ["Options:", "1. Red", "   Pros: On brand", "   Cons: Clashes with the charts"]);
  assert.equal(lines[11], "2. Blue", "an option without trade-offs has no empty Pros or Cons line");
  assert.equal(lines[12], "Agent recommends: Wait for your decision.");
  assert.equal(lines[13], "If you wait: This task and its pipeline stay paused; other workspaces continue.");
  assert.ok(rendered.text.includes(hint));
  assert.equal(rendered.entities.length, 1);
  assert.equal(rendered.entities[0]!.type, "expandable_blockquote");
  assert.equal(collapsed(rendered), [
    "Where it fits: Live setup, step 2/3; next: Pair the phone",
    "Goal: Store the live bot token outside the repository.",
    "So far: Wrote the loader; Added redaction; Documented setup · verification 41 passed, 0 failed",
    "",
    "History: first run, no previous answers.",
    "",
    "Decisions and assumptions:\n- Tokens never touch settings.json",
    "",
    "Important files:\n- server/src/credentials.ts",
    "",
    "Completed work:\n- Wrote the loader\n- Added redaction\n- Documented setup\n- Fourth item",
  ].join("\n"));
  assert.equal(rendered.entities[0]!.offset + rendered.entities[0]!.length, rendered.text.length);
});

test("S-L3-A-02/03, S-L3-A2-02 (T0): a remark-only or title-only summary has no empty sections and no options heading", () => {
  const bare = { objective: null, completedWork: null, verification: null, decisions: null, importantFiles: null, recommendation: null } as const;
  const remark = card(summary({ source: "remark", ...bare, blockers: [{ description: "Staging is down.\nAsk ops to restart it.", requiredAction: null }] }));
  assert.match(remark.text, /Blocked on:\nStaging is down\.\nAsk ops to restart it\./);
  for (const label of ["Goal:", "So far:", "Agent recommends:", "Action:", "Options:", "Pros:", "Cons:"]) assert.ok(!remark.text.includes(label), label);
  assert.doesNotMatch(remark.text, /\n\n\n/, "no empty line where a section would be");
  // Only context, history and details are collapsed, and the visible part is today's A layout plus the header.
  assert.equal(remark.text.split("\n\n")[0], ["#acme_t142", "Task: Add live bot credential storage", "blocked 14 min ago · jd-laptop · ai-workstation · Telegram L1 / Live setup · pipeline step 2/3", "Blocked on:", "Staging is down.", "Ask ops to restart it.", "If you wait: This task and its pipeline stay paused; other workspaces continue."].join("\n"));
  assert.equal(collapsed(remark), "Where it fits: Live setup, step 2/3; next: Pair the phone\n\nHistory: first run, no previous answers.");
  const title = card(summary({ source: "title", ...bare, blockers: null, blockedAt: null, breadcrumb: { ...summary().breadcrumb, step: null, nextStep: null }, history: { runs: [], moreRuns: 0, blocks: 0, previousAnswer: null, morePreviousAnswers: 0 } }));
  assert.deepEqual(title.text.split("\n").slice(0, 5), ["#acme_t142", "Task: Add live bot credential storage", "jd-laptop · ai-workstation · Telegram L1 / Live setup", "If you wait: This task and its pipeline stay paused; other workspaces continue.", ""]);
  assert.equal(collapsed(title), "History: first run, no previous answers.", "a task on no flowchart has no 'where it fits' line");
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

test("S-L3-A-05, S-L3-A2-10: the card never exceeds 4096 UTF-16 units and shrinks sections strictly in priority order", () => {
  const sizes = [0, 100, 1000, 4000, 20000];
  const sections = ["decisions", "objective", "completedWork", "recommendation"] as const;
  for (const section of sections) {
    for (const size of sizes) {
      const big = "w".repeat(size);
      const value = section === "objective" || section === "recommendation" ? big || null : size === 0 ? null : [big];
      const input = summary({ [section]: value, options: [{ label: "Red", advantages: ["On brand"], disadvantages: [] }] } as Partial<TaskSummary>);
      const rendered = card(input);
      assert.ok(rendered.text.length <= TELEGRAM_TEXT_LIMIT, `${section} ${size}: ${rendered.text.length}`);
      assert.ok(rendered.text.startsWith("#acme_t142\nTask: Add live bot credential storage\nblocked 14 min ago · "));
      assert.ok(rendered.text.includes("Which vault holds the token?\nThe team has two.\nAction: Name the vault."), "blocker and action are whole");
      assert.ok(rendered.text.includes("Options:\n1. Red\n   Pros: On brand"), "the options survive");
      assert.ok(rendered.text.includes(input.ifYouWait) && rendered.text.includes(hint));
      if (size >= 4000) assert.match(rendered.text, /Shortened for the phone: /);
    }
  }
  const fitting = card(summary());
  assert.ok(!fitting.text.includes("Shortened"), "a card that fits is not shortened");
  // Collapsed sections go first, in the documented order.
  const dropAll = card(summary({ decisions: ["d".repeat(2000)], importantFiles: ["f".repeat(2000)], objective: "o".repeat(2000), history: { runs: [{ provider: "grok", startedAt: at(20), state: "DONE" }, { provider: "grok", startedAt: at(40), state: "ERROR" }], moreRuns: 4, blocks: 2, previousAnswer: { text: "Red", at: at(30) }, morePreviousAnswers: 1 } }));
  assert.match(dropAll.text, /Shortened for the phone: details/);
  assert.ok(dropAll.text.indexOf("details") < dropAll.text.indexOf("history") || !dropAll.text.includes("history"), "details are named before history");
  // Exact-limit behaviour: pad the objective so the untouched card is 4095, 4096 and 4097 units long.
  const base = card(summary({ objective: "o" })).text.length;
  for (const target of [4095, 4096, 4097]) {
    const rendered = card(summary({ objective: "o".repeat(1 + target - base) }));
    assert.ok(rendered.text.length <= TELEGRAM_TEXT_LIMIT);
    assert.equal(rendered.text.includes("Shortened"), target > 4096, `target ${target}`);
  }
  // A larger lower-priority section never takes content from a higher one.
  const withBigDetails = card(summary({ decisions: ["d".repeat(20000)], objective: "keep me whole" }));
  assert.ok(collapsed(withBigDetails).includes("Goal: keep me whole"));
});

test("S-L3-A-06 (T0): twenty long blockers still yield one card within the limit that declares what it left out", () => {
  const blockers = Array.from({ length: 20 }, (_, index) => ({ description: `Blocker ${index} ${"b".repeat(400)}`, requiredAction: `Action ${index} ${"a".repeat(200)}` }));
  const rendered = card(summary({ blockers, breadcrumb: { ...summary().breadcrumb, workspace: "w".repeat(120) } }));
  assert.ok(rendered.text.length <= TELEGRAM_TEXT_LIMIT);
  assert.ok(rendered.text.includes(`blocked 14 min ago · jd-laptop · ${"w".repeat(120)} ·`), "the breadcrumb is whole");
  const kept = blockers.filter((blocker) => rendered.text.includes(blocker.description));
  assert.ok(kept.length > 0);
  for (const blocker of kept) assert.ok(rendered.text.includes(`Action: ${blocker.requiredAction}`), "a kept blocker keeps its action");
  assert.match(rendered.text, new RegExp(`and ${20 - kept.length} more blockers in the local app`));
  const answered = card(summary({ blockers }), { answer: { label: "Your answer", text: "Proceed" } });
  assert.ok(answered.text.length <= TELEGRAM_TEXT_LIMIT);
  assert.match(answered.text, /Your answer:\nProceed\n/, "a short answer survives many blockers");
  assert.ok(answered.text.includes(blockers[0]!.description), "the first blocker is always kept");
});

test("S-L3-A-07/08: entity offsets are UTF-16 indices and cuts never split surrogates, ZWJ sequences or combining marks", () => {
  for (const sample of ["😀 emoji", "\u{1f468}\u200d\u{1f469}\u200d\u{1f467} family", "🇦🇺 flag", "中文 CJK", "مرحبا Arabic", "e\u0301 combining"]) {
    const rendered = card(summary({ objective: sample, decisions: [sample] }));
    const [entity] = rendered.entities;
    assert.ok(entity!.offset + entity!.length <= rendered.text.length);
    assert.ok(collapsed(rendered).startsWith("Where it fits: "));
    assert.ok(collapsed(rendered).includes(sample));
  }
  assert.equal(cutUtf16("ab😀", 3), "ab");
  assert.equal(cutUtf16("abe\u0301x", 3), "ab");
  assert.equal(cutUtf16("a\u{1f468}\u200d\u{1f469}", 4), "a👨");
  for (let size = 3900; size < 4200; size += 7) {
    const rendered = card(summary({ objective: `${"😀".repeat(size / 2)}`, decisions: ["e\u0301".repeat(3000)] }));
    assert.ok(rendered.text.length <= TELEGRAM_TEXT_LIMIT);
    assert.doesNotMatch(rendered.text, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, `lone surrogate at size ${size}`);
    for (const entity of rendered.entities) assert.ok(entity.offset + entity.length <= rendered.text.length);
    assert.ok(JSON.parse(JSON.stringify(rendered.text)) === rendered.text);
  }
});

test("S-L3-A-10/11 (T0): markup characters stay literal and redaction happens before entity offsets are computed", () => {
  const markup = "<b>x</b> *bold* _it_ [click](https://example.com) `code` ||spoiler|| **>expandable &lt;b&gt; \\ /help @someone #tag";
  const rendered = formatTelegramMessage({ kind: "personal_question", promptId: 1, title: "t", execution: "", decision: "", receipt: "", question: "", actions: [], summary: summary({ title: lineText(markup), decisions: [blockText(markup)] }) }, () => null);
  assert.ok(rendered.text.includes(lineText(markup)));
  assert.deepEqual(rendered.entities.map((entity) => entity.type), ["expandable_blockquote"]);
  const secret = "sk-live-4f9a8b7c6d5e4f3a2b1c";
  const redacted = card(summary({ objective: blockText(`before ${secret} http://localhost:4000/admin`), decisions: [blockText(`inside ${secret} and Bearer abcdefghijklmnop`)] }));
  assert.ok(!redacted.text.includes(secret) && !redacted.text.includes("localhost"));
  assert.ok(collapsed(redacted).includes("- inside [redacted] and [redacted]"));
});

test("S-L3-A2-06/07 (T0): history lists the runs with their times, the block count and the previous answer", () => {
  const rendered = card(summary({ history: { runs: [{ provider: "grok", startedAt: at(10), state: "DONE" }, { provider: "claude", startedAt: at(70), state: "ERROR" }], moreRuns: 2, blocks: 2, previousAnswer: { text: "Red", at: at(65) }, morePreviousAnswers: 1 } }));
  // Local clock time, with the date when the moment is not the delivery day.
  const clock = (iso: string) => {
    const time = new Date(iso);
    const pad = (value: number) => String(value).padStart(2, "0");
    const stamp = `${pad(time.getHours())}:${pad(time.getMinutes())}`;
    return time.toDateString() === NOW.toDateString() ? stamp : `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${stamp}`;
  };
  const history = collapsed(rendered).split("\n\n").find((section) => section.startsWith("History:"))!;
  assert.deepEqual(history.split("\n"), [
    "History:",
    `- ${clock(at(10))} grok (done)`,
    `- ${clock(at(70))} claude (error)`,
    "and 2 more runs in the local app",
    "Blocked 2 times, including this one.",
    `Previous answer (${clock(at(65))}): Red`,
    "and 1 more answer in the local app",
  ]);
  const first = card(summary());
  assert.ok(collapsed(first).includes("History: first run, no previous answers."), "nothing is invented on a first run");
});

test("S-L3-A2 (T0): the age is computed at delivery and is absent when the task is not blocked", () => {
  assert.ok(card(summary({ blockedAt: at(0) })).text.includes("blocked just now · "));
  assert.ok(card(summary({ blockedAt: at(240) })).text.includes("blocked 4 hours ago · "));
  assert.ok(card(summary({ blockedAt: at(60 * 24 * 3) })).text.includes("blocked 3 days ago · "));
  const notBlocked = card(summary({ blockedAt: null }));
  assert.equal(notBlocked.text.split("\n")[2], "jd-laptop · ai-workstation · Telegram L1 / Live setup · pipeline step 2/3");
  assert.ok(!notBlocked.text.includes("blocked "));
});
