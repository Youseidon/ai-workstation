import type { TaskControlAction } from "@agent-console/shared";
import type { TaskSummary } from "../../telegramSummary.ts";
import { TelegramApiError } from "./botApi.ts";
import { formatCard, type CardEntity } from "./card.ts";
import { itemTag } from "../../teamItems.ts";

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

/**
 * B6: a card's buttons stop working ten minutes after it was sent, and
 * `notifyWaitingTasks` posts no second card for a question revision it has
 * already posted for, so a task can sit awaiting a response behind dead buttons
 * for as long as it waits. Replying to the card with an answer mints a fresh one
 * with fresh buttons, and that is the only recovery; it was undiscoverable.
 *
 * jd ruled on 2026-09-20 that the card says so and the dedupe stays as it is:
 * a waiting task may keep its dead buttons, in exchange for no extra posting and
 * no re-post loop. So this sentence is the fix, and it is on every question card,
 * because every one of them has buttons that expire.
 */
const EXPIRY_RECOVERY = "These buttons expire; a reply with your answer always brings a fresh card.";

/**
 * What each handover button says on a phone (C1). The seven actions TM4's
 * migration adds are exactly these; there is no eighth, and no button says
 * "release", because there is no release action and no `RELEASED` state.
 */
const HANDOVER_LABELS: Partial<Record<TaskControlAction, string>> = {
  accept_offer: "Accept and run",
  decline_offer: "Decline",
  withdraw_offer: "Withdraw offer",
  publish_offer: "Publish offer",
  return_work: "Return work",
  apply_result: "Apply",
  request_changes: "Request changes",
};

function handoverButtons(value: unknown): TelegramInlineButton[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    const action = record(entry);
    if (action === null || typeof action.ref !== "string") return [];
    const label = HANDOVER_LABELS[action.action as TaskControlAction];
    return label === undefined ? [] : [{ text: label, callback_data: action.ref }];
  });
}

