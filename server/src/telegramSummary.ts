import { hostname } from "node:os";
import type { AgentStatusOption, HandoffBrief, HandoffRecommendation, OperationsPrompt, OperationsSuite, PromptRemark, PromptStatusEvent } from "@agent-console/shared";
import { itemTag, isItemId } from "./teamItems.ts";
import { workspaces } from "./workspaces.ts";

/*
 * Task summary model (L3 slice F3, RTC-22; docs/e2e-scenarios/l3-f3-a.md).
 * Every phone surface describes a task from these structured, sanitized facts:
 * question cards (slice A) and the /task view (slice B) render the same model,
 * so they cannot disagree. Pure over durable state: no writes, no provider or
 * Bot API call, and never the all-runs session loader.
 */

export type SummaryAudience = "owner" | "team";

export interface TaskSummaryBlocker {
  description: string;
  requiredAction: string | null;
}

/** One choice the agent offered with the blocking status, capped for the phone (A2). */
export interface TaskSummaryOption {
  label: string;
  /** Capped lists; the last entry declares how many more the local app holds. */
  advantages: string[];
  disadvantages: string[];
}

export interface TaskSummaryRun {
  provider: string;
  startedAt: string;
  state: string;
}

/** What has already happened to this task: runs, blocks and the operator's earlier answers (A2). */
export interface TaskSummaryHistory {
  /** Newest first, at most `HISTORY_RUNS`. */
  runs: TaskSummaryRun[];
  moreRuns: number;
  /** How many times this task has blocked, including the current block. */
  blocks: number;
  previousAnswer: { text: string; at: string } | null;
  morePreviousAnswers: number;
}

export interface TaskSummary {
  promptId: number;
  /** The identifier `/task` accepts, so reading a card and asking for it later use the same word. */
  key: string;
  /** The chat tag for this task, scoped to its project: `#acme_t142` (A2 renders it; C1 owns the registry). */
  tag: string;
  /** Where "blocked on" and the brief fields came from. */
  source: "brief" | "remark" | "title";
  breadcrumb: {
    workstation: string;
    workspace: string;
    program: string;
    suite: string;
    /** Position among the enabled steps of the suite flowchart, or null when the task is not on it. */
    step: { index: number; total: number } | null;
    /** Title of the next enabled step of the suite flowchart, null when this is the last one. */
    nextStep: string | null;
  };
  title: string;
  /** When the task entered its current block; null when it is not blocked. The card turns it into an age at delivery. */
  blockedAt: string | null;
  /** Options the agent reported with the blocking status; never generated while rendering. */
  options: TaskSummaryOption[] | null;
  /** How many further options the local app holds. */
  optionsOmitted: number;
  history: TaskSummaryHistory;
  /** Fields absent from the source are null, never empty strings or zero counts. */
  objective: string | null;
  completedWork: string[] | null;
  verification: { passed: number; failed: number } | null;
  blockers: TaskSummaryBlocker[] | null;
  decisions: string[] | null;
  importantFiles: string[] | null;
  recommendation: string | null;
  ifYouWait: string;
}

/* ------------------------------ sanitization ------------------------------ */

/** Secret and local-address shapes removed from every phone text (I10). Widened in F3 (operator question 6). */
const REDACTIONS: RegExp[] = [
  /\b(?:sk-ant|sk|xai|ghp|gho|ghs|glpat)[-_][A-Za-z0-9_-]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi,
  /\b(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]\S*)?/gi,
];

export function redactPhoneText(value: string): string {
  let output = value;
  for (const pattern of REDACTIONS) output = output.replace(pattern, "[redacted]");
  return output;
}

/** Cuts to at most `max` UTF-16 units without splitting a surrogate pair. */
function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** Line form: one line, single spaces, redacted, capped with a declared shortening. */
export function lineText(value: string, max = 300): string {
  const flat = redactPhoneText(value).replace(/[\s\u2028\u2029]+/g, " ").trim();
  return flat.length <= max ? flat : `${cut(flat, max - 1).trimEnd()}…`;
}

/** Block form: line breaks kept as \n, redacted before capping, capped with a declared omission. */
export function blockText(value: string, max = 1500): string {
  const normalized = redactPhoneText(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+$/g, "").replace(/\t/g, "  "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (normalized.length <= max) return normalized;
  const marker = "\n[shortened]";
  return `${cut(normalized, max - marker.length).trimEnd()}${marker}`;
}

/* ---------------------------------- tag ---------------------------------- */

/** Documented cap: the project slug of a tag, in characters. */
export const TAG_SLUG_MAX = 16;

/** Hashtag-safe form of one part of a tag: redacted, then letters, digits and underscores only. */
function tagPart(value: string, max: number): string {
  return redactPhoneText(value).normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+/, "").slice(0, max).replace(/_+$/, "");
}

