/**
 * The status vocabulary: what a work item can be, what each state means, and
 * what put it there.
 *
 * This is the base layer of `shared` — it imports nothing, so both `index.ts`
 * and `pipelineRules.ts` can sit on top of it without a cycle. The tone and
 * rule-policy vocabularies live here rather than in `pipelineRules` for the
 * same reason: a status has a colour and an editability policy before there is
 * any transport interlocking to talk about.
 *
 * Three things are deliberately data rather than code:
 *
 * 1. **The catalog.** Every state carries its own label, description, colour
 *    and consequences. The engine keys off the immutable `id`; everything else
 *    is presentation and policy the operator owns, persisted in SQLite and
 *    layered over the defaults here. A hardcoded label map cannot be renamed,
 *    cannot be explained on screen, and — as this app proved twice — drifts
 *    into two copies that disagree.
 *
 * 2. **The triggers.** A status without a recorded cause is an assertion the
 *    operator has to take on faith. Every transition names one of these, and
 *    the sentence is rendered verbatim next to the badge.
 *
 * 3. **The transitions.** An ordered, first-match-wins table, so the answer to
 *    "why is this red" is a row you can point at rather than a branch buried in
 *    a scheduler.
 */

/* ------------------------------------------------------------------ */
/* Shared vocabularies                                                 */
/* ------------------------------------------------------------------ */

/**
 * Semantic colour roles. The web `Badge` imports this rather than declaring its
 * own, so the two cannot drift.
 */
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

/**
 * Icon keys, not glyphs. The server stores a key and the web maps it to an SVG,
 * so an operator picking an icon cannot inject markup and a theme can change
 * every glyph at once.
 */
export const STATUS_ICONS = [
  "dot", "spinner", "check", "cross", "question", "alert",
  "clock", "skip", "review", "search", "pause", "link",
] as const;
export type StatusIcon = (typeof STATUS_ICONS)[number];

export function isStatusIcon(value: unknown): value is StatusIcon {
  return typeof value === "string" && (STATUS_ICONS as readonly string[]).includes(value);
}

/**
 * Settings keys a rule row can defer to. Only keys an actual row references
 * live here; the rest of the pipeline policy group joins as rows start using it.
 */
export type PolicyKey =
  | "pipeline.pauseMode"
  | "pipeline.onRestart"
  | "pipeline.maxContinuations"
  | "pipeline.reviewAfterContinuations"
  | "pipeline.dodEnforcement";

/**
 * How much of a rule row the operator is allowed to change.
 *
 * `locked` is not an oversight — some rows are invariants rather than
 * preferences, and a settings screen that could break them would be worse than
 * no settings screen. The reason is shown in the UI instead of a missing
 * control, so a locked row explains itself.
 */
export type RulePolicy =
  | { kind: "locked"; reason: string }
  | { kind: "setting"; key: PolicyKey; reason: string }
  | { kind: "stationRule"; field: "onDone" | "onUnfinished"; reason: string };

/* ------------------------------------------------------------------ */
/* The stored status                                                   */
/* ------------------------------------------------------------------ */

/**
 * What can be written to `prompt.status`.
 *
 * `UNREPORTED`, `FAILED` and `NEEDS_REVIEW` are the three that used to be
 * inferred. Before them, a run whose agent finished the work but dropped its
 * final status post was written `BLOCKED` by the system and became
 * indistinguishable from an agent that stopped to ask a question; the only
 * thing separating the two was re-reading the last status event to see whether
 * its actor was `SYSTEM`. That inference is what made the pipeline's verdicts
 * untrustworthy, and storing the distinction is what retires it.
 */
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

/**
 * What a work item shows on a card.
 *
 * A superset of the stored statuses: three of these are live overlays that
 * exist only while something is true right now, and are never written to the
 * database. Keeping them in one catalog is deliberate — the operator sees one
 * list of states and edits it in one place, rather than learning which half of
 * the vocabulary lives where.
 */
