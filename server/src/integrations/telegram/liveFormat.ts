import type { TaskControlAction } from "@agent-console/shared";
import { TelegramApiError } from "./botApi.ts";

export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

export interface FormattedTelegramMessage {
  text: string;
  replyMarkup: { inline_keyboard: TelegramInlineButton[][] } | null;
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
      return { text: clip(str(data.text), MAX_TEXT), replyMarkup: null };
    case "quota_warning": {
      const choices = Array.isArray(data.choices) ? data.choices.filter((choice): choice is string => typeof choice === "string") : [];
      const lines = [`Quota warning (${str(data.provider)}, ${str(data.window)})`, "", str(data.message)];
      if (choices.length > 0) lines.push("", `Choices in the local app: ${choices.join(", ")}.`, "Nothing changes until you act.");
      return { text: clip(lines.join("\n"), MAX_TEXT), replyMarkup: null };
    }
    case "personal_question": {
      const bound = actions(data.actions).map(entry => ({ ...entry, content: contentForRef(entry.ref) }));
      const draft = bound.find(entry => entry.action === "save_human_response" && entry.content !== null)?.content ?? null;
      const saved = draft === null ? bound.find(entry => entry.action === "answer_and_resume" && entry.content !== null)?.content ?? null : null;
      const lines = [
        `Task needs input: ${str(data.title)}`,
        `Status: ${humanize(str(data.execution))} · ${humanize(str(data.decision))}`,
        "",
        str(data.question),
        "",
      ];
      const buttons: TelegramInlineButton[] = [];
      if (draft !== null) {
        lines.push("Your answer:", clip(draft, MAX_ANSWER_PREVIEW), "", "Save answer keeps the task waiting. Answer and resume continues it.");
        for (const entry of bound) {
          if (entry.content === null) continue;
          buttons.push({ text: entry.action === "save_human_response" ? "Save answer" : "Answer and resume", callback_data: entry.ref });
        }
      } else if (saved !== null) {
        lines.push("Saved answer:", clip(saved, MAX_ANSWER_PREVIEW), "", "Reply to this message to change it.");
        const resume = bound.find(entry => entry.action === "answer_and_resume" && entry.content !== null);
        if (resume) buttons.push({ text: "Resume with saved answer", callback_data: resume.ref });
      } else {
        lines.push("Reply to this message with your answer.");
      }
      return {
        text: clip(lines.join("\n"), MAX_TEXT),
        replyMarkup: buttons.length > 0 ? { inline_keyboard: buttons.map(button => [button]) } : null,
      };
    }
    default:
      throw new TelegramApiError("rejected", `Unsupported Telegram outbox payload kind: ${String(data?.kind ?? "none")}.`);
  }
}