/**
 * The chat tag for a task: a project slug and the task's own id, such as `#acme_t142`.
 * Two projects must never share a tag, so a slug another workspace also produces is
 * disambiguated with the workspace id; slugs are compared without case because Telegram
 * matches hashtags that way. The id, not the task key, carries the identity: a key may
 * repeat across programs (`/task` offers a picker when it does), and the tag must name
 * exactly one task. The same task therefore always produces the same tag.
 * Telegram makes a hashtag only of letters, digits and underscores, and only when it
 * contains a letter - `#123` is not a hashtag while `#a1` is
 * (`e2e/src/telegramEntities.test.ts`) - which the `t` before the id guarantees.
 */
export function taskTag(workspaceId: number, workspaceName: string, promptId: number): string {
  const slugOf = (id: number, name: string) => tagPart(name, TAG_SLUG_MAX) || `w${id}`;
  const slug = slugOf(workspaceId, workspaceName);
  const shared = workspaces.list().filter((entry) => slugOf(entry.id, entry.name).toLowerCase() === slug.toLowerCase()).length;
  return `#${shared > 1 ? `${slug}${workspaceId}` : slug}_t${promptId}`;
}

/**
 * The tag of one task, resolved from the task itself (L3 C1): every message about a
 * task carries it, not only the card, so tapping it filters the chat to that task.
 * Null when the task is gone, so a message is never held up by a missing tag.
 */
export function taskTagFor(promptId: number): string | null {
  try {
    const workspace = workspaces.get(workspaces.promptHome(promptId).workspaceId);
    return taskTag(workspace.id, workspace.name, promptId);
  } catch {
    return null;
  }
}

/* -------------------------------- options -------------------------------- */

/** Documented phone caps for agent-reported options (operator decision, 2026-09-16). */
export const MAX_OPTIONS = 4;
export const MAX_TRADE_OFFS = 3;
export const TRADE_OFF_MAX = 200;

/** Line form with the card's own shortening declaration, so a cut is never silent. */
function optionText(value: string, max: number): string {
  const flat = lineText(value, 20000);
  return flat.length <= max ? flat : `${cut(flat, max - 12).trimEnd()} [shortened]`;
}

function tradeOffs(items: string[]): string[] {
  const kept = items.map((item) => optionText(item, TRADE_OFF_MAX)).filter((item) => item !== "");
  if (kept.length <= MAX_TRADE_OFFS) return kept;
  return [...kept.slice(0, MAX_TRADE_OFFS), `and ${kept.length - MAX_TRADE_OFFS} more in the local app`];
}

function summaryOptions(stored: AgentStatusOption[]): { options: TaskSummaryOption[] | null; omitted: number } {
  const usable = stored.filter((option) => typeof option?.label === "string" && option.label.trim() !== "");
  const options = usable.slice(0, MAX_OPTIONS).map((option) => ({
    label: optionText(option.label, TRADE_OFF_MAX),
    advantages: tradeOffs(Array.isArray(option.advantages) ? option.advantages : []),
    disadvantages: tradeOffs(Array.isArray(option.disadvantages) ? option.disadvantages : []),
  }));
  return { options: options.length > 0 ? options : null, omitted: Math.max(0, usable.length - options.length) };
}

/* -------------------------------- history -------------------------------- */

/** Documented phone cap: the last three runs and the most recent previous answer (operator decision, 2026-09-16). */
export const HISTORY_RUNS = 3;

function history(promptId: number): TaskSummaryHistory {
  const record = workspaces.promptHistory(promptId);
  const runs = (record.runs as Array<{ provider: string; role: string; state: string; startedAt: string }>)
    .filter((run) => run.role === "execute")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const answers = (record.remarks as PromptRemark[]).filter((remark) => remark.kind === "HUMAN_RESPONSE" && remark.actorType === "USER").sort((a, b) => b.id - a.id);
  const latest = answers[0];
  return {
    runs: runs.slice(0, HISTORY_RUNS).map((run) => ({ provider: lineText(run.provider, 40), startedAt: run.startedAt, state: run.state })),
    moreRuns: Math.max(0, runs.length - HISTORY_RUNS),
    blocks: (record.events as PromptStatusEvent[]).filter((event) => event.newStatus === "BLOCKED").length,
    previousAnswer: latest ? { text: optionText(latest.content, TRADE_OFF_MAX), at: latest.createdAt } : null,
    morePreviousAnswers: Math.max(0, answers.length - 1),
  };
}