export const STEP_DISPLAY_STATUSES = [
  ...STEP_STATUSES,
  /** A process is running against this item. */
  "WORKING",
  /** TODO with every prerequisite satisfied. */
  "READY",
  /** TODO waiting on a dependency, an open child, or an earlier sibling. */
  "WAITING_DEPENDENCY",
  /** IN_PROGRESS but the process is gone — a crash before the bookkeeping ran. */
  "RECOVERY_NEEDED",
] as const;
export type StepDisplayStatus = (typeof STEP_DISPLAY_STATUSES)[number];

export function isStepDisplayStatus(value: unknown): value is StepDisplayStatus {
  return typeof value === "string" && (STEP_DISPLAY_STATUSES as readonly string[]).includes(value);
}

/** The overlays, as a set, for the places that need to reject them on a write. */
export const OVERLAY_STATUSES: readonly StepDisplayStatus[] = [
  "WORKING", "READY", "WAITING_DEPENDENCY", "RECOVERY_NEEDED",
];

/* ------------------------------------------------------------------ */
/* The catalog                                                         */
/* ------------------------------------------------------------------ */

/** What entering a state should set in motion. */
export const STATUS_ON_ENTER = ["none", "advance", "park", "review", "continue", "handoff", "retry"] as const;
export type StatusOnEnter = (typeof STATUS_ON_ENTER)[number];

export function isStatusOnEnter(value: unknown): value is StatusOnEnter {
  return typeof value === "string" && (STATUS_ON_ENTER as readonly string[]).includes(value);
}

/** The half of a definition the operator may rewrite. */
export interface StatusPresentation {
  label: string;
  shortLabel: string;
  description: string;
  tone: StatusTone;
  icon: StatusIcon;
}

/** The half that changes what the engine does. */
export interface StatusPolicy {
  /** No further work is expected. Terminal states settle a parent's rollup. */
  isTerminal: boolean;
  /**
   * A declared dependency on this item is satisfied.
   *
   * Split from `isTerminal` because `SKIPPED` is asymmetric on purpose: it
   * settles a parent, but it does not entitle a dependant to run against work
   * that was never done.
   */
  satisfiesDependency: boolean;
  /** A parent cannot close while a child sits here. */
  blocksParent: boolean;
  /** Counts toward the attention list and the blocked-stations panel. */
  needsAttention: boolean;
  /**
   * Worst-child ordering for the parent rollup: when every child has settled,
   * the parent takes the highest-precedence attention status among them.
   * Higher wins. Zero for states that never propagate.
   */
  precedence: number;
  onEnter: StatusOnEnter;
}

export type StatusPolicyKey = keyof StatusPolicy;
export type StatusEditableKey = keyof StatusPresentation | StatusPolicyKey;

export interface StatusDefinition extends StatusPresentation, StatusPolicy {
  id: StepDisplayStatus;
  /** False for the four live overlays, which are derived and never stored. */
  storable: boolean;
  /**
   * Fields the operator may not change, with the reason shown in their place.
   * An empty list means everything on this row is editable.
   */
  locked: readonly StatusEditableKey[];
  lockedReason: string | null;
}

const NEVER_STORED =
  "This state is derived from what is true right now, not written to the database, "
  + "so it has no entry behaviour to configure.";

const DEFINITION_OF_DONE =
  "Closing a work item is what the whole pipeline exists to decide. Letting it stop "
  + "counting as finished would make every rollup and every dependency wrong at once.";

/**
 * The shipped catalog. A `status_definition` row in SQLite overrides any field
 * of the matching entry; anything the operator has not touched falls through to
 * here, so a fresh install and an upgraded one behave identically.
 */
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

  /* ---- live overlays: derived every read, never stored ---- */

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

/**
 * The shipped definition for a state. Callers that need the operator's edits go
 * through the server's resolved catalog instead; this is the fallback beneath it
 * and the source the database is seeded from.
 */
