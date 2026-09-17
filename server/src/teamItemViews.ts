import { lineText, type TaskSummary } from "./telegramSummary.ts";
import { formatCard } from "./integrations/telegram/card.ts";
import type { RenderedView } from "./integrations/telegram/views.ts";

export type TeamItemCommand = "task" | "status" | "access" | "help";

export interface TeamItemViewState {
  promptStatus: string;
  operationalState: string;
  ownerWorkstation: string;
  memberLabels: string[];
  now: Date;
}

export function parseTeamItemCommand(text: string, botUsername: string | null): TeamItemCommand | "other_bot" | null {
  const match = /^\/(task|status|access|help)(?:@([A-Za-z0-9_]+))?\s*$/i.exec(text.trim());
  if (!match) return null;
  if (match[2] !== undefined && (botUsername === null || match[2].toLowerCase() !== botUsername.toLowerCase())) return "other_bot";
  return match[1]!.toLowerCase() as TeamItemCommand;
}

function simpleView(lines: string[]): RenderedView {
  return { kind: "view", text: lines.join("\n"), entities: [], buttons: [] };
}

function stateLabel(value: string): string {
  return value.toLowerCase().replaceAll("_", " ");
}

export function renderTeamItemAnchor(summary: TaskSummary, state: TeamItemViewState): RenderedView {
  const completed = state.promptStatus === "DONE" || state.promptStatus === "SKIPPED";
  const card = formatCard(summary, {
    hint: `${completed ? "Completed" : `State: ${stateLabel(state.operationalState)}`} · Owner: ${lineText(state.ownerWorkstation, 64)}`,
    now: state.now,
  });
  return { kind: "view", text: card.text, entities: card.entities, buttons: [] };
}

export function renderTeamItemView(command: TeamItemCommand, summary: TaskSummary, state: TeamItemViewState): RenderedView {
  if (command === "task") return renderTeamItemAnchor(summary, state);
  if (command === "status") {
    const awaitingDecision = state.operationalState === "AWAITING_RESPONSE";
    return simpleView([
      `Item status · ${lineText(state.ownerWorkstation, 64)}`,
      `Execution: ${stateLabel(state.promptStatus)}`,
      `Decision: ${awaitingDecision ? "waiting for the owner" : "none waiting"}`,
      "Receipt: no Team action is pending",
      `Owner workstation: ${lineText(state.ownerWorkstation, 64)}`,
      summary.tag,
    ]);
  }
  if (command === "access") {
    const members = state.memberLabels.length === 0
      ? ["Team members: read only"]
      : state.memberLabels.map((label) => `${lineText(label, 64)}: read only`);
    return simpleView(["Item access", ...members, "No open offer.", summary.tag]);
  }
  return simpleView([
    "Item commands",
    "/task - Current item summary",
    "/status - Execution and decision state",
    "/access - Current access",
    "/help - Commands available here",
    summary.tag,
  ]);
}