/* --------------------------------- model --------------------------------- */

const RECOMMENDATIONS: Record<HandoffRecommendation, string> = {
  CONTINUE: "Continue with the next step.",
  WAIT_FOR_HUMAN: "Wait for your decision.",
  RETRY_LATER: "Retry later.",
  DO_NOT_CONTINUE: "Do not continue this task.",
};

export interface SummaryOptions {
  /** The workstation label setting; empty means the OS hostname. */
  workstationLabel?: string;
  /** Team-wide identity used for the shared tag; required for the team audience. */
  itemId?: string;
}

export function defaultWorkstationLabel(): string {
  return lineText(hostname(), 64) || "workstation";
}

function locate(promptId: number): { suite: OperationsSuite; item: OperationsPrompt } {
  const workspaceId = workspaces.promptHome(promptId).workspaceId;
  for (const suite of workspaces.operations(workspaceId).suites) {
    const item = suite.prompts.find((entry) => entry.prompt.id === promptId);
    if (item) return { suite, item };
  }
  throw new Error(`prompt ${promptId} is not in its workspace's operations snapshot`);
}

function latestExecuteStart(promptId: number): string | null {
  const runs = workspaces.promptHistory(promptId).runs as Array<{ role: string; startedAt: string }>;
  return runs.filter((run) => run.role === "execute").map((run) => run.startedAt).sort().at(-1) ?? null;
}

/**
 * The brief a card may use: the latest READY handoff with a brief, and only if it
 * completed after the latest execute run started (operator question 1), so a card
 * never describes an earlier blocker than the one the task is waiting on (B21).
 */
function currentBrief(promptId: number): HandoffBrief | null {
  const ready = workspaces.handoffsForPrompt(promptId).filter((handoff) => handoff.state === "READY" && handoff.brief !== null).sort((a, b) => (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt))[0];
  if (!ready?.brief) return null;
  const runStart = latestExecuteStart(promptId);
  if (runStart !== null && (ready.completedAt ?? ready.createdAt) < runStart) return null;
  return ready.brief;
}

function latestBlockerRemark(promptId: number): PromptRemark | null {
  const remarks = workspaces.promptHistory(promptId).remarks as PromptRemark[];
  return remarks.filter((remark) => remark.kind === "BLOCKER" || remark.kind === "DECISION_NEEDED").sort((a, b) => b.id - a.id)[0] ?? null;
}

const list = (items: string[], max = 1500): string[] | null => {
  const kept = items.map((item) => blockText(item, max)).filter((item) => item !== "");
  return kept.length > 0 ? kept : null;
};

/** Deterministic "If you wait" line from the pipeline rule and state, never from agent text (operator question 5). */
function ifYouWait(suite: OperationsSuite, item: OperationsPrompt): string {
  if (item.prompt.humanResponseHeld) return "Your saved answer is held; nothing resumes until you choose Resume.";
  const active = suite.pipeline?.active ?? null;
  const onFlowchart = item.pipelineRule.enabled;
  if (!onFlowchart || active === null) {
    const latest = suite.pipeline?.latest ?? null;
    if (onFlowchart && latest?.state === "STOPPED" && latest.currentPromptId === item.prompt.id) return "The pipeline has stopped at this task; nothing resumes on its own. Other workspaces continue.";
    return "Only this task waits; other tasks and workspaces continue.";
  }
  if (active.state === "PAUSED") return "The pipeline is paused; this task waits until you resume it. Other workspaces continue.";
  if (active.currentPromptId === item.prompt.id) return "This task and its pipeline stay paused; other workspaces continue.";
  return "This task waits; its pipeline continues with other steps. Other workspaces continue.";
}

