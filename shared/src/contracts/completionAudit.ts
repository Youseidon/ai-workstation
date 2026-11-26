import type { ProviderId } from "./providers.ts";

export const COMPLETION_AUDIT_STATES = ["QUEUED", "RUNNING", "READY", "FAILED"] as const;
export type CompletionAuditState = (typeof COMPLETION_AUDIT_STATES)[number];

export const COMPLETION_VERDICTS = ["COMPLETE", "INCOMPLETE", "UNVERIFIABLE"] as const;
export type CompletionVerdict = (typeof COMPLETION_VERDICTS)[number];

export const AUDIT_CHECK_RESULTS = ["PASSED", "FAILED", "UNVERIFIED"] as const;
export type AuditCheckResult = (typeof AUDIT_CHECK_RESULTS)[number];

export interface CompletionAuditCheck {
  criterion: string;
  criterionId: number | null;
  result: AuditCheckResult;
  evidence: string;
  command: string | null;
}

export interface CompletionAuditReport {
  version: 1;
  verdict: CompletionVerdict;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  checks: CompletionAuditCheck[];
  remainingWork: string[];
  verificationSummary: string;
  reasoning: string;
}

export interface CompletionAuditRecord {
  id: string;
  workspaceId: number;
  promptId: number;
  sourceRunId: string;
  auditRunId: string | null;
  provider: ProviderId;
  model: string | null;
  state: CompletionAuditState;
  verdict: CompletionVerdict | null;
  report: CompletionAuditReport | null;
  reportMarkdown: string;
  applied: boolean;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}