export function defaultStatusDefinition(id: StepDisplayStatus): StatusDefinition {
  const found = CATALOG_BY_ID.get(id);
  if (found === undefined) throw new Error(`No status definition for ${id}`);
  return found;
}

/** Look a definition up in a resolved catalog, falling back to the shipped one. */
export function statusDefinition(
  catalog: readonly StatusDefinition[],
  id: StepDisplayStatus,
): StatusDefinition {
  return catalog.find((entry) => entry.id === id) ?? defaultStatusDefinition(id);
}

/** Whether a field on this row is the operator's to change. */
export function statusFieldEditable(
  definition: StatusDefinition,
  field: StatusEditableKey,
): boolean {
  return !definition.locked.includes(field);
}

/* ------------------------------------------------------------------ */
/* Triggers — what put an item where it is                             */
/* ------------------------------------------------------------------ */

/**
 * The closed set of causes. Every status change records exactly one, so
 * "why is this red" always has an answer that was written down at the time
 * rather than reconstructed afterwards.
 */
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
  "restart_resume",
  "dependency_blocked",
  "import",
] as const;
export type StatusTrigger = (typeof STATUS_TRIGGERS)[number];

export function isStatusTrigger(value: unknown): value is StatusTrigger {
  return typeof value === "string" && (STATUS_TRIGGERS as readonly string[]).includes(value);
}

/**
 * One sentence per cause, rendered verbatim beside the badge. Operator-editable
 * for the same reason the labels are: the wording is theirs, the token is ours.
 */
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
  restart_resume: "The server restarted mid-run, so the station was re-queued on the same working tree.",
  dependency_blocked: "Every remaining path is waiting on something else.",
  import: "It was created by an import.",
};

/**
 * A cause as a sentence. An unrecognised token is passed through rather than
 * dropped: a raw token in the UI is ugly, but silence is worse.
 */
export function describeTrigger(
  trigger: string | null,
  sentences: Partial<Record<string, string>> = DEFAULT_TRIGGER_SENTENCES,
): string | null {
  if (trigger === null || trigger === "") return null;
  return sentences[trigger] ?? DEFAULT_TRIGGER_SENTENCES[trigger as StatusTrigger] ?? trigger;
}

/* ------------------------------------------------------------------ */
/* Transitions — the step-level interlocking                           */
/* ------------------------------------------------------------------ */

/**
 * What the engine observed. These are facts about a run or a check, never
 * conclusions — the conclusion is the row that matches.
 */
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

/** What the scheduler should do once the status is written. */
export const STEP_NEXT_ACTIONS = ["advance", "park", "review", "continue", "rule"] as const;
export type StepNextAction = (typeof STEP_NEXT_ACTIONS)[number];

export interface StepTransitionRow {
  /** Stable id: a React key, a test label, and what the ledger records. */
  id: string;
  when: {
    signal: StepSignal;
    /**
     * Whether the run made at least one tool call. Omitted matches either way;
     * it is what separates "left work a successor must not redo" from "left
     * nothing to summarise".
     */
    producedWork?: boolean;
  };
  /** Where the item lands. `null` means the row defers to the station's rule. */
  to: StepStatus | null;
  trigger: StatusTrigger;
  next: StepNextAction;
  /** When this row applies, as a short phrase. Rendered verbatim. */
  condition: string;
  /** One sentence: what this row concluded and why. */
  because: string;
  policy: RulePolicy;
}

const LOCKED_NO_INFERENCE =
  "The pipeline must never turn a missing status post into a verdict. This row is what "
  + "guarantees that, so it is not a preference.";

const LOCKED_AGENT_AUTHORITY =
  "A status the agent posted through the audited API is the most direct evidence there "
  + "is. Overriding it from a rule table would make the API pointless.";

/**
 * The interlocking, in order. First match wins.
 *
 * Rows are split so that every variation is its own row — the point is that a
 * reader can see each distinct outcome, rather than a ternary buried in one.
 */
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
    // Above run-crashed / run-start-failed in the catalog: a provider that
    // could not run is swapped, not continued. The scheduler writes this
    // trigger itself after classifyFailure; the signal is not produced by
    // endOfRunSignal.
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

