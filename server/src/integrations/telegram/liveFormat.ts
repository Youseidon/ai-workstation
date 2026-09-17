import type { TaskControlAction } from "@agent-console/shared";
import type { TaskSummary } from "../../telegramSummary.ts";
import { TelegramApiError } from "./botApi.ts";
import { formatCard, type CardEntity } from "./card.ts";

export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

export interface FormattedTelegramMessage {
  text: string;
  replyMarkup: { inline_keyboard: TelegramInlineButton[][] } | null;
  /** Message entities with UTF-16 offsets; never a parse_mode. */
  entities: CardEntity[];
}

/** Plain text notice enqueued by the live runtime (receipts, pairing, help). */
export interface TelegramTextPayload {
  kind: "text";
  text: string;
}

const MAX_TEXT = 4000;
const MAX_ANSWER_PREVIEW = 1500;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Renderer states are enum-like (`awaiting_response`); a phone should read words. */
function humanize(text: string): string {
  return text.replace(/_/g, " ");
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function actions(value: unknown): Array<{ ref: string; action: TaskControlAction }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    const item = record(entry);
    if (!item || typeof item.ref !== "string") return [];
    if (item.action !== "save_human_response" && item.action !== "answer_and_resume") return [];
    return [{ ref: item.ref, action: item.action }];
  });
}

/**
 * Turns a durable outbox payload into a Telegram message. Plain text only, no
 * parse_mode, so task titles and answers can never inject markup.
 *
 * A button is shown only when an answer is bound to its action reference:
 * a Telegram button carries no text, so a tap without a bound answer has
 * nothing to save. The question card itself asks for a reply instead.
 */