/** The item tag a handover question carries, so it reads as part of the item's thread. */
function itemTagOf(value: unknown): string {
  return typeof value === "string" ? itemTag(value) : "";
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : [];
}

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
        ...HANDOVER_LABELS,
      };
      const buttons = Array.isArray(data.actions) ? data.actions.flatMap(entry => {
        const action = record(entry);
        if (action === null || typeof action.ref !== "string" || typeof action.action !== "string") return [];
        const label = labels[action.action as TaskControlAction];
        return label === undefined ? [] : [{ text: label, callback_data: action.ref }];
      }) : [];
      const lines = [str(data.title), "", str(data.detail)];
      // The footer: what the tap does, then what it spends. B18 stated only the second.
      const footer = [str(data.outcome), str(data.allowance)].filter(line => line !== "");
      if (footer.length > 0) lines.push("", ...footer);
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
          ? { answer: { label: "Your answer", text: draft }, hint: `Save answer keeps the task waiting. Answer and resume continues it. ${EXPIRY_RECOVERY}` }
          : saved !== null
            ? { answer: { label: "Saved answer", text: saved }, hint: `Reply to this message to change it. ${EXPIRY_RECOVERY}` }
            : { hint: `Reply to this message with your answer. ${EXPIRY_RECOVERY}` });
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
        lines.push("Your answer:", clip(draft, MAX_ANSWER_PREVIEW), "", `Save answer keeps the task waiting. Answer and resume continues it. ${EXPIRY_RECOVERY}`);
      } else if (saved !== null) {
        lines.push("Saved answer:", clip(saved, MAX_ANSWER_PREVIEW), "", `Reply to this message to change it. ${EXPIRY_RECOVERY}`);
      } else {
        lines.push(`Reply to this message with your answer. ${EXPIRY_RECOVERY}`);
      }
      return { text: clip(lines.join("\n"), MAX_TEXT), replyMarkup, entities: [] };
    }
    /*
     * Handover's three cards (C1). H03 to H05 rendered these payloads and
     * nothing turned them into a message: this switch had no case for any of
     * them, so every handover card failed delivery with "unsupported payload
     * kind" and no tap was ever possible. Each one is plain text with the
     * item's own tag, so it reads as part of the item's thread.
     */
    case "handover_offer": {
      const requested = record(data.requested);
      const capability = record(data.capability);
      const buttons = handoverButtons(data.actions);
      const lines = [
        `Handover offered: ${str(data.branch)}`,
        str(data.tag),
        "",
        // The open call, stated rather than implied: the card names no receiver.
        "This is an open call. It names no receiver, and the first accept that reaches the shared record wins.",
        `Asks for: ${str(requested?.provider)}${requested?.model ? ` · ${str(requested.model)}` : ""}`
          + `${requested?.sandbox ? ` · sandbox ${str(requested.sandbox)}` : ""}`
          + `${requested?.hostAccess === true ? " · Host access" : ""}`,
        `Offer expires ${str(data.startDeadline)} (epoch ${String(data.epoch ?? "")}).`,
        "",
        str(capability?.reason),
      ];
      const denied = list(capability?.denied);
      const unknown = list(capability?.unknown);
      const additions = list(capability?.additions);
      if (denied.length > 0) lines.push(`Denied here: ${denied.join(", ")}.`);
      if (unknown.length > 0) lines.push(`No local policy for: ${unknown.join(", ")}.`);
      if (additions.length > 0) lines.push(`Beyond your settings: ${additions.join(", ")}.`);
      lines.push("", str(data.reason));
      return {
        text: clip(lines.join("\n"), MAX_TEXT),
        replyMarkup: buttons.length > 0 ? { inline_keyboard: buttons.map(button => [button]) } : null,
        entities: [],
      };
    }
    case "handover_review": {
      const buttons = handoverButtons(data.actions);
      const verification = list(data.verification);
      const uncertain = list(data.uncertainEffects);
      const diverged = list(data.divergedPaths);
      const conflicts = list(data.conflictPaths);
      const lines = [
        `Work returned: ${str(data.branch)}`,
        str(data.tag),
        "",
        `Result ${str(data.resultId)} at ${str(data.resultCommit)}, labelled ${str(data.label)}.`,
      ];
      // B26: evidence and a claim of completion stay separate, so the card says
      // which it has rather than letting the label speak for both.
      lines.push(verification.length > 0 ? `Evidence: ${verification.join("; ")}` : "Evidence: none was reported.");
      if (data.evidenceMissing === true) {
        lines.push("This result claims completion and carries no evidence, which is not acceptance. Review it before applying.");
      }
      if (uncertain.length > 0) lines.push(`Uncertain external effects: ${uncertain.join("; ")}`);
      if (diverged.length > 0) lines.push(`Your checkout moved on in: ${diverged.join(", ")}`);
      if (conflicts.length > 0) lines.push(`Git stopped with a conflict in: ${conflicts.join(", ")}`);
      lines.push("", str(data.reason));
      // Apply is a button only when the merge is clean, so the phone never
      // offers a tap that would end in a conflict (Q9).
      if (data.applyOffered !== true) lines.push("Apply is not offered while the merge is not clean.");
      return {
        text: clip(lines.join("\n"), MAX_TEXT),
        replyMarkup: buttons.length > 0 ? { inline_keyboard: buttons.map(button => [button]) } : null,
        entities: [],
      };
    }
    case "handover_question": {
      // A requirement question is the requester's to answer and is posted by the
      // receiver's own bot; access, provider and allowance questions are the
      // receiver's own. Either way it is answered by replying, exactly as a
      // personal question is, and the buttons appear once an answer is bound.
      const bound = actions(data.actions).map(entry => ({ ...entry, content: contentForRef(entry.ref) }));
      const draft = bound.find(entry => entry.content !== null)?.content ?? null;
      const buttons: TelegramInlineButton[] = draft === null ? [] : bound.flatMap(entry => (entry.content === null ? [] : [{
        text: entry.action === "save_human_response" ? "Save answer" : "Answer and resume",
        callback_data: entry.ref,
      }]));
      const lines = [
        `Handover question (${humanize(str(data.questionKind))})`,
        itemTagOf(data.itemId),
        "",
        str(data.question),
        "",
        str(data.audience) === "requester"
          ? "This is a requirements question, so it is yours to answer."
          : "This is your workstation's own decision.",
      ];
      if (draft !== null) lines.push("", "Your answer:", clip(draft, MAX_ANSWER_PREVIEW));
      lines.push("", `Reply to this message with your answer. ${EXPIRY_RECOVERY}`);
      return {
        text: clip(lines.join("\n"), MAX_TEXT),
        replyMarkup: buttons.length > 0 ? { inline_keyboard: buttons.map(button => [button]) } : null,
        entities: [],
      };
    }
    default:
      throw new TelegramApiError("rejected", `Unsupported Telegram outbox payload kind: ${String(data?.kind ?? "none")}.`);
  }
}
