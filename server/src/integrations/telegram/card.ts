import type { TaskSummary, TaskSummaryOption } from "../../telegramSummary.ts";

/*
 * Question cards the operator can decide from (L3 slices A and A2, RTC-23;
 * user-flows section 2; docs/e2e-scenarios/l3-f3-a.md and l3-a2.md).
 * Renders a task summary in labelled sections, within Telegram's 4096 UTF-16 unit
 * limit, with context, history and details inside one expandable blockquote.
 * No parse_mode is ever used, so task text is always literal, and no model is ever
 * called while rendering: a card must not wait on a provider.
 *
 * Section order (A2), because a phone shows about twelve lines before a tap:
 *   1. identifier (the task tag), title, age and breadcrumb
 *   2. the question and its required action
 *   3. the options with their trade-offs
 *   4. the operator's answer, on answer cards
 *   5. the recommendation and what happens if you wait, then the reply hint
 *   6. collapsed: context ("where it fits", goal, progress), history, details
 * A section with no data is absent entirely: no heading, no empty line.
 *
 * Budget (operator questions 2 and 3 of l3-f3-a.md, and l3-a2.md):
 * - Never shortened: the tag, title, age, breadcrumb, "If you wait", the reply hint.
 * - Blockers and their required actions are kept whole up to a per-item cap;
 *   as many as fit are listed and the rest are declared.
 * - When the card is too long, sections shrink or drop in this order: details,
 *   history, context, recommendation; then blockers after the first; then the
 *   answer; then, only as a last resort, the options. Every shortening is declared.
 */

export const TELEGRAM_TEXT_LIMIT = 4096;
const BLOCKER_ITEM_CAP = 900;
const SHORTENED = " [shortened]";

export interface CardEntity {
  type: "expandable_blockquote";
  offset: number;
  length: number;
}

export interface FormattedCard {
  text: string;
  entities: CardEntity[];
}

export interface CardAnswer {
  label: "Your answer" | "Saved answer";
  text: string;
}

export interface CardOptions {
  answer?: CardAnswer | null;
  hint: string;
  /** Delivery time: the card states the age it had when it was sent, and is not edited as it ages. */
  now?: Date;
}

/** Cuts to at most `max` UTF-16 units, never inside a surrogate pair or before a combining mark. */
export function cutUtf16(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = Math.max(0, max);
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  while (end > 0 && /\p{M}|‍/u.test(value[end] ?? "")) end -= 1;
  if (end > 0 && value.charCodeAt(end - 1) === 0x200d) end -= 1;
  return value.slice(0, end);
}

function shorten(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${cutUtf16(value, Math.max(0, max - SHORTENED.length)).trimEnd()}${SHORTENED}`;
}

function breadcrumb(summary: TaskSummary): string {
  const { breadcrumb: crumb } = summary;
  const parts = [crumb.workstation, crumb.workspace, `${crumb.program} / ${crumb.suite}`];
  if (crumb.step) parts.push(`pipeline step ${crumb.step.index}/${crumb.step.total}`);
  return parts.join(" · ");
}

/** "blocked 14 min ago", computed at delivery; absent when the task is not blocked. */
export function ageText(blockedAt: string | null, now: Date): string | null {
  if (blockedAt === null) return null;
  const at = Date.parse(blockedAt);
  if (Number.isNaN(at)) return null;
  const minutes = Math.floor(Math.max(0, now.getTime() - at) / 60_000);
  if (minutes < 1) return "blocked just now";
  if (minutes < 90) return `blocked ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `blocked ${hours} hours ago`;
  return `blocked ${Math.floor(hours / 24)} days ago`;
}

