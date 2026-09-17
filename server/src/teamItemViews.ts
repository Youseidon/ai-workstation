import { lineText, type TaskSummary } from "./telegramSummary.ts";
import { formatCard } from "./integrations/telegram/card.ts";
import type { RenderedView } from "./integrations/telegram/views.ts";
import { ITEM_GRANT_CAPABILITIES, type ItemGrantCapability } from "./teamGrants.ts";

export type TeamItemCommand = "task" | "status" | "access" | "help";

export interface ParsedTeamItemCommand {
  command: TeamItemCommand;
  itemReference: string | null;
}

export interface TeamItemViewState {
  promptStatus: string;
  operationalState: string;
  ownerWorkstation: string;
  memberLabels: string[];
  memberAccess?: Array<{ personId: string; label: string; capabilities: ItemGrantCapability[]; owner: boolean }>;
  now: Date;
}

export type TeamItemGrantedCommand =
  | { command: "context" | "resume" | "close" }
  | { command: "answer"; answer: string }
  | { command: "grant"; capabilities: ItemGrantCapability[] }
  | { command: "revoke"; capabilities: ItemGrantCapability[] };

export function parseTeamItemGrantedCommand(text: string, botUsername: string | null): TeamItemGrantedCommand | "other_bot" | null {
  const match = /^\/(context|resume|close|answer|grant|revoke)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]+?))?\s*$/i.exec(text.trim());
  if (!match) return null;
  if (match[2] !== undefined && (botUsername === null || match[2].toLowerCase() !== botUsername.toLowerCase())) return "other_bot";
  const command = match[1]!.toLowerCase();
  const argument = match[3]?.trim() ?? "";
  if (command === "answer") return argument === "" ? null : { command, answer: argument };
  if (command === "grant" || command === "revoke") {
    const requested = argument === "" && command === "revoke" ? "all" : argument.toLowerCase();
    if (requested === "all") return { command, capabilities: [...ITEM_GRANT_CAPABILITIES] };
    return ITEM_GRANT_CAPABILITIES.includes(requested as ItemGrantCapability)
      ? { command, capabilities: [requested as ItemGrantCapability] }
      : null;
  }
  return argument === "" ? { command: command as "context" | "resume" | "close" } : null;
}

export function parseTeamItemCommand(text: string, botUsername: string | null): ParsedTeamItemCommand | "other_bot" | null {
  const match = /^\/(task|status|access|help)(?:@([A-Za-z0-9_]+))?(?:\s+(awi1_[a-f0-9]{24}|#item_[a-f0-9]{24}))?\s*$/i.exec(text.trim());
  if (!match) return null;
  if (match[2] !== undefined && (botUsername === null || match[2].toLowerCase() !== botUsername.toLowerCase())) return "other_bot";
  return {
    command: match[1]!.toLowerCase() as TeamItemCommand,
    itemReference: match[3] ?? null,
  };
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
    const members = state.memberAccess !== undefined
      ? state.memberAccess.map(member => `${lineText(member.label, 64)}: ${member.owner ? "owner" : member.capabilities.length > 0 ? member.capabilities.join(", ") : "read only"}`)
      : state.memberLabels.length === 0
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

export function renderTeamItemContext(summary: TaskSummary): RenderedView {
  const lines = ["Item context", `Objective: ${summary.objective || summary.title}`];
  if (summary.completedWork?.length) lines.push("Completed:", ...summary.completedWork.slice(0, 8).map(item => `- ${item}`));
  if (summary.decisions?.length) lines.push("Decisions and assumptions:", ...summary.decisions.slice(0, 8).map(item => `- ${item}`));
  if (summary.importantFiles?.length) lines.push("Important files:", ...summary.importantFiles.slice(0, 8).map(item => `- ${item}`));
  if (summary.blockers?.length) lines.push("Open question:", summary.blockers[0]!.description);
  lines.push(summary.tag);
  return simpleView(lines);
}

export interface TeamItemAccessAction {
  ref: string;
  action: "grant" | "revoke";
  capability: ItemGrantCapability;
}

export interface TeamItemAccessMessage {
  kind: "team_item_access";
  itemId: string;
  text: string;
  entities: [];
  buttons: [];
  actions: TeamItemAccessAction[];
}

export function renderTeamItemAccessMessage(input: {
  itemId: string;
  ownerLabel: string;
  teammateLabel: string;
  capabilities: ItemGrantCapability[];
  actions: TeamItemAccessAction[];
}): TeamItemAccessMessage {
  const access = input.capabilities.length > 0 ? input.capabilities.join(", ") : "read only";
  return {
    kind: "team_item_access",
    itemId: input.itemId,
    text: `Item access\n${lineText(input.ownerLabel, 64)}: owner\n${lineText(input.teammateLabel, 64)}: ${access}\n#item_${input.itemId.slice(5)}`,
    entities: [],
    buttons: [],
    actions: input.actions,
  };
}

export function renderTeamItemActionCard(input: {
  itemId: string;
  title: string;
  detail: string;
  allowance?: string | null;
  actions: Array<{ ref: string; action: "save_human_response" | "answer_and_resume" | "resume_saved" | "grant" | "revoke" | "close_thread" }>;
}) {
  return {
    kind: "team_item_action",
    itemId: input.itemId,
    title: lineText(input.title, 120),
    detail: lineText(input.detail, 1000),
    allowance: input.allowance ? lineText(input.allowance, 200) : null,
    actions: input.actions,
  } as const;
}
