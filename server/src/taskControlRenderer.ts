import type { QuotaWarning, TaskControlActionReference } from "@agent-console/shared";
import { settings as appSettings } from "./settings.ts";
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
