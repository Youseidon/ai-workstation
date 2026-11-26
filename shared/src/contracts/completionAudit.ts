import type { ProviderId } from "./providers.ts";

/* -------------------------------------------------------------------------- */
/* Completion audit                                                            */
/* -------------------------------------------------------------------------- */

export const COMPLETION_AUDIT_STATES = ["QUEUED", "RUNNING", "READY", "FAILED"] as const;
export type CompletionAuditState = (typeof COMPLETION_AUDIT_STATES)[number];

/**
 * What a read-only auditor concluded about a station that blocked without an
 * agent-posted status. COMPLETE means the work is provably finished in the tree
 * and only the status post is missing; INCOMPLETE means real work remains;
 * UNVERIFIABLE means the auditor could not tell either way, which is not a pass.
 */
export const COMPLETION_VERDICTS = ["COMPLETE", "INCOMPLETE", "UNVERIFIABLE"] as const;
export type CompletionVerdict = (typeof COMPLETION_VERDICTS)[number];

export const AUDIT_CHECK_RESULTS = ["PASSED", "FAILED", "UNVERIFIED"] as const;
export type AuditCheckResult = (typeof AUDIT_CHECK_RESULTS)[number];

export interface CompletionAuditCheck {
  /** The acceptance criterion, quoted from the work item where possible. */
  criterion: string;
  /**
   * The `dod_criterion` this check answers, when the reviewer was given a
   * structured definition of done and echoed the id back.
   *
   * Matching a reviewer's verdict to a criterion by comparing its prose would
   * be a fuzzy string match deciding whether a work item closes, which is not a
   * thing to leave to a regex. An id the reviewer was handed and quoted back is
   * exact, and a check that names no id is simply not recorded against any
   * criterion rather than guessed at.
   */
  criterionId: number | null;
  result: AuditCheckResult;
  /** What the auditor observed — output, file contents, a diff hunk. */
  evidence: string;
  /** The read-only command it ran to see that, when it ran one. */
  command: string | null;
}

export interface CompletionAuditReport {
  version: 1;
  verdict: CompletionVerdict;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  checks: CompletionAuditCheck[];
  /** Concrete work the auditor found still missing. Empty when COMPLETE. */
  remainingWork: string[];
  /** Evidence sentence recorded on the work item when a COMPLETE is applied. */
  verificationSummary: string;
  reasoning: string;
}

export interface CompletionAuditRecord {
  id: string;
  workspaceId: number;
  promptId: number;
  /** The developer run whose outcome is being adjudicated. */
  sourceRunId: string;
  auditRunId: string | null;
  provider: ProviderId;
  model: string | null;
  state: CompletionAuditState;
  verdict: CompletionVerdict | null;
  report: CompletionAuditReport | null;
  reportMarkdown: string;
  /** True once a COMPLETE verdict actually moved the station to DONE. */
  applied: boolean;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}