/** Local clock time, with the date when the moment is not today. */
function clock(at: string, now: Date): string {
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${pad(time.getHours())}:${pad(time.getMinutes())}`;
  return time.toDateString() === now.toDateString() ? stamp : `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${stamp}`;
}

function optionLines(options: TaskSummaryOption[], omitted: number): string {
  const lines = ["Options:"];
  options.forEach((option, index) => {
    lines.push(`${index + 1}. ${option.label}`);
    if (option.advantages.length > 0) lines.push(`   Pros: ${option.advantages.join("; ")}`);
    if (option.disadvantages.length > 0) lines.push(`   Cons: ${option.disadvantages.join("; ")}`);
  });
  if (omitted > 0) lines.push(`and ${omitted} more option${omitted === 1 ? "" : "s"} in the local app`);
  return lines.join("\n");
}

function historyLines(summary: TaskSummary, now: Date): string {
  const { history } = summary;
  if (history.runs.length <= 1 && history.moreRuns === 0 && history.blocks <= 1 && history.previousAnswer === null) {
    return "History: first run, no previous answers.";
  }
  const lines = ["History:"];
  for (const run of history.runs) lines.push(`- ${clock(run.startedAt, now)} ${run.provider} (${run.state.toLowerCase()})`);
  if (history.moreRuns > 0) lines.push(`and ${history.moreRuns} more run${history.moreRuns === 1 ? "" : "s"} in the local app`);
  if (history.blocks > 0) lines.push(history.blocks === 1 ? "Blocked once, now." : `Blocked ${history.blocks} times, including this one.`);
  if (history.previousAnswer) {
    lines.push(`Previous answer (${clock(history.previousAnswer.at, now)}): ${history.previousAnswer.text}`);
    if (history.morePreviousAnswers > 0) lines.push(`and ${history.morePreviousAnswers} more answer${history.morePreviousAnswers === 1 ? "" : "s"} in the local app`);
  } else {
    lines.push("No previous answers.");
  }
  return lines.join("\n");
}

function contextLines(summary: TaskSummary): string {
  const lines: string[] = [];
  const { step, nextStep, suite } = summary.breadcrumb;
  if (step) lines.push(`Where it fits: ${suite}, step ${step.index}/${step.total}; ${nextStep ? `next: ${nextStep}` : "this is the last step"}`);
  if (summary.objective) lines.push(`Goal: ${summary.objective}`);
  const progressParts: string[] = [];
  if (summary.completedWork) progressParts.push(summary.completedWork.slice(0, 3).join("; "));
  if (summary.verification) progressParts.push(`verification ${summary.verification.passed} passed, ${summary.verification.failed} failed`);
  if (progressParts.length > 0) lines.push(`So far: ${progressParts.join(" · ")}`);
  return lines.join("\n");
}

function detailLines(summary: TaskSummary): string {
  const parts: string[] = [];
  if (summary.decisions) parts.push(["Decisions and assumptions:", ...summary.decisions.map((item) => `- ${item}`)].join("\n"));
  if (summary.importantFiles) parts.push(["Important files:", ...summary.importantFiles.map((item) => `- ${item}`)].join("\n"));
  if (summary.completedWork && summary.completedWork.length > 0) parts.push(["Completed work:", ...summary.completedWork.map((item) => `- ${item}`)].join("\n"));
  return parts.join("\n\n");
}

/** Sections that shrink, lowest priority first. */
const SHRINK_ORDER = ["details", "history", "context", "recommendation"] as const;
/** The collapsed blockquote, in reading order. */
const COLLAPSED = ["context", "history", "details"] as const;

export function formatCard(summary: TaskSummary, options: CardOptions): FormattedCard {
  const now = options.now ?? new Date();
  const age = ageText(summary.blockedAt, now);
  const fixedHead = [summary.tag, `Task: ${summary.title}`, [age, breadcrumb(summary)].filter(Boolean).join(" · ")];
  const tail = [`If you wait: ${summary.ifYouWait}`, "", options.hint];

  const blockerItems: string[][] = (summary.blockers ?? []).map((blocker) => [shorten(blocker.description, BLOCKER_ITEM_CAP), ...(blocker.requiredAction ? [`Action: ${shorten(blocker.requiredAction, BLOCKER_ITEM_CAP)}`] : [])]);
  const blockerLines = blockerItems.length > 0 ? ["Blocked on:", ...blockerItems.flat()] : [];
  const answerLines = options.answer ? [`${options.answer.label}:`, options.answer.text] : [];

  const parts: Record<string, string> = {
    details: detailLines(summary),
    history: historyLines(summary, now),
    context: contextLines(summary),
    recommendation: summary.recommendation ? `Agent recommends: ${summary.recommendation}` : "",
  };
  let optionsText = summary.options ? optionLines(summary.options, summary.optionsOmitted) : "";
  const omitted: string[] = [];

  const assemble = (blockers: string[], answer: string[], notes: string[]) => {
    const body: string[] = [...fixedHead];
    if (blockers.length > 0) body.push(...blockers);
    if (optionsText) body.push(optionsText);
    if (answer.length > 0) body.push("", ...answer);
    if (parts.recommendation) body.push(parts.recommendation);
    body.push(...tail);
    if (notes.length > 0) body.push(`Shortened for the phone: ${notes.join(", ")}. The local app has everything.`);
    let text = body.join("\n");
    const entities: CardEntity[] = [];
    const collapsed = COLLAPSED.map((name) => parts[name]).filter((section) => section).join("\n\n");
    if (collapsed) {
      text = `${text}\n\n`;
      entities.push({ type: "expandable_blockquote", offset: text.length, length: collapsed.length });
      text += collapsed;
    }
    return { text, entities };
  };

  let blockers = blockerLines;
  let answer = answerLines;
  const build = () => assemble(blockers, answer, omitted);
  const overBy = () => build().text.length - TELEGRAM_TEXT_LIMIT;
  for (const name of SHRINK_ORDER) {
    if (overBy() <= 0) break;
    if (!parts[name]) continue;
    omitted.push(name);
    const room = parts[name]!.length - overBy();
    parts[name] = room >= 60 ? shorten(parts[name]!, room) : "";
  }
  // Then blockers: keep whole items (a blocker with its action) while they fit and declare the rest,
  // always keeping the first, so a short answer is never cut to make room for further blockers.
  for (let keep = blockerItems.length - 1; overBy() > 0 && keep >= 1; keep -= 1) {
    const dropped = blockerItems.length - keep;
    blockers = ["Blocked on:", ...blockerItems.slice(0, keep).flat(), `and ${dropped} more blocker${dropped === 1 ? "" : "s"} in the local app`];
  }
  // Then a very long answer; the buttons still submit it in full.
  if (overBy() > 0 && answer.length > 0) {
    const marker = " [shortened; the buttons submit your full answer]";
    omitted.push("answer");
    const kept = Math.max(0, answer[1]!.length - overBy() - marker.length);
    answer = [answer[0]!, `${cutUtf16(answer[1]!, kept).trimEnd()}${marker}`];
  }
  // Last, the options, which the operator decides from: only an extreme set gets here.
  if (overBy() > 0 && optionsText) {
    omitted.push("options");
    optionsText = shorten(optionsText, Math.max(0, optionsText.length - overBy()));
  }
  const card = build();
  if (card.text.length > TELEGRAM_TEXT_LIMIT) {
    // Only an extreme breadcrumb or title can get here; the Bot API would refuse the card, so cut the end.
    const text = cutUtf16(card.text, TELEGRAM_TEXT_LIMIT);
    return { text, entities: card.entities.filter((entity) => entity.offset + entity.length <= text.length) };
  }
  return card;
}