/**
 * The row that decides an outcome. First match wins, exactly like the transport
 * table. Returns `null` only for a signal no row covers, which the totality
 * test in `statusModel.test.ts` exists to prevent.
 */
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

/* ------------------------------------------------------------------ */
/* Catalog-driven predicates                                           */
/* ------------------------------------------------------------------ */

/**
 * Whether a display state settles a parent and lets the pipeline move past it.
 *
 * Callers used to spell this inline as `!== "COMPLETE" && !== "SKIPPED"`, in
 * four places that had to be kept in step by hand. Reading it off the catalog
 * means an operator who marks a state terminal changes every one of them at once.
 */
export function isTerminalDisplayStatus(
  catalog: readonly StatusDefinition[],
  id: StepDisplayStatus,
): boolean {
  return statusDefinition(catalog, id).isTerminal;
}

/** Whether a dependant may run once its prerequisite reaches this state. */
export function satisfiesDependency(
  catalog: readonly StatusDefinition[],
  id: StepDisplayStatus,
): boolean {
  return statusDefinition(catalog, id).satisfiesDependency;
}

/** Whether this state belongs on the attention list. */
export function needsAttention(
  catalog: readonly StatusDefinition[],
  id: StepDisplayStatus,
): boolean {
  return statusDefinition(catalog, id).needsAttention;
}

/**
 * The state a parent should take when every child has settled and at least one
 * needs attention: the highest-precedence attention status among them.
 */
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

/* ------------------------------------------------------------------ */
/* The definition of done                                             */
/* ------------------------------------------------------------------ */

/**
 * What "finished" means for a work item, as data rather than prose.
 *
 * Before this, the only acceptance criteria the app had were whatever a regex
 * could scrape out of the work item's markdown — and that regex had one
 * installation's domain headings baked into it, so on any other repository it
 * matched almost nothing and the reviewer was handed an empty checklist.
 *
 * Three kinds, because they are checked by three different things and only one
 * of them can be argued with:
 *
 * - `PROSE` is judged by the reviewer agent. It is the flexible kind and the
 *   least trustworthy: a model can talk itself into a pass.
 * - `COMMAND` is run by the *server*, in the workspace directory, and judged on
 *   its exit code. Nothing in the loop can talk an exit code into being 0.
 * - `CHILDREN_CLOSED` is read off the child rollup the app already computes.
 */
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

/** Who produced a result. `RUNNER` is this server executing a command itself. */
export const DOD_RESULT_SOURCES = ["AGENT", "REVIEWER", "RUNNER", "HUMAN"] as const;
export type DodResultSource = (typeof DOD_RESULT_SOURCES)[number];

export function isDodResultSource(value: unknown): value is DodResultSource {
  return typeof value === "string" && (DOD_RESULT_SOURCES as readonly string[]).includes(value);
}

/**
 * `UNVERIFIED` is not a soft failure — it is the absence of evidence, and it is
 * distinct from `FAILED` for the same reason `UNREPORTED` is distinct from
 * `FAILED` on a work item: "nobody checked" and "it was checked and it did not
 * pass" are different facts, and collapsing them is what makes a verdict
 * untrustworthy. Neither one closes an item.
 */
export const DOD_RESULTS = ["PASSED", "FAILED", "UNVERIFIED"] as const;
export type DodResult = (typeof DOD_RESULTS)[number];

export function isDodResult(value: unknown): value is DodResult {
  return typeof value === "string" && (DOD_RESULTS as readonly string[]).includes(value);
}

/** What an unmet definition of done is allowed to do. */
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

/**
 * Where a definition of done can be attached. A work item inherits the nearest
 * one above it, so a house rule is written once.
 */
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

