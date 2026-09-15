import type { TaskSummary } from "../../telegramSummary.ts";

/*
 * Context-rich question cards (L3 slice A, RTC-23; user-flows section 2;
 * docs/e2e-scenarios/l3-f3-a.md). Renders a task summary general to specific,
 * within Telegram's 4096 UTF-16 unit limit, with the long detail inside one
 * expandable blockquote entity. No parse_mode is ever used, so task text is
 * always literal.
 *
 * Budget (operator questions 2 and 3, answered with the table's recommendations):
 * - Never shortened: breadcrumb, title, "If you wait", the reply hint.
 * - Blockers and their required actions are kept whole up to a per-item cap;
 *   as many as fit are listed and the rest are declared.
 * - The operator's answer on answer cards sits above the recommendation and is
 *   shown in full unless the card cannot hold it, which is declared (the buttons
 *   always submit the full text).
 * - When the card is too long, sections shrink or drop in this order: details
 *   (decisions, files, the full completed list), objective, progress and
 *   verification, recommendation; then blockers after the first; then the answer.
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

/** Cuts to at most `max` UTF-16 units, never inside a surrogate pair or before a combining mark. */
export function cutUtf16(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = Math.max(0, max);
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  while (end > 0 && /\p{M}|\u200d/u.test(value[end] ?? "")) end -= 1;
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

interface Shrinkable {
  name: string;
  lines: string;
}

export function formatCard(summary: TaskSummary, options: { answer?: CardAnswer | null; hint: string }): FormattedCard {
  const fixedHead = [breadcrumb(summary), `Task: ${summary.title}`];
  const tail = [`If you wait: ${summary.ifYouWait}`, "", options.hint];

  const blockerItems: string[][] = (summary.blockers ?? []).map((blocker) => [shorten(blocker.description, BLOCKER_ITEM_CAP), ...(blocker.requiredAction ? [`Action: ${shorten(blocker.requiredAction, BLOCKER_ITEM_CAP)}`] : [])]);
  const blockerLines = blockerItems.length > 0 ? ["Blocked on:", ...blockerItems.flat()] : [];

  const progressParts: string[] = [];
  if (summary.completedWork) progressParts.push(summary.completedWork.slice(0, 3).join("; "));
  if (summary.verification) progressParts.push(`verification ${summary.verification.passed} passed, ${summary.verification.failed} failed`);
  const shrinkable: Shrinkable[] = [];
  const recommendation = summary.recommendation ? `Agent recommends: ${summary.recommendation}` : "";
  const progress = progressParts.length > 0 ? `So far: ${progressParts.join(" · ")}` : "";
  const objective = summary.objective ? `Goal: ${summary.objective}` : "";
  const detailParts: string[] = [];
  if (summary.decisions) detailParts.push(["Decisions and assumptions:", ...summary.decisions.map((item) => `- ${item}`)].join("\n"));
  if (summary.importantFiles) detailParts.push(["Important files:", ...summary.importantFiles.map((item) => `- ${item}`)].join("\n"));
  if (summary.completedWork && summary.completedWork.length > 0) detailParts.push(["Completed work:", ...summary.completedWork.map((item) => `- ${item}`)].join("\n"));
  // Shrink order, lowest priority first.
  shrinkable.push({ name: "details", lines: detailParts.join("\n\n") }, { name: "goal", lines: objective }, { name: "progress", lines: progress }, { name: "recommendation", lines: recommendation });

  const answerLines = options.answer ? [`${options.answer.label}:`, options.answer.text] : [];
  const omitted: string[] = [];

  const assemble = (blockers: string[], answer: string[], parts: Record<string, string>, notes: string[]) => {
    const body: string[] = [...fixedHead];
    if (parts.goal) body.push(parts.goal);
    if (parts.progress) body.push(parts.progress);
    if (blockers.length > 0) body.push(...blockers);
    if (answer.length > 0) body.push("", ...answer);
    if (parts.recommendation) body.push(parts.recommendation);
    body.push(...tail);
    if (notes.length > 0) body.push(`Shortened for the phone: ${notes.join(", ")}. The local app has everything.`);
    let text = body.join("\n");
    const entities: CardEntity[] = [];
    if (parts.details) {
      text = `${text}\n\n`;
      entities.push({ type: "expandable_blockquote", offset: text.length, length: parts.details.length });
      text += parts.details;
    }
    return { text, entities };
  };

  const parts: Record<string, string> = Object.fromEntries(shrinkable.map((section) => [section.name, section.lines]));
  let blockers = blockerLines;
  let answer = answerLines;
  const build = () => assemble(blockers, answer, parts, omitted);
  const overBy = () => build().text.length - TELEGRAM_TEXT_LIMIT;
  for (const section of shrinkable) {
    if (overBy() <= 0) break;
    if (!parts[section.name]) continue;
    omitted.push(section.name);
    const room = parts[section.name]!.length - overBy();
    parts[section.name] = room >= 60 ? shorten(parts[section.name]!, room) : "";
  }
  // Then blockers: keep whole items (a blocker with its action) while they fit and declare the rest,
  // always keeping the first, so a short answer is never cut to make room for further blockers.
  for (let keep = blockerItems.length - 1; overBy() > 0 && keep >= 1; keep -= 1) {
    const dropped = blockerItems.length - keep;
    blockers = ["Blocked on:", ...blockerItems.slice(0, keep).flat(), `and ${dropped} more blocker${dropped === 1 ? "" : "s"} in the local app`];
  }
  // Last, a very long answer; the buttons still submit it in full.
  if (overBy() > 0 && answer.length > 0) {
    const marker = " [shortened; the buttons submit your full answer]";
    omitted.push("answer");
    const kept = Math.max(0, answer[1]!.length - overBy() - marker.length);
    answer = [answer[0]!, `${cutUtf16(answer[1]!, kept).trimEnd()}${marker}`];
  }
  const card = build();
  if (card.text.length > TELEGRAM_TEXT_LIMIT) {
    // Only an extreme breadcrumb or title can get here; the Bot API would refuse the card, so cut the end.
    const text = cutUtf16(card.text, TELEGRAM_TEXT_LIMIT);
    return { text, entities: card.entities.filter((entity) => entity.offset + entity.length <= text.length) };
  }
  return card;
}
