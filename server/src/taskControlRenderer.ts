import type { QuotaWarning, TaskControlActionReference } from "@agent-console/shared";
import { settings as appSettings } from "./settings.ts";
import { itemTag } from "./teamItems.ts";
import { redactPhoneText, taskSummary, type TaskSummary } from "./telegramSummary.ts";
import { workspaces } from "./workspaces.ts";


export interface RenderedTaskControlQuestion {
  kind: "personal_question";
  promptId: number;
  title: string;
  execution: string;
  decision: string;
  receipt: string;
  question: string;
  actions: Array<Pick<TaskControlActionReference, "ref" | "action">>;
  /** The structured facts the phone card is rendered from (L3 slice A); absent on rows queued before it. */
  summary?: TaskSummary;
}

export interface RenderedQuotaWarning {
  kind: "quota_warning";
  warningId: string;
  provider: string;
  window: string;
  message: string;
  choices: string[];
}

export function sanitizeTelegramText(value: string): string {
  // One redaction for every phone text (F3 widened it); the card layout itself changes in slice A.
  return redactPhoneText(value).replace(/\s+/g, " ").trim().slice(0, 1200);
}

export function renderPersonalQuestion(promptId: number, actions: Array<Pick<TaskControlActionReference, "ref" | "action">>): RenderedTaskControlQuestion {
  const activity = workspaces.promptActivity(promptId);
  const run = activity.sessions.find(session => session.role === "execute" && ["STARTING", "RUNNING"].includes(session.state));
  const saved = activity.humanInput.savedResponseId !== null;
  // A task blocked by its own agent has no handoff question; its latest blocker
  // remark is what the operations view shows, so the phone shows it too.
  const blocker = activity.item.prompt.status === "BLOCKED"
    ? activity.remarks.filter(remark => remark.kind === "BLOCKER" || remark.kind === "DECISION_NEEDED").sort((a, b) => b.id - a.id)[0]?.content ?? null
    : null;
  const question = workspaces.pendingHumanQuestion(promptId)
    ?? (saved ? "An answer is saved. Choose whether to resume with the saved answer." : blocker ?? "This task needs your input.");
  return {
    kind: "personal_question",
    promptId,
    title: sanitizeTelegramText(activity.item.prompt.title),
    execution: run ? `Running on ${run.provider}` : activity.item.prompt.status.toLowerCase(),
    decision: saved ? "answer saved" : activity.item.operationalState.toLowerCase(),
    receipt: "waiting for action",
    question: sanitizeTelegramText(question),
    actions,
    summary: taskSummary(promptId, "owner", { workstationLabel: appSettings.taskControl.workstationLabel }),
  };
}

export function renderQuotaWarning(warning: QuotaWarning): RenderedQuotaWarning {
  return {
    kind: "quota_warning",
    warningId: warning.id,
    provider: warning.provider,
    window: warning.windowKind,
    message: sanitizeTelegramText(warning.message),
    choices: warning.choices.map((choice) => choice.label),
  };
}

/* ------------------------------- handover --------------------------------- */

/**
 * The offer card (H04, TM-T0-7's `team` summary rendering and TM-T1-H1).
 *
 * One shape serves both sides of the open call: the requester's item thread and
 * every receiver's own bot render the same facts, so the two cannot disagree.
 * It names **no receiver**, because the offer is an open call, and it carries
 * the `team` audience task summary so a teammate reading it sees the work the
 * way the item thread already shows it.
 *
 * `inert` is what a card becomes when its own person can no longer act on it: a
 * lost race, a decline, an expiry or a roster removal. An inert card keeps its
 * facts, drops every button and states the reason.
 */
export interface RenderedHandoverOffer {
  kind: "handover_offer";
  itemId: string;
  tag: string;
  branch: string;
  /** The open call names nobody. */
  receiver: null;
  epoch: number;
  startDeadline: string;
  requested: { provider: string; model: string | null; hostAccess: boolean | null; sandbox: string | null; tools: string[] | null };
  capability: {
    outcome: string;
    additions: string[];
    denied: string[];
    unknown: string[];
    reason: string;
  };
  inert: boolean;
  reason: string;
  actions: Array<Pick<TaskControlActionReference, "ref" | "action">>;
  summary: TaskSummary | null;
}

export interface HandoverOfferCardInput {
  itemId: string;
  branch: string;
  epoch: number;
  startDeadline: string;
  requested: RenderedHandoverOffer["requested"];
  capability: RenderedHandoverOffer["capability"];
  /** The local task this card is rendered from, when this workstation has one. */
  promptId: number | null;
  actions: Array<Pick<TaskControlActionReference, "ref" | "action">>;
  inert?: boolean;
  reason?: string;
}