export function formatTelegramMessage(payload: unknown, contentForRef: (ref: string) => string | null): FormattedTelegramMessage {
  const data = record(payload);
  switch (data?.kind) {
    case "text":
      return { text: clip(str(data.text), MAX_TEXT), replyMarkup: null, entities: [] };
    case "quota_warning": {
      const choices = Array.isArray(data.choices) ? data.choices.filter((choice): choice is string => typeof choice === "string") : [];
      const lines = [`Quota warning (${str(data.provider)}, ${str(data.window)})`, "", str(data.message)];
      if (choices.length > 0) lines.push("", `Choices in the local app: ${choices.join(", ")}.`, "Nothing changes until you act.");
      return { text: clip(lines.join("\n"), MAX_TEXT), replyMarkup: null, entities: [] };
    }
    case "view": {
      // Read-only status views (slice B): navigation buttons carry nv_ data, never an action reference.
      const rows = Array.isArray(data.buttons) ? data.buttons : [];
      const keyboard = rows.map(row => (Array.isArray(row) ? row : []).flatMap(button => {
        const item = record(button);
        return item && typeof item.text === "string" && typeof item.data === "string" && item.data.startsWith("nv_") ? [{ text: item.text, callback_data: item.data }] : [];
      })).filter(row => row.length > 0);
      const entities = Array.isArray(data.entities) ? data.entities as CardEntity[] : [];
      return { text: str(data.text), replyMarkup: keyboard.length > 0 ? { inline_keyboard: keyboard } : null, entities };
    }
    case "team_thread_request":
      return { text: clip(str(data.text), MAX_TEXT), replyMarkup: null, entities: [] };
    case "team_thread_confirmation": {
      const buttons = Array.isArray(data.actions) ? data.actions.flatMap(entry => {
        const action = record(entry);
        if (action === null || typeof action.ref !== "string") return [];
        if (action.decision !== "confirm" && action.decision !== "decline") return [];
        return [{ text: action.decision === "confirm" ? "Confirm thread" : "Decline", callback_data: action.ref }];
      }) : [];
      const lines = [
        "Team thread request",
        "",
        `${str(data.requesterLabel)} asked to discuss: ${str(data.title)}`,
        "Confirming shares a sanitized Team summary in the team group.",
      ];
      return { text: clip(lines.join("\n"), MAX_TEXT), replyMarkup: buttons.length > 0 ? { inline_keyboard: buttons.map(button => [button]) } : null, entities: [] };
    }
    case "team_item_access": {
      const buttons = Array.isArray(data.actions) ? data.actions.flatMap(entry => {
        const action = record(entry);
        if (action === null || typeof action.ref !== "string" || typeof action.capability !== "string") return [];
        if (action.action !== "grant" && action.action !== "revoke") return [];
        const verb = action.action === "grant" ? "Grant" : "Revoke";
        return [{ text: `${verb} ${action.capability}`, callback_data: action.ref }];
      }) : [];
      return {
        text: clip(str(data.text), MAX_TEXT),
        replyMarkup: buttons.length > 0 ? { inline_keyboard: buttons.map(button => [button]) } : null,
        entities: [],
      };
    }
    case "team_item_action": {
      const labels: Partial<Record<TaskControlAction, string>> = {
        save_human_response: "Save answer",
        answer_and_resume: "Answer and resume",
        resume_saved: "Resume with saved answer",
        grant: "Grant",
        revoke: "Revoke",
        close_thread: "Close thread",
      };
      const buttons = Array.isArray(data.actions) ? data.actions.flatMap(entry => {
        const action = record(entry);
        if (action === null || typeof action.ref !== "string" || typeof action.action !== "string") return [];
        const label = labels[action.action as TaskControlAction];
        return label === undefined ? [] : [{ text: label, callback_data: action.ref }];
      }) : [];
      const lines = [str(data.title), "", str(data.detail)];
      if (typeof data.allowance === "string" && data.allowance !== "") lines.push("", str(data.allowance));
      return { text: clip(lines.join("\n"), MAX_TEXT), replyMarkup: buttons.length > 0 ? { inline_keyboard: buttons.map(button => [button]) } : null, entities: [] };
    }
    case "personal_question": {
      const bound = actions(data.actions).map(entry => ({ ...entry, content: contentForRef(entry.ref) }));
      const draft = bound.find(entry => entry.action === "save_human_response" && entry.content !== null)?.content ?? null;
      const saved = draft === null ? bound.find(entry => entry.action === "answer_and_resume" && entry.content !== null)?.content ?? null : null;
      const buttons: TelegramInlineButton[] = [];
      if (draft !== null) {
        for (const entry of bound) {
          if (entry.content === null) continue;
          buttons.push({ text: entry.action === "save_human_response" ? "Save answer" : "Answer and resume", callback_data: entry.ref });
        }
      } else if (saved !== null) {
        const resume = bound.find(entry => entry.action === "answer_and_resume" && entry.content !== null);
        if (resume) buttons.push({ text: "Resume with saved answer", callback_data: resume.ref });
      }
      const replyMarkup = buttons.length > 0 ? { inline_keyboard: buttons.map(button => [button]) } : null;
      // L3 cards carry the task summary (slice A); rows queued by the L1 code keep the L1 layout.
      const summary = record(data.summary) as TaskSummary | null;
      if (summary !== null) {
        const card = formatCard(summary, draft !== null
          ? { answer: { label: "Your answer", text: draft }, hint: "Save answer keeps the task waiting. Answer and resume continues it." }
          : saved !== null
            ? { answer: { label: "Saved answer", text: saved }, hint: "Reply to this message to change it." }
            : { hint: "Reply to this message with your answer." });
        return { ...card, replyMarkup };
      }
      const lines = [
        `Task needs input: ${str(data.title)}`,
        `Status: ${humanize(str(data.execution))} · ${humanize(str(data.decision))}`,
        "",
        str(data.question),
        "",
      ];
      if (draft !== null) {
        lines.push("Your answer:", clip(draft, MAX_ANSWER_PREVIEW), "", "Save answer keeps the task waiting. Answer and resume continues it.");
      } else if (saved !== null) {
        lines.push("Saved answer:", clip(saved, MAX_ANSWER_PREVIEW), "", "Reply to this message to change it.");
      } else {
        lines.push("Reply to this message with your answer.");
      }
      return { text: clip(lines.join("\n"), MAX_TEXT), replyMarkup, entities: [] };
    }
    default:
      throw new TelegramApiError("rejected", `Unsupported Telegram outbox payload kind: ${String(data?.kind ?? "none")}.`);
  }
}
