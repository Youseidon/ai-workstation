export type StatusTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "caution"
  | "danger"
  | "info"
  | "violet";

export const STATUS_TONES: readonly StatusTone[] = [
  "neutral", "accent", "success", "warning", "caution", "danger", "info", "violet",
];

export function isStatusTone(value: unknown): value is StatusTone {
  return typeof value === "string" && (STATUS_TONES as readonly string[]).includes(value);
}

export const STATUS_ICONS = [
  "dot", "spinner", "check", "cross", "question", "alert",
  "clock", "skip", "review", "search", "pause", "link",
] as const;
export type StatusIcon = (typeof STATUS_ICONS)[number];

export function isStatusIcon(value: unknown): value is StatusIcon {
  return typeof value === "string" && (STATUS_ICONS as readonly string[]).includes(value);
}

export type PolicyKey =
  | "pipeline.pauseMode"
  | "pipeline.onRestart"
  | "pipeline.maxContinuations"
  | "pipeline.reviewAfterContinuations"
  | "pipeline.dodEnforcement";

export type RulePolicy =
  | { kind: "locked"; reason: string }
  | { kind: "setting"; key: PolicyKey; reason: string }
  | { kind: "stationRule"; field: "onDone" | "onUnfinished"; reason: string };

export const STEP_STATUSES = [
  "TODO",
  "IN_PROGRESS",
  "DONE",
  "BLOCKED",
  "UNREPORTED",
  "FAILED",
  "NEEDS_REVIEW",
  "SKIPPED",
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export function isStepStatus(value: unknown): value is StepStatus {
  return typeof value === "string" && (STEP_STATUSES as readonly string[]).includes(value);
}

export const STEP_DISPLAY_STATUSES = [
  ...STEP_STATUSES,
  "WORKING",
  "READY",
  "WAITING_DEPENDENCY",
  "RECOVERY_NEEDED",
] as const;
export type StepDisplayStatus = (typeof STEP_DISPLAY_STATUSES)[number];

export function isStepDisplayStatus(value: unknown): value is StepDisplayStatus {
  return typeof value === "string" && (STEP_DISPLAY_STATUSES as readonly string[]).includes(value);
}

export const OVERLAY_STATUSES: readonly StepDisplayStatus[] = [
  "WORKING", "READY", "WAITING_DEPENDENCY", "RECOVERY_NEEDED",
];

export const STATUS_ON_ENTER = ["none", "advance", "park", "review", "continue", "handoff", "retry"] as const;
export type StatusOnEnter = (typeof STATUS_ON_ENTER)[number];

export function isStatusOnEnter(value: unknown): value is StatusOnEnter {
  return typeof value === "string" && (STATUS_ON_ENTER as readonly string[]).includes(value);
}

export interface StatusPresentation {
  label: string;
  shortLabel: string;
  description: string;
  tone: StatusTone;
  icon: StatusIcon;
}

export interface StatusPolicy {
  isTerminal: boolean;
  satisfiesDependency: boolean;
  blocksParent: boolean;
  needsAttention: boolean;
  precedence: number;
  onEnter: StatusOnEnter;
}

export type StatusPolicyKey = keyof StatusPolicy;
export type StatusEditableKey = keyof StatusPresentation | StatusPolicyKey;

export interface StatusDefinition extends StatusPresentation, StatusPolicy {
  id: StepDisplayStatus;
  storable: boolean;
  locked: readonly StatusEditableKey[];
  lockedReason: string | null;
}

const NEVER_STORED =
  "This state is derived from what is true right now, not written to the database, "
  + "so it has no entry behaviour to configure.";

const DEFINITION_OF_DONE =
  "Closing a work item is what the whole pipeline exists to decide. Letting it stop "
  + "counting as finished would make every rollup and every dependency wrong at once.";

export const DEFAULT_STATUS_CATALOG: readonly StatusDefinition[] = [
  {
    id: "TODO",
    storable: true,
    label: "To do",
    shortLabel: "To do",
    description: "Not started. No agent has been given this work item yet.",
    tone: "neutral",
    icon: "dot",
    isTerminal: false,
    satisfiesDependency: false,
    blocksParent: true,
    needsAttention: false,
    precedence: 0,
    onEnter: "none",
    locked: ["isTerminal", "satisfiesDependency"],
    lockedReason: "Unstarted work is never finished and never satisfies a dependency.",
  },
  {
    id: "IN_PROGRESS",
    storable: true,
    label: "In progress",
    shortLabel: "Running",
    description: "An agent holds this work item. Set when a run starts, cleared when it ends.",
    tone: "info",
    icon: "spinner",
    isTerminal: false,
    satisfiesDependency: false,
    blocksParent: true,
    needsAttention: false,
    precedence: 0,
    onEnter: "none",
    locked: ["isTerminal", "satisfiesDependency"],
    lockedReason: "Work still in flight is never finished and never satisfies a dependency.",
  },
  {
    id: "DONE",
    storable: true,
    label: "Done",
    shortLabel: "Done",
    description:
      "Finished, and the definition of done was satisfied. Reached by an agent's own "
      + "status post, by a reviewer's COMPLETE verdict, or by you.",
    tone: "success",
    icon: "check",
    isTerminal: true,
    satisfiesDependency: true,
    blocksParent: false,
    needsAttention: false,
    precedence: 0,
    onEnter: "advance",
    locked: ["isTerminal", "satisfiesDependency", "needsAttention"],
    lockedReason: DEFINITION_OF_DONE,
  },
  {
    id: "BLOCKED",
    storable: true,
    label: "Needs you",
    shortLabel: "Needs you",
    description:
      "The agent stopped and asked a question only a human can answer. This is a "
      + "question, not unfinished work — it is never audited and never handed off.",
    tone: "warning",
    icon: "question",
    isTerminal: false,
    satisfiesDependency: false,
    blocksParent: true,
    needsAttention: true,
    precedence: 30,
    onEnter: "park",
    locked: ["isTerminal", "satisfiesDependency"],
    lockedReason: "An unanswered question is not finished work.",
  },
  {
    id: "UNREPORTED",
    storable: true,
    label: "Not reported",
    shortLabel: "Unreported",
    description:
      "The run ended without posting a final status. Whether the work was finished "
      + "is unknown — never assumed. A reviewer decides, and until it does this is "
      + "neither a success nor a failure.",
    tone: "caution",
    icon: "search",
    isTerminal: false,
    satisfiesDependency: false,
    blocksParent: true,
    needsAttention: true,
    precedence: 40,
    onEnter: "review",
    locked: ["isTerminal", "satisfiesDependency"],
    lockedReason:
      "Work nobody has confirmed cannot count as finished. This is the whole point of "
      + "the state: it exists so that a dropped status post is never read as failure "
      + "and never read as success.",
  },
  {
    id: "FAILED",
    storable: true,
    label: "Failed",
    shortLabel: "Failed",
    description:
      "The run reported failure, crashed, or never started. Only an observed process "
      + "failure produces this — it is never inferred from a missing status post.",
    tone: "danger",
    icon: "cross",
    isTerminal: false,
    satisfiesDependency: false,
    blocksParent: true,
    needsAttention: true,
    precedence: 60,
    onEnter: "park",
    locked: ["isTerminal", "satisfiesDependency"],
    lockedReason: "A failed run has not finished its work.",
  },
  {
    id: "NEEDS_REVIEW",
    storable: true,
    label: "Needs review",
    shortLabel: "Review",
    description:
      "Something could not be confirmed either way: a reviewer returned UNVERIFIABLE, "
      + "a definition-of-done check did not pass, or a child needs attention. Waiting "
      + "on your judgement.",
    tone: "violet",
    icon: "review",
    isTerminal: false,
    satisfiesDependency: false,
    blocksParent: true,
    needsAttention: true,
    precedence: 50,
    onEnter: "park",
    locked: ["isTerminal", "satisfiesDependency"],
    lockedReason: "Unconfirmed work is not finished work.",
  },
  {
    id: "SKIPPED",
    storable: true,
    label: "Skipped",
    shortLabel: "Skipped",
    description:
      "Deliberately passed over. Settles a parent, but does not satisfy anything that "
      + "declared a dependency on it — that work was never done.",
    tone: "neutral",
    icon: "skip",
    isTerminal: true,
    satisfiesDependency: false,
    blocksParent: false,
    needsAttention: false,
    precedence: 0,
    onEnter: "advance",
    locked: ["isTerminal"],
    lockedReason: "A skipped item is settled; the pipeline must be able to move past it.",
  },

  {
    id: "WORKING",
    storable: false,
    label: "Agent working",
    shortLabel: "Working",
    description: "A process is running against this work item right now.",
    tone: "info",
    icon: "spinner",
    isTerminal: false,
    satisfiesDependency: false,
    blocksParent: true,
    needsAttention: false,
    precedence: 0,
    onEnter: "none",
    locked: ["isTerminal", "satisfiesDependency", "blocksParent", "precedence", "onEnter"],
    lockedReason: NEVER_STORED,
  },
  {
    id: "READY",
    storable: false,
    label: "Ready",
    shortLabel: "Ready",
    description: "Not started, with every prerequisite satisfied. The scheduler can pick it up.",
    tone: "accent",
    icon: "dot",
    isTerminal: false,
    satisfiesDependency: false,
    blocksParent: true,
    needsAttention: false,
    precedence: 0,
    onEnter: "none",
    locked: ["isTerminal", "satisfiesDependency", "blocksParent", "precedence", "onEnter"],
    lockedReason: NEVER_STORED,
  },
  {
    id: "WAITING_DEPENDENCY",
    storable: false,
    label: "Waiting",
    shortLabel: "Waiting",
    description:
      "Not started, and something else has to finish first — a declared dependency, an "
      + "open child, or an earlier sibling.",
    tone: "neutral",
    icon: "clock",
    isTerminal: false,
    satisfiesDependency: false,
    blocksParent: true,
    needsAttention: false,
    precedence: 0,
    onEnter: "none",
    locked: ["isTerminal", "satisfiesDependency", "blocksParent", "precedence", "onEnter"],
    lockedReason: NEVER_STORED,
  },
  {
    id: "RECOVERY_NEEDED",
    storable: false,
    label: "Recovery needed",
    shortLabel: "Recover",
    description:
      "Marked in progress, but the process is gone and the server never got to record "
      + "how it ended — a crash mid-run. Recovering resets it so it can be run again.",
    tone: "caution",
    icon: "alert",
    isTerminal: false,
    satisfiesDependency: false,
    blocksParent: true,
    needsAttention: true,
    precedence: 45,
    onEnter: "none",
    locked: ["isTerminal", "satisfiesDependency", "blocksParent", "onEnter"],
    lockedReason: NEVER_STORED,
  },
];

const CATALOG_BY_ID = new Map<StepDisplayStatus, StatusDefinition>(
  DEFAULT_STATUS_CATALOG.map((entry) => [entry.id, entry]),
);

export function defaultStatusDefinition(id: StepDisplayStatus): StatusDefinition {
  const found = CATALOG_BY_ID.get(id);
  if (found === undefined) throw new Error(`No status definition for ${id}`);
  return found;
}

export function statusDefinition(
  catalog: readonly StatusDefinition[],
  id: StepDisplayStatus,
): StatusDefinition {
  return catalog.find((entry) => entry.id === id) ?? defaultStatusDefinition(id);
}

export function statusFieldEditable(
  definition: StatusDefinition,
  field: StatusEditableKey,
): boolean {
  return !definition.locked.includes(field);
}

export const STATUS_TRIGGERS = [
  "agent_post",
  "agent_decompose",
  "agent_continue",
  "run_started",
  "run_ended_without_post",
  "run_crashed",
  "run_start_failed",
  "budget_exhausted",
  "continuation",
  "provider_fallback",
  "review_complete",
  "review_not_complete",
  "dod_unmet",
  "dod_command_failed",
  "child_rollup",
  "operator_override",
  "operator_skip",
  "operator_recover",
  "operator_retry",
  "operator_resume",
  "restart_resume",
  "dependency_blocked",
  "import",
] as const;
export type StatusTrigger = (typeof STATUS_TRIGGERS)[number];

export function isStatusTrigger(value: unknown): value is StatusTrigger {
  return typeof value === "string" && (STATUS_TRIGGERS as readonly string[]).includes(value);
}

export const DEFAULT_TRIGGER_SENTENCES: Record<StatusTrigger, string> = {
  agent_post: "The agent posted this status itself.",
  agent_decompose: "The agent split this work item into sub-steps.",
  agent_continue: "The agent recorded its progress and asked to be resumed on the same working tree.",
  run_started: "An agent run started.",
  run_ended_without_post: "The run ended without posting a final status.",
  run_crashed: "The agent process failed.",
  run_start_failed: "The agent process could not be started.",
  budget_exhausted: "The run hit its budget before it finished.",
  continuation: "The station was re-queued on the same working tree with the previous run's notes.",
  provider_fallback: "The agent could not run, so the station was started with another provider.",
  review_complete: "A reviewer checked the work and found it complete.",
  review_not_complete: "A reviewer could not confirm the work was finished.",
  dod_unmet: "The definition of done was not satisfied.",
  dod_command_failed: "A definition-of-done command did not pass.",
  child_rollup: "A sub-step's outcome propagated up to this item.",
  operator_override: "You set this status yourself.",
  operator_skip: "You skipped it.",
  operator_recover: "You recovered it.",
  operator_retry: "You retried it.",
  operator_resume: "You resumed the station, granting a fresh continuation allowance.",
  restart_resume: "The server restarted mid-run, so the station was re-queued on the same working tree.",
  dependency_blocked: "Every remaining path is waiting on something else.",
  import: "It was created by an import.",
};

export function describeTrigger(
  trigger: string | null,
  sentences: Partial<Record<string, string>> = DEFAULT_TRIGGER_SENTENCES,
): string | null {
  if (trigger === null || trigger === "") return null;
  return sentences[trigger] ?? DEFAULT_TRIGGER_SENTENCES[trigger as StatusTrigger] ?? trigger;
}

export const STEP_SIGNALS = [
  "agent_posted_done",
  "agent_posted_blocked",
  "agent_posted_continue",
  "agent_decomposed",
  "run_ended_no_post",
  "run_crashed",
  "run_start_failed",
  "provider_could_not_run",
  "review_verdict_complete",
  "review_verdict_incomplete",
  "review_verdict_unverifiable",
  "review_unavailable",
  "dod_unmet",
  "children_settled_clean",
  "children_settled_with_attention",
] as const;
export type StepSignal = (typeof STEP_SIGNALS)[number];

export function isStepSignal(value: unknown): value is StepSignal {
  return typeof value === "string" && (STEP_SIGNALS as readonly string[]).includes(value);
}

export const STEP_NEXT_ACTIONS = ["advance", "park", "review", "continue", "rule"] as const;
export type StepNextAction = (typeof STEP_NEXT_ACTIONS)[number];

export interface StepTransitionRow {
  id: string;
  when: {
    signal: StepSignal;
    producedWork?: boolean;
  };
  to: StepStatus | null;
  trigger: StatusTrigger;
  next: StepNextAction;
  condition: string;
  because: string;
  policy: RulePolicy;
}

const LOCKED_NO_INFERENCE =
  "The pipeline must never turn a missing status post into a verdict. This row is what "
  + "guarantees that, so it is not a preference.";

const LOCKED_AGENT_AUTHORITY =
  "A status the agent posted through the audited API is the most direct evidence there "
  + "is. Overriding it from a rule table would make the API pointless.";

export const STEP_TRANSITIONS: readonly StepTransitionRow[] = [
  {
    id: "agent-done",
    when: { signal: "agent_posted_done" },
    to: "DONE",
    trigger: "agent_post",
    next: "rule",
    condition: "The agent posted DONE",
    because: "The agent reported the work finished, with a verification summary.",
    policy: { kind: "locked", reason: LOCKED_AGENT_AUTHORITY },
  },
  {
    id: "agent-blocked",
    when: { signal: "agent_posted_blocked" },
    to: "BLOCKED",
    trigger: "agent_post",
    next: "rule",
    condition: "The agent posted BLOCKED",
    because: "The agent stopped to ask a question only a human can answer.",
    policy: { kind: "locked", reason: LOCKED_AGENT_AUTHORITY },
  },
  {
    id: "agent-continue",
    when: { signal: "agent_posted_continue" },
    to: "TODO",
    trigger: "agent_continue",
    next: "rule",
    condition: "The agent recorded what remains and asked to be resumed",
    because:
      "The agent's own account of what remains is the cheapest brief there is — it wrote it "
      + "while it still had the context, so the run that resumes this item does not have to "
      + "rediscover the work.",
    policy: { kind: "locked", reason: LOCKED_AGENT_AUTHORITY },
  },
  {
    id: "agent-decomposed",
    when: { signal: "agent_decomposed" },
    to: "TODO",
    trigger: "agent_decompose",
    next: "advance",
    condition: "The agent split the item into sub-steps",
    because: "The work item became a parent; its sub-steps carry the work now.",
    policy: { kind: "locked", reason: "A parent waits on its children by construction." },
  },
  {
    id: "provider-fallback",
    when: { signal: "provider_could_not_run" },
    to: "TODO",
    trigger: "provider_fallback",
    next: "rule",
    condition: "The agent process could not run for a reason that says nothing about the work",
    because:
      "The agent could not run, so the station was started with another provider. "
      + "This does not consume a continuation.",
    policy: {
      kind: "locked",
      reason: "A capacity, quota, auth or start failure is about the provider, not the work.",
    },
  },
  {
    id: "run-start-failed",
    when: { signal: "run_start_failed" },
    to: "FAILED",
    trigger: "run_start_failed",
    next: "continue",
    condition: "The agent process could not start",
    because: "No agent ever ran, so nothing about the work can be concluded. The station is continued rather than parked.",
    policy: { kind: "locked", reason: "A process that never started cannot have finished." },
  },
  {
    id: "run-ended-no-post",
    when: { signal: "run_ended_no_post" },
    to: "UNREPORTED",
    trigger: "run_ended_without_post",
    next: "continue",
    condition: "The run ended without posting a status",
    because:
      "The run finished cleanly but never said what it achieved, so whether the work is "
      + "done is unknown. The station is continued on the same working tree rather than "
      + "guessed at.",
    policy: { kind: "locked", reason: LOCKED_NO_INFERENCE },
  },
  {
    id: "run-crashed",
    when: { signal: "run_crashed" },
    to: "FAILED",
    trigger: "run_crashed",
    next: "continue",
    condition: "The agent process failed",
    because: "The process exited abnormally, which is an observed failure rather than a guess. The station is continued rather than parked.",
    policy: { kind: "locked", reason: "An observed crash is a fact, not a preference." },
  },
  {
    id: "review-complete",
    when: { signal: "review_verdict_complete" },
    to: "DONE",
    trigger: "review_complete",
    next: "rule",
    condition: "A reviewer confirmed the work, after continuations ran out",
    because: "An independent read-only agent checked the tree and found every criterion met.",
    policy: {
      kind: "setting",
      key: "pipeline.dodEnforcement",
      reason: "The definition of done still gets the last word on whether this closes.",
    },
  },
  {
    id: "review-not-complete",
    when: { signal: "review_verdict_incomplete" },
    to: null,
    trigger: "review_not_complete",
    next: "park",
    condition: "A reviewer could not confirm the work is finished, after continuations ran out",
    because: "The station is held for you rather than continued again or guessed at.",
    policy: {
      kind: "setting",
      key: "pipeline.reviewAfterContinuations",
      reason: "Whether a reviewer is sent after continuations run out is a house rule.",
    },
  },
  {
    id: "review-unverifiable",
    when: { signal: "review_verdict_unverifiable" },
    to: null,
    trigger: "review_not_complete",
    next: "park",
    condition: "A reviewer could not tell either way, after continuations ran out",
    because: "Neither completion nor failure could be established, so it waits for your judgement.",
    policy: { kind: "locked", reason: LOCKED_NO_INFERENCE },
  },
  {
    id: "review-unavailable",
    when: { signal: "review_unavailable" },
    to: null,
    trigger: "review_not_complete",
    next: "park",
    condition: "The reviewer itself could not be run, after continuations ran out",
    because:
      "No second opinion was available, and an unchecked run is not evidence of anything.",
    policy: { kind: "locked", reason: LOCKED_NO_INFERENCE },
  },
  {
    id: "dod-unmet",
    when: { signal: "dod_unmet" },
    to: "NEEDS_REVIEW",
    trigger: "dod_unmet",
    next: "park",
    condition: "The definition of done was not satisfied",
    because: "A required criterion did not pass, so the item cannot close on this evidence.",
    policy: {
      kind: "setting",
      key: "pipeline.dodEnforcement",
      reason: "Whether an unmet definition of done blocks or merely warns is a house rule.",
    },
  },
  {
    id: "children-settled-clean",
    when: { signal: "children_settled_clean" },
    to: "DONE",
    trigger: "child_rollup",
    next: "rule",
    condition: "Every sub-step settled, none needing attention",
    because: "All the work this item was split into is finished.",
    policy: { kind: "locked", reason: "A parent whose children are all done has nothing left to do." },
  },
  {
    id: "children-settled-with-attention",
    when: { signal: "children_settled_with_attention" },
    to: null,
    trigger: "child_rollup",
    next: "park",
    condition: "Every sub-step settled, at least one needing attention",
    because: "A sub-step needs you, so its parent cannot be treated as finished.",
    policy: {
      kind: "locked",
      reason:
        "The parent takes the highest-precedence attention status among its children, which is "
        + "configured on those statuses rather than here.",
    },
  },
];

export function matchStepTransition(args: {
  signal: StepSignal;
  producedWork?: boolean;
}): StepTransitionRow | null {
  for (const row of STEP_TRANSITIONS) {
    if (row.when.signal !== args.signal) continue;
    if (row.when.producedWork !== undefined && row.when.producedWork !== (args.producedWork ?? false)) continue;
    return row;
  }
  return null;
}

export function isTerminalDisplayStatus(
  catalog: readonly StatusDefinition[],
  id: StepDisplayStatus,
): boolean {
  return statusDefinition(catalog, id).isTerminal;
}

export function satisfiesDependency(
  catalog: readonly StatusDefinition[],
  id: StepDisplayStatus,
): boolean {
  return statusDefinition(catalog, id).satisfiesDependency;
}

export function needsAttention(
  catalog: readonly StatusDefinition[],
  id: StepDisplayStatus,
): boolean {
  return statusDefinition(catalog, id).needsAttention;
}

export function rollupStatus(
  catalog: readonly StatusDefinition[],
  childStatuses: readonly StepDisplayStatus[],
): StepDisplayStatus | null {
  let winner: StatusDefinition | null = null;
  for (const id of childStatuses) {
    const definition = statusDefinition(catalog, id);
    if (!definition.needsAttention) continue;
    if (winner === null || definition.precedence > winner.precedence) winner = definition;
  }
  return winner === null ? null : winner.id;
}

export const DOD_CRITERION_KINDS = ["PROSE", "COMMAND", "CHILDREN_CLOSED"] as const;
export type DodCriterionKind = (typeof DOD_CRITERION_KINDS)[number];

export function isDodCriterionKind(value: unknown): value is DodCriterionKind {
  return typeof value === "string" && (DOD_CRITERION_KINDS as readonly string[]).includes(value);
}

export const DOD_KIND_LABEL: Record<DodCriterionKind, string> = {
  PROSE: "A reviewer judges it",
  COMMAND: "A command this server runs",
  CHILDREN_CLOSED: "Every sub-step is closed",
};

export const DOD_KIND_HINT: Record<DodCriterionKind, string> = {
  PROSE:
    "Written for a person to read and a read-only reviewer agent to judge. Flexible, and the "
    + "only kind an agent can argue its way past.",
  COMMAND:
    "Run by this server in the workspace directory, not by the agent. Its exit code decides, and "
    + "its real output is recorded as the evidence.",
  CHILDREN_CLOSED:
    "Satisfied when every sub-step this item was split into has settled and none needs attention.",
};

export const DOD_RESULT_SOURCES = ["AGENT", "REVIEWER", "RUNNER", "HUMAN"] as const;
export type DodResultSource = (typeof DOD_RESULT_SOURCES)[number];

export function isDodResultSource(value: unknown): value is DodResultSource {
  return typeof value === "string" && (DOD_RESULT_SOURCES as readonly string[]).includes(value);
}

export const DOD_RESULTS = ["PASSED", "FAILED", "UNVERIFIED"] as const;
export type DodResult = (typeof DOD_RESULTS)[number];

export function isDodResult(value: unknown): value is DodResult {
  return typeof value === "string" && (DOD_RESULTS as readonly string[]).includes(value);
}

export const DOD_ENFORCEMENTS = ["block", "warn", "off"] as const;
export type DodEnforcement = (typeof DOD_ENFORCEMENTS)[number];

export function isDodEnforcement(value: unknown): value is DodEnforcement {
  return typeof value === "string" && (DOD_ENFORCEMENTS as readonly string[]).includes(value);
}

export const DOD_ENFORCEMENT_LABEL: Record<DodEnforcement, string> = {
  block: "Refuse to close the item",
  warn: "Close it, but record what did not pass",
  off: "Do not check",
};

export const DOD_SCOPES = ["workspace", "program", "suite", "prompt"] as const;
export type DodScope = (typeof DOD_SCOPES)[number];

export function isDodScope(value: unknown): value is DodScope {
  return typeof value === "string" && (DOD_SCOPES as readonly string[]).includes(value);
}

export const DOD_SCOPE_LABEL: Record<DodScope, string> = {
  workspace: "this workspace",
  program: "this program",
  suite: "this suite",
  prompt: "this work item",
};

export const DOD_COMMAND_TIMEOUT_DEFAULT_MS = 120_000;
export const DOD_COMMAND_TIMEOUT_MIN_MS = 1_000;
export const DOD_COMMAND_TIMEOUT_MAX_MS = 600_000;
export const DOD_COMMAND_OUTPUT_MAX_BYTES = 16_000;
export const DOD_COMMAND_MAX_LENGTH = 2_000;

export function clampDodTimeout(milliseconds: number): number {
  if (!Number.isFinite(milliseconds)) return DOD_COMMAND_TIMEOUT_DEFAULT_MS;
  return Math.min(DOD_COMMAND_TIMEOUT_MAX_MS, Math.max(DOD_COMMAND_TIMEOUT_MIN_MS, Math.round(milliseconds)));
}

export interface DodCriterion {
  id: number;
  kind: DodCriterionKind;
  text: string;
  command: string | null;
  cwd: string | null;
  expectExitCode: number;
  timeoutMs: number;
  required: boolean;
  sortOrder: number;
}

export interface DefinitionOfDone {
  scope: DodScope;
  scopeId: number;
  enforcement: DodEnforcement;
  inheritedFrom: { scope: DodScope; scopeId: number } | null;
  criteria: DodCriterion[];
}

export interface DodCriterionResult {
  criterionId: number;
  kind: DodCriterionKind;
  text: string;
  required: boolean;
  result: DodResult;
  source: DodResultSource | null;
  evidence: string;
  output: string;
  exitCode: number | null;
  runId: string | null;
  createdAt: string | null;
}

export interface DodEvaluation {
  enforcement: DodEnforcement;
  satisfied: boolean;
  blocking: boolean;
  criteria: DodCriterionResult[];
}

export function unmetCriteria(evaluation: DodEvaluation): DodCriterionResult[] {
  return evaluation.criteria.filter((entry) => entry.required && entry.result !== "PASSED");
}

export function dodUnmetEvidence(evaluation: DodEvaluation): Record<string, unknown> {
  const unmet = unmetCriteria(evaluation);
  const required = evaluation.criteria.filter((entry) => entry.required).length;
  const evidence: Record<string, unknown> = {
    definitionOfDone: `${unmet.length} of ${required} required criteria not met`,
  };
  for (const entry of unmet) {
    const detail = entry.evidence !== "" ? entry.evidence
      : entry.result === "UNVERIFIED" ? "Nothing has checked this yet."
      : "";
    evidence[entry.text.slice(0, 200)] = detail === "" ? entry.result : `${entry.result} — ${detail}`;
  }
  return evidence;
}

export function dodUnmetReason(evaluation: DodEvaluation): string {
  const unmet = unmetCriteria(evaluation);
  const names = unmet.slice(0, 3).map((entry) => entry.text).join("; ");
  const more = unmet.length > 3 ? ` (and ${unmet.length - 3} more)` : "";
  return `The definition of done was not satisfied: ${names}${more}. `
    + "The work item is held for review rather than closed on this evidence.";
}