export function renderHandoverOfferCard(input: HandoverOfferCardInput): RenderedHandoverOffer {
  const inert = input.inert === true;
  const summary = input.promptId === null
    ? null
    : taskSummary(input.promptId, "team", { workstationLabel: appSettings.taskControl.workstationLabel, itemId: input.itemId });
  return {
    kind: "handover_offer",
    itemId: input.itemId,
    tag: itemTag(input.itemId),
    branch: input.branch,
    receiver: null,
    epoch: input.epoch,
    startDeadline: input.startDeadline,
    requested: input.requested,
    capability: {
      outcome: input.capability.outcome,
      additions: input.capability.additions.map(sanitizeTelegramText),
      denied: input.capability.denied.map(sanitizeTelegramText),
      unknown: input.capability.unknown.map(sanitizeTelegramText),
      reason: sanitizeTelegramText(input.capability.reason),
    },
    inert,
    reason: sanitizeTelegramText(input.reason ?? (inert ? "This card no longer applies." : "Open call: any available teammate may take this on.")),
    actions: inert ? [] : input.actions,
    summary,
  };
}

/**
 * The requester's review card (H05, TM-T1-H3).
 *
 * `return_work` puts the record in `RETURNED` and this is what the requester is
 * shown. `offered` is what they may do next and it is deliberately not the same
 * list as `actions`: **Review is not an action**. TM4's migration adds exactly
 * seven actions and TM-T0-5-29 asserts that an eighth is rejected, so reviewing
 * is reading this card's own evidence, and only Request changes and Apply mint a
 * `task_control_action`.
 *
 * **Apply appears only when the merge is clean.** A checkout that moved on, or a
 * merge Git cannot complete, drops `apply_result` from both lists and states the
 * reason, so the phone never offers a tap that would end in a conflict (Q9).
 */
export interface RenderedHandoverReview {
  kind: "handover_review";
  itemId: string;
  tag: string;
  branch: string;
  epoch: number;
  resultId: string;
  resultCommit: string;
  /** A returned branch is not a claim that the work is right (B26). */
  label: "full" | "partial";
  verification: string[];
  uncertainEffects: string[];
  /** True when a result claims completion without the evidence to accept it. */
  evidenceMissing: boolean;
  applyOffered: boolean;
  offered: Array<"review" | "request_changes" | "apply_result">;
  divergedPaths: string[];
  conflictPaths: string[];
  inert: boolean;
  reason: string;
  actions: Array<Pick<TaskControlActionReference, "ref" | "action">>;
  summary: TaskSummary | null;
}

export interface HandoverReviewCardInput {
  itemId: string;
  branch: string;
  epoch: number;
  resultId: string;
  resultCommit: string;
  label: "full" | "partial";
  verification: string[];
  uncertainEffects: string[];
  evidenceMissing: boolean;
  applyOffered: boolean;
  divergedPaths: string[];
  conflictPaths: string[];
  promptId: number | null;
  actions: Array<Pick<TaskControlActionReference, "ref" | "action">>;
  inert?: boolean;
  reason: string;
}

export function renderHandoverReviewCard(input: HandoverReviewCardInput): RenderedHandoverReview {
  const inert = input.inert === true;
  const summary = input.promptId === null
    ? null
    : taskSummary(input.promptId, "team", { workstationLabel: appSettings.taskControl.workstationLabel, itemId: input.itemId });
  const offered: RenderedHandoverReview["offered"] = inert
    ? []
    : input.applyOffered ? ["review", "request_changes", "apply_result"] : ["review", "request_changes"];
  return {
    kind: "handover_review",
    itemId: input.itemId,
    tag: itemTag(input.itemId),
    branch: input.branch,
    epoch: input.epoch,
    resultId: input.resultId,
    resultCommit: input.resultCommit,
    label: input.label,
    verification: input.verification.map(sanitizeTelegramText),
    uncertainEffects: input.uncertainEffects.map(sanitizeTelegramText),
    evidenceMissing: input.evidenceMissing,
    applyOffered: inert ? false : input.applyOffered,
    offered,
    divergedPaths: input.divergedPaths,
    conflictPaths: input.conflictPaths,
    inert,
    reason: sanitizeTelegramText(input.reason),
    actions: inert ? [] : input.actions,
    summary,
  };
}
