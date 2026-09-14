import type { QuotaWarning, TaskControlActionReference } from "@agent-console/shared";
import { workspaces } from "./workspaces.ts";

const SECRET_PATTERNS = [
  /\b(?:sk|xai|ghp|glpat|sk-ant)-[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi,
  /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\S*/gi,
];

export interface RenderedTaskControlQuestion {
  kind: "personal_question";
  promptId: number;
  title: string;
  execution: string;
  decision: string;
  receipt: string;
  question: string;
  actions: Array<Pick<TaskControlActionReference, "ref" | "action">>;
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
  let output = value;
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, "[redacted]");
  return output.replace(/\s+/g, " ").trim().slice(0, 1200);
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
