import { lineText, type TaskSummary } from "./telegramSummary.ts";
import { formatCard, renderedAge, withoutRenderedAge, type CardEntity } from "./integrations/telegram/card.ts";
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
  /** Who asked, so `/help` can list what that member may actually run (TM-T1-4). */
  askingPersonId?: string | null;
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

/** Always available to every roster member. */
const HELP_READ_ONLY = [
  "/task - Current item summary",
  "/status - Execution and decision state",
  "/access - Current access",
  "/help - Commands available here",
];

/** Unlocked one for one by the capability named beside it. */
const HELP_BY_CAPABILITY: Array<{ capability: ItemGrantCapability; line: string }> = [
  { capability: "context", line: "/context - Item context and open question" },
  { capability: "answer", line: "/answer <text> - Answer the open question" },
  { capability: "resume", line: "/resume - Resume with the saved answer" },
];

/** The owner's own commands, which no grant ever confers on anyone else. */
const HELP_OWNER_ONLY = [
  "/close - Close this thread and end every grant",
  "/grant <capability> - Grant access to the other member",
  "/revoke [capability] - Revoke access",
];

function simpleView(lines: string[]): RenderedView {
  return { kind: "view", text: lines.join("\n"), entities: [], buttons: [] };
}

function stateLabel(value: string): string {
  return value.toLowerCase().replaceAll("_", " ");
}

/** The `agent_run` states that mean the row has not ended; every other state is terminal. */
const OPEN_RUN_STATES = new Set(["STARTING", "RUNNING"]);

/**
 * The same task described from its completed state, for the anchor that stays in
 * the group as the item's permanent record (B13).
 *
 * Completion used to be marked in the hint line alone, so the card around it went
 * on describing the block the item finished in: the pilot's last anchor said the
 * item was complete, said it was blocked on a decision, told the reader nothing
 * would move until they chose, and showed the run still going. A finished item
 * asks the group for nothing, so the blocker, the recommendation and the "If you
 * wait" line are not part of its record, and a run the card is about to freeze is
 * stated as finished rather than as running: the prompt reaching DONE is the
 * agent's last word, whatever its own row still says for the next few seconds.
 *
 * `blockedAt` and the options are already absent on a finished prompt, because
 * `blockingStatus` answers only for a BLOCKED one; they are stated here so the
 * completed card does not depend on that from a distance.
 */
export function completedSummary(summary: TaskSummary): TaskSummary {
  return {
    ...summary,
    blockedAt: null,
    options: null,
    optionsOmitted: 0,
    blockers: null,
    recommendation: null,
    ifYouWait: "",
    history: {
      ...summary.history,
      runs: summary.history.runs.map(run => OPEN_RUN_STATES.has(run.state.toUpperCase()) ? { ...run, state: "FINISHED" } : run),
    },
  };
}

export function renderTeamItemAnchor(summary: TaskSummary, state: TeamItemViewState): RenderedView {
  const completed = state.promptStatus === "DONE" || state.promptStatus === "SKIPPED";
  const card = formatCard(completed ? completedSummary(summary) : summary, {
    hint: `${completed ? "Completed" : `State: ${stateLabel(state.operationalState)}`} · Owner: ${lineText(state.ownerWorkstation, 64)}`,
    now: state.now,
  });
  return { kind: "view", text: card.text, entities: card.entities, buttons: [] };
}

/** The card text of an anchor payload, or null for anything that is not one. */
function anchorText(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

/**
 * An anchor payload reduced to what a reader would call a change: everything but
 * the rendered age, which moves on its own and whose restatement is the churn B11
 * recorded. When the age is due a refresh, `teamItemAnchorAge` says so; it is never
 * something this comparison should discover.
 */
export function teamItemAnchorMaterial(payload: unknown): string {
  const text = anchorText(payload);
  if (text === null) return JSON.stringify(payload ?? null);
  const entities = (payload as { entities?: unknown }).entities;
  const stripped = withoutRenderedAge({ text, entities: Array.isArray(entities) ? entities as CardEntity[] : [] });
  return JSON.stringify({ ...(payload as object), ...stripped });
}

/** The age an anchor payload currently states, for deciding whether it is due a refresh (B11). */
export function teamItemAnchorAge(payload: unknown): string | null {
  const text = anchorText(payload);
  return text === null ? null : renderedAge(text);
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
  // `/help` answers for the member who asked: the read-only commands, plus the
  // ones their current grants unlock, plus the owner's own set when they are the
  // owner. An unidentified asker is told only what needs no grant.
  const asking = state.askingPersonId === undefined || state.askingPersonId === null
    ? undefined
    : state.memberAccess?.find(member => member.personId === state.askingPersonId);
  const granted = asking === undefined
    ? []
    : asking.owner
    ? [...HELP_BY_CAPABILITY.map(entry => entry.line), ...HELP_OWNER_ONLY]
    : HELP_BY_CAPABILITY.filter(entry => asking.capabilities.includes(entry.capability)).map(entry => entry.line);
  return simpleView(["Item commands", ...HELP_READ_ONLY, ...granted, summary.tag]);
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