/*
 * Caps on a command criterion, stated here so the server, the editor and the
 * validator cannot disagree about them.
 *
 * These are a security boundary, not tuning. A criterion's command comes out of
 * the database and runs as the server's own user, so an unbounded timeout is a
 * hung console and an unbounded capture is a heap the operator cannot see
 * filling.
 */
export const DOD_COMMAND_TIMEOUT_DEFAULT_MS = 120_000;
export const DOD_COMMAND_TIMEOUT_MIN_MS = 1_000;
export const DOD_COMMAND_TIMEOUT_MAX_MS = 600_000;
export const DOD_COMMAND_OUTPUT_MAX_BYTES = 16_000;
export const DOD_COMMAND_MAX_LENGTH = 2_000;

/** Clamp a requested timeout into the range the server will actually honour. */
export function clampDodTimeout(milliseconds: number): number {
  if (!Number.isFinite(milliseconds)) return DOD_COMMAND_TIMEOUT_DEFAULT_MS;
  return Math.min(DOD_COMMAND_TIMEOUT_MAX_MS, Math.max(DOD_COMMAND_TIMEOUT_MIN_MS, Math.round(milliseconds)));
}

export interface DodCriterion {
  id: number;
  kind: DodCriterionKind;
  /** What the criterion says, in the operator's words. Always present. */
  text: string;
  /** The shell command, for `COMMAND` only. */
  command: string | null;
  /** Relative to the workspace directory. `null` means the workspace root. */
  cwd: string | null;
  expectExitCode: number;
  timeoutMs: number;
  /** An optional criterion is reported but never blocks a close. */
  required: boolean;
  sortOrder: number;
}

export interface DefinitionOfDone {
  /** The scope this was resolved *for*. */
  scope: DodScope;
  scopeId: number;
  enforcement: DodEnforcement;
  /**
   * Which scope the criteria actually came from, or `null` when nothing is
   * defined anywhere above this item. Rendered, because "this suite has no
   * definition of done" and "this suite inherits the workspace's" look
   * identical otherwise.
   */
  inheritedFrom: { scope: DodScope; scopeId: number } | null;
  criteria: DodCriterion[];
}

/** One criterion and the newest thing anyone recorded about it. */
export interface DodCriterionResult {
  criterionId: number;
  kind: DodCriterionKind;
  text: string;
  required: boolean;
  result: DodResult;
  /** `null` when nothing has ever been recorded for this criterion. */
  source: DodResultSource | null;
  evidence: string;
  /** Captured command output, for a `COMMAND` the server ran. */
  output: string;
  exitCode: number | null;
  runId: string | null;
  createdAt: string | null;
}

export interface DodEvaluation {
  enforcement: DodEnforcement;
  /** Every *required* criterion passed. Vacuously true when none is defined. */
  satisfied: boolean;
  /**
   * Whether falling short may actually stop a close. False under `warn` and
   * `off`, so the caller never has to re-derive the policy from the enum.
   */
  blocking: boolean;
  criteria: DodCriterionResult[];
}

/** The required criteria that are not passing. The reason a close is refused. */
export function unmetCriteria(evaluation: DodEvaluation): DodCriterionResult[] {
  return evaluation.criteria.filter((entry) => entry.required && entry.result !== "PASSED");
}

/**
 * What gets stored as `evidence_json` when a definition of done refuses a
 * close, shaped for the key/value renderer in the "Why this status" panel.
 *
 * The failing command's *own output* is what goes in the value — an operator
 * looking at a refused close needs the compiler's words, not ours.
 */
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

/** One sentence for a refused close, for the ledger's `reason`. */
export function dodUnmetReason(evaluation: DodEvaluation): string {
  const unmet = unmetCriteria(evaluation);
  const names = unmet.slice(0, 3).map((entry) => entry.text).join("; ");
  const more = unmet.length > 3 ? ` (and ${unmet.length - 3} more)` : "";
  return `The definition of done was not satisfied: ${names}${more}. `
    + "The work item is held for review rather than closed on this evidence.";
}