export function taskSummary(promptId: number, audience: SummaryAudience = "owner", options: SummaryOptions = {}): TaskSummary {
  if (audience === "team" && !isItemId(options.itemId)) throw new Error("team task summaries require a valid Team item id");
  const { suite, item } = locate(promptId);
  const enabled = suite.prompts.filter((entry) => entry.pipelineRule.enabled).sort((a, b) => a.pipelineRule.stepOrder - b.pipelineRule.stepOrder);
  const index = enabled.findIndex((entry) => entry.prompt.id === promptId);
  const label = lineText(options.workstationLabel ?? "", 64) || defaultWorkstationLabel();
  const key = item.prompt.externalKey ?? String(promptId);
  const blocking = workspaces.blockingStatus(promptId);
  const offered = summaryOptions(blocking?.options ?? []);
  const base = {
    promptId,
    key: lineText(key, 60),
    tag: taskTag(item.workspace.id, item.workspace.name, promptId),
    breadcrumb: {
      workstation: label,
      workspace: lineText(item.workspace.name, 120),
      program: lineText(suite.programName, 120),
      suite: lineText(suite.name, 120),
      step: index === -1 ? null : { index: index + 1, total: enabled.length },
      nextStep: index === -1 ? null : enabled[index + 1] ? lineText(enabled[index + 1]!.prompt.title, 120) : null,
    },
    title: lineText(item.prompt.title, 300),
    blockedAt: blocking?.createdAt ?? null,
    options: offered.options,
    optionsOmitted: offered.omitted,
    history: history(promptId),
    ifYouWait: ifYouWait(suite, item),
  };
  const empty = { objective: null, completedWork: null, verification: null, blockers: null, decisions: null, importantFiles: null, recommendation: null };

  const brief = currentBrief(promptId);
  let summary: TaskSummary;
  if (brief) {
    const human = brief.blockers.filter((blocker) => blocker.requiresHuman && blocker.description.trim() !== "");
    const passed = brief.verificationPassed.length;
    const failed = brief.verificationFailed.length;
    summary = {
      ...base,
      source: "brief",
      objective: brief.originalObjective.trim() === "" ? null : blockText(brief.originalObjective, 600),
      completedWork: list(brief.completedWork),
      verification: passed + failed > 0 ? { passed, failed } : null,
      blockers: human.length > 0 ? human.map((blocker) => ({ description: blockText(blocker.description), requiredAction: blocker.requiredAction?.trim() ? blockText(blocker.requiredAction) : null })) : null,
      decisions: list(brief.decisionsAndAssumptions),
      importantFiles: list(brief.importantFiles, 300),
      recommendation: RECOMMENDATIONS[brief.recommendation] ?? null,
    };
  } else {
    const remark = latestBlockerRemark(promptId);
    summary = remark && remark.content.trim() !== ""
      ? { ...base, ...empty, source: "remark", blockers: [{ description: blockText(remark.content), requiredAction: null }] }
      : { ...base, ...empty, source: "title" };
  }
  if (audience === "owner") return summary;
  return teamSummary(summary, options.itemId!);
}

const TEAM_LOCAL_PATH = /(^|[\s("'`])(?:\/(?:home|Users|tmp|var|private|mnt|workspace|workspaces)\/[^\s,;)\]}"']+|[A-Za-z]:\\[^\s,;)\]}"']+)/g;

function teamText(value: string): string {
  return value.replace(TEAM_LOCAL_PATH, "$1[local path]");
}

function teamList(values: string[] | null): string[] | null {
  return values?.map(teamText) ?? null;
}

/** Removes owner-only machine detail while preserving facts needed for a Team decision. */
function teamSummary(summary: TaskSummary, itemId: string): TaskSummary {
  return {
    ...summary,
    key: itemId,
    tag: itemTag(itemId),
    breadcrumb: {
      ...summary.breadcrumb,
      workstation: teamText(summary.breadcrumb.workstation),
      workspace: teamText(summary.breadcrumb.workspace),
      program: teamText(summary.breadcrumb.program),
      suite: teamText(summary.breadcrumb.suite),
      nextStep: summary.breadcrumb.nextStep === null ? null : teamText(summary.breadcrumb.nextStep),
    },
    title: teamText(summary.title),
    options: summary.options?.map((option) => ({
      label: teamText(option.label),
      advantages: option.advantages.map(teamText),
      disadvantages: option.disadvantages.map(teamText),
    })) ?? null,
    history: {
      ...summary.history,
      runs: summary.history.runs.map((run) => ({ ...run, provider: teamText(run.provider) })),
      previousAnswer: summary.history.previousAnswer === null ? null : { ...summary.history.previousAnswer, text: teamText(summary.history.previousAnswer.text) },
    },
    objective: summary.objective === null ? null : teamText(summary.objective),
    completedWork: teamList(summary.completedWork),
    blockers: summary.blockers?.map((blocker) => ({
      description: teamText(blocker.description),
      requiredAction: blocker.requiredAction === null ? null : teamText(blocker.requiredAction),
    })) ?? null,
    decisions: teamList(summary.decisions),
    // File names and paths remain available to the owner, but never enter the shared group.
    importantFiles: null,
    recommendation: summary.recommendation === null ? null : teamText(summary.recommendation),
    ifYouWait: teamText(summary.ifYouWait),
  };
}
