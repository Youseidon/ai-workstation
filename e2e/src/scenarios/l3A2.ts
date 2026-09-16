import { expect } from "@playwright/test";
import { state } from "../drivers/state.ts";
import { runSavedTask, waitForRunEnd } from "../scenarios.ts";
import type { L1Context } from "./l1.ts";
import { executeRuns, humanResponses, questionCard, receipts, replyWithAnswer, tapAndReport, waitForPromptStatus } from "./l1Flows.ts";
import { BRIEF, blockWithBrief } from "./l3A.ts";
import { command } from "./l3B.ts";

/*
 * L3 slice A2 scenarios (docs/e2e-scenarios/l3-a2.md): a card the operator can decide from.
 * The card is read on the phone; the answer path behind it must stay exactly S-L1-05.
 */

let sequence = 0;
const label = (base: string) => `${base} ${++sequence}`;

const OPTIONS = [
  { label: "Ship red", advantages: ["On brand", "Ready today"], disadvantages: ["Clashes with the charts"] },
  { label: "Ship blue", advantages: ["Matches the charts"], disadvantages: ["Needs a new palette"] },
];

const collapsed = (text: string, entities: Array<{ type: string; offset: number; length: number }>) => {
  const entity = entities.find((item) => item.type === "expandable_blockquote");
  return entity ? text.slice(entity.offset, entity.offset + entity.length) : "";
};

/** S-L3-A2-11: a card with every section, whose answer path is unchanged from S-L1-05. */
export async function decidableCard(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const title = label("Decide the report colour");
  const { task, card } = await blockWithBrief(ctx, title, BRIEF, [{ behavior: "consume-answer", expectInContext: "Ship red" }], OPTIONS);
  const lines = card.text.split("\n");
  expect(lines[0]).toMatch(/^#[A-Za-z0-9_]*[A-Za-z][A-Za-z0-9_]*$/);
  expect(lines[0]).toContain(`_t${task.promptId}`);
  expect(lines[1]).toBe(`Task: ${title}`);
  expect(lines[2]).toMatch(/^blocked [^·]+ · .+ · .+ \/ .+$/);
  expect(lines.slice(3, 7)).toEqual(["Blocked on:", "The brand guide allows red or blue.", "Marketing has not chosen.", "Action: Pick red or blue."]);
  expect(lines.slice(7, 12)).toEqual(["Options:", "1. Ship red", "   Pros: On brand; Ready today", "   Cons: Clashes with the charts", "2. Ship blue"]);
  expect(lines.slice(12, 14)).toEqual(["   Pros: Matches the charts", "   Cons: Needs a new palette"]);
  expect(lines[14]).toBe("Agent recommends: Wait for your decision.");
  expect(lines[15]).toMatch(/^If you wait: /);
  expect(card.text).toContain("Reply to this message with your answer.");
  const details = collapsed(card.text, card.entities);
  // This task is on no flowchart, so the collapsed context opens with the goal and has no "where it fits" line.
  expect(details).toMatch(/^Goal: Produce the quarterly report in the brand colour\./);
  expect(details).not.toContain("Where it fits:");
  expect(details).toContain("History:");
  expect(details).toContain("Decisions and assumptions:\n- Charts use the existing palette");
  // The answer path behind the card is exactly S-L1-05.
  const answerCard = await replyWithAnswer(phone, card, "Ship red");
  expect(answerCard.text).toContain("Your answer:\nShip red");
  expect(answerCard.buttons).toEqual(["Save answer", "Answer and resume"]);
  await tapAndReport(phone, answerCard, "Answer and resume", /^Done: Answer saved and resume requested\./);
  await waitForPromptStatus(task, "DONE");
  expect(await executeRuns(task)).toHaveLength(2);
  expect(await humanResponses(task)).toEqual(["Ship red"]);
  expect(receipts(harness, task).filter((receipt) => receipt.state === "APPLIED")).toHaveLength(1);
}

/** S-L3-A2-12: a blocker-only card shows the identifier, the blocker and the action, with no empty sections. */
export async function blockerOnlyCard(ctx: L1Context): Promise<void> {
  const { harness, phone } = ctx;
  const title = label("Restart the queue");
  const before = await phone.cursor();
  const { task, runId } = await runSavedTask(harness, { title, scenarios: [{ behavior: "block-on-decision", remarkKind: "BLOCKER", reason: "The queue host is down.", humanAction: "Restart the queue host." }] });
  await waitForRunEnd(task, runId);
  const card = await questionCard(phone, title, before);
  const lines = card.text.split("\n");
  expect(lines[0]).toContain(`_t${task.promptId}`);
  expect(lines[1]).toBe(`Task: ${title}`);
  expect(lines[2]).toMatch(/^blocked [^·]+ · /);
  expect(card.text).toContain("Blocked on:\nThe queue host is down.");
  expect(card.text).toContain("Required human action: Restart the queue host.");
  for (const empty of ["Goal:", "So far:", "Options:", "Agent recommends:", "Pros:", "Cons:"]) expect(card.text).not.toContain(empty);
  expect(card.text).not.toMatch(/\n\n\n/);
  // Only context and history are collapsed; nothing above the blockquote is a heading with nothing after it.
  expect(collapsed(card.text, card.entities)).toContain("History:");
}

/** S-L3-A2-13: /task shows the same sections, from the same summary, within the view budget. */
export async function taskViewMatchesCard(ctx: L1Context): Promise<void> {
  const title = label("View the decision");
  const { task, card } = await blockWithBrief(ctx, title, BRIEF, [], OPTIONS);
  const view = await command(ctx, `/task ${task.promptId}`, new RegExp(`\\nTask: ${title}\\n`));
  expect(view.text.length).toBeLessThanOrEqual(4096);
  const lines = view.text.split("\n");
  expect(lines[0]).toBe(card.text.split("\n")[0]);
  expect(lines[2]).toMatch(/^blocked [^·]+ · /);
  for (const section of ["Blocked on:", "Options:", "1. Ship red", "   Pros: On brand; Ready today", "Agent recommends: ", "If you wait: "]) expect(view.text).toContain(section);
  const details = collapsed(view.text, view.entities);
  expect(details).toContain("Goal: Produce the quarterly report in the brand colour.");
  expect(details).toContain("History:");
  expect(await state.get<{ item: { prompt: { status: string } } }>(`/api/prompts/${task.promptId}/activity`).then((activity) => activity.item.prompt.status)).toBe("BLOCKED");
}
