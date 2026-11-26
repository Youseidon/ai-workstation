import type { NormalizedEvent } from "./events.ts";
import type { OperationsPrompt } from "./operations.ts";
import type { ClarificationExchange, PromptRemark, PromptStatusEvent } from "./workspaces.ts";
import type { AgentSession } from "./runs.ts";
import type { CompletionAuditRecord } from "./completionAudit.ts";

export type SuiteVerificationVerdict = "PASS" | "WARNING" | "FAIL";
/** UNVERIFIED is a real outcome: the agent looked and could not establish it. */
export type SuiteVerificationCheck = "VERIFIED" | "WARNING" | "FAILED" | "UNVERIFIED";
/** AGENT re-runs the checks; AUDIT only reads back what was already recorded. */
export type SuiteVerificationKind = "AGENT" | "AUDIT";
export type SuiteVerificationState = "RUNNING" | "DONE" | "INTERRUPTED" | "ERROR" | "RECORDED";

export interface SuiteVerificationItem {
  promptId: number | null;
  promptKey: string | null;
  title: string;
  check: SuiteVerificationCheck;
  evidence: string;
  /** The decisive commands the agent says it ran for this item. */
  commands: string;
}

export interface SuiteVerificationSummary {
  total: number;
  verified: number;
  warnings: number;
  failed: number;
  unverified: number;
}

export interface SuiteVerificationStats {
  workItems: number;
  sourceCharacters: number;
  dossierCharacters: number;
  uniqueCommands: number;
}

/**
 * A verification that happened, kept forever.
 *
 * Verifications used to leave nothing behind: the agent kind ran as an
 * anonymous custom prompt whose events were never persisted, and the audit kind
 * was recomputed on every request. Both vanished on navigation or reload, so
 * "was this suite ever verified, and what did it find?" had no answer.
 */
export interface SuiteVerificationRecord {
  id: number;
  suite: { id: number; key: string | null; name: string; programName: string; workspaceName: string; workspaceId: number };
  kind: SuiteVerificationKind;
  /** The agent run that produced it, for AGENT verifications. */
  runId: string | null;
  provider: string | null;
  model: string | null;
  state: SuiteVerificationState;
  /** Null while an agent verification is still running. */
  verdict: SuiteVerificationVerdict | null;
  summary: SuiteVerificationSummary;
  /** The agent's full written report, kept verbatim even if parsing fails. */
  reportMarkdown: string;
  stats: SuiteVerificationStats | null;
  /** When set, the verification covered one work item rather than the whole suite. */
  scopePromptId: number | null;
  startedAt: string;
  endedAt: string | null;
  items: SuiteVerificationItem[];
}

/** A record plus the transcript of the run that produced it. */
export interface SuiteVerificationDetail extends SuiteVerificationRecord {
  events: NormalizedEvent[];
}

/** The badge on a suite: what the last verification concluded, and when. */
export interface SuiteVerificationBadge {
  id: number;
  kind: SuiteVerificationKind;
  state: SuiteVerificationState;
  verdict: SuiteVerificationVerdict | null;
  startedAt: string;
  endedAt: string | null;
}

export interface SuiteVerificationContext {
  suiteId: number;
  prompt: string;
  stats: SuiteVerificationStats;
  scopePromptId: number | null;
  scopePromptKey: string | null;
}
export interface PromptActivity {
  item: OperationsPrompt;
  remarks: PromptRemark[];
  events: PromptStatusEvent[];
  clarifications: ClarificationExchange[];
  sessions: AgentSession[];
  /** Newest first. Read-only adjudications of a run that ended without a status. */
  audits: CompletionAuditRecord[];
  /** True when the latest developer run made at least one tool call. */
  producedWork: boolean;
}
